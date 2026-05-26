"""Backtesting endpoints."""
from __future__ import annotations

import asyncio
import copy
import logging
from datetime import datetime, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.custom_script import CustomScript
from app.models.report import BacktestReport
from app.services.backtester import run_backtest
from app.services.data_maintenance import enqueue_ib_verification, get_ib_verification_status
from app.services.data_provider import (
    DataSource,
    get_intraday_cache_coverage,
    list_data_sources,
    warm_intraday_cache,
)
from app.services.ib_service import IB_AVAILABLE, ib_service
from app.services.local_storage import (
    _safe_filename,
    list_backtest_report_files,
    load_backtest_report,
    records_to_csv_bytes,
    records_to_json_bytes,
    save_backtest_report,
)
from app.services.portfolio_manager import get_manager_settings
from app.services.reporter import generate_html_report
from app.services.script_executor import validate_script
from app.services.strategies import list_strategies

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backtest", tags=["backtest"])

_SENTIMENT_BUCKETS = ("crash", "bearish", "neutral", "bullish", "euphoric")
_MATRIX_FALLBACK_AI_ORDER = ("NEUTRAL", "LONG", "STRONG LONG", "SHORT", "STRONG SHORT")


def _normalize_strategy_name(name: str, default: str) -> str:
    """Normalize aliases used in PM settings to executable strategy identifiers."""
    raw = (name or "").strip()
    if not raw:
        return default
    aliases = {
        "bollinger": "bollinger_bands",
        "intraday_1m": "template:intraday_1m_regime_template.py",
    }
    return aliases.get(raw, raw)


def _resolve_backtest_sentiment_strategies(pm_settings: dict) -> tuple[dict[str, str], str]:
    """Resolve the effective PM sentiment strategy map used by backtests.

    Preference order:
      1) sentiment_matrix_strategies row using AI `NEUTRAL` column
      2) first non-empty matrix cell in fallback AI order
      3) market_sentiment_strategies bucket mapping
      4) hardcoded defaults
    """
    defaults: dict[str, str] = {
        "crash": "rsi",
        "bearish": "macd",
        "neutral": "bollinger_bands",
        "bullish": "sma_crossover",
        "euphoric": "rsi",
    }
    market_map_raw = pm_settings.get("market_sentiment_strategies") or {}
    matrix_raw = pm_settings.get("sentiment_matrix_strategies") or {}

    resolved: dict[str, str] = {}
    used_matrix = False
    for bucket in _SENTIMENT_BUCKETS:
        fallback = _normalize_strategy_name(str(market_map_raw.get(bucket) or ""), defaults[bucket])
        strat = fallback
        row = matrix_raw.get(bucket) if isinstance(matrix_raw, dict) else None
        if isinstance(row, dict) and row:
            candidate = ""
            for ai_col in _MATRIX_FALLBACK_AI_ORDER:
                cell = row.get(ai_col)
                if isinstance(cell, str) and cell.strip():
                    candidate = cell.strip()
                    break
            if candidate:
                strat = _normalize_strategy_name(candidate, fallback)
                used_matrix = True
        resolved[bucket] = strat

    source = "sentiment_matrix_strategies" if used_matrix else "market_sentiment_strategies"
    return resolved, source


def _intraday_cache_covers_range(coverage: dict, start_date: str, end_date: str) -> bool:
    """Return True when cached intraday data spans the requested date range."""
    oldest = coverage.get("oldest")
    newest = coverage.get("newest")
    if not oldest or not newest:
        return False
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
        oldest_dt = datetime.fromisoformat(str(oldest)).date()
        newest_dt = datetime.fromisoformat(str(newest)).date()
    except ValueError:
        return False

    required_start = start_dt
    while required_start.weekday() >= 5:
        required_start += timedelta(days=1)

    # Intraday feeds do not emit bars on weekends/holidays, and callers often
    # use "today" as end_date. Validate against the latest required trading day.
    required_end = min(end_dt, datetime.now().date())
    while required_end.weekday() >= 5:
        required_end -= timedelta(days=1)

    # Allow a small calendar-day tolerance so holiday closures (for example,
    # Monday market holidays) do not fail otherwise valid Friday-ending caches.
    return oldest_dt <= (required_start + timedelta(days=3)) and (newest_dt + timedelta(days=3)) >= required_end


def _intraday_cache_covers_range_for_source(
    symbol: str,
    data_source: DataSource,
    start_date: str,
    end_date: str,
) -> bool:
    """Check whether cache coverage satisfies the requested date range.

    In ``auto`` mode, either IB or Yahoo cache can satisfy the requirement.
    """
    if data_source != "auto":
        return _intraday_cache_covers_range(
            get_intraday_cache_coverage(symbol, data_source),
            start_date,
            end_date,
        )

    return (
        _intraday_cache_covers_range(get_intraday_cache_coverage(symbol, "ib"), start_date, end_date)
        or _intraday_cache_covers_range(get_intraday_cache_coverage(symbol, "yfinance"), start_date, end_date)
    )


async def _ensure_watchlist_intraday_cache(
    symbols: list[str],
    start_date: str,
    end_date: str,
    data_source: DataSource,
) -> dict[str, object]:
    """Warm intraday cache for a watchlist backtest and fail fast on gaps.

    Sandbox portfolio backtests are cache-first. For a month-long 1m run we
    need the whole watchlist covered up front; otherwise the coordinator would
    silently skip symbols with cache misses and return a partial report.
    """
    if not symbols:
        return {}

    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return {}

    lookback_days = max(1, (end_dt - start_dt).days + 1)
    today_dt = datetime.now().date()
    warm_lookback_days = max(lookback_days, (today_dt - start_dt).days + 1)

    async def _warm_symbols(target_symbols: list[str], source: DataSource, *, prefer_ib: bool) -> None:
        sem = asyncio.Semaphore(3)

        async def _warm_one(sym: str) -> None:
            async with sem:
                await asyncio.to_thread(
                    warm_intraday_cache,
                    sym,
                    lookback_days=warm_lookback_days,
                    source=source,
                    chunk_days=min(max(1, warm_lookback_days), 20),
                    prefer_ib=prefer_ib,
                    ib_use_rth=False,
                    ib_what_to_show="TRADES",
                    ib_max_retries=2,
                    ib_pause_ms=150,
                )

        await asyncio.gather(*[_warm_one(sym) for sym in target_symbols])

    missing = [
        sym for sym in symbols
        if not _intraday_cache_covers_range_for_source(sym, data_source, start_date, end_date)
    ]
    if missing:
        if data_source == "auto":
            # In auto mode, avoid IB-first warm-ups that can stall and trip
            # frontend proxy timeouts while connected to IB.
            await _warm_symbols(missing, "auto", prefer_ib=False)
        else:
            await _warm_symbols(missing, data_source, prefer_ib=(data_source == "ib"))

    still_missing = [
        sym for sym in symbols
        if not _intraday_cache_covers_range_for_source(sym, data_source, start_date, end_date)
    ]
    if still_missing and data_source == "auto":
        # For long lookbacks where Yahoo coverage is insufficient, make a
        # second pass through IB only for remaining symbols.
        await _warm_symbols(still_missing, "ib", prefer_ib=True)
        still_missing = [
            sym for sym in symbols
            if not _intraday_cache_covers_range_for_source(sym, data_source, start_date, end_date)
        ]
    if still_missing and data_source == "ib":
        # Force a second pass against Yahoo for symbols that still have gaps.
        # This handles cases where IB is technically connected but not serving
        # historical bars for the current host/session.
        await _warm_symbols(still_missing, "yfinance", prefer_ib=False)
        still_missing = [
            sym for sym in symbols
            if not _intraday_cache_covers_range_for_source(sym, data_source, start_date, end_date)
        ]

    if still_missing:
        raise HTTPException(
            status_code=409,
            detail=(
                "Intraday cache does not cover the requested backtest range for: "
                + ", ".join(still_missing)
                + ". Existing local cache was checked first, then internet fallback (Yahoo) was attempted. "
                + "Coverage is still insufficient for the requested range."
            ),
        )

    verification_info: dict[str, object] = {}
    ib_connected = bool(IB_AVAILABLE and ib_service.is_connected)
    if data_source == "auto" and ib_connected:
        unverified = [
            sym
            for sym in symbols
            if _intraday_cache_covers_range_for_source(sym, data_source, start_date, end_date)
            and not _intraday_cache_covers_range(
                get_intraday_cache_coverage(sym, "ib"),
                start_date,
                end_date,
            )
        ]
        if unverified:
            queued = enqueue_ib_verification(
                unverified,
                start_date,
                end_date,
                reason="sandbox_backtest_preflight",
            )
            verification_info = {
                "verification_unverified_symbols": unverified,
                "verification_queued_symbols": queued,
                "verification_warning": (
                    "Not all intraday bars are IB-verified for this range. "
                    "The backtest used existing cached data now, and IB verification "
                    "was queued in the background for: "
                    + ", ".join(unverified)
                ),
            }

    return verification_info


def _bars_per_year_from_interval(interval: str | None) -> float:
    """Map interval strings to trading bars per year for Sharpe scaling."""
    interval_key = (interval or "1d").strip().lower()
    interval_bars: dict[str, float] = {
        "5s": 252 * 4680,
        "1m": 252 * 390,
        "2m": 252 * 195,
        "5m": 252 * 78,
        "15m": 252 * 26,
        "30m": 252 * 13,
        "60m": 252 * 6.5,
        "1h": 252 * 6.5,
        "1d": 252,
    }
    return float(interval_bars.get(interval_key, 252.0))


