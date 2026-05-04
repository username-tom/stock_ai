"""Engine toggle and IB mode endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional

from app.database import get_db
from app.models.sandbox import SandboxPosition
from app.routers.sandbox_router._helpers import position_dict

router = APIRouter()


@router.get("/engine/state")
async def engine_state():
    from app.services.sandbox_engine import get_engine_state
    return get_engine_state()


@router.post("/engine/toggle-all")
async def engine_toggle_all(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.strategy_name.isnot(None)))
    positions = result.scalars().all()
    if not positions:
        raise HTTPException(400, "No positions with a strategy assigned.")
    any_stopped = any(not p.strategy_enabled for p in positions)
    for pos in positions:
        pos.strategy_enabled = any_stopped
    await db.commit()
    return {"enabled": any_stopped, "count": len(positions)}


@router.post("/engine/toggle/{symbol}")
async def engine_toggle(symbol: str, db: AsyncSession = Depends(get_db)):
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
    deploy_available_funds: Optional[bool] = None
    deploy_target: Optional[str] = Field(default=None, pattern="^(most_bearish|most_bullish|most_held|least_held|specific)$")
    deploy_target_symbol: Optional[str] = None
    reallocation_enabled: Optional[bool] = None
    reallocation_mode: Optional[str] = Field(default=None, pattern="^(to_stock|to_available)$")


@router.get("/manager/state")
async def get_manager_state():
    from app.services.portfolio_manager import get_manager_state
    return get_manager_state()


@router.patch("/manager/settings")
async def update_manager_settings(req: PortfolioManagerSettingsRequest):
    from app.services.portfolio_manager import update_manager_settings
    payload = {k: v for k, v in req.model_dump().items() if v is not None}
    return update_manager_settings(payload)


@router.post("/manager/toggle")
async def toggle_manager():
    from app.services.portfolio_manager import get_manager_settings, update_manager_settings
    current = get_manager_settings()
    return update_manager_settings({"enabled": not current["enabled"]})
