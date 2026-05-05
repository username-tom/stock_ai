"""Sandbox portfolio router – simulated trading environment."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import Optional, List

from app.database import get_db
from app.models.sandbox import SandboxAccount, SandboxPosition, SandboxTrade

router = APIRouter(prefix="/api/sandbox", tags=["sandbox"])


# ── helpers ──────────────────────────────────────────────────────────────── #

async def _get_account(db: AsyncSession) -> SandboxAccount:
    result = await db.execute(select(SandboxAccount).limit(1))
    account = result.scalar_one_or_none()
    if account is None:
        account = SandboxAccount(total_funds=0.0)
        db.add(account)
        await db.commit()
        await db.refresh(account)
    return account


def _position_dict(p: SandboxPosition, market_price: float | None = None) -> dict:
    market_val = (market_price or p.avg_cost) * p.shares if p.shares else 0.0
    unrealised_pnl = market_val - p.avg_cost * p.shares if p.shares else 0.0
    return {
        "id": p.id,
        "symbol": p.symbol,
        "allocated_funds": p.allocated_funds,
        "shares": p.shares,
        "avg_cost": p.avg_cost,
        "strategy_name": p.strategy_name,
        "strategy_enabled": p.strategy_enabled,
        "last_signal": p.last_signal,
        "last_run_at": p.last_run_at.isoformat() if p.last_run_at else None,
        "engine_error": p.engine_error,
        "realized_pnl": p.realized_pnl,
        "unrealized_pnl": round(unrealised_pnl, 4),
        "market_value": round(market_val, 4),
        "is_on_watchlist": p.is_on_watchlist,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "pending_shares": p.pending_shares,
        "pending_avg_cost": p.pending_avg_cost,
        "pending_since": p.pending_since.isoformat() if p.pending_since else None,
    }


# ── account ───────────────────────────────────────────────────────────────── #

@router.get("/account")
async def get_account(db: AsyncSession = Depends(get_db)):
    account = await _get_account(db)
    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    allocated = sum(p.allocated_funds for p in positions)
    return {
        "total_funds": account.total_funds,
        "allocated_funds": allocated,
        "available_funds": account.total_funds - allocated,
        "updated_at": account.updated_at.isoformat() if account.updated_at else None,
    }


class AddFundsRequest(BaseModel):
    amount: float = Field(..., gt=0)


@router.post("/account/add-funds")
async def add_funds(req: AddFundsRequest, db: AsyncSession = Depends(get_db)):
    account = await _get_account(db)
    account.total_funds += req.amount
    await db.commit()
    await db.refresh(account)
    return {"total_funds": account.total_funds, "added": req.amount}


# ── positions / watchlist ─────────────────────────────────────────────────── #

@router.get("/positions")
async def get_positions(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    positions = result.scalars().all()
    return {"positions": [_position_dict(p) for p in positions]}


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
        # Re-add to watchlist if removed
        pos.is_on_watchlist = True
        if req.strategy_name:
            pos.strategy_name = req.strategy_name
        await db.commit()
        await db.refresh(pos)
        return _position_dict(pos)

    # Auto-top-up simulation account if there aren't enough available funds
    if req.allocated_funds > 0:
        account = await _get_account(db)
        all_pos = (await db.execute(select(SandboxPosition))).scalars().all()
        currently_allocated = sum(p.allocated_funds for p in all_pos)
        available = account.total_funds - currently_allocated
        if req.allocated_funds > available:
            shortfall = req.allocated_funds - available
            account.total_funds += shortfall

    pos = SandboxPosition(
        symbol=symbol,
        allocated_funds=req.allocated_funds,
        strategy_name=req.strategy_name,
        is_on_watchlist=True,
    )
    db.add(pos)
    await db.commit()
    await db.refresh(pos)
    return _position_dict(pos)


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
        account = await _get_account(db)
        all_pos = (await db.execute(select(SandboxPosition))).scalars().all()
        currently_allocated = sum(p.allocated_funds for p in all_pos if p.id != pos.id)
        available = account.total_funds - currently_allocated
        if req.allocated_funds > available:
            # Simulation: auto-top-up account so allocation is never blocked
            shortfall = req.allocated_funds - available
            account.total_funds += shortfall
        pos.allocated_funds = req.allocated_funds

    await db.commit()
    await db.refresh(pos)
    return _position_dict(pos)


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


# ── trades ────────────────────────────────────────────────────────────────── #

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
    side = req.side.upper()
    total = req.quantity * req.price

    # Get or create position
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, f"Symbol {symbol} not in sandbox. Add it first.")

    pnl = None

    if side == "BUY":
        # Check allocated funds vs cost
        if pos.allocated_funds < total:
            raise HTTPException(400, f"Insufficient allocated funds. Allocated: ${pos.allocated_funds:.2f}, Cost: ${total:.2f}")
        # Update position
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
        "position": _position_dict(pos),
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
    """
    Return time-series data derived from trade history for portfolio charts:
      - cumulative_pnl:   [{date, value}]  running total of realised P&L over time
      - daily_volume:     [{date, buy, sell}]  total $ traded per day by side
      - symbol_pnl:       [{symbol, realized_pnl, trade_count}]  per-symbol breakdown
      - win_loss:         {wins, losses, breakeven}  trade outcome counts
    """
    trades_res = await db.execute(
        select(SandboxTrade).order_by(SandboxTrade.created_at)
    )
    trades = trades_res.scalars().all()

    # ── cumulative realised P&L ───────────────────────────────────────── #
    cumulative = []
    running = 0.0
    for t in trades:
        if t.pnl is not None:
            running += t.pnl
        date_str = t.created_at.strftime("%Y-%m-%d %H:%M") if t.created_at else "unknown"
        cumulative.append({"date": date_str, "value": round(running, 2)})

    # ── daily buy/sell volume ─────────────────────────────────────────── #
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

    # ── per-symbol realised P&L ───────────────────────────────────────── #
    sym_map: dict[str, dict] = {}
    for t in trades:
        if t.symbol not in sym_map:
            sym_map[t.symbol] = {"symbol": t.symbol, "realized_pnl": 0.0, "trade_count": 0}
        sym_map[t.symbol]["trade_count"] += 1
        if t.pnl is not None:
            sym_map[t.symbol]["realized_pnl"] = round(
                sym_map[t.symbol]["realized_pnl"] + t.pnl, 2
            )
    symbol_pnl = sorted(sym_map.values(), key=lambda x: x["realized_pnl"], reverse=True)

    # ── win / loss / breakeven counts (SELL trades only) ─────────────── #
    wins = sum(1 for t in trades if t.pnl is not None and t.pnl > 0)
    losses = sum(1 for t in trades if t.pnl is not None and t.pnl < 0)
    breakeven = sum(1 for t in trades if t.pnl is not None and t.pnl == 0)

    return {
        "cumulative_pnl": cumulative,
        "daily_volume": daily_volume,
        "symbol_pnl": symbol_pnl,
        "win_loss": {"wins": wins, "losses": losses, "breakeven": breakeven},
        "total_trades": len(trades),
    }


# ── engine status ─────────────────────────────────────────────────────────── #

@router.get("/engine/state")
async def engine_state():
    """Return the current sandbox engine state (running, last tick, per-symbol status)."""
    from app.services.sandbox_engine import get_engine_state
    return get_engine_state()


@router.post("/engine/toggle-all")
async def engine_toggle_all(db: AsyncSession = Depends(get_db)):
    """Start all engines if any are stopped, otherwise stop all."""
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.strategy_name.isnot(None)))
    positions = result.scalars().all()
    if not positions:
        raise HTTPException(400, "No positions with a strategy assigned.")
    any_stopped = any(not p.strategy_enabled for p in positions)
    for pos in positions:
        pos.strategy_enabled = any_stopped  # start all if any stopped, else stop all
    await db.commit()
    return {"enabled": any_stopped, "count": len(positions)}


@router.post("/engine/toggle/{symbol}")
async def engine_toggle(symbol: str, db: AsyncSession = Depends(get_db)):
    """Toggle the automated strategy engine on/off for a symbol."""
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
    return _position_dict(pos)


# ── IB mode toggle ────────────────────────────────────────────────────────── #

class IBModeRequest(BaseModel):
    mode: str = Field(..., pattern="^(paper|live)$")


@router.post("/ib-mode")
async def set_ib_mode(req: IBModeRequest):
    """Toggle the in-memory IB trading mode between paper and live."""
    from app.config import settings
    settings.TRADING_MODE = req.mode
    return {"mode": settings.TRADING_MODE}


@router.get("/ib-mode")
async def get_ib_mode():
    from app.config import settings
    return {"mode": settings.TRADING_MODE}


# ── portfolio manager ─────────────────────────────────────────────────────── #

class PortfolioManagerSettingsRequest(BaseModel):
    enabled: Optional[bool] = None
    transfer_pct: Optional[float] = Field(default=None, ge=0.01, le=1.0)
    transfer_interval_s: Optional[int] = Field(default=None, ge=30)
    indicator_interval_s: Optional[int] = Field(default=None, ge=30)
    min_position_funds: Optional[float] = Field(default=None, ge=0)
    deploy_available_funds: Optional[bool] = None
    deploy_target: Optional[str] = Field(default=None, pattern="^(most_bearish|most_bullish|most_held|least_held|specific)$")
    deploy_target_symbol: Optional[str] = None


@router.get("/manager/state")
async def get_manager_state():
    """Return current portfolio manager state + settings."""
    from app.services.portfolio_manager import get_manager_state
    return get_manager_state()


@router.patch("/manager/settings")
async def update_manager_settings(req: PortfolioManagerSettingsRequest):
    """Update one or more portfolio manager settings."""
    from app.services.portfolio_manager import update_manager_settings
    payload = {k: v for k, v in req.model_dump().items() if v is not None}
    return update_manager_settings(payload)


@router.post("/manager/toggle")
async def toggle_manager():
    """Toggle the portfolio manager on/off."""
    from app.services.portfolio_manager import get_manager_settings, update_manager_settings
    current = get_manager_settings()
    new_enabled = not current["enabled"]
    return update_manager_settings({"enabled": new_enabled})


# ── export / import / reset ───────────────────────────────────────────────── #

@router.get("/export")
async def export_sandbox(db: AsyncSession = Depends(get_db)):
    """Download the full sandbox state as a JSON snapshot."""
    account = await _get_account(db)

    pos_res = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    positions = pos_res.scalars().all()

    trades_res = await db.execute(select(SandboxTrade).order_by(SandboxTrade.created_at))
    trades = trades_res.scalars().all()

    snapshot = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "version": 1,
        "account": {
            "total_funds": account.total_funds,
        },
        "positions": [
            {
                "symbol": p.symbol,
                "allocated_funds": p.allocated_funds,
                "shares": p.shares,
                "avg_cost": p.avg_cost,
                "strategy_name": p.strategy_name,
                "realized_pnl": p.realized_pnl,
                "is_on_watchlist": p.is_on_watchlist,
            }
            for p in positions
        ],
        "trades": [
            {
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
        ],
    }

    filename = f"sandbox_export_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json"
    return JSONResponse(
        content=snapshot,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import")
async def import_sandbox(file: UploadFile = File(...), db: AsyncSession = Depends(get_db)):
    """
    Upload a previously exported JSON snapshot to restore a sandbox state.
    This REPLACES the current sandbox data entirely.
    """
    try:
        raw = await file.read()
        snapshot = json.loads(raw)
    except Exception:
        raise HTTPException(400, "Invalid JSON file.")

    if snapshot.get("version") != 1:
        raise HTTPException(400, "Unsupported snapshot version.")

    # Wipe existing data
    await db.execute(delete(SandboxTrade))
    await db.execute(delete(SandboxPosition))
    await db.execute(delete(SandboxAccount))
    await db.flush()

    # Restore account
    acc_data = snapshot.get("account", {})
    account = SandboxAccount(total_funds=acc_data.get("total_funds", 0.0))
    db.add(account)

    # Restore positions
    for p in snapshot.get("positions", []):
        pos = SandboxPosition(
            symbol=p["symbol"],
            allocated_funds=p.get("allocated_funds", 0.0),
            shares=p.get("shares", 0.0),
            avg_cost=p.get("avg_cost", 0.0),
            strategy_name=p.get("strategy_name"),
            realized_pnl=p.get("realized_pnl", 0.0),
            is_on_watchlist=p.get("is_on_watchlist", True),
        )
        db.add(pos)

    # Restore trades (preserve original timestamps when available)
    for t in snapshot.get("trades", []):
        created = None
        if t.get("created_at"):
            try:
                created = datetime.fromisoformat(t["created_at"])
            except Exception:
                pass
        trade = SandboxTrade(
            symbol=t["symbol"],
            side=t["side"],
            quantity=t["quantity"],
            price=t["price"],
            total=t["total"],
            strategy_name=t.get("strategy_name"),
            reason=t.get("reason"),
            pnl=t.get("pnl"),
        )
        if created:
            trade.created_at = created
        db.add(trade)

    await db.commit()

    pos_count = len(snapshot.get("positions", []))
    trade_count = len(snapshot.get("trades", []))
    return {
        "status": "ok",
        "imported_positions": pos_count,
        "imported_trades": trade_count,
        "total_funds": account.total_funds,
    }


@router.post("/reset")
async def reset_sandbox(db: AsyncSession = Depends(get_db)):
    """Wipe all sandbox data and start fresh."""
    await db.execute(delete(SandboxTrade))
    await db.execute(delete(SandboxPosition))
    await db.execute(delete(SandboxAccount))
    await db.flush()
    account = SandboxAccount(total_funds=0.0)
    db.add(account)
    await db.commit()
    return {"status": "ok", "message": "Sandbox reset to factory defaults."}
