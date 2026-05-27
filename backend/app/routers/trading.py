"""Trading endpoints: simulated, paper (IB), and live (IB)."""
from __future__ import annotations

import logging
import math
import asyncio
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import delete, select

from app.config import settings
from app.database import get_db, AsyncSessionLocal
from app.models.trade import Trade, OrderSide, OrderStatus, TradingMode
from app.models.sandbox import SandboxPosition
from app.routers.sandbox_router._helpers import offload_simulated_state
from app.services import market_service
from app.services.ib_service import ib_service
from app.services.local_storage import (
    save_trade_logs_csv, save_trade_logs_json, list_trade_log_files,
    records_to_csv_bytes, records_to_json_bytes, save_portfolio_state, load_portfolio_state,
)

router = APIRouter(prefix="/api/trading", tags=["trading"])
logger = logging.getLogger(__name__)

_SIM_AUTOMATION_PROFILE = "simulated_automation"


async def _reconcile_pending_ib_trades(db: AsyncSession, trades: list[Trade]) -> int:
    """Best-effort reconciliation of stale IB pending trade rows.

    Trade rows are written at submit-time and can remain PENDING if no later
    endpoint mutates them. This checker uses current open orders + latest IB
    callback statuses to mark rows FILLED/CANCELLED.
    """
    if not ib_service.is_connected:
        return 0

    pending = [
        t
        for t in trades
        if t.status == OrderStatus.PENDING
        and t.mode in {TradingMode.PAPER, TradingMode.LIVE}
        and t.ib_order_id is not None
    ]
    if not pending:
        return 0

    active_statuses = {"PENDINGSUBMIT", "APIPENDING", "PRESUBMITTED", "SUBMITTED"}
    cancelled_statuses = {"CANCELLED", "APICANCELLED", "INACTIVE"}

    open_orders = await ib_service.get_open_orders()
    open_status_by_id: dict[int, str] = {}
    for order in open_orders:
        oid = order.get("ib_order_id")
        if oid is None:
            continue
        try:
            open_status_by_id[int(oid)] = str(order.get("status") or "").upper()
        except Exception:
            continue

    known_status_by_id = {
        int(oid): str(status or "").upper()
        for oid, status in ib_service.get_known_order_statuses().items()
    }
    known_fill_price_by_id = {
        int(oid): float(price)
        for oid, price in ib_service.get_known_order_fill_prices().items()
        if float(price or 0.0) > 0.0
    }

    symbol_qty: dict[str, float] = {}
    try:
        for row in await ib_service.get_positions():
            sym = str(row.get("symbol") or "").upper()
            if not sym:
                continue
            symbol_qty[sym] = float(row.get("quantity") or 0.0)
    except Exception as exc:
        logger.debug("Pending-trade reconciliation position lookup failed: %s", exc)

    changed = 0
    now_utc = datetime.now(timezone.utc)
    for trade in pending:
        row_changed = False
        if trade.pnl is not None:
            trade.pnl = None
            row_changed = True
        oid = int(trade.ib_order_id)
        open_status = open_status_by_id.get(oid)
        known_status = known_status_by_id.get(oid, "")

        final_status: OrderStatus | None = None
        if open_status == "FILLED" or known_status == "FILLED":
            final_status = OrderStatus.FILLED
        elif open_status in cancelled_statuses or known_status in cancelled_statuses:
            final_status = OrderStatus.CANCELLED
        elif open_status in active_statuses or known_status in active_statuses:
            final_status = None
        else:
            # Heuristic fallback when IB no longer reports the order:
            # BUY likely filled if long position now exists.
            # SELL likely filled if no long position remains.
            sym = str(trade.symbol or "").upper()
            qty = float(symbol_qty.get(sym, 0.0) or 0.0)
            if trade.side == OrderSide.BUY and qty > 0.0:
                final_status = OrderStatus.FILLED
            elif trade.side == OrderSide.SELL and qty <= 0.0:
                final_status = OrderStatus.FILLED

            # If IB no longer reports the order and we still cannot infer a fill,
            # treat an old unresolved pending row as cancelled to prevent
            # indefinitely stuck local PENDING state in the UI.
            if final_status is None and open_status is None and not known_status:
                created_at = trade.created_at
                if created_at is not None:
                    if created_at.tzinfo is None:
                        created_at = created_at.replace(tzinfo=timezone.utc)
                    age_seconds = (now_utc - created_at).total_seconds()
                    if age_seconds >= 120:
                        final_status = OrderStatus.CANCELLED
                        if not str(trade.strategy_name or "").lower().endswith("_timeout_cancel"):
                            base = str(trade.strategy_name or "ib_order")
                            trade.strategy_name = f"{base}_timeout_cancel"
                            row_changed = True
                        logger.info(
                            "Pending IB trade stale timeout -> CANCELLED (ib_order_id=%s symbol=%s age=%.1fs)",
                            trade.ib_order_id,
                            trade.symbol,
                            age_seconds,
                        )

        if final_status is None or trade.status == final_status:
            if row_changed:
                changed += 1
            continue

        trade.status = final_status
        row_changed = True
        if final_status == OrderStatus.FILLED:
            fill_px = float(known_fill_price_by_id.get(oid, 0.0) or 0.0)
            if fill_px > 0:
                trade.price = fill_px
        if final_status != OrderStatus.FILLED:
            trade.pnl = None
        elif trade.side != OrderSide.SELL:
            trade.pnl = None
        if final_status == OrderStatus.FILLED and trade.filled_at is None:
            trade.filled_at = now_utc
            row_changed = True
        if row_changed:
            changed += 1

    if changed:
        await db.commit()
    return changed


