"""Backtesting endpoints."""
from __future__ import annotations

import asyncio
import copy
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.custom_script import CustomScript
from app.models.report import BacktestReport
from app.services.backtester import run_backtest
from app.services.data_provider import DataSource, list_data_sources
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
            "Options: 'auto' (IB when connected, otherwise Yahoo Finance), "
            "'yfinance' (forced Yahoo), 'stooq' (Stooq.com), 'ib' (forced IB)."
        ),
        example="auto",
    )
    day_trade: bool = Field(
        default=True,
        description=(
            "When True, fetches intraday data (IB: 5s when available; Yahoo: 1m → 2m → 5m) "
            "and scales performance metrics accordingly. "
            "Note: Yahoo Finance limits 1m data to the last 7 days."
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

    # Offload full result data (equity curve, trades, OHLCV) to local storage
    try:
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
            "created_at": report.created_at.isoformat() if report.created_at else None,
        }
        saved_path = save_backtest_report(report.id, name, offload_payload)
        report.result_data_path = saved_path
        await db.commit()
    except Exception:
        logger.exception("Failed to offload backtest report %s to local storage", report.id)

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
    day_trade: bool = Field(default=True)
    symbols: list[str] | None = Field(
        default=None,
        description="Override watchlist; if omitted, uses all sandbox watchlist symbols.",
    )
    use_sentiment_routing: bool = Field(
        default=True,
        description=(
            "When True, run each symbol with sentiment-driven strategy switching using PM's "
            "market_sentiment_strategies map. When False, use the strategy_name assigned to "
            "each sandbox position (falling back to sma_crossover)."
        ),
    )
    allocation_mode: str = Field(
        default="proportional",
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
        default=0.0,
        ge=0.0,
        le=100.0,
        description=(
            "Lower bound of equity earmarked per position, as a percentage of "
            "initial_capital. Default 0 means everything starts in the shared pool. "
            "Only used when use_shared_pool=True."
        ),
    )
    per_position_max_pct: float = Field(
        default=100.0,
        ge=0.0,
        le=200.0,
        description=(
            "Upper bound of equity per position, as a percentage of initial_capital. "
            "0 disables the cap (uncapped). Only used when use_shared_pool=True."
        ),
    )


def _build_sandbox_activity_log(per_symbol: list[dict]) -> list[dict]:
    """Flatten per-symbol trades into a chronological activity log.

    Each completed trade produces a BUY and SELL entry so the log mirrors what
    a trader would see in an order history view.
    """
    events: list[dict] = []
    for entry in per_symbol:
        sym = entry.get("symbol")
        strat = entry.get("strategy")
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

    pm = get_manager_settings()
    sentiment_strategies = dict(pm.get("market_sentiment_strategies") or {
        "crash": "rsi", "bearish": "macd", "neutral": "bollinger_bands",
        "bullish": "sma_crossover", "euphoric": "rsi",
    })
    stop_loss_pct = float(pm.get("stop_loss_pct") or 0.0)
    take_profit_pct = float(pm.get("take_profit_pct") or 0.0)
    hold_overnight = bool(pm.get("hold_positions_overnight", True))
    eod_window = int(pm.get("eod_sell_window_minutes") or 30)
    sentiment_warmup = int(pm.get("sentiment_data_points") or 35)

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
                if kind == "custom" and sid is not None and sid in custom_scripts:
                    fixed_strategy = f"custom:{sid}"
                elif kind == "template" and tfn and tfn in template_filenames:
                    fixed_strategy = f"template:{tfn}"
                else:
                    fixed_strategy = getattr(by_symbol.get(s), "strategy_name", None) or "sma_crossover"
            specs.append({
                "symbol": s,
                "routing": routing,
                "fixed_strategy": fixed_strategy,
                "min_alloc": min_alloc_by_symbol.get(s, 0.0),
                "max_alloc": max_alloc_each,
            })

        try:
            coord = await asyncio.to_thread(
                run_sandbox_portfolio_backtest,
                symbol_specs=specs,
                start_date=req.start_date,
                end_date=req.end_date,
                initial_capital=req.initial_capital,
                commission=req.commission,
                data_source=req.data_source,
                day_trade=req.day_trade,
                sentiment_strategies=sentiment_strategies,
                sentiment_warmup=sentiment_warmup,
                custom_scripts=custom_scripts or None,
                stop_loss_pct=stop_loss_pct,
                take_profit_pct=take_profit_pct,
                hold_positions_overnight=hold_overnight,
                eod_sell_window_minutes=eod_window,
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
            cal_days = 0.0
            try:
                _s = datetime.strptime(req.start_date, "%Y-%m-%d")
                _e = datetime.strptime(req.end_date, "%Y-%m-%d")
                cal_days = max((_e - _s).days, 0)
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
                    sharpe_ratio = round((mean_r / std_r) * _math.sqrt(252.0), 2) if std_r > 0 else 0.0
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

        name = (
            f"SANDBOX_pool_{'sentiment' if req.use_sentiment_routing else 'positions'}"
            f"_{req.start_date}_to_{req.end_date}"
        )
        parameters_payload = {
            "symbols": symbols,
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
            "trades": [],
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
        }
        report = BacktestReport(
            name=name,
            symbol=",".join(symbols)[:20] or "SANDBOX",
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
            },
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
                    data_source=req.data_source,
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
                    data_source=req.data_source,
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
                "strategy": getattr(by_symbol.get(sym), "strategy_name", None),
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
        bars_per_year = 252.0

        # Calendar-day span for CAGR-style annualisation.
        cal_days: float = 0.0
        try:
            _s = datetime.strptime(req.start_date, "%Y-%m-%d")
            _e = datetime.strptime(req.end_date, "%Y-%m-%d")
            cal_days = max((_e - _s).days, 0)
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
        # Sharpe ratio (rf=0), still computed per equity-curve bar (assumed daily).
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

    pm_settings_snapshot = _build_pm_settings_snapshot({
        "stop_loss_pct": stop_loss_pct,
        "take_profit_pct": take_profit_pct,
        "hold_positions_overnight": hold_overnight,
        "eod_sell_window_minutes": eod_window,
        "sentiment_strategies": sentiment_strategies,
        "sentiment_warmup": sentiment_warmup,
    })

    # Persist a summary report.
    name = (
        f"SANDBOX_{'sentiment' if req.use_sentiment_routing else 'positions'}"
        f"_{req.start_date}_to_{req.end_date}"
    )
    parameters_payload = {
        "symbols": symbols,
        "use_sentiment_routing": req.use_sentiment_routing,
        "allocation_mode": req.allocation_mode,
        "pm_settings": pm_settings_snapshot,
        "per_symbol_capital": per_symbol_capital,
    }
    result_data_payload = {
        "equity_curve": equity_curve,
        "trades": [],
        "ohlcv": [],
        "per_symbol": per_symbol_summary,
        "activity_log": _build_sandbox_activity_log(per_symbol_summary),
        "initial_capital": req.initial_capital,
        "per_symbol_capital": per_symbol_capital,
        "use_sentiment_routing": req.use_sentiment_routing,
        "pm_settings": pm_settings_snapshot,
    }
    report = BacktestReport(
        name=name,
        symbol=",".join(symbols)[:20] or "SANDBOX",
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
        },
    }


@router.get("/reports")
async def list_reports(db: AsyncSession = Depends(get_db)):
    """List all saved backtest reports (summary only)."""
    result = await db.execute(
        select(BacktestReport).order_by(BacktestReport.created_at.desc())
    )
    reports = result.scalars().all()
    return {
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
        "result_data": r.result_data,
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
    saved_path = save_backtest_report(r.id, r.name, payload)
    r.result_data_path = saved_path
    await db.commit()
    return {"status": "saved", "path": saved_path}


@router.get("/local-storage/files")
async def list_local_report_files():
    """List all backtest report files saved to local PC storage."""
    return {"files": list_backtest_report_files()}
