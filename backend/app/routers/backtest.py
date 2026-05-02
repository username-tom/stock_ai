"""Backtesting endpoints."""
from __future__ import annotations

import asyncio
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.report import BacktestReport
from app.models.custom_script import CustomScript
from app.services.backtester import run_backtest
from app.services.reporter import generate_html_report
from app.services.strategies import list_strategies

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


class BacktestRequest(BaseModel):
    symbol: str = Field(..., example="AAPL")
    strategy_type: str = Field(default="sma_crossover", example="sma_crossover")
    script_id: int | None = Field(
        default=None,
        description="ID of a saved custom script to use instead of a built-in strategy.",
    )
    start_date: str = Field(..., example="2022-01-01")
    end_date: str = Field(..., example="2023-12-31")
    initial_capital: float = Field(default=10000.0, ge=1000)
    commission: float = Field(default=0.001, ge=0, le=0.05)
    strategy_params: dict = Field(default_factory=dict)


@router.get("/strategies")
async def get_strategies():
    """List all available strategies with their default parameters."""
    return {"strategies": list_strategies()}


@router.post("/run")
async def run_backtest_endpoint(
    req: BacktestRequest,
    db: AsyncSession = Depends(get_db),
):
    """Run a backtest and persist the report.

    Supply either a ``strategy_type`` (built-in) or a ``script_id`` (custom
    Python script).  When ``script_id`` is given it takes precedence and the
    strategy type is recorded as ``custom_script``.
    """
    script_code: str | None = None
    effective_strategy_type = req.strategy_type

    if req.script_id is not None:
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
            **req.strategy_params,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Backtest error: {exc}")

    m = result["metrics"]
    if req.script_id is not None:
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
        result_data={
            "equity_curve": result["equity_curve"],
            "trades": result["trades"],
            "ohlcv": result["ohlcv"],
        },
        html_report_path=html_path,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)

    return {"id": report.id, "name": name, "metrics": m, "result": result}


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
