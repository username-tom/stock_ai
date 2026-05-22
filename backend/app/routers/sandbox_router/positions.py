"""Position / watchlist management endpoints."""
from __future__ import annotations

import asyncio
import logging
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
from app.services import market_service
from app.services.ib_service import ib_service
from app.services.local_storage import save_portfolio_state

router = APIRouter()
logger = logging.getLogger(__name__)


def _should_force_engine_off_for_position(pos: SandboxPosition) -> bool:
    from app.services.portfolio_manager import get_manager_settings
    from app.services.sandbox_engine import should_force_engine_off_without_position

    manager_settings = get_manager_settings()
    return should_force_engine_off_without_position(
        shares=pos.shares,
        pending_shares=pos.pending_shares,
        hold_overnight=bool(manager_settings.get("hold_positions_overnight", True)),
        eod_sell_window_minutes=int(manager_settings.get("eod_sell_window_minutes", 30) or 30),
        eod_engine_shutoff_minutes_before_sell=int(
            manager_settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120
        ),
    )


@router.get("/positions")
async def get_positions(db: AsyncSession = Depends(get_db)):
    if ib_service.is_connected:
        from app.models.trade import Trade, TradingMode, OrderStatus

        raw_positions = await ib_service.get_positions()
        ib_filtered = [p for p in raw_positions if abs(float(p.get("quantity") or 0.0)) > 0]
        ib_by_symbol = {
            str(p.get("symbol") or "").upper(): p
            for p in ib_filtered
            if str(p.get("symbol") or "").strip()
        }

        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        trade_mode = TradingMode.LIVE if mode == "live" else TradingMode.PAPER
        pnl_res = await db.execute(
            select(Trade.symbol, Trade.pnl).where(
                Trade.mode == trade_mode,
                Trade.pnl.isnot(None),
                Trade.status != OrderStatus.CANCELLED,
            )
        )
        realized_by_symbol: dict[str, float] = {}
        for sym, pnl in pnl_res.all():
            key = str(sym or "").upper()
            if not key:
                continue
            realized_by_symbol[key] = realized_by_symbol.get(key, 0.0) + float(pnl or 0.0)

        local_rows = (await db.execute(select(SandboxPosition))).scalars().all()
        local_by_symbol = {p.symbol: p for p in local_rows if p.symbol}

        # Ensure owned IB symbols are represented locally so PM/engine metadata
        # can still track them even when they are not on the sidebar watchlist.
        missing_owned = [sym for sym in ib_by_symbol.keys() if sym not in local_by_symbol]
        if missing_owned:
            for sym in missing_owned:
                db.add(SandboxPosition(
                    symbol=sym,
                    allocated_funds=0.0,
                    strategy_name=None,
                    is_on_watchlist=False,
                ))
            await db.commit()
            local_rows = (await db.execute(select(SandboxPosition))).scalars().all()
            local_by_symbol = {p.symbol: p for p in local_rows if p.symbol}

        async def _to_position(symbol: str, ib_item: dict | None) -> dict:
            local = local_by_symbol.get(symbol)

            quantity = float((ib_item or {}).get("quantity") or 0.0)
            avg_cost = float((ib_item or {}).get("avg_cost") or 0.0)
            market_price = avg_cost
            if ib_item is not None:
                ib_market_price = float((ib_item or {}).get("market_price") or (ib_item or {}).get("last_price") or 0.0)
                ib_market_value = float((ib_item or {}).get("market_value") or 0.0)
                if ib_market_price > 0:
                    market_price = ib_market_price
                elif quantity != 0 and ib_market_value != 0:
                    market_price = abs(ib_market_value / quantity)

                try:
                    quote = await market_service.get_quote(symbol, source_preference="ib")
                    if isinstance(quote, dict) and "error" not in quote:
                        market_price = float(
                            quote.get("last_price")
                            or quote.get("last")
                            or quote.get("close")
                            or market_price
                            or avg_cost
                            or 0.0
                        )
                except Exception as exc:
                    # Avoid failing /sandbox/positions when IB quote service has gaps.
                    logger.warning("IB quote unavailable for %s in positions endpoint: %s", symbol, exc)

            market_value = quantity * market_price
            unrealized = (market_price - avg_cost) * quantity
            local_created_at = local.created_at.astimezone().isoformat() if local and local.created_at else None

            return {
                "id": local.id if local else None,
                "symbol": symbol,
                "allocated_funds": round(max(0.0, market_value), 4),
                "shares": quantity,
                "avg_cost": round(avg_cost, 4),
                "market_price": round(market_price, 4),
                "last_price": round(market_price, 4),
                "strategy_name": local.strategy_name if local else None,
                "strategy_enabled": bool(local.strategy_enabled) if local else False,
                "pm_managed": bool(local.pm_managed) if local else False,
                "last_signal": local.last_signal if local else None,
                "last_run_at": local.last_run_at.isoformat() if local and local.last_run_at else None,
                "engine_error": local.engine_error if local else None,
                "realized_pnl": round(
                    float(realized_by_symbol.get(symbol, 0.0)),
                    4,
                ),
                "total_invested": round(max(0.0, avg_cost * quantity), 4),
                "unrealized_pnl": round(unrealized, 4),
                "market_value": round(market_value, 4),
                "max_allocation_mode": (local.max_allocation_mode if local and local.max_allocation_mode else "dollar"),
                "max_allocation_value": (local.max_allocation_value if local else None),
                "sentiment_mode": (local.sentiment_mode if local else None),
                "is_on_watchlist": bool(local.is_on_watchlist) if local else True,
                "created_at": local_created_at,
                "pending_shares": float(local.pending_shares or 0.0) if local else 0.0,
                "pending_avg_cost": float(local.pending_avg_cost or 0.0) if local else 0.0,
                "pending_since": local.pending_since.isoformat() if local and local.pending_since else None,
            }

        watched_local_symbols = {
            p.symbol for p in local_rows if p.symbol and bool(getattr(p, "is_on_watchlist", True))
        }
        symbols = sorted(watched_local_symbols | set(ib_by_symbol.keys()))
        enriched = await asyncio.gather(
            *[_to_position(symbol, ib_by_symbol.get(symbol)) for symbol in symbols],
            return_exceptions=False,
        )
        enriched.sort(key=lambda p: p["symbol"])

        try:
            from app.services.stock_learner import classify_symbols
            insights = await classify_symbols(list({p["symbol"] for p in enriched}))
        except Exception:
            insights = {}
        enriched = [{**p, **insights.get(p["symbol"], {})} for p in enriched]

        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        save_portfolio_state(mode, {
            "source": "ib",
            "mode": mode,
            "positions": enriched,
        })
        return {"positions": enriched}

    result = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    positions = result.scalars().all()
    pos_dicts = [position_dict(p) for p in positions]
    try:
        from app.services.stock_learner import classify_symbols
        insights = await classify_symbols([p["symbol"] for p in pos_dicts])
    except Exception:
        insights = {}
    return {"positions": [{**p, **insights.get(p["symbol"], {})} for p in pos_dicts]}


