"""Backtesting endpoints."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

logger = logging.getLogger(__name__)
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.report import BacktestReport
from app.models.custom_script import CustomScript
from app.services.backtester import run_backtest
from app.services.reporter import generate_html_report
from app.services.strategies import list_strategies
from app.services.data_provider import DataSource, list_data_sources
from app.services.script_executor import validate_script
from app.services.local_storage import (
    save_backtest_report, load_backtest_report, list_backtest_report_files,
    records_to_csv_bytes, records_to_json_bytes, _safe_filename,
)

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
    report = BacktestReport(
        name=name,
        symbol=req.symbol.upper(),
        strategy_type="sentiment_switching",
        parameters={
            "sentiment_strategies": req.sentiment_strategies,
            "sentiment_warmup": req.sentiment_warmup,
            "stop_loss_pct": req.stop_loss_pct,
            "take_profit_pct": req.take_profit_pct,
        },
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
        # Derive merged params the same way script_executor does
        script_defaults = validate_script(script_code).get("default_params", {})
        merged = {**script_defaults}
        merged.update(
            {k: v for k, v in req.strategy_params.items()
             if v is not None and not (isinstance(v, str) and not str(v).strip())}
        )
        params_repr = repr(merged)
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