def _summarize_report_symbols(symbols: list[str], max_len: int = 20) -> str:
    """Build a compact report symbol label that fits DB storage limits.

    The output never ends with a dangling delimiter. When the full list does
    not fit, append a compact "+N" remainder count.
    """
    cleaned: list[str] = []
    for raw in symbols:
        sym = str(raw or "").strip().upper()
        if not sym:
            continue
        if sym not in cleaned:
            cleaned.append(sym)

    if not cleaned:
        return "SANDBOX"

    full = ",".join(cleaned)
    if len(full) <= max_len:
        return full

    # Keep as many leading symbols as possible and annotate omitted count.
    for keep in range(len(cleaned), 0, -1):
        base = ",".join(cleaned[:keep])
        remaining = len(cleaned) - keep
        suffix = f"+{remaining}" if remaining > 0 else ""
        candidate = f"{base}{suffix}"
        if len(candidate) <= max_len:
            return candidate

    return cleaned[0][:max_len]


def _flatten_per_symbol_trades(per_symbol: list[dict]) -> list[dict]:
    """Aggregate per-symbol trades into a stable, chronologically sorted list."""
    combined: list[dict] = []
    for entry in per_symbol:
        sym = str(entry.get("symbol") or "").upper()
        for trade in entry.get("trades") or []:
            row = dict(trade)
            if sym and "symbol" not in row:
                row["symbol"] = sym
            combined.append(row)
    combined.sort(key=lambda t: (
        str(t.get("exit_date") or ""),
        str(t.get("entry_date") or ""),
        str(t.get("symbol") or ""),
    ))
    return combined


def _extract_result_bar_date(bar: dict | None) -> datetime.date | None:
    if not isinstance(bar, dict):
        return None
    raw = bar.get("date") or bar.get("timestamp") or bar.get("Date") or bar.get("ts")
    if not raw:
        return None
    text = str(raw).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d_%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(raw), fmt).date()
        except ValueError:
            continue
    return None


def _build_result_range_warning(per_symbol: list[dict], start_date: str, end_date: str) -> str | None:
    try:
        requested_start = datetime.strptime(start_date, "%Y-%m-%d").date()
        requested_end = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        return None

    required_start = requested_start
    while required_start.weekday() >= 5:
        required_start += timedelta(days=1)

    required_end = min(requested_end, datetime.now().date())
    while required_end.weekday() >= 5:
        required_end -= timedelta(days=1)

    mismatched: list[str] = []
    for item in per_symbol or []:
        ohlcv = item.get("ohlcv") or []
        if not ohlcv:
            continue
        first_dt = _extract_result_bar_date(ohlcv[0])
        last_dt = _extract_result_bar_date(ohlcv[-1])
        if first_dt is None or last_dt is None:
            continue
        if first_dt > (required_start + timedelta(days=3)) or (last_dt + timedelta(days=3)) < required_end:
            mismatched.append(f"{item.get('symbol')}: {first_dt.isoformat()} to {last_dt.isoformat()}")

    if not mismatched:
        return None

    suffix = "." if len(mismatched) <= 8 else f"; +{len(mismatched) - 8} more."
    return (
        "Saved result data does not fully cover the requested range. Actual cached bars used were: "
        + "; ".join(mismatched[:8])
        + suffix
    )


def _raise_if_backtest_fully_failed(symbols_run: int, errors: dict[str, object] | None, data_source: DataSource) -> None:
    if symbols_run > 0:
        return
    error_map = errors or {}
    message = "Sandbox backtest produced no runnable symbols."
    if error_map:
        first_error = next(iter(error_map.values()))
        if first_error:
            message = str(first_error)
    raise HTTPException(
        status_code=409,
        detail={
            "message": message,
            "data_source": data_source,
            "errors": error_map,
        },
    )


class BacktestRequest(BaseModel):
    symbol: str = Field(..., example="AAPL")
    strategy_type: str = Field(default="sma_crossover", example="sma_crossover")
    script_id: int | None = Field(
        default=None,
        description="ID of a saved custom script to use instead of a built-in strategy.",
    )
    template_filename: str | None = Field(
        default=None,
        description="Filename of a built-in template (e.g. 'day_trade_template.py') to run directly.",
    )
    start_date: str = Field(..., example="2022-01-01")
    end_date: str = Field(..., example="2023-12-31")
    initial_capital: float = Field(default=10000.0, ge=1000)
    commission: float = Field(default=0.001, ge=0, le=0.05)
    strategy_params: dict = Field(default_factory=dict)
    data_source: DataSource = Field(
        default="auto",
        description=(
            "Historical data source for the backtest. "
            "Backtests are cache-first: non-IB sources use locally cached history and do not "
            "pull free-source data on demand. Options: 'auto', 'yfinance', 'stooq', 'ib'."
        ),
        example="auto",
    )
    day_trade: bool = Field(
        default=True,
        description=(
            "When True, uses intraday bars and scales performance metrics accordingly. "
            "Backtests read from local cache for non-IB sources."
        ),
    )
    hold_positions_overnight: bool = Field(
        default=True,
        description="When False, forces liquidation at end of day during eod_sell_window."
    )
    eod_sell_window_minutes: int = Field(
        default=30,
        ge=1,
        le=240,
        description="Duration in minutes before market close (16:00 ET) for EOD liquidation."
    )


@router.get("/strategies")
async def get_strategies():
    """List all available strategies with their default parameters."""
    return {"strategies": list_strategies()}


@router.get("/data-sources")
async def get_data_sources():
    """List all supported data sources and their availability."""
    return {"data_sources": list_data_sources()}


class IntradayCacheWarmRequest(BaseModel):
    symbol: str = Field(..., example="AAPL")
    lookback_days: int = Field(default=365, ge=1, le=730)
    data_source: DataSource = Field(default="auto")
    chunk_days: int = Field(
        default=20,
        ge=1,
        le=90,
        description="Chunk size per pull when backfilling IB intraday bars.",
    )
    prefer_ib: bool = Field(
        default=True,
        description="When enabled and IB is connected, force IB-based backfill even if data_source is auto/yfinance.",
    )
    ib_use_rth: bool = Field(
        default=False,
        description="Request regular-trading-hours only from IB (True) or include extended session (False).",
    )
    ib_what_to_show: str = Field(
        default="TRADES",
        description="IB whatToShow field for historical pulls (e.g. TRADES, MIDPOINT).",
    )
    ib_max_retries: int = Field(default=2, ge=0, le=10)
    ib_pause_ms: int = Field(default=150, ge=0, le=5000)


@router.post("/cache/warm-intraday")
async def warm_intraday_history_cache(req: IntradayCacheWarmRequest):
    """Warm local 1-minute intraday cache used by cache-first backtests."""
    result = await asyncio.to_thread(
        warm_intraday_cache,
        req.symbol,
        lookback_days=req.lookback_days,
        source=req.data_source,
        chunk_days=req.chunk_days,
        prefer_ib=req.prefer_ib,
        ib_use_rth=req.ib_use_rth,
        ib_what_to_show=req.ib_what_to_show,
        ib_max_retries=req.ib_max_retries,
        ib_pause_ms=req.ib_pause_ms,
    )
    return result


@router.get("/cache/intraday-coverage")
async def intraday_history_cache_coverage(
    symbol: str = Query(..., description="Ticker symbol (e.g. AAPL)"),
    data_source: DataSource = Query(default="auto"),
):
    """Inspect local intraday cache coverage for a symbol/source."""
    return get_intraday_cache_coverage(symbol, data_source)


@router.get("/cache/ib-verification-status")
async def ib_intraday_verification_status(
    limit: int = Query(default=50, ge=1, le=500),
):
    """Return current/recent queued IB verification jobs for intraday cache."""
    return get_ib_verification_status(limit=limit)


class SentimentBacktestRequest(BaseModel):
    symbol: str = Field(..., example="AAPL")
    start_date: str = Field(..., example="2022-01-01")
    end_date: str = Field(..., example="2023-12-31")
    initial_capital: float = Field(default=10000.0, ge=1000)
    commission: float = Field(default=0.001, ge=0, le=0.05)
    data_source: DataSource = Field(default="auto")
    day_trade: bool = Field(default=True)
    sentiment_strategies: dict[str, str] = Field(
        default_factory=lambda: {
            "crash": "rsi",
            "bearish": "macd",
            "neutral": "bollinger_bands",
            "bullish": "sma_crossover",
            "euphoric": "rsi",
        }
    )
    sentiment_warmup: int = Field(default=35, ge=5, le=500)
    stop_loss_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    take_profit_pct: float = Field(default=0.0, ge=0.0, le=1000.0)
    hold_positions_overnight: bool = Field(
        default=True,
        description="When False, forces liquidation at end of day during eod_sell_window."
    )
    eod_sell_window_minutes: int = Field(
        default=30,
        ge=1,
        le=240,
        description="Duration in minutes before market close (16:00 ET) for EOD liquidation."
    )

    def validate_strategies(self) -> None:
        aliases = {
            "bollinger": "bollinger_bands",
            "moving_avg": "sma_crossover",
            "sma": "sma_crossover",
            "bb": "bollinger_bands",
        }
        valid_strategy_types = {s["type"] for s in list_strategies()}
        for bucket, stype in self.sentiment_strategies.items():
            if stype.startswith("custom:"):
                try:
                    int(stype[7:])
                except ValueError:
                    raise ValueError(f"Invalid custom script reference '{stype}' for bucket '{bucket}'.")
                continue
            if stype.startswith("template:"):
                filename = stype[9:]
                if not filename or "/" in filename or "\\" in filename or ".." in filename:
                    raise ValueError(f"Invalid template filename '{filename}' for bucket '{bucket}'.")
                continue
            resolved = aliases.get(stype, stype)
            if resolved not in valid_strategy_types:
                raise ValueError(
                    f"Unknown strategy '{stype}' for bucket '{bucket}'. "
                    f"Valid: {sorted(valid_strategy_types)}"
                )


def _build_pm_settings_snapshot(overrides: dict | None = None) -> dict:
    """Return a complete PM settings snapshot for report storage."""
    snapshot = copy.deepcopy(get_manager_settings())
    if overrides:
        snapshot.update(overrides)
    return snapshot