async def _snapshot_ib_state(mode: str) -> None:
    if not ib_service.is_connected:
        return
    account_summary, positions = await asyncio.gather(
        ib_service.get_account_summary(),
        ib_service.get_positions(),
    )
    save_portfolio_state(mode, {
        "source": "ib",
        "mode": mode,
        "captured_at": datetime.utcnow().isoformat(),
        "account_summary": account_summary,
        "positions": positions,
    })


async def _snapshot_simulated_automation_state() -> None:
    """Save simulated engine + manager enabled states before IB handoff."""
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(SandboxPosition))
        positions = res.scalars().all()
        engine_enabled_by_symbol = {
            p.symbol: bool(p.strategy_enabled)
            for p in positions
            if p.symbol
        }

    from app.services.portfolio_manager import get_manager_settings
    manager_settings = get_manager_settings()
    manager_enabled = bool(manager_settings.get("enabled", False))

    save_portfolio_state(_SIM_AUTOMATION_PROFILE, {
        "source": "simulated",
        "captured_at": datetime.utcnow().isoformat(),
        "engine_enabled_by_symbol": engine_enabled_by_symbol,
        "manager_enabled": manager_enabled,
    })


async def _pause_simulated_automation() -> dict:
    """Disable sandbox automation while IB mode is active."""
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(SandboxPosition))
        positions = res.scalars().all()
        paused_engines = 0
        for p in positions:
            if bool(p.strategy_enabled):
                p.strategy_enabled = False
                paused_engines += 1
        await db.commit()

    from app.services.portfolio_manager import get_manager_settings, update_manager_settings

    manager_was_enabled = bool(get_manager_settings().get("enabled", False))
    if manager_was_enabled:
        update_manager_settings({"enabled": False})

    logger.info(
        "IB handoff: paused simulated automation (engines_paused=%s, manager_paused=%s)",
        paused_engines,
        manager_was_enabled,
    )
    return {
        "engines_paused": paused_engines,
        "manager_paused": manager_was_enabled,
    }


async def _restore_simulated_automation_state() -> dict:
    """Restore simulated engine + manager enabled states after IB disconnect."""
    payload = load_portfolio_state(_SIM_AUTOMATION_PROFILE)
    state = (payload or {}).get("state") or {}

    engine_enabled_by_symbol = state.get("engine_enabled_by_symbol") or {}
    manager_enabled = state.get("manager_enabled")

    restored_engines = 0
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(SandboxPosition))
        positions = res.scalars().all()
        for p in positions:
            if p.symbol in engine_enabled_by_symbol:
                p.strategy_enabled = bool(engine_enabled_by_symbol[p.symbol])
                restored_engines += 1
        await db.commit()

    restored_manager = False
    if manager_enabled is not None:
        from app.services.portfolio_manager import update_manager_settings
        update_manager_settings({"enabled": bool(manager_enabled)})
        restored_manager = True

    return {
        "restored": bool(payload),
        "restored_engines": restored_engines,
        "restored_manager": restored_manager,
    }


# --------------------------------------------------------------------------- #
# IB Connection
# --------------------------------------------------------------------------- #

