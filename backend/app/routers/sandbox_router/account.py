"""Account and fund management endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxPosition, SandboxFundEvent
from app.routers.sandbox_router._helpers import get_account
from app.services.local_storage import (
    save_portfolio_activities_csv, save_portfolio_activities_json,
    list_portfolio_activity_files, records_to_csv_bytes, records_to_json_bytes,
)

router = APIRouter()


@router.get("/account")
async def get_account_info(db: AsyncSession = Depends(get_db)):
    account = await get_account(db)
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
    account = await get_account(db)
    account.total_funds += req.amount
    account.total_deposited = (account.total_deposited or 0.0) + req.amount
    db.add(SandboxFundEvent(event_type="deposit", amount=req.amount))
    await db.commit()
    await db.refresh(account)
    return {"total_funds": account.total_funds, "added": req.amount}


class WithdrawFundsRequest(BaseModel):
    amount: float = Field(..., gt=0)


@router.post("/account/withdraw-funds")
async def withdraw_funds(req: WithdrawFundsRequest, db: AsyncSession = Depends(get_db)):
    account = await get_account(db)
    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    allocated = sum(p.allocated_funds for p in positions)
    available = account.total_funds - allocated
    if req.amount > available:
        from fastapi import HTTPException
        raise HTTPException(400, f"Insufficient available funds. Available: ${available:.2f}")
    account.total_funds -= req.amount
    account.total_deposited = max(0.0, (account.total_deposited or 0.0) - req.amount)
    db.add(SandboxFundEvent(event_type="withdrawal", amount=req.amount))
    await db.commit()
    await db.refresh(account)
    return {"total_funds": account.total_funds, "withdrawn": req.amount}


@router.get("/account/fund-events")
async def get_fund_events(limit: int = 200, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SandboxFundEvent).order_by(SandboxFundEvent.created_at.desc()).limit(limit)
    )
    events = result.scalars().all()
    return {"events": [
        {"id": e.id, "event_type": e.event_type, "amount": e.amount, "note": e.note,
         "created_at": e.created_at.isoformat() if e.created_at else None}
        for e in events
    ]}


@router.post("/account/repair-funds")
async def repair_funds(db: AsyncSession = Depends(get_db)):
    """
    Recompute account.total_funds and per-position realized_pnl from the
    activity log (fund events + trade records) — the only source of truth.

      net_deposits   = sum(fund_events: deposit) - sum(fund_events: withdrawal)
      realized_pnl   = sum(trades: pnl  where side=SELL)
      correct_total  = net_deposits + realized_pnl

    Also resets pos.realized_pnl for each symbol from its SELL trade history.
    """
    from app.models.sandbox import SandboxTrade

    account = await get_account(db)

    # --- fund events → net deposits ---
    fund_res = await db.execute(select(SandboxFundEvent))
    fund_events = fund_res.scalars().all()
    net_deposits = sum(
        e.amount if e.event_type == "deposit" else -e.amount
        for e in fund_events
    )

    # --- trade history → realized pnl per symbol + total ---
    trades_res = await db.execute(select(SandboxTrade))
    all_trades = trades_res.scalars().all()

    pnl_by_symbol: dict[str, float] = {}
    total_realized_pnl = 0.0
    for t in all_trades:
        if t.side == "SELL" and t.pnl is not None:
            pnl_by_symbol[t.symbol] = pnl_by_symbol.get(t.symbol, 0.0) + t.pnl
            total_realized_pnl += t.pnl

    # --- correct total_funds ---
    correct_total = round(net_deposits + total_realized_pnl, 4)
    old_total = account.total_funds
    account.total_funds = correct_total
    # keep total_deposited in sync with the fund events log
    account.total_deposited = round(
        sum(e.amount for e in fund_events if e.event_type == "deposit"), 4
    )

    # --- correct per-position realized_pnl ---
    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    for pos in positions:
        pos.realized_pnl = round(pnl_by_symbol.get(pos.symbol, 0.0), 4)

    total_allocated = sum(p.allocated_funds for p in positions)

    await db.commit()
    await db.refresh(account)

    return {
        "repaired": True,
        "net_deposits": round(net_deposits, 4),
        "total_realized_pnl": round(total_realized_pnl, 4),
        "total_funds_before": round(old_total, 4),
        "total_funds_after": round(account.total_funds, 4),
        "available_funds": round(account.total_funds - total_allocated, 4),
        "correction": round(correct_total - old_total, 4),
    }


# ---------------------------------------------------------------------------
# Portfolio activity export / local-storage offload
# ---------------------------------------------------------------------------

@router.get("/activities/export")
async def export_portfolio_activities(
    fmt: str = "csv",
    save: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Download all portfolio activities (sandbox trades + fund events) as CSV or JSON.

    - ``fmt``  – ``csv`` (default) or ``json``
    - ``save`` – if ``true``, also persist a copy to local PC storage
    """
    from app.models.sandbox import SandboxTrade

    trades_res = await db.execute(select(SandboxTrade).order_by(SandboxTrade.created_at))
    trades = trades_res.scalars().all()

    events_res = await db.execute(select(SandboxFundEvent).order_by(SandboxFundEvent.created_at))
    events = events_res.scalars().all()

    trade_records = [
        {
            "type": "trade",
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
    event_records = [
        {
            "type": "fund_event",
            "id": e.id,
            "symbol": None,
            "side": e.event_type,
            "quantity": None,
            "price": None,
            "total": e.amount,
            "strategy_name": None,
            "reason": e.note,
            "pnl": None,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in events
    ]
    activities = sorted(
        trade_records + event_records,
        key=lambda x: x["created_at"] or "",
    )

    if save:
        if fmt == "json":
            local_storage.save_portfolio_activities_json(activities)
        else:
            local_storage.save_portfolio_activities_csv(activities)

    if fmt == "json":
        content = local_storage.records_to_json_bytes(activities)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="portfolio_activities.json"'},
        )

    content = local_storage.records_to_csv_bytes(activities)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="portfolio_activities.csv"'},
    )


@router.get("/activities/local-storage/files")
async def list_portfolio_activity_files():
    """List all portfolio activity files saved to local PC storage."""
    return {"files": local_storage.list_portfolio_activity_files()}