async def _offload_report_payload(
    db: AsyncSession,
    report: BacktestReport,
    payload: dict,
    *,
    clear_db_result_data: bool = True,
) -> None:
    """Persist full report payload to local storage and optionally clear DB JSON blob."""
    result_data = payload.get("result_data") if isinstance(payload, dict) else None
    has_result_data = isinstance(result_data, dict) and bool(result_data)
    if not has_result_data:
        logger.warning(
            "Skipping offload for report %s due to empty result_data payload",
            report.id,
        )
        return
    try:
        saved_path = save_backtest_report(report.id, report.name, payload)
        report.result_data_path = saved_path
        if clear_db_result_data and report.result_data is not None:
            report.result_data = None
        await db.commit()
    except Exception:
        logger.exception("Failed to offload backtest report %s to local storage", report.id)


def _build_trace_log(
    *,
    symbol: str,
    strategy_type: str,
    start_date: str,
    end_date: str,
    initial_capital: float,
    strategy_params: dict,
    script_source: str,
    script_id: int | None,
    template_filename: str | None,
    trades: list[dict],
) -> dict:
    return {
        "trace_id": str(uuid4()),
        "trace_generated_at": datetime.utcnow().isoformat() + "Z",
        "symbol": symbol,
        "strategy_type": strategy_type,
        "script_source": script_source,
        "script_id": script_id,
        "template_filename": template_filename,
        "start_date": start_date,
        "end_date": end_date,
        "initial_capital": initial_capital,
        "strategy_params": strategy_params,
        "trade_count": len(trades),
        "sample_trades": trades[:10],
    }

