"""Account and fund management endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxPosition, SandboxFundEvent
from app.routers.sandbox_router._helpers import get_account

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