@router.post("/ib/connect")
async def connect_ib():
    logger.info("IB connect requested (configured_mode=%s)", settings.TRADING_MODE)
    result = await ib_service.connect()
    if result.get("status") == "ok" and ib_service.is_connected:
        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        try:
            async with AsyncSessionLocal() as db:
                await offload_simulated_state(db)

            await _snapshot_ib_state(mode)
            result["handoff"] = {
                "simulated_saved": True,
                "engines_stopped": False,
                "portfolio_manager_stopped": False,
                "engines_paused_count": 0,
                "active_profile": mode,
            }
            logger.info(
                "IB connected and handoff complete (profile=%s, signals/PM remain active)",
                mode,
            )
        except Exception as exc:
            logger.warning("IB handoff setup failed: %s", exc)
            result["handoff"] = {
                "simulated_saved": False,
                "engines_stopped": False,
                "portfolio_manager_stopped": False,
                "error": str(exc),
            }
    return result


@router.post("/ib/disconnect")
async def disconnect_ib():
    logger.info("IB disconnect requested")
    if ib_service.is_connected:
        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        await _snapshot_ib_state(mode)
    return await ib_service.disconnect()


@router.get("/ib/status")
async def ib_status():
    return ib_service.connection_status()


class IBModeToggleRequest(BaseModel):
    mode: str = Field(..., pattern="^(paper|live)$")


@router.post("/ib/mode")
async def set_ib_mode(req: IBModeToggleRequest):
    """Toggle IB connector between paper (port 4002) and live (port 4001)."""
    settings.TRADING_MODE = req.mode
    # Update the default port to match the selected mode
    if req.mode == "live":
        settings.IB_PORT = 4001
    else:
        settings.IB_PORT = 4002
    if ib_service.is_connected:
        await _snapshot_ib_state(req.mode)
    return {"mode": settings.TRADING_MODE, "port": settings.IB_PORT}


@router.get("/ib/account")
async def ib_account():
    return await ib_service.get_account_summary()


@router.get("/ib/positions")
async def ib_positions():
    return {"positions": await ib_service.get_positions()}


@router.get("/ib/orders")
async def ib_open_orders():
    return {"orders": await ib_service.get_open_orders()}


@router.post("/ib/paper/reset")
async def reset_ib_paper_portfolio(db: AsyncSession = Depends(get_db)):
    """Reset IB paper portfolio by cancelling open orders and flattening positions.

    This endpoint is intentionally disabled for live mode.
    """
    if settings.TRADING_MODE != "paper":
        raise HTTPException(status_code=403, detail="Paper reset is only available in paper mode.")
    if not ib_service.is_connected:
        raise HTTPException(status_code=503, detail="Not connected to Interactive Brokers.")

    cancelled_order_ids: list[int] = []
    cancel_errors: list[dict] = []
    flattened: list[dict] = []
    flatten_errors: list[dict] = []

    open_orders = await ib_service.get_open_orders()
    for order in open_orders:
        oid = order.get("ib_order_id")
        if oid is None:
            continue
        result = await ib_service.cancel_order(int(oid))
        if result.get("status") == "ok":
            cancelled_order_ids.append(int(oid))
        else:
            cancel_errors.append({
                "ib_order_id": int(oid),
                "error": result.get("error", "unknown error"),
            })

    positions = await ib_service.get_positions()
    for p in positions:
        symbol = str(p.get("symbol") or "").upper()
        qty = float(p.get("quantity") or 0.0)
        if not symbol or math.isclose(qty, 0.0, abs_tol=1e-9):
            continue

        side = "SELL" if qty > 0 else "BUY"
        quantity = abs(qty)
        result = await ib_service.place_order(
            symbol=symbol,
            side=side,
            quantity=quantity,
            order_type="MKT",
        )
        if "error" in result:
            flatten_errors.append({
                "symbol": symbol,
                "side": side,
                "quantity": quantity,
                "error": result.get("error"),
            })
        else:
            flattened.append({
                "symbol": symbol,
                "side": side,
                "quantity": quantity,
                "ib_order_id": result.get("ib_order_id"),
                "status": result.get("status"),
            })

    # Reset local PAPER trade history so realized PnL/activity views reflect
    # the reset account state and do not show stale values.
    delete_result = await db.execute(delete(Trade).where(Trade.mode == TradingMode.PAPER))
    await db.commit()
    deleted_trade_rows = int(delete_result.rowcount or 0)

    return {
        "status": "ok",
        "cancelled_orders": len(cancelled_order_ids),
        "flatten_orders": len(flattened),
        "deleted_trade_rows": deleted_trade_rows,
        "cancel_errors": cancel_errors,
        "flatten_errors": flatten_errors,
        "details": {
            "cancelled_order_ids": cancelled_order_ids,
            "flattened": flattened,
        },
    }


