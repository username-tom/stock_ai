"""Sandbox export / import / reset endpoints."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from app.database import get_db
from app.models.sandbox import SandboxAccount, SandboxPosition, SandboxTrade, SandboxAllocationEvent
from app.routers.sandbox_router._helpers import (
    get_account,
    ensure_sandbox_write_allowed,
    offload_simulated_state,
)
from app.services.ib_service import ib_service
from app.services.local_storage import save_portfolio_state
from app.config import settings

router = APIRouter()


@router.get("/export")
async def export_sandbox(db: AsyncSession = Depends(get_db)):
    """Download the full sandbox state as a JSON snapshot."""
    if ib_service.is_connected:
        summary = await ib_service.get_account_summary()
        positions = await ib_service.get_positions()
        mode = settings.TRADING_MODE if settings.TRADING_MODE in {"paper", "live"} else "paper"
        snapshot = {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "version": 2,
            "source": "ib",
            "mode": mode,
            "account_summary": summary,
            "positions": positions,
        }
        save_portfolio_state(mode, snapshot)
        filename = f"ib_{mode}_export_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json"
        return JSONResponse(
            content=snapshot,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    account = await get_account(db)
    pos_res = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    positions = pos_res.scalars().all()
    trades_res = await db.execute(select(SandboxTrade).order_by(SandboxTrade.created_at))
    trades = trades_res.scalars().all()

    snapshot = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "version": 1,
        "account": {"total_funds": account.total_funds},
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
    """Replace sandbox state from a previously exported JSON snapshot."""
    ensure_sandbox_write_allowed()
    try:
        raw = await file.read()
        snapshot = json.loads(raw)
    except Exception:
        raise HTTPException(400, "Invalid JSON file.")

    if snapshot.get("version") != 1:
        raise HTTPException(400, "Unsupported snapshot version.")

    await db.execute(delete(SandboxTrade))
    await db.execute(delete(SandboxPosition))
    await db.execute(delete(SandboxAllocationEvent))
    await db.execute(delete(SandboxAccount))
    await db.flush()

    acc_data = snapshot.get("account", {})
    account = SandboxAccount(total_funds=acc_data.get("total_funds", 0.0))
    db.add(account)

    for p in snapshot.get("positions", []):
        db.add(SandboxPosition(
            symbol=p["symbol"],
            allocated_funds=p.get("allocated_funds", 0.0),
            shares=p.get("shares", 0.0),
            avg_cost=p.get("avg_cost", 0.0),
            strategy_name=p.get("strategy_name"),
            realized_pnl=p.get("realized_pnl", 0.0),
            is_on_watchlist=p.get("is_on_watchlist", True),
        ))

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
    await offload_simulated_state(db)
    return {
        "status": "ok",
        "imported_positions": len(snapshot.get("positions", [])),
        "imported_trades": len(snapshot.get("trades", [])),
        "total_funds": account.total_funds,
    }


@router.post("/reset")
async def reset_sandbox(db: AsyncSession = Depends(get_db)):
    """Wipe all sandbox data and start fresh."""
    ensure_sandbox_write_allowed()
    from app.models.sandbox import SandboxFundEvent
    await db.execute(delete(SandboxTrade))
    await db.execute(delete(SandboxPosition))
    await db.execute(delete(SandboxFundEvent))
    await db.execute(delete(SandboxAllocationEvent))
    await db.execute(delete(SandboxAccount))
    await db.flush()
    db.add(SandboxAccount(total_funds=0.0))
    await db.commit()
    await offload_simulated_state(db)
    return {"status": "ok", "message": "Sandbox reset to factory defaults."}


@router.post("/reset-soft")
async def reset_sandbox_soft(db: AsyncSession = Depends(get_db)):
    """Keep all symbols in the portfolio but reset all shares, costs, PnL, and trades.

    Each position's allocated_funds is preserved so the user's allocation
    structure is maintained.  Total funds is recalculated to equal the sum of
    all allocated funds (available cash becomes zero, ready to trade fresh).
    Strategy assignments and watchlist membership are also preserved.
    """
    ensure_sandbox_write_allowed()
    # Delete all trade history and allocation movements (position state is reset)
    await db.execute(delete(SandboxTrade))
    await db.execute(delete(SandboxAllocationEvent))

    # Reset per-position counters while keeping symbol / allocation / strategy
    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    for pos in positions:
        pos.shares = 0.0
        pos.avg_cost = 0.0
        pos.allocated_funds = 0.0
        pos.realized_pnl = 0.0
        pos.last_signal = None
        pos.last_run_at = None
        pos.engine_error = None
        pos.strategy_enabled = False

    # Restore total_funds from the preserved fund-event log (deposits minus withdrawals).
    # Trades are wiped but deposit history is kept, so total_funds = net deposits.
    from app.models.sandbox import SandboxFundEvent
    account = await get_account(db)
    fund_res = await db.execute(select(SandboxFundEvent))
    fund_events = fund_res.scalars().all()
    net_deposits = round(
        sum(e.amount if e.event_type == "deposit" else -e.amount for e in fund_events), 4
    )
    account.total_funds = net_deposits
    account.total_deposited = round(
        sum(e.amount for e in fund_events if e.event_type == "deposit"), 4
    )

    await db.commit()
    await offload_simulated_state(db)
    return {
        "status": "ok",
        "message": "Portfolio counters reset. Symbols, strategies, and deposit history preserved.",
        "positions_kept": len(positions),
        "total_funds": net_deposits,
    }