class AddSymbolRequest(BaseModel):
    symbol: str
    strategy_name: Optional[str] = None
    allocated_funds: float = Field(default=0.0, ge=0)


@router.post("/positions")
async def add_symbol(req: AddSymbolRequest, db: AsyncSession = Depends(get_db)):
    if ib_service.is_connected:
        # In IB mode we only allow metadata rows (strategy/watchlist), not funding edits.
        if req.allocated_funds > 0:
            raise HTTPException(
                status_code=409,
                detail="Allocated funds cannot be changed while IB is connected.",
            )
        ensure_sandbox_write_allowed(allow_while_ib=True)
    else:
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
    max_allocation_mode: Optional[str] = Field(default=None, pattern=r'^(dollar|percent)$')
    max_allocation_value: Optional[float] = Field(default=None, ge=0)
    sentiment_mode: Optional[str] = Field(default=None, pattern=r'^(market|symbol|none)$')


@router.patch("/positions/{symbol}")
async def update_position(symbol: str, req: UpdatePositionRequest, db: AsyncSession = Depends(get_db)):
    if ib_service.is_connected:
        # Allow strategy/sentiment/engine metadata updates in IB mode, but block
        # capital/allocation mutations that should remain simulated-only.
        forbidden = any(
            field in req.model_fields_set
            for field in ("allocated_funds",)
        )
        if forbidden:
            raise HTTPException(
                status_code=409,
                detail="Allocated funds cannot be changed while IB is connected.",
            )
        ensure_sandbox_write_allowed(allow_while_ib=True)
    else:
        ensure_sandbox_write_allowed()
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        if ib_service.is_connected:
            # Allow assigning strategy metadata to IB watchlist symbols that do
            # not yet exist in the local sandbox table.
            pos = SandboxPosition(
                symbol=symbol,
                allocated_funds=0.0,
                strategy_name=None,
                is_on_watchlist=True,
            )
            db.add(pos)
            await db.flush()
        else:
            raise HTTPException(404, f"Position {symbol} not found.")

    sentiment_mode_changed = False
    strategy_name_provided = "strategy_name" in req.model_fields_set
    sentiment_mode_provided = "sentiment_mode" in req.model_fields_set

    if strategy_name_provided:
        pos.strategy_name = req.strategy_name
        # Manual strategy edits should take precedence over PM sentiment routing.
        # Clear routing unless the caller explicitly sets sentiment_mode as part
        # of the same request.
        if not sentiment_mode_provided and pos.sentiment_mode is not None:
            pos.sentiment_mode = None
            sentiment_mode_changed = True
    if req.strategy_enabled is not None:
        pos.strategy_enabled = req.strategy_enabled
        if pos.strategy_enabled and _should_force_engine_off_for_position(pos):
            pos.strategy_enabled = False
    if req.max_allocation_mode is not None:
        pos.max_allocation_mode = req.max_allocation_mode
    if req.max_allocation_value is not None:
        pos.max_allocation_value = req.max_allocation_value
    if sentiment_mode_provided:
        pos.sentiment_mode = None if req.sentiment_mode in (None, 'none') else req.sentiment_mode
        sentiment_mode_changed = True

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
    
    # Refresh sentiment routing if sentiment_mode changed
    if sentiment_mode_changed:
        from app.services.portfolio_manager import refresh_sentiment_routing
        asyncio.create_task(refresh_sentiment_routing())
    
    return position_dict(pos)