# --------------------------------------------------------------------------- #
# Order placement
# --------------------------------------------------------------------------- #

class OrderRequest(BaseModel):
    symbol: str = Field(..., example="AAPL")
    side: str = Field(..., example="BUY")
    quantity: float = Field(..., gt=0, example=10)
    mode: str = Field(default="SIMULATED", example="SIMULATED")  # SIMULATED | PAPER | LIVE
    order_type: str = Field(default="MKT", example="MKT")
    limit_price: float | None = Field(default=None, example=None)
    price: float | None = Field(default=None, description="For simulated fill price")
    strategy_name: str | None = None


@router.post("/order")
async def place_order(req: OrderRequest, db: AsyncSession = Depends(get_db)):
    """Place an order. Mode SIMULATED fills immediately at the provided price."""
    mode = req.mode.upper()

    if mode == "SIMULATED":
        if req.price is None:
            raise HTTPException(
                status_code=400,
                detail="price is required for SIMULATED mode."
            )
        trade = Trade(
            symbol=req.symbol.upper(),
            side=OrderSide(req.side.upper()),
            quantity=req.quantity,
            price=req.price,
            status=OrderStatus.FILLED,
            mode=TradingMode.SIMULATED,
            strategy_name=req.strategy_name,
            filled_at=datetime.now(timezone.utc),
        )
        db.add(trade)
        await db.commit()
        await db.refresh(trade)
        return {"id": trade.id, "status": "FILLED", "mode": "SIMULATED"}

    # PAPER or LIVE – requires IB connection
    if not ib_service.is_connected:
        raise HTTPException(
            status_code=503,
            detail="Not connected to Interactive Brokers. Connect first."
        )
    result = await ib_service.place_order(
        symbol=req.symbol.upper(),
        side=req.side,
        quantity=req.quantity,
        order_type=req.order_type,
        limit_price=req.limit_price,
    )
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    ib_status = str(result.get("status") or "").upper()
    is_filled = ib_status == "FILLED"

    symbol = req.symbol.upper()
    side = req.side.upper()

    # For IB market orders we may not get an immediate fill price from TWS.
    # Persist a best-effort reference price so activity rows can compute amount/PnL.
    reference_price = float(req.limit_price) if req.limit_price is not None else None
    if reference_price is None:
        try:
            quote = await market_service.get_quote(symbol, source_preference="ib")
            if isinstance(quote, dict) and "error" not in quote:
                candidate = quote.get("last_price") or quote.get("last") or quote.get("close")
                if candidate is not None:
                    price_num = float(candidate)
                    if price_num > 0:
                        reference_price = price_num
        except Exception as exc:
            logger.debug("IB quote lookup for order reference price failed (%s): %s", symbol, exc)

    # If IB already reports a fill, prefer callback avgFillPrice over submit-time
    # quote/limit references so UI activity rows match broker execution.
    if is_filled:
        fill_prices = ib_service.get_known_order_fill_prices()
        fill_px = float(fill_prices.get(int(result.get("ib_order_id") or 0), 0.0) or 0.0)
        if fill_px > 0:
            reference_price = fill_px

    estimated_pnl = None
    if side == "SELL":
        try:
            positions = await ib_service.get_positions()
            position = next(
                (
                    p for p in positions
                    if str(p.get("symbol") or "").upper() == symbol and float(p.get("quantity") or 0.0) > 0
                ),
                None,
            )
            if position is not None and reference_price is not None and reference_price > 0:
                avg_cost = float(position.get("avg_cost") or 0.0)
                held_qty = float(position.get("quantity") or 0.0)
                sell_qty = min(float(req.quantity), max(0.0, held_qty))
                if avg_cost > 0 and sell_qty > 0:
                    estimated_pnl = round((reference_price - avg_cost) * sell_qty, 4)
        except Exception as exc:
            logger.debug("IB SELL PnL estimate failed (%s): %s", symbol, exc)

    trade = Trade(
        symbol=symbol,
        side=OrderSide(side),
        quantity=req.quantity,
        price=reference_price or 0.0,
        status=OrderStatus.FILLED if is_filled else OrderStatus.PENDING,
        mode=TradingMode(mode),
        ib_order_id=result.get("ib_order_id"),
        strategy_name=req.strategy_name,
        pnl=estimated_pnl,
        filled_at=datetime.now(timezone.utc) if is_filled else None,
    )
    db.add(trade)
    await db.commit()
    await db.refresh(trade)
    return {**result, "id": trade.id}


