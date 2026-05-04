"""Trade execution and analytics endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxAccount, SandboxPosition, SandboxTrade
from app.routers.sandbox_router._helpers import get_account, position_dict
from app.services.local_storage import (
    save_trade_logs_csv, save_trade_logs_json, list_trade_log_files,
    records_to_csv_bytes, records_to_json_bytes,
)

router = APIRouter()


class TradeRequest(BaseModel):
    symbol: str
    side: str = Field(..., pattern="^(BUY|SELL)$")
    quantity: float = Field(..., gt=0)
    price: float = Field(..., gt=0)
    strategy_name: Optional[str] = None
    reason: Optional[str] = None


@router.post("/trade")
async def place_trade(req: TradeRequest, db: AsyncSession = Depends(get_db)):
    symbol = req.symbol.upper()
    side   = req.side.upper()
    total  = req.quantity * req.price

    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, f"Symbol {symbol} not in sandbox. Add it first.")

    pnl = None

    if side == "BUY":
        if pos.allocated_funds < total:
            raise HTTPException(400, f"Insufficient allocated funds. Allocated: ${pos.allocated_funds:.2f}, Cost: ${total:.2f}")
        new_shares = pos.shares + req.quantity
        pos.avg_cost = (pos.avg_cost * pos.shares + total) / new_shares
        pos.shares = new_shares
        pos.allocated_funds -= total
    elif side == "SELL":
        if pos.shares < req.quantity:
            raise HTTPException(400, f"Insufficient shares. Held: {pos.shares}, Sell: {req.quantity}")
        pnl = round((req.price - pos.avg_cost) * req.quantity, 4)
        pos.shares -= req.quantity
        pos.allocated_funds += total
        pos.realized_pnl += pnl
        if pos.shares == 0:
            pos.avg_cost = 0.0
        # Credit profit / debit loss to account.total_funds so that
        # available_funds = total_funds - sum(allocated_funds) stays accurate.
        account = await get_account(db)
        account.total_funds += pnl

    trade = SandboxTrade(
        symbol=symbol,
        side=side,
        quantity=req.quantity,
        price=req.price,
        total=total,
        strategy_name=req.strategy_name or pos.strategy_name,
        reason=req.reason,
        pnl=pnl,
    )
    db.add(trade)
    await db.commit()
    await db.refresh(trade)
    await db.refresh(pos)

    return {
        "trade_id": trade.id,
        "symbol": symbol,
        "side": side,
        "quantity": req.quantity,
        "price": req.price,
        "total": total,
        "pnl": pnl,
        "position": position_dict(pos),
    }


@router.get("/trades")
async def get_trades(symbol: Optional[str] = None, limit: int = 200, db: AsyncSession = Depends(get_db)):
    q = select(SandboxTrade).order_by(SandboxTrade.created_at.desc()).limit(limit)
    if symbol:
        q = q.where(SandboxTrade.symbol == symbol.upper())
    result = await db.execute(q)
    trades = result.scalars().all()
    return {
        "trades": [
            {
                "id": t.id,
                "symbol": t.symbol,
                "side": t.side,
                "quantity": t.quantity,
                "price": t.price,
                "total": t.total,
                "strategy_name": t.strategy_name,
                "reason": t.reason,
                "pnl": t.pnl,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in trades
        ]
    }


@router.get("/analytics")
async def get_analytics(db: AsyncSession = Depends(get_db)):
    """Time-series analytics derived from trade history."""
    trades_res = await db.execute(select(SandboxTrade).order_by(SandboxTrade.created_at))
    trades = trades_res.scalars().all()

    # Cumulative realised P&L
    cumulative = []
    running = 0.0
    for t in trades:
        if t.pnl is not None:
            running += t.pnl
        date_str = t.created_at.strftime("%Y-%m-%d %H:%M") if t.created_at else "unknown"
        cumulative.append({"date": date_str, "value": round(running, 2)})

    # Daily buy/sell volume
    daily: dict[str, dict] = {}
    for t in trades:
        day = t.created_at.strftime("%Y-%m-%d") if t.created_at else "unknown"
        if day not in daily:
            daily[day] = {"date": day, "buy": 0.0, "sell": 0.0}
        if t.side == "BUY":
            daily[day]["buy"] = round(daily[day]["buy"] + t.total, 2)
        else:
            daily[day]["sell"] = round(daily[day]["sell"] + t.total, 2)
    daily_volume = [{"date": d, "buy": v["buy"], "sell": v["sell"]}
                    for d, v in sorted(daily.items())]

    # Per-symbol realised P&L
    sym_map: dict[str, dict] = {}
    for t in trades:
        if t.symbol not in sym_map:
            sym_map[t.symbol] = {"symbol": t.symbol, "realized_pnl": 0.0, "trade_count": 0}
        sym_map[t.symbol]["trade_count"] += 1
        if t.pnl is not None:
            sym_map[t.symbol]["realized_pnl"] = round(sym_map[t.symbol]["realized_pnl"] + t.pnl, 2)
    symbol_pnl = sorted(sym_map.values(), key=lambda x: x["realized_pnl"], reverse=True)

    wins      = sum(1 for t in trades if t.pnl is not None and t.pnl > 0)
    losses    = sum(1 for t in trades if t.pnl is not None and t.pnl < 0)
    breakeven = sum(1 for t in trades if t.pnl is not None and t.pnl == 0)

    return {
        "cumulative_pnl": cumulative,
        "daily_volume": daily_volume,
        "symbol_pnl": symbol_pnl,
        "win_loss": {"wins": wins, "losses": losses, "breakeven": breakeven},
        "total_trades": len(trades),
    }


def _trade_dicts(trades) -> list[dict]:
    return [
        {
            "id": t.id,
            "symbol": t.symbol,
            "side": t.side,
            "quantity": t.quantity,
            "price": t.price,
            "total": t.total,
            "strategy_name": t.strategy_name,
            "reason": t.reason,
            "pnl": t.pnl,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in trades
    ]


@router.get("/trades/export")
async def export_trades(
    fmt: str = "csv",
    symbol: Optional[str] = None,
    save: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Download sandbox trade logs as CSV or JSON.

    - ``fmt``    – ``csv`` (default) or ``json``
    - ``symbol`` – optional filter by ticker symbol
    - ``save``   – if ``true``, also persist a copy to local PC storage
    """
    q = select(SandboxTrade).order_by(SandboxTrade.created_at.desc())
    if symbol:
        q = q.where(SandboxTrade.symbol == symbol.upper())
    result = await db.execute(q)
    trades = result.scalars().all()
    records = _trade_dicts(trades)

    if save:
        prefix = f"sandbox_trades_{symbol.upper()}" if symbol else "sandbox_trades"
        if fmt == "json":
            local_storage.save_trade_logs_json(records, filename_prefix=prefix)
        else:
            local_storage.save_trade_logs_csv(records, filename_prefix=prefix)

    if fmt == "json":
        content = local_storage.records_to_json_bytes(records)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="sandbox_trades.json"'},
        )

    content = local_storage.records_to_csv_bytes(records)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="sandbox_trades.csv"'},
    )


@router.get("/trades/local-storage/files")
async def list_trade_log_files():
    """List all trade log files saved to local PC storage."""
    return {"files": local_storage.list_trade_log_files()}