@router.delete("/positions/{symbol}")
async def remove_symbol(symbol: str, db: AsyncSession = Depends(get_db)):
    if ib_service.is_connected:
        ensure_sandbox_write_allowed(allow_while_ib=True)
    else:
        ensure_sandbox_write_allowed()
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, "Position not found.")

    if ib_service.is_connected:
        # In IB mode this is a watchlist removal, not a hard delete.
        # Return any idle allocation back to the unallocated pool.
        settled_cost = float(pos.shares or 0.0) * float(pos.avg_cost or 0.0)
        pending_cost = float(pos.pending_shares or 0.0) * float(pos.pending_avg_cost or 0.0)
        committed_cost = settled_cost + pending_cost
        releasable = max(0.0, float(pos.allocated_funds or 0.0) - committed_cost)
        if releasable > 0:
            pos.allocated_funds = round(float(pos.allocated_funds or 0.0) - releasable, 4)
            db.add(SandboxAllocationEvent(
                event_type="deallocate",
                from_symbol=symbol,
                to_symbol=None,
                amount=round(releasable, 4),
                note="IB watchlist removal: return idle allocation to pool",
            ))
        pos.is_on_watchlist = False
    else:
        await db.delete(pos)

    await db.commit()
    await offload_simulated_state(db)
    return {
        "status": "ok",
        "symbol": symbol,
        "watchlist_removed": bool(ib_service.is_connected),
    }


class BulkStrategyRequest(BaseModel):
    strategy_name: Optional[str] = None


class BulkAllocationCapRequest(BaseModel):
    max_allocation_mode: str = Field(..., pattern=r'^(dollar|percent)$')
    max_allocation_value: float = Field(..., ge=0)


@router.patch("/positions-bulk-strategy")
async def bulk_update_strategy(req: BulkStrategyRequest, db: AsyncSession = Depends(get_db)):
    """Set the same strategy on every existing position at once."""
    ensure_sandbox_write_allowed(allow_while_ib=True)
    result = await db.execute(select(SandboxPosition))
    positions = result.scalars().all()
    sentiment_mode_changed = False
    for pos in positions:
        pos.strategy_name = req.strategy_name
        if pos.sentiment_mode is not None:
            pos.sentiment_mode = None
            sentiment_mode_changed = True
    await db.commit()
    await offload_simulated_state(db)

    if sentiment_mode_changed:
        from app.services.portfolio_manager import refresh_sentiment_routing
        asyncio.create_task(refresh_sentiment_routing())

    return {"updated": len(positions), "strategy_name": req.strategy_name}


@router.patch("/positions-bulk-allocation-cap")
async def bulk_update_allocation_cap(req: BulkAllocationCapRequest, db: AsyncSession = Depends(get_db)):
    """Set the same max allocation cap on every existing position at once."""
    ensure_sandbox_write_allowed(allow_while_ib=True)
    result = await db.execute(select(SandboxPosition))
    positions = result.scalars().all()

    for pos in positions:
        pos.max_allocation_mode = req.max_allocation_mode
        pos.max_allocation_value = req.max_allocation_value

    await db.commit()
    await offload_simulated_state(db)
    return {
        "updated": len(positions),
        "max_allocation_mode": req.max_allocation_mode,
        "max_allocation_value": req.max_allocation_value,
    }
