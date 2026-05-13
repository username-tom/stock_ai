"""Trading endpoints: simulated, paper (IB), and live (IB)."""
from __future__ import annotations

import logging
import math
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.database import get_db, AsyncSessionLocal
from app.models.trade import Trade, OrderSide, OrderStatus, TradingMode
from app.models.sandbox import SandboxPosition
from app.routers.sandbox_router._helpers import offload_simulated_state
from app.services.ib_service import ib_service
from app.services.local_storage import (
    save_trade_logs_csv, save_trade_logs_json, list_trade_log_files,
    records_to_csv_bytes, records_to_json_bytes, save_portfolio_state, load_portfolio_state,
)

router = APIRouter(prefix="/api/trading", tags=["trading"])
logger = logging.getLogger(__name__)

_SIM_AUTOMATION_PROFILE = "simulated_automation"


async def _snapshot_ib_state(mode: str) -> None:
    if not ib_service.is_connected:
        return
    account_summary = await ib_service.get_account_summary()
    positions = await ib_service.get_positions()
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
    result = await ib_service.connect()
    if result.get("status") == "ok" and ib_service.is_connected:
        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        try:
            async with AsyncSessionLocal() as db:
                await offload_simulated_state(db)
                await _snapshot_simulated_automation_state()

                res = await db.execute(select(SandboxPosition))
                positions = res.scalars().all()
                for pos in positions:
                    pos.strategy_enabled = False
                await db.commit()

            from app.services.portfolio_manager import update_manager_settings
            update_manager_settings({"enabled": False})
            await _snapshot_ib_state(mode)
            result["handoff"] = {
                "simulated_saved": True,
                "engines_stopped": True,
                "portfolio_manager_stopped": True,
                "active_profile": mode,
            }
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
    if ib_service.is_connected:
        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        await _snapshot_ib_state(mode)
    result = await ib_service.disconnect()

    try:
        restored = await _restore_simulated_automation_state()
        result["simulated_restore"] = restored
    except Exception as exc:
        logger.warning("Simulated automation state restore failed: %s", exc)
        result["simulated_restore"] = {
            "restored": False,
            "error": str(exc),
        }

    return result


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
async def reset_ib_paper_portfolio():
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

    return {
        "status": "ok",
        "cancelled_orders": len(cancelled_order_ids),
        "flatten_orders": len(flattened),
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
            filled_at=datetime.utcnow(),
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

    trade = Trade(
        symbol=req.symbol.upper(),
        side=OrderSide(req.side.upper()),
        quantity=req.quantity,
        price=req.limit_price or 0.0,
        status=OrderStatus.PENDING,
        mode=TradingMode(mode),
        ib_order_id=result.get("ib_order_id"),
        strategy_name=req.strategy_name,
    )
    db.add(trade)
    await db.commit()
    await db.refresh(trade)
    return {**result, "id": trade.id}


@router.delete("/order/{ib_order_id}")
async def cancel_order(ib_order_id: int):
    return await ib_service.cancel_order(ib_order_id)


# --------------------------------------------------------------------------- #
# Trade history
# --------------------------------------------------------------------------- #

@router.get("/history")
async def trade_history(
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Trade).order_by(Trade.created_at.desc()).limit(limit)
    )
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
