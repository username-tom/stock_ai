"""Engine toggle and IB mode endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional

from app.database import get_db
from app.models.sandbox import SandboxPosition
from app.routers.sandbox_router._helpers import position_dict, ensure_sandbox_write_allowed, offload_simulated_state

router = APIRouter()


@router.get("/engine/state")
async def engine_state():
    from app.services.sandbox_engine import get_engine_state
    return get_engine_state()


@router.post("/engine/toggle-all")
async def engine_toggle_all(db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.strategy_name.isnot(None)))
    positions = result.scalars().all()
    if not positions:
        raise HTTPException(400, "No positions with a strategy assigned.")
    any_stopped = any(not p.strategy_enabled for p in positions)
    for pos in positions:
        pos.strategy_enabled = any_stopped
    await db.commit()
    await offload_simulated_state(db)
    return {"enabled": any_stopped, "count": len(positions)}


@router.post("/engine/toggle/{symbol}")
async def engine_toggle(symbol: str, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, f"Position {symbol} not found.")
    if not pos.strategy_name:
        raise HTTPException(400, "Assign a strategy before enabling the engine.")
    pos.strategy_enabled = not pos.strategy_enabled
    await db.commit()
    await db.refresh(pos)
    await offload_simulated_state(db)
    return position_dict(pos)


class IBModeRequest(BaseModel):
    mode: str = Field(..., pattern="^(paper|live)$")


@router.post("/ib-mode")
async def set_ib_mode(req: IBModeRequest):
    from app.config import settings
    settings.TRADING_MODE = req.mode
    return {"mode": settings.TRADING_MODE}


@router.get("/ib-mode")
async def get_ib_mode():
    from app.config import settings
    return {"mode": settings.TRADING_MODE}


class PortfolioManagerSettingsRequest(BaseModel):
    enabled: Optional[bool] = None
    transfer_pct: Optional[float] = Field(default=None, ge=0.01, le=1.0)
    transfer_interval_s: Optional[int] = Field(default=None, ge=30)
    indicator_interval_s: Optional[int] = Field(default=None, ge=30)
    min_position_funds: Optional[float] = Field(default=None, ge=0)
    min_position_funds_mode: Optional[str] = Field(default=None, pattern="^(dollar|percent)$")
    min_position_funds_pct: Optional[float] = Field(default=None, ge=0, le=100)
    deploy_available_funds: Optional[bool] = None
    deploy_target: Optional[str] = Field(default=None, pattern="^(most_bearish|most_bullish|most_held|least_held|specific)$")
    deploy_target_symbol: Optional[str] = None
    reallocation_enabled: Optional[bool] = None
    reallocation_mode: Optional[str] = Field(default=None, pattern="^(to_stock|to_available)$")
    allow_buy_outside_allocation: Optional[bool] = None
    market_sentiment_strategies: Optional[dict[str, str]] = None
    symbol_sentiment_strategies: Optional[dict[str, str]] = None
    sentiment_strategy_enabled: Optional[bool] = None
    stop_loss_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    take_profit_pct: Optional[float] = Field(default=None, ge=0.0, le=1000.0)
    hold_positions_overnight: Optional[bool] = None
    eod_engine_shutoff_minutes_before_sell: Optional[int] = Field(default=None, ge=1, le=480)
    eod_sell_window_minutes: Optional[int] = Field(default=None, ge=1, le=240)
    sentiment_lookback_days: Optional[int] = Field(default=None, ge=1, le=30)
    sentiment_data_points: Optional[int] = Field(default=None, ge=10, le=5000)
    sentiment_interval: Optional[str] = None


@router.get("/manager/state")
async def get_manager_state():
    from app.services.portfolio_manager import get_manager_state
    return get_manager_state()


@router.patch("/manager/settings")
async def update_manager_settings(req: PortfolioManagerSettingsRequest):
    ensure_sandbox_write_allowed()
    from app.services.portfolio_manager import update_manager_settings
    payload = {k: v for k, v in req.model_dump().items() if v is not None}
    return update_manager_settings(payload)


@router.post("/manager/toggle")
async def toggle_manager():
    ensure_sandbox_write_allowed()
    from app.services.portfolio_manager import get_manager_settings, update_manager_settings
    current = get_manager_settings()
    return update_manager_settings({"enabled": not current["enabled"]})
