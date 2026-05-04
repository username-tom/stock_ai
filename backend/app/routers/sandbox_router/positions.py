"""Position / watchlist management endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxPosition
from app.routers.sandbox_router._helpers import get_account, position_dict

router = APIRouter()


@router.get("/positions")
async def get_positions(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    positions = result.scalars().all()
    return {"positions": [position_dict(p) for p in positions]}


class AddSymbolRequest(BaseModel):
    symbol: str
    strategy_name: Optional[str] = None
    allocated_funds: float = Field(default=0.0, ge=0)


@router.post("/positions")
async def add_symbol(req: AddSymbolRequest, db: AsyncSession = Depends(get_db)):
    symbol = req.symbol.upper().strip()
    existing = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = existing.scalar_one_or_none()
    if pos:
        pos.is_on_watchlist = True
        if req.strategy_name:
            pos.strategy_name = req.strategy_name
        await db.commit()
        await db.refresh(pos)
        return position_dict(pos)

    if req.allocated_funds > 0:
        account = await get_account(db)
        all_pos = (await db.execute(select(SandboxPosition))).scalars().all()
        available = account.total_funds - sum(p.allocated_funds for p in all_pos)
        if req.allocated_funds > available:
            account.total_funds += req.allocated_funds - available

    pos = SandboxPosition(
        symbol=symbol,
        allocated_funds=req.allocated_funds,
        strategy_name=req.strategy_name,
        is_on_watchlist=True,
    )
    db.add(pos)
    await db.commit()
    await db.refresh(pos)
    return position_dict(pos)


class UpdatePositionRequest(BaseModel):
    strategy_name: Optional[str] = None
    allocated_funds: Optional[float] = Field(default=None, ge=0)
    strategy_enabled: Optional[bool] = None


@router.patch("/positions/{symbol}")
async def update_position(symbol: str, req: UpdatePositionRequest, db: AsyncSession = Depends(get_db)):
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, f"Position {symbol} not found.")

    if req.strategy_name is not None:
        pos.strategy_name = req.strategy_name
    if req.strategy_enabled is not None:
        pos.strategy_enabled = req.strategy_enabled

    if req.allocated_funds is not None:
        account = await get_account(db)
        all_pos = (await db.execute(select(SandboxPosition))).scalars().all()
        available = account.total_funds - sum(p.allocated_funds for p in all_pos if p.id != pos.id)
        if req.allocated_funds > available:
            account.total_funds += req.allocated_funds - available
        pos.allocated_funds = req.allocated_funds

    await db.commit()
    await db.refresh(pos)
    return position_dict(pos)


@router.delete("/positions/{symbol}")
async def remove_symbol(symbol: str, db: AsyncSession = Depends(get_db)):
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, "Position not found.")
    await db.delete(pos)
    await db.commit()
    return {"status": "ok", "symbol": symbol}