@router.post("/run-sentiment")
async def run_sentiment_backtest_endpoint(
    req: SentimentBacktestRequest,
    db: AsyncSession = Depends(get_db),
):
    """Run a sentiment backtest and persist the report."""
    from app.services.backtester import run_sentiment_backtest as _run_sent

    try:
        req.validate_strategies()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Load code for any custom:{id} scripts referenced in the strategy map.
    custom_script_ids = {
        int(stype[7:])
        for stype in req.sentiment_strategies.values()
        if stype.startswith("custom:")
    }
    custom_scripts: dict[int, str] = {}
    if custom_script_ids:
        from app.models.custom_script import CustomScript
        from sqlalchemy import select as _sa_select
        res = await db.execute(_sa_select(CustomScript).where(CustomScript.id.in_(custom_script_ids)))
        for row in res.scalars().all():
            custom_scripts[row.id] = row.script_code
        missing = custom_script_ids - custom_scripts.keys()
        if missing:
            raise HTTPException(status_code=404, detail=f"Custom script(s) not found: {sorted(missing)}")

    try:
        result = await asyncio.to_thread(
            _run_sent,
            symbol=req.symbol.upper(),
            start_date=req.start_date,
            end_date=req.end_date,
            initial_capital=req.initial_capital,
            commission=req.commission,
            data_source=req.data_source,
            day_trade=req.day_trade,
            sentiment_strategies=req.sentiment_strategies,
            sentiment_warmup=req.sentiment_warmup,
            stop_loss_pct=req.stop_loss_pct,
            take_profit_pct=req.take_profit_pct,
            hold_positions_overnight=req.hold_positions_overnight,
            eod_sell_window_minutes=req.eod_sell_window_minutes,
            custom_scripts=custom_scripts or None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Sentiment backtest error for symbol=%s", req.symbol)
        raise HTTPException(status_code=500, detail=f"Backtest error: {exc}")

    m = result["metrics"]
    name = (
        f"{req.symbol.upper()}_sentiment_{req.start_date}_to_{req.end_date}"
    )
    result_data_payload = {
        "equity_curve": result["equity_curve"],
        "trades": result["trades"],
        "ohlcv": result["ohlcv"],
    }
    pm_settings_snapshot = _build_pm_settings_snapshot({
        "sentiment_strategies": req.sentiment_strategies,
        "sentiment_warmup": req.sentiment_warmup,
        "stop_loss_pct": req.stop_loss_pct,
        "take_profit_pct": req.take_profit_pct,
        "hold_positions_overnight": req.hold_positions_overnight,
        "eod_sell_window_minutes": req.eod_sell_window_minutes,
    })
    report = BacktestReport(
        name=name,
        symbol=req.symbol.upper(),
        strategy_type="sentiment_switching",
        parameters={"pm_settings": pm_settings_snapshot},
        start_date=req.start_date,
        end_date=req.end_date,
        initial_capital=req.initial_capital,
        final_value=m["final_value"],
        total_return_pct=m["total_return_pct"],
        annualized_return_pct=m["annualized_return_pct"],
        sharpe_ratio=m["sharpe_ratio"],
        max_drawdown_pct=m["max_drawdown_pct"],
        win_rate_pct=m["win_rate_pct"],
        total_trades=m["total_trades"],
        result_data=result_data_payload,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)

    offload_payload = {
        "id": report.id,
        "name": name,
        "symbol": req.symbol.upper(),
        "strategy_type": "sentiment_switching",
        "start_date": req.start_date,
        "end_date": req.end_date,
        "initial_capital": req.initial_capital,
        "metrics": m,
        "result_data": result_data_payload,
        "created_at": report.created_at.isoformat() if report.created_at else None,
    }
    await _offload_report_payload(db, report, offload_payload)

    return {
        "id": report.id,
        "name": name,
        "metrics": m,
        "result": result,
    }

@router.post("/run")
async def run_backtest_endpoint(
    req: BacktestRequest,
    db: AsyncSession = Depends(get_db),
):
    """Run a backtest and persist the report.

    Supply either a ``strategy_type`` (built-in), a ``script_id`` (saved custom
    script), or a ``template_filename`` (built-in template file).
    ``template_filename`` > ``script_id`` > ``strategy_type`` in precedence.
    """
    from pathlib import Path
    _TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"

    script_code: str | None = None
    effective_strategy_type = req.strategy_type

    if req.template_filename is not None:
        filename = req.template_filename
        if "/" in filename or "\\" in filename or ".." in filename:
            raise HTTPException(status_code=400, detail="Invalid template filename.")
        tmpl_path = _TEMPLATES_DIR / filename
        if not tmpl_path.exists():
            raise HTTPException(status_code=404, detail=f"Template '{filename}' not found.")
        script_code = tmpl_path.read_text(encoding="utf-8")
        effective_strategy_type = f"template:{filename}"
    elif req.script_id is not None:
        script = await db.get(CustomScript, req.script_id)
        if not script:
            raise HTTPException(status_code=404, detail=f"Custom script {req.script_id} not found.")
        script_code = script.script_code
        effective_strategy_type = "custom_script"

    try:
        result = await asyncio.to_thread(
            run_backtest,
            symbol=req.symbol.upper(),
            strategy_type=effective_strategy_type,
            start_date=req.start_date,
            end_date=req.end_date,
            initial_capital=req.initial_capital,
            commission=req.commission,
            script_code=script_code,
            data_source=req.data_source,
            day_trade=req.day_trade,
            hold_positions_overnight=req.hold_positions_overnight,
            eod_sell_window_minutes=req.eod_sell_window_minutes,
            **req.strategy_params,
        )
    except ValueError as exc:
        logger.exception("Backtest validation error for symbol=%s strategy=%s", req.symbol, effective_strategy_type)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Backtest unexpected error for symbol=%s strategy=%s", req.symbol, effective_strategy_type)
        raise HTTPException(status_code=500, detail=f"Backtest error: {exc}")

    m = result["metrics"]
    if req.template_filename is not None:
        stem = req.template_filename.removesuffix(".py")
        name = f"{req.symbol.upper()}_{stem}_{req.start_date}_to_{req.end_date}"
    elif req.script_id is not None:
        name = (
            f"{req.symbol.upper()}_script{req.script_id}_"
            f"{req.start_date}_to_{req.end_date}"
        )
    else:
        name = (
            f"{req.symbol.upper()}_{effective_strategy_type}_"
            f"{req.start_date}_to_{req.end_date}"
        )

    # Generate HTML report
    try:
        html_path = await asyncio.to_thread(generate_html_report, result, name)
    except Exception:
        html_path = None

    # Persist summary to DB
    # Build a frozen snapshot: the raw script with an appended get_default_params()
    # that returns the exact merged params used for this run, so the downloaded
    # file is fully self-contained and reproducible.
    frozen_snapshot: str | None = None
    if script_code is not None:
        params_repr = repr(req.strategy_params)
        frozen_snapshot = (
            f"{script_code.rstrip()}\n\n\n"
            f"# ── Frozen parameters for this backtest run ──────────────────────────────\n"
            f"# Symbol: {req.symbol.upper()}  |  {req.start_date} → {req.end_date}\n"
            f"# Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC\n"
            f"# Do NOT edit below — these values were locked in when the report was saved.\n"
            f"def get_default_params():  # noqa: F811\n"
            f"    return {params_repr}\n"
        )

    result_data_payload = {
        "equity_curve": result["equity_curve"],
        "trades": result["trades"],
        "ohlcv": result["ohlcv"],
    }

    report = BacktestReport(
        name=name,
        symbol=req.symbol.upper(),
        strategy_type=effective_strategy_type,
        parameters=req.strategy_params,
        start_date=req.start_date,
        end_date=req.end_date,
        initial_capital=req.initial_capital,
        final_value=m["final_value"],
        total_return_pct=m["total_return_pct"],
        annualized_return_pct=m["annualized_return_pct"],
        sharpe_ratio=m["sharpe_ratio"],
        max_drawdown_pct=m["max_drawdown_pct"],
        win_rate_pct=m["win_rate_pct"],
        total_trades=m["total_trades"],
        result_data=result_data_payload,
        html_report_path=html_path,
        script_snapshot=frozen_snapshot,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)

    offload_payload = {
        "id": report.id,
        "name": name,
        "symbol": req.symbol.upper(),
        "strategy_type": effective_strategy_type,
        "start_date": req.start_date,
        "end_date": req.end_date,
        "initial_capital": req.initial_capital,
        "metrics": m,
        "result_data": result_data_payload,
        "script_snapshot": frozen_snapshot,
        "trace_log": _build_trace_log(
            symbol=req.symbol.upper(),
            strategy_type=effective_strategy_type,
            start_date=req.start_date,
            end_date=req.end_date,
            initial_capital=req.initial_capital,
            strategy_params=req.strategy_params,
            script_source=(
                "template" if req.template_filename is not None
                else ("custom_script" if req.script_id is not None else "builtin")
            ),
            script_id=req.script_id,
            template_filename=req.template_filename,
            trades=result_data_payload["trades"],
        ),
        "created_at": report.created_at.isoformat() if report.created_at else None,
    }
    await _offload_report_payload(db, report, offload_payload)

    return {
        "id": report.id,
        "name": name,
        "metrics": m,
        "result": result,
        "html_report_path": html_path,
        "script_snapshot": frozen_snapshot,
    }


# ── Sandbox + Portfolio Manager batch backtest ───────────────────────────── #

class SandboxBacktestRequest(BaseModel):
    start_date: str = Field(..., example="2024-01-01")
    end_date: str = Field(..., example="2024-12-31")
    initial_capital: float = Field(default=10000.0, ge=1000)
    commission: float = Field(default=0.001, ge=0, le=0.05)
    data_source: DataSource = Field(default="auto")
    day_trade: bool = Field(
        default=True,
        description="Deprecated override; sandbox PM backtests always run in day-trade mode.",
    )
    symbols: list[str] | None = Field(
        default=None,
        description="Override watchlist; if omitted, uses all sandbox watchlist symbols.",
    )
    use_sentiment_routing: bool = Field(
        default=True,
        description=(
            "Deprecated override; sandbox PM backtests always use PM sentiment strategy routing."
        ),
    )
    allocation_mode: str = Field(
        default="equal",
        description="'proportional' splits capital by allocated_funds; 'equal' splits evenly.",
    )
    use_shared_pool: bool = Field(
        default=True,
        description=(
            "When True (default), runs a coordinated portfolio simulation with a "
            "centralised cash pool that positions can draw from up to their per-position "
            "max-allocation cap. Mirrors live sandbox behaviour. When False, falls back to "
            "isolated per-symbol backtests with fixed up-front capital splits."
        ),
    )
    per_position_min_pct: float = Field(
        default=5.0,
        ge=0.0,
        le=100.0,
        description=(
            "Lower bound of equity earmarked per position, as a percentage of "
            "initial_capital. Default 5 means each position gets a small baseline earmark. "
            "Only used when use_shared_pool=True."
        ),
    )
    per_position_max_pct: float = Field(
        default=15.0,
        ge=0.0,
        le=200.0,
        description=(
            "Upper bound of equity per position, as a percentage of initial_capital. "
            "0 disables the cap (uncapped). Only used when use_shared_pool=True."
        ),
    )
    sim_buy_fill_rate_pct: float | None = Field(
        default=None,
        ge=0.0,
        le=100.0,
        description="Optional override for simulated BUY pending fill probability (%).",
    )
    sim_sell_fill_rate_pct: float | None = Field(
        default=None,
        ge=0.0,
        le=100.0,
        description="Optional override for simulated SELL pending fill probability (%).",
    )


def _build_sandbox_activity_log(per_symbol: list[dict]) -> list[dict]:
    """Flatten per-symbol trades into a chronological activity log.

    Each completed trade produces a BUY and SELL entry. Raw signal events are
    also included so the log shows BUY/SELL signals even when no fill occurs.
    """
    events: list[dict] = []
    for entry in per_symbol:
        sym = entry.get("symbol")
        strat = entry.get("strategy")
        for ev in entry.get("signal_events") or []:
            events.append({
                "timestamp": ev.get("timestamp"),
                "symbol": sym,
                "side": ev.get("side"),
                "price": ev.get("price"),
                "quantity": ev.get("quantity"),
                "value": ev.get("value"),
                "strategy": ev.get("strategy") or strat,
                "pnl": None,
                "exit_reason": ev.get("signal_reason"),
                "commission": ev.get("commission") or 0.0,
                "event_type": ev.get("event_type") or "SIGNAL",
                "signal_reason": ev.get("signal_reason"),
                "status": ev.get("status") or "signal",
                "notes": ev.get("notes") or ev.get("signal_reason") or ev.get("status") or "",
            })
        for t in entry.get("trades") or []:
            qty = t.get("quantity")
            entry_date = t.get("entry_date")
            exit_date = t.get("exit_date")
            entry_price = t.get("entry_price")
            exit_price = t.get("exit_price")
            pnl = t.get("pnl")
            commission = t.get("commission") or 0.0
            entry_strategy = t.get("entry_strategy") or strat
            exit_reason = t.get("exit_reason") or ""
            if entry_date is not None:
                events.append({
                    "timestamp": entry_date,
                    "symbol": sym,
                    "side": "BUY",
                    "price": entry_price,
                    "quantity": qty,
                    "value": (entry_price or 0) * (qty or 0),
                    "strategy": entry_strategy,
                    "pnl": None,
                    "exit_reason": None,
                    "commission": commission,
                    "event_type": "BUY_FILL",
                    "status": "filled",
                    "notes": "filled buy order",
                })
            if exit_date is not None:
                events.append({
                    "timestamp": exit_date,
                    "symbol": sym,
                    "side": "SELL",
                    "price": exit_price,
                    "quantity": qty,
                    "value": (exit_price or 0) * (qty or 0),
                    "strategy": entry_strategy,
                    "pnl": pnl,
                    "exit_reason": exit_reason,
                    "commission": commission,
                    "event_type": "SELL_FILL",
                    "status": "filled",
                    "notes": f"filled sell order: {exit_reason}",
                })
    events.sort(key=lambda e: (str(e.get("timestamp") or ""), e.get("symbol") or ""))
    return events


@router.post("/run-sandbox")
async def run_sandbox_backtest_endpoint(
    req: SandboxBacktestRequest,
    db: AsyncSession = Depends(get_db),
):
    """Backtest the current sandbox watchlist using PM settings.

    Splits ``initial_capital`` across watchlist symbols (proportional to each
    position's ``allocated_funds`` or evenly), then runs an individual backtest
    per symbol with PM-derived risk settings. Returns aggregate metrics, a
    combined equity curve, and per-symbol results.
    """
    from app.models.sandbox import SandboxPosition
    from app.services.portfolio_manager import get_manager_settings
    from app.services.backtester import (
        run_sentiment_backtest as _run_sent,
        run_sandbox_portfolio_backtest,
    )

    # Sandbox PM backtests are fixed to PM sentiment routing + day-trade mode.
    # Keep request fields for backwards compatibility with older frontend payloads.
    requested_data_source = req.data_source
    effective_data_source: DataSource = "auto" if requested_data_source == "ib" else req.data_source
    req = req.model_copy(update={"day_trade": True, "use_sentiment_routing": True, "data_source": effective_data_source})

    if req.allocation_mode not in ("proportional", "equal"):
        raise HTTPException(status_code=400, detail="allocation_mode must be 'proportional' or 'equal'.")

    # Pull watchlist + per-symbol strategy assignments from sandbox.
    rows = (await db.execute(select(SandboxPosition))).scalars().all()
    by_symbol = {p.symbol.upper(): p for p in rows if p.symbol}
    if req.symbols:
        symbols = [s.strip().upper() for s in req.symbols if s.strip()]
    else:
        symbols = sorted(
            p.symbol.upper() for p in rows
            if p.symbol and bool(getattr(p, "is_on_watchlist", True))
        )
    if not symbols:
        raise HTTPException(
            status_code=400,
            detail="No watchlist symbols found in sandbox. Add positions or pass `symbols`.",
        )

    verification_info: dict[str, object] = {}
    if req.day_trade:
        verification_info = await _ensure_watchlist_intraday_cache(
            symbols,
            req.start_date,
            req.end_date,
            effective_data_source,
        )

    pm = get_manager_settings()
    sentiment_strategies, sentiment_strategy_source = _resolve_backtest_sentiment_strategies(pm)
    stop_loss_pct = float(pm.get("stop_loss_pct") or 0.0)
    take_profit_pct = float(pm.get("take_profit_pct") or 0.0)
    stop_loss_value = float(pm.get("stop_loss_value") or 0.0)
    take_profit_value = float(pm.get("take_profit_value") or 0.0)
    hold_overnight = bool(pm.get("hold_positions_overnight", True))
    eod_window = int(pm.get("eod_sell_window_minutes") or 30)
    sentiment_warmup = int(pm.get("sentiment_data_points") or 35)
    sim_buy_fill_rate = float(pm.get("sim_buy_fill_rate_pct", 80.0) or 0.0)
    sim_sell_fill_rate = float(pm.get("sim_sell_fill_rate_pct", 90.0) or 0.0)
    pending_drift_cancel = float(pm.get("pending_price_drift_cancel_pct", 0.75) or 0.0)
    pending_cancel_after_bars = int(max(0, pm.get("pending_cancel_after_bars", 3) or 3))
    default_strategy_name = str(pm.get("default_strategy_name") or "template:intraday_1m_regime_template.py")
    intraday_1m_template_params = pm.get("intraday_1m_template_params") if isinstance(pm.get("intraday_1m_template_params"), dict) else {}
    position_overrides = pm.get("position_overrides") if isinstance(pm.get("position_overrides"), dict) else {}
    bar_predictor_enabled = bool(pm.get("bar_predictor_enabled", False))
    bar_predictor_buy_min_bias = float(pm.get("bar_predictor_buy_min_bias", 0.3) or 0.0)
    bar_predictor_sell_min_bias = float(pm.get("bar_predictor_sell_min_bias", 0.3) or 0.0)
    if req.sim_buy_fill_rate_pct is not None:
        sim_buy_fill_rate = float(req.sim_buy_fill_rate_pct)
    if req.sim_sell_fill_rate_pct is not None:
        sim_sell_fill_rate = float(req.sim_sell_fill_rate_pct)

    pm_settings_snapshot = _build_pm_settings_snapshot({
        "sentiment_strategy_source": sentiment_strategy_source,
        "effective_sentiment_strategies": sentiment_strategies,
        "stop_loss_pct": stop_loss_pct,
        "take_profit_pct": take_profit_pct,
        "stop_loss_value": stop_loss_value,
        "take_profit_value": take_profit_value,
        "hold_positions_overnight": hold_overnight,
        "eod_sell_window_minutes": eod_window,
        "sentiment_strategies": sentiment_strategies,
        "sentiment_warmup": sentiment_warmup,
        "sim_buy_fill_rate_pct": sim_buy_fill_rate,
        "sim_sell_fill_rate_pct": sim_sell_fill_rate,
        "pending_price_drift_cancel_pct": pending_drift_cancel,
        "pending_cancel_after_bars": pending_cancel_after_bars,
        "default_strategy_name": default_strategy_name,
        "intraday_1m_template_params": intraday_1m_template_params,
        "position_overrides": position_overrides,
    })

    # Capital split.
    if req.allocation_mode == "proportional":
        weights = {
            s: max(0.0, float(getattr(by_symbol.get(s), "allocated_funds", 0.0) or 0.0))
            for s in symbols
        }
        total_w = sum(weights.values())
        if total_w <= 0:
            per_symbol_capital = {s: req.initial_capital / len(symbols) for s in symbols}
        else:
            per_symbol_capital = {
                s: round(req.initial_capital * (weights[s] / total_w), 2) for s in symbols
            }
    else:
        per_symbol_capital = {s: req.initial_capital / len(symbols) for s in symbols}

    # Pre-load any custom scripts referenced by per-symbol strategies or sentiment map.
    needed_script_ids: set[int] = set()
    template_filenames: dict[str, str] = {}  # filename → code

    def _classify_strategy(name: str | None) -> tuple[str, int | None, str | None]:
        """Return (kind, script_id, template_filename). kind ∈ {builtin, custom, template}."""
        if not name:
            return ("builtin", None, None)
        if name.startswith("custom:"):
            try:
                return ("custom", int(name[7:]), None)
            except ValueError:
                return ("builtin", None, None)
        if name.startswith("template:"):
            return ("template", None, name[9:])
        return ("builtin", None, None)

    if not req.use_sentiment_routing:
        for s in symbols:
            kind, sid, tfn = _classify_strategy(getattr(by_symbol.get(s), "strategy_name", None))
            if kind == "custom" and sid is not None:
                needed_script_ids.add(sid)
            elif kind == "template" and tfn:
                template_filenames[tfn] = ""
    else:
        for stype in sentiment_strategies.values():
            if isinstance(stype, str) and stype.startswith("custom:"):
                try:
                    needed_script_ids.add(int(stype[7:]))
                except ValueError:
                    pass

    custom_scripts: dict[int, str] = {}
    if needed_script_ids:
        res = await db.execute(
            select(CustomScript).where(CustomScript.id.in_(needed_script_ids))
        )
        for row in res.scalars().all():
            custom_scripts[row.id] = row.script_code

    from pathlib import Path
    _TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"
    for fn in list(template_filenames.keys()):
        if "/" in fn or "\\" in fn or ".." in fn:
            template_filenames.pop(fn, None)
            continue
        path = _TEMPLATES_DIR / fn
        if path.exists():
            template_filenames[fn] = path.read_text(encoding="utf-8")
        else:
            template_filenames.pop(fn, None)

    # ── Shared-pool coordinated backtest (sandbox-style fund allocation) ── #
    if req.use_shared_pool:
        # Derive per-symbol earmark (min_alloc) and cap (max_alloc).
        n = len(symbols)
        max_pct = max(0.0, float(req.per_position_max_pct or 0.0))
        max_alloc_each = (max_pct / 100.0) * req.initial_capital if max_pct > 0 else 0.0
        min_pct_each = max(0.0, float(req.per_position_min_pct or 0.0)) / 100.0
        total_earmark = min(min_pct_each * n, 1.0) * req.initial_capital
        if req.allocation_mode == "proportional":
            weights = {
                s: max(0.0, float(getattr(by_symbol.get(s), "allocated_funds", 0.0) or 0.0))
                for s in symbols
            }
            total_w = sum(weights.values())
            if total_w > 0:
                min_alloc_by_symbol = {s: total_earmark * (weights[s] / total_w) for s in symbols}
            else:
                min_alloc_by_symbol = {s: total_earmark / n if n else 0.0 for s in symbols}
        else:
            min_alloc_by_symbol = {s: total_earmark / n if n else 0.0 for s in symbols}

        # Build the symbol_specs list for the coordinator.
        specs: list[dict] = []
        for s in symbols:
            if req.use_sentiment_routing:
                routing = "sentiment"
                fixed_strategy = None
            else:
                routing = "fixed"
                kind, sid, tfn = _classify_strategy(
                    getattr(by_symbol.get(s), "strategy_name", None)
                )
                sym_override = position_overrides.get(s, {}) if isinstance(position_overrides, dict) else {}
                override_strategy = str(sym_override.get("strategy_name") or "").strip() if isinstance(sym_override, dict) else ""
                if override_strategy:
                    kind, sid, tfn = _classify_strategy(override_strategy)
                if kind == "custom" and sid is not None and sid in custom_scripts:
                    fixed_strategy = f"custom:{sid}"
                elif kind == "template" and tfn and tfn in template_filenames:
                    fixed_strategy = f"template:{tfn}"
                else:
                    fixed_strategy = override_strategy or getattr(by_symbol.get(s), "strategy_name", None) or default_strategy_name or "sma_crossover"
                if fixed_strategy == "":
                    fixed_strategy = default_strategy_name or "sma_crossover"
                sl_pct_eff = stop_loss_pct
                tp_pct_eff = take_profit_pct
                sl_value_eff = stop_loss_value
                tp_value_eff = take_profit_value
                if isinstance(sym_override, dict):
                    sl_pct_eff = float(sym_override.get("stop_loss_pct", sl_pct_eff) or 0.0)
                    tp_pct_eff = float(sym_override.get("take_profit_pct", tp_pct_eff) or 0.0)
                    sl_value_eff = float(sym_override.get("stop_loss_value", sl_value_eff) or 0.0)
                    tp_value_eff = float(sym_override.get("take_profit_value", tp_value_eff) or 0.0)
            specs.append({
                "symbol": s,
                "routing": routing,
                "fixed_strategy": fixed_strategy,
                "min_alloc": min_alloc_by_symbol.get(s, 0.0),
                "max_alloc": max_alloc_each,
                "stop_loss_pct": sl_pct_eff if not req.use_sentiment_routing else stop_loss_pct,
                "take_profit_pct": tp_pct_eff if not req.use_sentiment_routing else take_profit_pct,
                "stop_loss_value": sl_value_eff if not req.use_sentiment_routing else stop_loss_value,
                "take_profit_value": tp_value_eff if not req.use_sentiment_routing else take_profit_value,
            })

        try:
            coord = await asyncio.to_thread(
                run_sandbox_portfolio_backtest,
                symbol_specs=specs,
                start_date=req.start_date,
                end_date=req.end_date,
                initial_capital=req.initial_capital,
                commission=req.commission,
                data_source=effective_data_source,
                day_trade=req.day_trade,
                sentiment_strategies=sentiment_strategies,
                sentiment_warmup=sentiment_warmup,
                custom_scripts=custom_scripts or None,
                stop_loss_pct=stop_loss_pct,
                take_profit_pct=take_profit_pct,
                stop_loss_value=stop_loss_value,
                take_profit_value=take_profit_value,
                hold_positions_overnight=hold_overnight,
                eod_sell_window_minutes=eod_window,
                sim_buy_fill_rate_pct=sim_buy_fill_rate,
                sim_sell_fill_rate_pct=sim_sell_fill_rate,
                pending_price_drift_cancel_pct=pending_drift_cancel,
                sim_pending_duration_bars=pending_cancel_after_bars,
                intraday_1m_template_params=intraday_1m_template_params,
                bar_predictor_enabled=bar_predictor_enabled,
                bar_predictor_buy_min_bias=bar_predictor_buy_min_bias,
                bar_predictor_sell_min_bias=bar_predictor_sell_min_bias,
            )
        except Exception as exc:
            logger.exception("Sandbox shared-pool backtest failed")
            raise HTTPException(status_code=500, detail=f"Coordinator failed: {exc}") from exc

        metrics_co = coord["metrics"]
        per_symbol_summary = coord["per_symbol"]
        equity_curve = coord["equity_curve"]
        # Downsample per-symbol trade lists if huge to keep payload sane.
        for entry in per_symbol_summary:
            tr = entry.get("trades") or []
            if len(tr) > 2000:
                entry["trades"] = tr[-2000:]

        # Aggregate trade fields used to compute CAGR / Sharpe / MDD on a
        # portfolio-level equity curve (calendar-day annualisation).
        annualized_return_pct = None
        sharpe_ratio = None
        max_drawdown_pct = None
        if equity_curve:
            import math as _math
            values = [float(p["value"]) for p in equity_curve]
            interval = next(
                (str(entry.get("interval")) for entry in per_symbol_summary if entry.get("interval")),
                "1d",
            )
            bars_per_year = _bars_per_year_from_interval(interval)
            cal_days = 0.0
            try:
                _s = datetime.strptime(req.start_date, "%Y-%m-%d")
                _e = datetime.strptime(req.end_date, "%Y-%m-%d")
                cal_days = max((_e - _s).days + 1, 0)
            except (ValueError, TypeError):
                cal_days = 0.0
            if req.initial_capital > 0 and coord["final_value"] > 0 and cal_days > 0:
                n_years = cal_days / 365.25
                if n_years > 0:
                    annualized_return_pct = round(
                        ((coord["final_value"] / req.initial_capital) ** (1.0 / n_years) - 1.0) * 100.0,
                        2,
                    )
            if len(values) > 1:
                rets = [
                    (values[i] - values[i - 1]) / values[i - 1]
                    for i in range(1, len(values))
                    if values[i - 1] > 0
                ]
                if len(rets) > 1:
                    mean_r = sum(rets) / len(rets)
                    var_r = sum((x - mean_r) ** 2 for x in rets) / (len(rets) - 1)
                    std_r = _math.sqrt(var_r)
                    sharpe_ratio = round((mean_r / std_r) * _math.sqrt(bars_per_year), 2) if std_r > 0 else 0.0
            peak = values[0]
            worst = 0.0
            for v in values:
                if v > peak:
                    peak = v
                if peak > 0:
                    dd = (v - peak) / peak
                    if dd < worst:
                        worst = dd
            max_drawdown_pct = round(worst * 100.0, 2)

        metrics_out = {
            "final_value": metrics_co["final_value"],
            "total_return_pct": metrics_co["total_return_pct"],
            "annualized_return_pct": annualized_return_pct,
            "sharpe_ratio": sharpe_ratio,
            "max_drawdown_pct": max_drawdown_pct,
            "win_rate_pct": metrics_co["win_rate_pct"],
            "total_trades": metrics_co["total_trades"],
            "symbols_run": metrics_co["symbols_run"],
            "symbols_failed": metrics_co["symbols_failed"],
        }
        _raise_if_backtest_fully_failed(
            metrics_out["symbols_run"],
            coord.get("errors") or {},
            effective_data_source,
        )
        report_symbol = _summarize_report_symbols(symbols)
        aggregated_trades = _flatten_per_symbol_trades(per_symbol_summary)

        name = (
            f"SANDBOX_pool_{'sentiment' if req.use_sentiment_routing else 'positions'}"
            f"_{req.start_date}_to_{req.end_date}"
        )
        parameters_payload = {
            "symbols": symbols,
            "data_source": effective_data_source,
            "requested_data_source": requested_data_source,
            "use_sentiment_routing": req.use_sentiment_routing,
            "allocation_mode": req.allocation_mode,
            "use_shared_pool": True,
            "per_position_min_pct": req.per_position_min_pct,
            "per_position_max_pct": req.per_position_max_pct,
            "pm_settings": pm_settings_snapshot,
            "per_symbol_min_alloc": min_alloc_by_symbol,
            "per_symbol_max_alloc": max_alloc_each,
        }
        result_data_payload = {
            "equity_curve": equity_curve,
            "trades": aggregated_trades,
            "ohlcv": [],
            "per_symbol": per_symbol_summary,
            "activity_log": _build_sandbox_activity_log(per_symbol_summary),
            "initial_capital": req.initial_capital,
            "per_symbol_min_alloc": min_alloc_by_symbol,
            "per_symbol_max_alloc": max_alloc_each,
            "use_sentiment_routing": req.use_sentiment_routing,
            "use_shared_pool": True,
            "pool_final": coord.get("pool_final"),
            "pm_settings": pm_settings_snapshot,
            "errors": coord.get("errors") or {},
            "verification_warning": verification_info.get("verification_warning"),
            "verification_unverified_symbols": verification_info.get("verification_unverified_symbols") or [],
            "verification_queued_symbols": verification_info.get("verification_queued_symbols") or [],
        }
        data_warning = _build_result_range_warning(per_symbol_summary, req.start_date, req.end_date)
        if data_warning:
            result_data_payload["data_warning"] = data_warning
        report = BacktestReport(
            name=name,
            symbol=report_symbol,
            strategy_type="sandbox_portfolio",
            parameters=parameters_payload,
            start_date=req.start_date,
            end_date=req.end_date,
            initial_capital=req.initial_capital,
            final_value=metrics_out["final_value"],
            total_return_pct=metrics_out["total_return_pct"],
            annualized_return_pct=metrics_out["annualized_return_pct"],
            sharpe_ratio=metrics_out["sharpe_ratio"],
            max_drawdown_pct=metrics_out["max_drawdown_pct"],
            win_rate_pct=metrics_out["win_rate_pct"],
            total_trades=metrics_out["total_trades"],
            result_data=result_data_payload,
        )
        db.add(report)
        await db.commit()
        await db.refresh(report)

        offload_payload = {
            "id": report.id,
            "name": name,
            "symbol": report.symbol,
            "strategy_type": "sandbox_portfolio",
            "start_date": req.start_date,
            "end_date": req.end_date,
            "initial_capital": req.initial_capital,
            "metrics": metrics_out,
            "result_data": result_data_payload,
            "created_at": report.created_at.isoformat() if report.created_at else None,
        }
        await _offload_report_payload(db, report, offload_payload)

        return {
            "id": report.id,
            "name": name,
            "metrics": metrics_out,
            "result": {
                "equity_curve": equity_curve,
                "per_symbol": per_symbol_summary,
                "initial_capital": req.initial_capital,
                "per_symbol_min_alloc": min_alloc_by_symbol,
                "per_symbol_max_alloc": max_alloc_each,
                "pool_final": coord.get("pool_final"),
                "pm_settings": pm_settings_snapshot,
                "use_sentiment_routing": req.use_sentiment_routing,
                "use_shared_pool": True,
                "activity_log": result_data_payload["activity_log"],
                "errors": result_data_payload["errors"],
                "verification_warning": result_data_payload.get("verification_warning"),
                "verification_unverified_symbols": result_data_payload.get("verification_unverified_symbols") or [],
                "verification_queued_symbols": result_data_payload.get("verification_queued_symbols") or [],
                "data_warning": result_data_payload.get("data_warning"),
            },
            "verification_warning": result_data_payload.get("verification_warning"),
            "verification_unverified_symbols": result_data_payload.get("verification_unverified_symbols") or [],
            "verification_queued_symbols": result_data_payload.get("verification_queued_symbols") or [],
            "data_warning": result_data_payload.get("data_warning"),
        }

    # Run all per-symbol backtests in parallel.
    async def _run_one(sym: str) -> dict:
        cap = per_symbol_capital.get(sym, 0.0)
        if cap <= 0:
            return {"symbol": sym, "skipped": True, "reason": "no capital allocated"}
        try:
            if req.use_sentiment_routing:
                res = await asyncio.to_thread(
                    _run_sent,
                    symbol=sym,
                    start_date=req.start_date,
                    end_date=req.end_date,
                    initial_capital=cap,
                    commission=req.commission,
                    data_source=effective_data_source,
                    day_trade=req.day_trade,
                    sentiment_strategies=sentiment_strategies,
                    sentiment_warmup=sentiment_warmup,
                    stop_loss_pct=stop_loss_pct,
                    take_profit_pct=take_profit_pct,
                    hold_positions_overnight=hold_overnight,
                    eod_sell_window_minutes=eod_window,
                    custom_scripts=custom_scripts or None,
                )
            else:
                kind, sid, tfn = _classify_strategy(
                    getattr(by_symbol.get(sym), "strategy_name", None)
                )
                script_code: str | None = None
                eff_type = "sma_crossover"
                if kind == "custom" and sid is not None and sid in custom_scripts:
                    script_code = custom_scripts[sid]
                    eff_type = "custom_script"
                elif kind == "template" and tfn and tfn in template_filenames:
                    script_code = template_filenames[tfn]
                    eff_type = f"template:{tfn}"
                elif kind == "builtin":
                    raw = getattr(by_symbol.get(sym), "strategy_name", None) or "sma_crossover"
                    eff_type = raw
                res = await asyncio.to_thread(
                    run_backtest,
                    symbol=sym,
                    strategy_type=eff_type,
                    start_date=req.start_date,
                    end_date=req.end_date,
                    initial_capital=cap,
                    commission=req.commission,
                    script_code=script_code,
                    data_source=effective_data_source,
                    day_trade=req.day_trade,
                    hold_positions_overnight=hold_overnight,
                    eod_sell_window_minutes=eod_window,
                )
            return {"symbol": sym, "result": res}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Sandbox backtest failed for %s", sym)
            return {"symbol": sym, "error": str(exc), "initial_capital": cap}

    per_results = await asyncio.gather(*[_run_one(s) for s in symbols])

    # Aggregate per-symbol metrics.
    per_symbol_summary: list[dict] = []
    aggregate_equity: dict[str, float] = {}
    aggregate_initial_remaining = 0.0  # capital for symbols that errored / had no data
    total_trades = 0
    aggregate_final = 0.0
    all_trade_pnls: list[float] = []
    wins = 0
    closed_trades = 0

    for entry in per_results:
        sym = entry["symbol"]
        cap = per_symbol_capital.get(sym, 0.0)
        if entry.get("error") or entry.get("skipped"):
            per_symbol_summary.append({
                "symbol": sym,
                "initial_capital": cap,
                "final_value": cap,
                "total_return_pct": 0.0,
                "total_trades": 0,
                "win_rate_pct": 0.0,
                "strategy": (
                    "sentiment_switching"
                    if req.use_sentiment_routing
                    else getattr(by_symbol.get(sym), "strategy_name", None)
                ),
                "error": entry.get("error") or entry.get("reason"),
            })
            aggregate_initial_remaining += cap
            aggregate_final += cap
            continue
        res = entry["result"]
        m = res["metrics"]
        raw_ohlcv = res.get("ohlcv") or []
        # Downsample OHLCV to keep payload reasonable across many symbols.
        MAX_OHLCV_POINTS = 800
        if len(raw_ohlcv) > MAX_OHLCV_POINTS:
            step = max(1, len(raw_ohlcv) // MAX_OHLCV_POINTS)
            ohlcv_out = raw_ohlcv[::step]
            # Always keep the last bar so the chart ends at end_date.
            if raw_ohlcv and ohlcv_out[-1] is not raw_ohlcv[-1]:
                ohlcv_out.append(raw_ohlcv[-1])
        else:
            ohlcv_out = raw_ohlcv
        per_symbol_summary.append({
            "symbol": sym,
            "initial_capital": cap,
            "final_value": m.get("final_value"),
            "total_return_pct": m.get("total_return_pct"),
            "sharpe_ratio": m.get("sharpe_ratio"),
            "max_drawdown_pct": m.get("max_drawdown_pct"),
            "win_rate_pct": m.get("win_rate_pct"),
            "total_trades": m.get("total_trades"),
            "strategy": res.get("strategy_type"),
            "interval": res.get("interval"),
            "trades": res.get("trades", []),
            "ohlcv": ohlcv_out,
            "equity_curve": res.get("equity_curve", []),
        })
        total_trades += int(m.get("total_trades") or 0)
        aggregate_final += float(m.get("final_value") or cap)
        for t in res.get("trades", []):
            pnl = t.get("pnl")
            if pnl is None:
                continue
            try:
                pv = float(pnl)
            except (TypeError, ValueError):
                continue
            all_trade_pnls.append(pv)
            closed_trades += 1
            if pv > 0:
                wins += 1
        for point in res.get("equity_curve", []):
            d = point.get("date")
            v = point.get("value")
            if d is None or v is None:
                continue
            aggregate_equity[d] = aggregate_equity.get(d, 0.0) + float(v)

    # Add baseline (errored / skipped symbol capital) to every aggregate point so totals balance.
    if aggregate_initial_remaining > 0 and aggregate_equity:
        for k in list(aggregate_equity.keys()):
            aggregate_equity[k] += aggregate_initial_remaining

    equity_curve = [
        {"date": d, "value": round(v, 2)}
        for d, v in sorted(aggregate_equity.items())
    ]

    total_return_pct = (
        ((aggregate_final - req.initial_capital) / req.initial_capital * 100.0)
        if req.initial_capital > 0 else 0.0
    )
    win_rate_pct = (wins / closed_trades * 100.0) if closed_trades else 0.0

    # Aggregate risk metrics computed from the portfolio-level equity curve.
    # Annualisation is calendar-time (CAGR) so the portfolio is treated like an
    # ETF / NAV series rather than a bar-count based single-symbol backtest.
    # This avoids inflating returns when the backtest window is short or when
    # the equity curve has gaps for symbols that didn't trade every day.
    annualized_return_pct: float | None = None
    sharpe_ratio: float | None = None
    max_drawdown_pct: float | None = None
    if equity_curve:
        import math as _math
        values = [float(p["value"]) for p in equity_curve]
        n_bars = len(values)
        interval = next(
            (
                str(r.get("result", {}).get("interval"))
                for r in per_results
                if isinstance(r.get("result"), dict) and r.get("result", {}).get("interval")
            ),
            "1d",
        )
        bars_per_year = _bars_per_year_from_interval(interval)

        # Calendar-day span for CAGR-style annualisation.
        cal_days: float = 0.0
        try:
            _s = datetime.strptime(req.start_date, "%Y-%m-%d")
            _e = datetime.strptime(req.end_date, "%Y-%m-%d")
            cal_days = max((_e - _s).days + 1, 0)
        except (ValueError, TypeError):
            cal_days = 0.0

        # Annualised return (CAGR): (final/initial) ^ (365.25 / calendar_days) - 1
        if (
            req.initial_capital > 0
            and aggregate_final > 0
            and cal_days > 0
        ):
            n_years = cal_days / 365.25
            if n_years > 0:
                annualized_return_pct = round(
                    ((aggregate_final / req.initial_capital) ** (1.0 / n_years) - 1.0) * 100.0,
                    2,
                )
        # Sharpe ratio (rf=0), annualised using the equity-curve bar interval.
        if n_bars > 1:
            rets = [
                (values[i] - values[i - 1]) / values[i - 1]
                for i in range(1, n_bars)
                if values[i - 1] > 0
            ]
            if len(rets) > 1:
                mean_r = sum(rets) / len(rets)
                var_r = sum((x - mean_r) ** 2 for x in rets) / (len(rets) - 1)
                std_r = _math.sqrt(var_r)
                if std_r > 0:
                    sharpe_ratio = round((mean_r / std_r) * _math.sqrt(bars_per_year), 2)
                else:
                    sharpe_ratio = 0.0
        # Max drawdown
        peak = values[0]
        worst = 0.0
        for v in values:
            if v > peak:
                peak = v
            if peak > 0:
                dd = (v - peak) / peak
                if dd < worst:
                    worst = dd
        max_drawdown_pct = round(worst * 100.0, 2)

    metrics = {
        "final_value": round(aggregate_final, 2),
        "total_return_pct": round(total_return_pct, 4),
        "annualized_return_pct": annualized_return_pct,
        "sharpe_ratio": sharpe_ratio,
        "max_drawdown_pct": max_drawdown_pct,
        "win_rate_pct": round(win_rate_pct, 2),
        "total_trades": total_trades,
        "symbols_run": sum(1 for r in per_results if not r.get("error") and not r.get("skipped")),
        "symbols_failed": sum(1 for r in per_results if r.get("error")),
    }
    _raise_if_backtest_fully_failed(
        metrics["symbols_run"],
        {str(entry.get("symbol") or ""): entry.get("error") for entry in per_results if entry.get("error")},
        effective_data_source,
    )
    report_symbol = _summarize_report_symbols(symbols)
    aggregated_trades = _flatten_per_symbol_trades(per_symbol_summary)

    # Persist a summary report.
    name = (
        f"SANDBOX_{'sentiment' if req.use_sentiment_routing else 'positions'}"
        f"_{req.start_date}_to_{req.end_date}"
    )
    parameters_payload = {
        "symbols": symbols,
        "data_source": effective_data_source,
        "requested_data_source": requested_data_source,
        "use_sentiment_routing": req.use_sentiment_routing,
        "allocation_mode": req.allocation_mode,
        "pm_settings": pm_settings_snapshot,
        "per_symbol_capital": per_symbol_capital,
    }
    result_data_payload = {
        "equity_curve": equity_curve,
        "trades": aggregated_trades,
        "ohlcv": [],
        "per_symbol": per_symbol_summary,
        "activity_log": _build_sandbox_activity_log(per_symbol_summary),
        "initial_capital": req.initial_capital,
        "per_symbol_capital": per_symbol_capital,
        "use_sentiment_routing": req.use_sentiment_routing,
        "pm_settings": pm_settings_snapshot,
        "verification_warning": verification_info.get("verification_warning"),
        "verification_unverified_symbols": verification_info.get("verification_unverified_symbols") or [],
        "verification_queued_symbols": verification_info.get("verification_queued_symbols") or [],
    }
    data_warning = _build_result_range_warning(per_symbol_summary, req.start_date, req.end_date)
    if data_warning:
        result_data_payload["data_warning"] = data_warning
    report = BacktestReport(
        name=name,
        symbol=report_symbol,
        strategy_type="sandbox_portfolio",
        parameters=parameters_payload,
        start_date=req.start_date,
        end_date=req.end_date,
        initial_capital=req.initial_capital,
        final_value=metrics["final_value"],
        total_return_pct=metrics["total_return_pct"],
        annualized_return_pct=metrics["annualized_return_pct"],
        sharpe_ratio=metrics["sharpe_ratio"],
        max_drawdown_pct=metrics["max_drawdown_pct"],
        win_rate_pct=metrics["win_rate_pct"],
        total_trades=metrics["total_trades"],
        result_data=result_data_payload,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)

    offload_payload = {
        "id": report.id,
        "name": name,
        "symbol": report.symbol,
        "strategy_type": "sandbox_portfolio",
        "start_date": req.start_date,
        "end_date": req.end_date,
        "initial_capital": req.initial_capital,
        "metrics": metrics,
        "result_data": result_data_payload,
        "created_at": report.created_at.isoformat() if report.created_at else None,
    }
    await _offload_report_payload(db, report, offload_payload)

    return {
        "id": report.id,
        "name": name,
        "metrics": metrics,
        "result": {
            "equity_curve": equity_curve,
            "per_symbol": per_symbol_summary,
            "initial_capital": req.initial_capital,
            "per_symbol_capital": per_symbol_capital,
            "pm_settings": parameters_payload["pm_settings"],
            "use_sentiment_routing": req.use_sentiment_routing,
            "activity_log": result_data_payload["activity_log"],
            "verification_warning": result_data_payload.get("verification_warning"),
            "verification_unverified_symbols": result_data_payload.get("verification_unverified_symbols") or [],
            "verification_queued_symbols": result_data_payload.get("verification_queued_symbols") or [],
            "data_warning": result_data_payload.get("data_warning"),
        },
        "verification_warning": result_data_payload.get("verification_warning"),
        "verification_unverified_symbols": result_data_payload.get("verification_unverified_symbols") or [],
        "verification_queued_symbols": result_data_payload.get("verification_queued_symbols") or [],
        "data_warning": result_data_payload.get("data_warning"),
    }


@router.get("/reports")
async def list_reports(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """List saved backtest reports (summary only), paginated."""
    total = await db.scalar(select(func.count()).select_from(BacktestReport))
    total_count = int(total or 0)
    offset = (page - 1) * page_size
    result = await db.execute(
        select(
            BacktestReport.id,
            BacktestReport.name,
            BacktestReport.symbol,
            BacktestReport.strategy_type,
            BacktestReport.start_date,
            BacktestReport.end_date,
            BacktestReport.initial_capital,
            BacktestReport.total_return_pct,
            BacktestReport.sharpe_ratio,
            BacktestReport.max_drawdown_pct,
            BacktestReport.win_rate_pct,
            BacktestReport.total_trades,
            BacktestReport.created_at,
        )
        .order_by(BacktestReport.created_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    reports = result.all()
    return {
        "page": page,
        "page_size": page_size,
        "total_count": total_count,
        "has_next": offset + len(reports) < total_count,
        "has_prev": page > 1,
        "reports": [
            {
                "id": r.id,
                "name": r.name,
                "symbol": r.symbol,
                "strategy_type": r.strategy_type,
                "start_date": r.start_date,
                "end_date": r.end_date,
                "initial_capital": r.initial_capital,
                "total_return_pct": r.total_return_pct,
                "sharpe_ratio": r.sharpe_ratio,
                "max_drawdown_pct": r.max_drawdown_pct,
                "win_rate_pct": r.win_rate_pct,
                "total_trades": r.total_trades,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in reports
        ]
    }


@router.get("/reports/{report_id}")
async def get_report(report_id: int, db: AsyncSession = Depends(get_db)):
    """Get full detail of a backtest report including equity curve and trades."""
    r = await db.get(BacktestReport, report_id)
    if not r:
        raise HTTPException(status_code=404, detail="Report not found.")

    file_data = load_backtest_report(r.id, r.name)
    result_data = file_data.get("result_data") if file_data else (r.result_data or {})
    data_warning = None

    # Opportunistic migration: if old DB rows still hold large JSON blobs, offload now.
    if (not file_data) and r.result_data:
        payload = {
            "id": r.id,
            "name": r.name,
            "symbol": r.symbol,
            "strategy_type": r.strategy_type,
            "start_date": r.start_date,
            "end_date": r.end_date,
            "initial_capital": r.initial_capital,
            "metrics": {
                "final_value": r.final_value,
                "total_return_pct": r.total_return_pct,
                "annualized_return_pct": r.annualized_return_pct,
                "sharpe_ratio": r.sharpe_ratio,
                "max_drawdown_pct": r.max_drawdown_pct,
                "win_rate_pct": r.win_rate_pct,
                "total_trades": r.total_trades,
            },
            "result_data": r.result_data,
            "script_snapshot": r.script_snapshot,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        await _offload_report_payload(db, r, payload)
    elif not result_data:
        data_warning = (
            "Detailed trade/ohlcv payload is unavailable for this historical report. "
            "New scripted backtests now persist traceable local logs."
        )
    elif isinstance(result_data, dict):
        range_warning = _build_result_range_warning(
            result_data.get("per_symbol") or [],
            r.start_date,
            r.end_date,
        )
        if range_warning:
            data_warning = range_warning if not data_warning else f"{data_warning} {range_warning}"

    return {
        "id": r.id,
        "name": r.name,
        "symbol": r.symbol,
        "strategy_type": r.strategy_type,
        "parameters": r.parameters,
        "start_date": r.start_date,
        "end_date": r.end_date,
        "initial_capital": r.initial_capital,
        "metrics": {
            "final_value": r.final_value,
            "total_return_pct": r.total_return_pct,
            "annualized_return_pct": r.annualized_return_pct,
            "sharpe_ratio": r.sharpe_ratio,
            "max_drawdown_pct": r.max_drawdown_pct,
            "win_rate_pct": r.win_rate_pct,
            "total_trades": r.total_trades,
        },
        "result_data": result_data,
        "data_warning": data_warning,
        "trace_log": file_data.get("trace_log") if file_data else None,
        "html_report_path": r.html_report_path,
        "script_snapshot": r.script_snapshot,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.delete("/reports/{report_id}")
async def delete_report(report_id: int, db: AsyncSession = Depends(get_db)):
    r = await db.get(BacktestReport, report_id)
    if not r:
        raise HTTPException(status_code=404, detail="Report not found.")
    await db.delete(r)
    await db.commit()
    return {"status": "deleted", "id": report_id}


# ---------------------------------------------------------------------------
# Local-storage offload / download endpoints
# ---------------------------------------------------------------------------

@router.get("/reports/{report_id}/download")
async def download_report(
    report_id: int,
    fmt: str = "json",
    db: AsyncSession = Depends(get_db),
):
    """Download a backtest report as JSON or CSV (trades only).

    - ``fmt=json``  → full report JSON (metrics + equity curve + trades + OHLCV)
    - ``fmt=csv``   → trades list only as CSV
    """
    r = await db.get(BacktestReport, report_id)
    if not r:
        raise HTTPException(status_code=404, detail="Report not found.")

    # Try local-storage file first; fall back to DB result_data
    file_data = load_backtest_report(r.id, r.name)
    if file_data is None:
        # Build payload from DB columns
        file_data = {
            "id": r.id,
            "name": r.name,
            "symbol": r.symbol,
            "strategy_type": r.strategy_type,
            "start_date": r.start_date,
            "end_date": r.end_date,
            "initial_capital": r.initial_capital,
            "metrics": {
                "final_value": r.final_value,
                "total_return_pct": r.total_return_pct,
                "annualized_return_pct": r.annualized_return_pct,
                "sharpe_ratio": r.sharpe_ratio,
                "max_drawdown_pct": r.max_drawdown_pct,
                "win_rate_pct": r.win_rate_pct,
                "total_trades": r.total_trades,
            },
            "result_data": r.result_data or {},
            "script_snapshot": r.script_snapshot,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }

    safe_name = _safe_filename(r.name)

    if fmt == "csv":
        trades = (file_data.get("result_data") or {}).get("trades", [])
        content = records_to_csv_bytes(trades)
        return Response(
            content=content,
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}_trades.csv"'},
        )

    content = records_to_json_bytes(file_data)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
    )


@router.get("/reports/{report_id}/offload")
async def offload_report_to_storage(report_id: int, db: AsyncSession = Depends(get_db)):
    """Manually save (or re-save) a backtest report to local PC storage."""
    r = await db.get(BacktestReport, report_id)
    if not r:
        raise HTTPException(status_code=404, detail="Report not found.")
    file_data = load_backtest_report(r.id, r.name)
    if file_data is not None:
        payload = file_data
    elif r.result_data:
        payload = {
        "id": r.id,
        "name": r.name,
        "symbol": r.symbol,
        "strategy_type": r.strategy_type,
        "start_date": r.start_date,
        "end_date": r.end_date,
        "initial_capital": r.initial_capital,
        "metrics": {
            "final_value": r.final_value,
            "total_return_pct": r.total_return_pct,
            "annualized_return_pct": r.annualized_return_pct,
            "sharpe_ratio": r.sharpe_ratio,
            "max_drawdown_pct": r.max_drawdown_pct,
            "win_rate_pct": r.win_rate_pct,
            "total_trades": r.total_trades,
        },
        "result_data": r.result_data or {},
        "script_snapshot": r.script_snapshot,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        }
    else:
        raise HTTPException(
            status_code=409,
            detail="No detailed result payload remains for this report.",
        )
    await _offload_report_payload(db, r, payload)
    return {"status": "saved", "path": r.result_data_path}


@router.post("/reports/offload-all")
async def offload_all_reports_to_storage(
    offset: int = Query(default=0, ge=0),
    batch_size: int = Query(default=100, ge=1, le=300),
    db: AsyncSession = Depends(get_db),
):
    """Bulk migrate report payloads to local PC files in bounded batches."""
    total = await db.scalar(select(func.count()).select_from(BacktestReport))
    total_count = int(total or 0)
    result = await db.execute(
        select(BacktestReport)
        .order_by(BacktestReport.id.asc())
        .offset(offset)
        .limit(batch_size)
    )
    reports = result.scalars().all()

    processed = 0
    offloaded = 0
    cleared_db_blobs = 0
    failed = 0
    skipped_missing_detail = 0

    for r in reports:
        processed += 1
        try:
            file_data = load_backtest_report(r.id, r.name)
            if file_data is not None:
                payload = file_data
            elif r.result_data:
                payload = {
                    "id": r.id,
                    "name": r.name,
                    "symbol": r.symbol,
                    "strategy_type": r.strategy_type,
                    "start_date": r.start_date,
                    "end_date": r.end_date,
                    "initial_capital": r.initial_capital,
                    "metrics": {
                        "final_value": r.final_value,
                        "total_return_pct": r.total_return_pct,
                        "annualized_return_pct": r.annualized_return_pct,
                        "sharpe_ratio": r.sharpe_ratio,
                        "max_drawdown_pct": r.max_drawdown_pct,
                        "win_rate_pct": r.win_rate_pct,
                        "total_trades": r.total_trades,
                    },
                    "result_data": r.result_data,
                    "script_snapshot": r.script_snapshot,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
            else:
                skipped_missing_detail += 1
                continue
            saved_path = save_backtest_report(r.id, r.name, payload)
            if r.result_data is not None:
                cleared_db_blobs += 1
            r.result_data_path = saved_path
            r.result_data = None
            offloaded += 1
        except Exception:
            failed += 1
            logger.exception("Failed to bulk-offload backtest report %s", r.id)

    await db.commit()
    next_offset = offset + processed
    has_more = next_offset < total_count

    return {
        "offset": offset,
        "batch_size": batch_size,
        "next_offset": next_offset,
        "has_more": has_more,
        "total_count": total_count,
        "processed": processed,
        "offloaded": offloaded,
        "cleared_db_blobs": cleared_db_blobs,
        "skipped_missing_detail": skipped_missing_detail,
        "failed": failed,
    }


@router.get("/local-storage/files")
async def list_local_report_files():
    """List all backtest report files saved to local PC storage."""
    return {"files": list_backtest_report_files()}
