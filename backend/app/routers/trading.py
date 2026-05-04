"""Trading endpoints: simulated, paper (IB), and live (IB)."""
from __future__ import annotations

from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.trade import Trade, OrderSide, OrderStatus, TradingMode
from app.services.ib_service import ib_service

router = APIRouter(prefix="/api/trading", tags=["trading"])


# --------------------------------------------------------------------------- #
# IB Connection
# --------------------------------------------------------------------------- #

@router.post("/ib/connect")
async def connect_ib():
    return await ib_service.connect()


@router.post("/ib/disconnect")
async def disconnect_ib():
    return await ib_service.disconnect()


@router.get("/ib/status")
async def ib_status():
    return ib_service.connection_status()


class IBModeToggleRequest(BaseModel):
    mode: str = Field(..., pattern="^(paper|live)$")


@router.post("/ib/mode")
async def set_ib_mode(req: IBModeToggleRequest):
    """Toggle IB connector between paper (port 7497) and live (port 7496)."""
    from app.config import settings
    settings.TRADING_MODE = req.mode
    # Update the default port to match the selected mode
    if req.mode == "live":
        settings.IB_PORT = 7496
    else:
        settings.IB_PORT = 7497
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
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "filled_at": t.filled_at.isoformat() if t.filled_at else None,
            }
            for t in trades
        ]
    }
