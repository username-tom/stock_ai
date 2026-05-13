"""Position / watchlist management endpoints."""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxPosition, SandboxAllocationEvent
from app.config import settings
from app.routers.sandbox_router._helpers import (
    get_account,
    position_dict,
    compute_available_cash,
    ensure_sandbox_write_allowed,
    offload_simulated_state,
)
from app.services.ib_service import ib_service
from app.services.local_storage import save_portfolio_state

router = APIRouter()


@router.get("/positions")
async def get_positions(db: AsyncSession = Depends(get_db)):
    if ib_service.is_connected:
        raw_positions = await ib_service.get_positions()

        async def _ib_to_position(item: dict) -> dict:
            symbol = str(item.get("symbol") or "").upper()
            quantity = float(item.get("quantity") or 0.0)
            avg_cost = float(item.get("avg_cost") or 0.0)
            quote = await ib_service.get_market_data(symbol)
            market_price = avg_cost
            if isinstance(quote, dict) and "error" not in quote:
                market_price = float(quote.get("last") or quote.get("close") or avg_cost or 0.0)
            market_value = quantity * market_price
            unrealized = (market_price - avg_cost) * quantity
            return {
                "id": None,
                "symbol": symbol,
                "allocated_funds": round(max(0.0, market_value), 4),
                "shares": quantity,
                "avg_cost": round(avg_cost, 4),
                "strategy_name": None,
                "strategy_enabled": False,
                "last_signal": None,
                "last_run_at": None,
                "engine_error": None,
                "realized_pnl": 0.0,
                "total_invested": round(max(0.0, avg_cost * quantity), 4),
                "unrealized_pnl": round(unrealized, 4),
                "market_value": round(market_value, 4),
                "is_on_watchlist": True,
                "created_at": None,
                "pending_shares": 0.0,
                "pending_avg_cost": 0.0,
                "pending_since": None,
            }

        filtered = [p for p in raw_positions if abs(float(p.get("quantity") or 0.0)) > 0]
        enriched = await asyncio.gather(*[_ib_to_position(p) for p in filtered], return_exceptions=False)
        enriched.sort(key=lambda p: p["symbol"])

        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        save_portfolio_state(mode, {
            "source": "ib",
            "mode": mode,
            "positions": enriched,
        })
        return {"positions": enriched}

    result = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    positions = result.scalars().all()
    return {"positions": [position_dict(p) for p in positions]}


class AddSymbolRequest(BaseModel):
    symbol: str
    strategy_name: Optional[str] = None
    allocated_funds: float = Field(default=0.0, ge=0)


@router.post("/positions")
async def add_symbol(req: AddSymbolRequest, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
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
        available = await compute_available_cash(db, account, all_pos)
        # Cap allocation to what is actually available — do NOT inflate total_funds
        capped = min(req.allocated_funds, max(0.0, available))
        req = req.model_copy(update={"allocated_funds": capped})
        if capped > 0:
            db.add(SandboxAllocationEvent(
                event_type="allocate",
                from_symbol=None,
                to_symbol=symbol,
                amount=capped,
                note="Initial allocation on add",
            ))

    pos = SandboxPosition(
        symbol=symbol,
        allocated_funds=req.allocated_funds,
        strategy_name=req.strategy_name,
        is_on_watchlist=True,
    )
    db.add(pos)
    await db.commit()
    await db.refresh(pos)
    await offload_simulated_state(db)
    return position_dict(pos)


class UpdatePositionRequest(BaseModel):
    strategy_name: Optional[str] = None
    allocated_funds: Optional[float] = Field(default=None, ge=0)
    strategy_enabled: Optional[bool] = None


@router.patch("/positions/{symbol}")
async def update_position(symbol: str, req: UpdatePositionRequest, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
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
        # Compute available cash treating equity (shares × avg_cost) as committed.
        # Exclude current position's allocation since we are replacing it.
        available = await compute_available_cash(db, account, all_pos) + pos.allocated_funds
        if req.allocated_funds > available:
            raise HTTPException(400, f"Insufficient available funds. Available: ${available:.2f}")
        old_alloc = pos.allocated_funds
        diff = round(req.allocated_funds - old_alloc, 4)
        if diff > 0:
            db.add(SandboxAllocationEvent(
                event_type="allocate",
                from_symbol=None,
                to_symbol=symbol,
                amount=diff,
                note="Manual allocation increase",
            ))
        elif diff < 0:
            db.add(SandboxAllocationEvent(
                event_type="deallocate",
                from_symbol=symbol,
                to_symbol=None,
                amount=abs(diff),
                note="Manual allocation decrease",
            ))
        pos.allocated_funds = req.allocated_funds

    await db.commit()
    await db.refresh(pos)
    await offload_simulated_state(db)
    return position_dict(pos)


@router.delete("/positions/{symbol}")
async def remove_symbol(symbol: str, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, "Position not found.")
    await db.delete(pos)
    await db.commit()
    await offload_simulated_state(db)
    return {"status": "ok", "symbol": symbol}


class BulkStrategyRequest(BaseModel):
    strategy_name: Optional[str] = None


@router.patch("/positions-bulk-strategy")
async def bulk_update_strategy(req: BulkStrategyRequest, db: AsyncSession = Depends(get_db)):
    """Set the same strategy on every existing position at once."""
    ensure_sandbox_write_allowed()
    result = await db.execute(select(SandboxPosition))
    positions = result.scalars().all()
    for pos in positions:
        pos.strategy_name = req.strategy_name
    await db.commit()
    await offload_simulated_state(db)
    return {"updated": len(positions), "strategy_name": req.strategy_name}
