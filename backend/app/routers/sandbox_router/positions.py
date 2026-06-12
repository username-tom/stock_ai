"""Position / watchlist management endpoints."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxPosition, SandboxAllocationEvent
from app.config import settings
from app.routers.sandbox_router._helpers import (
    get_account,
    fetch_ib_market_prices,
    position_dict,
    compute_available_cash,
    ensure_sandbox_write_allowed,
    offload_simulated_state,
)
from app.services.ib_service import ib_service
from app.services.local_storage import save_portfolio_state

router = APIRouter()
logger = logging.getLogger(__name__)


def _fallback_ai_insights(symbols: list[str]) -> dict[str, dict]:
    """Use PM-cached AI tags when live classification is slow/unavailable."""
    try:
        from app.services.portfolio_manager import get_manager_state

        ai_tags = (get_manager_state() or {}).get("ai_tags", {})
        out: dict[str, dict] = {}
        for symbol in symbols:
            info = ai_tags.get(symbol) or ai_tags.get(symbol.upper()) or {}
            if not isinstance(info, dict):
                continue
            out[symbol] = {
                "learner_tag": info.get("learner_tag", "WATCH"),
                "learner_direction": info.get("learner_direction", "neutral"),
                "learner_confidence": float(info.get("learner_confidence", 0.0) or 0.0),
                "learner_model": "portfolio_manager_cache",
            }
        return out
    except Exception:
        return {}


async def _load_ai_insights(symbols: list[str]) -> dict[str, dict]:
    requested = [str(s or "").upper().strip() for s in symbols if str(s or "").strip()]
    if not requested:
        return {}
    unique_symbols = list(dict.fromkeys(requested))
    try:
        from app.services.stock_learner import classify_symbols
        from app.services.portfolio_manager import get_manager_settings, get_manager_state

        manager_settings = get_manager_settings()
        matrix_mode = bool(
            manager_settings.get("sentiment_strategy_enabled", True)
            and manager_settings.get("ai_tag_strategy_enabled", False)
            and manager_settings.get("ai_sentiment_change_enabled", True)
        )
        if matrix_mode:
            pm_ai_tags = (get_manager_state() or {}).get("ai_tags", {})
            out: dict[str, dict] = {}
            for symbol in unique_symbols:
                info = pm_ai_tags.get(symbol) or pm_ai_tags.get(symbol.upper()) or {}
                out[symbol] = {
                    "learner_tag": info.get("learner_tag", "WATCH"),
                    "learner_direction": info.get("learner_direction", "neutral"),
                    "learner_confidence": float(info.get("learner_confidence", 0.0) or 0.0),
                    "learner_model": "portfolio_manager_cache",
                }
            return out

        ext_w = float(manager_settings.get("ai_external_sentiment_weight", 0.0) or 0.0)
        return await asyncio.wait_for(
            classify_symbols(unique_symbols, external_sentiment_weight=ext_w),
            timeout=2.0,
        )
    except Exception as exc:
        logger.debug("positions insight classification fallback: %s", exc)
        return _fallback_ai_insights(unique_symbols)


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
async def get_positions(
    profile: Optional[str] = Query(default=None, pattern=r"^(simulated|paper|live)$"),
    db: AsyncSession = Depends(get_db),
):
    requested_profile = (profile or (settings.TRADING_MODE if ib_service.is_connected else "simulated") or "simulated").lower()
    use_ib = requested_profile in {"paper", "live"} and ib_service.is_connected

    if use_ib:
        from app.models.trade import Trade, TradingMode, OrderStatus

        raw_positions = await ib_service.get_positions()
        ib_filtered = [p for p in raw_positions if abs(float(p.get("quantity") or 0.0)) > 0]
        ib_by_symbol = {
            str(p.get("symbol") or "").upper(): p
            for p in ib_filtered
            if str(p.get("symbol") or "").strip()
        }
        market_price_by_symbol = await fetch_ib_market_prices(list(ib_by_symbol.keys()))
        # IB's own per-position PnL (value + unrealized via reqPnLSingle). These
        # sum exactly to the account-level UnrealizedPnL/GrossPositionValue, so
        # the breakdown rows and footer match IB instead of drifting from the
        # separate quote feed.
        try:
            ib_pnl_by_symbol = await ib_service.get_positions_pnl()
        except Exception:
            ib_pnl_by_symbol = {}

        mode = requested_profile if requested_profile in {"paper", "live"} else "paper"
        trade_mode = TradingMode.LIVE if mode == "live" else TradingMode.PAPER
        # Backfill missing SELL pnl from IB's per-execution realized PnL so the
        # per-symbol REALISED GAIN column matches IB (and the overview totals).
        try:
            from app.routers.sandbox_router._helpers import reconcile_ib_realized_pnl
            await reconcile_ib_realized_pnl(db, trade_mode)
        except Exception:
            pass
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
            market_price = float(market_price_by_symbol.get(symbol, 0.0) or 0.0)
            if ib_item is not None:
                ib_market_price = float((ib_item or {}).get("market_price") or (ib_item or {}).get("last_price") or 0.0)
                if market_price <= 0 and ib_market_price > 0:
                    market_price = ib_market_price

            # Prefer IB's authoritative per-position PnL (reqPnLSingle): value
            # and unrealized use IB marks/cost basis and reconcile to the
            # account totals. Fall back to the quote-derived estimate only when
            # IB has not reported a single-position PnL yet.
            ib_single = ib_pnl_by_symbol.get(symbol) or {}
            ib_single_unreal = ib_single.get("unrealized_pnl")
            ib_single_value = ib_single.get("market_value")
            ib_single_mp = ib_single.get("market_price")
            if ib_single_mp is not None and ib_single_mp > 0:
                market_price = float(ib_single_mp)

            has_market_price = market_price > 0
            if ib_single_value is not None:
                market_value = float(ib_single_value)
            else:
                market_value = (quantity * market_price) if has_market_price else None
            if ib_single_unreal is not None:
                unrealized = float(ib_single_unreal)
            else:
                unrealized = ((market_price - avg_cost) * quantity) if has_market_price else None
            local_created_at = local.created_at.astimezone().isoformat() if local and local.created_at else None

            return {
                "id": local.id if local else None,
                "symbol": symbol,
                "allocated_funds": round(max(0.0, float(market_value)), 4) if market_value is not None else 0.0,
                "shares": quantity,
                "avg_cost": round(avg_cost, 4),
                "market_price": round(market_price, 4) if has_market_price else None,
                "last_price": round(market_price, 4) if has_market_price else None,
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
                "unrealized_pnl": round(unrealized, 4) if unrealized is not None else None,
                "market_value": round(market_value, 4) if market_value is not None else None,
                "max_allocation_mode": (local.max_allocation_mode if local and local.max_allocation_mode else "dollar"),
                "max_allocation_value": (local.max_allocation_value if local else None),
                "sentiment_mode": (local.sentiment_mode if local else None),
                "is_on_watchlist": bool(local.is_on_watchlist) if local else True,
                "created_at": local_created_at,
                "pending_shares": float(local.pending_shares or 0.0) if local else 0.0,
                "pending_avg_cost": float(local.pending_avg_cost or 0.0) if local else 0.0,
                "pending_since": local.pending_since.isoformat() if local and local.pending_since else None,
                "pending_reroll_active": False,
                "pending_reroll_side": None,
                "pending_reroll_attempts": 0,
                "pending_reroll_in_range": None,
                "pending_reroll_last_result": None,
                "pending_reroll_last_at": None,
            }

        owned_ib_symbols = set(ib_by_symbol.keys())
        watched_local_symbols = {
            p.symbol for p in local_rows if p.symbol and bool(getattr(p, "is_on_watchlist", True))
        }
        hidden_local_symbols = {
            p.symbol for p in local_rows if p.symbol and not bool(getattr(p, "is_on_watchlist", True))
        }
        # Always surface positions that are actually owned in IB (e.g. a symbol
        # removed from the watchlist while still holding shares). Only hide
        # off-watchlist rows that hold no shares (leftover metadata).
        symbols = sorted(
            (watched_local_symbols | owned_ib_symbols)
            - (hidden_local_symbols - owned_ib_symbols)
        )
        enriched = await asyncio.gather(
            *[_to_position(symbol, ib_by_symbol.get(symbol)) for symbol in symbols],
            return_exceptions=False,
        )
        enriched.sort(key=lambda p: p["symbol"])

        insights = await _load_ai_insights([p["symbol"] for p in enriched])
        enriched = [{**p, **insights.get(p["symbol"], {})} for p in enriched]

        mode = requested_profile if requested_profile in {"paper", "live"} else "paper"
        save_portfolio_state(mode, {
            "source": "ib",
            "mode": mode,
            "positions": enriched,
        })
        return {"positions": enriched}

    result = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    # Mirror watchlist removals across modes: hide off-watchlist rows that hold
    # no shares/pending (e.g. removed while connected to IB), but always keep
    # rows that still hold shares so liquidations remain visible.
    positions = [
        p for p in result.scalars().all()
        if bool(getattr(p, "is_on_watchlist", True))
        or float(p.shares or 0.0) > 0
        or float(p.pending_shares or 0.0) > 0
    ]
    pos_dicts = [position_dict(p) for p in positions]
    insights = await _load_ai_insights([p["symbol"] for p in pos_dicts])
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
async def remove_symbol(
    symbol: str,
    profile: Optional[str] = Query(default=None, pattern=r"^(simulated|paper|live)$"),
    db: AsyncSession = Depends(get_db),
):
    requested_profile = (profile or (settings.TRADING_MODE if ib_service.is_connected else "simulated") or "simulated").lower()
    use_ib = requested_profile in {"paper", "live"} and ib_service.is_connected
    # Removing a position (and liquidating any held shares) is always permitted,
    # even while IB is connected — including simulated-only leftovers viewed via
    # the SIM tab. This keeps the sim/IB watchlist in sync from either mode.
    ensure_sandbox_write_allowed(allow_while_ib=True)
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, "Position not found.")

    liquidated = None

    if use_ib:
        # In IB mode this is a watchlist removal. If shares are still held in IB,
        # place a market SELL to liquidate them before removing from the watchlist.
        liquidated = await _liquidate_ib_position(symbol, requested_profile, db)

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
        pos.strategy_enabled = False
        pos.pm_managed = False
        pos.sentiment_mode = None
    else:
        # Simulated mode: liquidate any held shares (record a SELL trade and
        # book realized PnL) before hard-deleting the row.
        liquidated = await _liquidate_simulated_position(pos, db)
        await db.delete(pos)

    await db.commit()
    await offload_simulated_state(db)
    return {
        "status": "ok",
        "symbol": symbol,
        "watchlist_removed": bool(use_ib),
        "liquidated": liquidated,
    }


async def _liquidate_simulated_position(pos: SandboxPosition, db: AsyncSession) -> Optional[dict]:
    """Sell all settled shares of a simulated position at market and book PnL.

    Returns a summary dict of the executed SELL, or ``None`` when nothing was held.
    """
    from app.models.sandbox import SandboxTrade, SandboxAccount

    qty = float(pos.shares or 0.0)
    if qty <= 0:
        return None

    avg_cost = float(pos.avg_cost or 0.0)
    price = await _resolve_simulated_exit_price(pos.symbol)
    if price is None or price <= 0:
        # No live quote available — fall back to cost basis so the position is
        # closed flat rather than silently discarded.
        price = avg_cost

    total = round(qty * price, 4)
    pnl = round((price - avg_cost) * qty, 4)

    pos.shares = 0.0
    pos.allocated_funds = round(float(pos.allocated_funds or 0.0) + total, 4)
    pos.realized_pnl = round(float(pos.realized_pnl or 0.0) + pnl, 4)
    pos.avg_cost = 0.0

    account_res = await db.execute(select(SandboxAccount).limit(1))
    account = account_res.scalar_one_or_none()
    if account is not None:
        account.total_funds = round(float(account.total_funds or 0.0) + pnl, 4)

    db.add(SandboxTrade(
        symbol=pos.symbol,
        side="SELL",
        quantity=qty,
        price=price,
        total=total,
        strategy_name=pos.strategy_name,
        reason="Watchlist removal: liquidate held shares",
        pnl=pnl,
    ))
    return {"side": "SELL", "quantity": qty, "price": round(price, 4), "pnl": pnl}


async def _resolve_simulated_exit_price(symbol: str) -> Optional[float]:
    """Best-effort current market price for a simulated liquidation."""
    try:
        from app.services import market_service

        quote = await market_service.get_quote(symbol)
        if isinstance(quote, dict):
            for key in ("last_price", "last", "price", "close"):
                candidate = quote.get(key)
                if candidate is None:
                    continue
                try:
                    value = float(candidate)
                except (TypeError, ValueError):
                    continue
                if value > 0:
                    return value
    except Exception as exc:
        logger.debug("Simulated exit price lookup failed for %s: %s", symbol, exc)
    return None


async def _liquidate_ib_position(
    symbol: str, requested_profile: str, db: AsyncSession
) -> Optional[dict]:
    """Place a market SELL for any IB-held shares of *symbol* and persist a Trade.

    Returns a summary dict of the submitted order, or ``None`` when no shares
    are held in IB (or an open SELL already covers the held quantity).
    """
    held_qty = 0.0
    try:
        ib_positions = await ib_service.get_positions()
        for item in ib_positions or []:
            if str(item.get("symbol") or "").upper() == symbol:
                held_qty = float(item.get("quantity") or 0.0)
                break
    except Exception as exc:
        logger.debug("IB position lookup failed for %s: %s", symbol, exc)
        return None

    # Only long positions can be liquidated with a SELL. A non-positive quantity
    # means we are flat or already short — never place a SELL that would open or
    # deepen a short position.
    if held_qty <= 0:
        return None

    # Guard against double-liquidation: if a SELL order is already working for
    # this symbol (e.g. a prior removal whose market order has not filled yet),
    # do not place another order. Only sell the quantity not already covered by
    # open SELL orders so we never oversell into a short.
    pending_sell_qty = 0.0
    try:
        open_orders = await ib_service.get_open_orders()
        active_status = {"PendingSubmit", "ApiPending", "PreSubmitted", "Submitted"}
        for order in open_orders or []:
            if (
                str(order.get("symbol") or "").upper() == symbol
                and str(order.get("side") or "").upper() == "SELL"
                and str(order.get("status") or "") in active_status
            ):
                remaining = order.get("remaining")
                if remaining is None:
                    remaining = order.get("quantity")
                pending_sell_qty += max(0.0, float(remaining or 0.0))
    except Exception as exc:
        logger.debug("IB open-order lookup failed for %s: %s", symbol, exc)

    sell_qty = round(held_qty - pending_sell_qty, 6)
    if sell_qty <= 0:
        # An existing open SELL already covers the held quantity.
        return {
            "side": "SELL",
            "quantity": 0.0,
            "status": "ALREADY_PENDING",
            "pending_quantity": round(pending_sell_qty, 6),
        }

    result = await ib_service.place_order(
        symbol=symbol,
        side="SELL",
        quantity=sell_qty,
        order_type="MKT",
    )
    if result.get("error"):
        raise HTTPException(
            status_code=400,
            detail=f"Failed to place SELL order for {symbol}: {result['error']}",
        )

    from app.models.trade import Trade, TradingMode, OrderSide, OrderStatus

    ib_status = str(result.get("status") or "").upper()
    is_filled = ib_status == "FILLED"
    mode = TradingMode.LIVE if requested_profile == "live" else TradingMode.PAPER
    db.add(Trade(
        symbol=symbol,
        side=OrderSide.SELL,
        quantity=sell_qty,
        price=0.0,
        status=OrderStatus.FILLED if is_filled else OrderStatus.PENDING,
        mode=mode,
        ib_order_id=result.get("ib_order_id"),
        strategy_name="watchlist_removal_liquidation",
        filled_at=datetime.now(timezone.utc) if is_filled else None,
    ))
    return {
        "side": "SELL",
        "quantity": sell_qty,
        "ib_order_id": result.get("ib_order_id"),
        "status": ib_status or "SUBMITTED",
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