@router.delete("/order/{ib_order_id}")
async def cancel_order(ib_order_id: int, db: AsyncSession = Depends(get_db)):
    # Snapshot open-order details before cancellation so we can persist
    # a cancellation event in trade history for activity feeds.
    prior_orders = await ib_service.get_open_orders() if ib_service.is_connected else []
    order_info = next(
        (o for o in prior_orders if int(o.get("ib_order_id") or 0) == int(ib_order_id)),
        None,
    )

    result = await ib_service.cancel_order(ib_order_id)
    if result.get("status") != "ok":
        return result

    try:
        symbol = str((order_info or {}).get("symbol") or "UNKNOWN").upper()
        side_raw = str((order_info or {}).get("side") or "BUY").upper()
        side = OrderSide.BUY if side_raw != "SELL" else OrderSide.SELL
        qty = float((order_info or {}).get("remaining") or (order_info or {}).get("quantity") or 0.0)
        price = float((order_info or {}).get("limit_price") or 0.0)
        mode = TradingMode.LIVE if settings.TRADING_MODE == "live" else TradingMode.PAPER

        cancel_evt = Trade(
            symbol=symbol,
            side=side,
            quantity=max(0.0, qty),
            price=max(0.0, price),
            status=OrderStatus.CANCELLED,
            mode=mode,
            ib_order_id=int(ib_order_id),
            strategy_name="ib_cancel",
            filled_at=None,
        )
        db.add(cancel_evt)
        await db.commit()
    except Exception as exc:
        logger.warning("Failed to persist cancel event for order %s: %s", ib_order_id, exc)

    return result


# --------------------------------------------------------------------------- #
# Trade history
# --------------------------------------------------------------------------- #

@router.get("/history")
async def trade_history(
    limit: int = 100,
    mode: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(Trade)
    if mode:
        mode_norm = mode.strip().upper()
        if mode_norm in {"SIMULATED", "PAPER", "LIVE"}:
            q = q.where(Trade.mode == TradingMode(mode_norm))
    result = await db.execute(q.order_by(Trade.created_at.desc()).limit(limit))
    trades = result.scalars().all()

    # Keep IB activity/history views in sync with actual order state.
    # This prevents stale PENDING rows from lingering in the UI when orders
    # were filled/cancelled but no explicit mutation endpoint was called.
    await _reconcile_pending_ib_trades(db, trades)

    result = await db.execute(q.order_by(Trade.created_at.desc()).limit(limit))
    trades = result.scalars().all()

    return {
        "trades": [
            {
                "id": t.id,
                "symbol": t.symbol,
                "side": t.side.value,
                "quantity": t.quantity,
                "price": t.price,
                "status": t.status.value,
                "mode": t.mode.value,
                "ib_order_id": t.ib_order_id,
                "strategy_name": t.strategy_name,
                "pnl": t.pnl,
                "created_at": t.created_at.astimezone().isoformat() if t.created_at else None,
                "filled_at": t.filled_at.astimezone().isoformat() if t.filled_at else None,
            }
            for t in trades
        ]
    }


@router.get("/history/export")
async def export_trade_history(
    fmt: str = "csv",
    save: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Download the full trade history log as CSV or JSON.

    - ``fmt``  – ``csv`` (default) or ``json``
    - ``save`` – if ``true``, also persist a copy to local PC storage
    """
    result = await db.execute(select(Trade).order_by(Trade.created_at.desc()))
    trades = result.scalars().all()
    records = [
        {
            "id": t.id,
            "symbol": t.symbol,
            "side": t.side.value,
            "quantity": t.quantity,
            "price": t.price,
            "status": t.status.value,
            "mode": t.mode.value,
            "ib_order_id": t.ib_order_id,
            "strategy_name": t.strategy_name,
            "pnl": t.pnl,
            "created_at": t.created_at.astimezone().isoformat() if t.created_at else None,
            "filled_at": t.filled_at.astimezone().isoformat() if t.filled_at else None,
        }
        for t in trades
    ]

    if save:
        if fmt == "json":
            save_trade_logs_json(records, filename_prefix="trade_logs")
        else:
            save_trade_logs_csv(records, filename_prefix="trade_logs")

    if fmt == "json":
        content = records_to_json_bytes(records)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="trade_logs.json"'},
        )

    content = records_to_csv_bytes(records)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="trade_logs.csv"'},
    )


@router.get("/history/local-storage/files")
async def list_trade_log_files():
    """List all trade log files saved to local PC storage."""
    return {"files": list_trade_log_files()}
