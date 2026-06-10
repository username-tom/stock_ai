"""Account and fund management endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.database import get_db
from app.models.sandbox import SandboxPosition, SandboxFundEvent, SandboxAllocationEvent
from app.routers.sandbox_router._helpers import (
    get_account,
    compute_available_cash,
    ensure_sandbox_write_allowed,
    offload_simulated_state,
)
from app.services.ib_service import ib_service
from app.services.local_storage import (
    save_portfolio_activities_csv, save_portfolio_activities_json,
    list_portfolio_activity_files, records_to_csv_bytes, records_to_json_bytes, save_portfolio_state,
)

router = APIRouter()


def _sum_position_max_allocations(
    positions: list[SandboxPosition],
    percent_base_total: float | None,
) -> float | None:
    total = 0.0
    has_any_cap = False
    base_total = float(percent_base_total or 0.0)
    for pos in positions:
        cap_value = float(getattr(pos, "max_allocation_value", 0.0) or 0.0)
        if cap_value <= 0.0:
            continue
        mode = str(getattr(pos, "max_allocation_mode", "dollar") or "dollar").lower()
        if mode == "percent":
            if base_total <= 0.0:
                continue
            total += base_total * (cap_value / 100.0)
        else:
            total += cap_value
        has_any_cap = True
    if not has_any_cap:
        return None
    return round(max(0.0, total), 4)


@router.get("/account")
async def get_account_info(
    profile: Optional[str] = Query(default=None, pattern=r"^(simulated|paper|live)$"),
    db: AsyncSession = Depends(get_db),
):
    requested_profile = (profile or (settings.TRADING_MODE if ib_service.is_connected else "simulated") or "simulated").lower()
    use_ib = requested_profile in {"paper", "live"} and ib_service.is_connected

    if use_ib:
        summary = await ib_service.get_account_summary()

        def _to_float(*tags: str) -> float | None:
            if not isinstance(summary, dict):
                return None
            for tag in tags:
                node = summary.get(tag)
                if isinstance(node, dict):
                    value = node.get("value")
                else:
                    value = node
                try:
                    if value is not None:
                        return float(str(value).replace(",", "").strip())
                except (TypeError, ValueError):
                    continue
            return None

        # Strict IB-backed values for most fields. For paper mode only,
        # total_funds is overridden by configured allocation caps.
        ib_net_liq = _to_float("NetLiquidation")
        total_funds = ib_net_liq
        total_funds_source = "ib_net_liq"
        available_funds = _to_float("AvailableFunds")
        buying_power = _to_float("BuyingPower")
        cash_value = _to_float("TotalCashValue")
        equity = _to_float("GrossPositionValue")
        unrealized_pnl = _to_float("UnrealizedPnL")
        realized_pnl = _to_float("RealizedPnL")

        if requested_profile == "paper":
            positions_res = await db.execute(
                select(SandboxPosition).where(SandboxPosition.is_on_watchlist.is_(True))
            )
            local_positions = positions_res.scalars().all()
            cap_total = _sum_position_max_allocations(local_positions, ib_net_liq)
            if cap_total is not None and cap_total > 0:
                total_funds = cap_total
                total_funds_source = "paper_max_allocation_sum"

        # Fallback only when GrossPositionValue is unavailable.
        if equity is None and ib_net_liq is not None and available_funds is not None:
            equity = max(0.0, ib_net_liq - available_funds)

        mode = requested_profile if requested_profile in {"paper", "live"} else "paper"
        save_portfolio_state(mode, {
            "source": "ib",
            "mode": mode,
            "account_summary": summary,
            # Keep account snapshots lightweight; positions are captured by
            # /sandbox/positions and trading snapshots.
            "positions": [],
        })

        # IB's authoritative account-level PnL (reqPnL): today's realized,
        # today's total (daily), and current unrealized. These match what TWS
        # shows and are preferred over our derived trade-ledger calculations.
        ib_pnl = await ib_service.get_account_pnl()
        ib_daily_pnl = None
        ib_realized_today = None
        ib_unrealized_live = None
        if isinstance(ib_pnl, dict) and not ib_pnl.get("error"):
            ib_daily_pnl = ib_pnl.get("daily_pnl")
            ib_realized_today = ib_pnl.get("realized_pnl")
            ib_unrealized_live = ib_pnl.get("unrealized_pnl")
        # Prefer IB's live unrealized PnL when available.
        if ib_unrealized_live is not None:
            unrealized_pnl = ib_unrealized_live

        return {
            "total_funds": round(total_funds, 4) if total_funds is not None else None,
            "total_funds_source": total_funds_source,
            "total_funds_ib_net_liq": round(ib_net_liq, 4) if ib_net_liq is not None else None,
            "allocated_funds": round(equity, 4) if equity is not None else None,
            "equity": round(equity, 4) if equity is not None else None,
            "available_funds": round(available_funds, 4) if available_funds is not None else None,
            "buying_power": round(buying_power, 4) if buying_power is not None else None,
            "cash_value": round(cash_value, 4) if cash_value is not None else None,
            "unrealized_pnl": round(unrealized_pnl, 4) if unrealized_pnl is not None else None,
            "realized_pnl": round(realized_pnl, 4) if realized_pnl is not None else None,
            "ib_daily_pnl": round(ib_daily_pnl, 4) if ib_daily_pnl is not None else None,
            "ib_realized_today": round(ib_realized_today, 4) if ib_realized_today is not None else None,
            "updated_at": None,
            "source": "ib",
            "profile": mode,
        }

    account = await get_account(db)
    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    allocated = sum(p.allocated_funds for p in positions)
    equity = sum(p.shares * p.avg_cost for p in positions)
    available = await compute_available_cash(db, account, positions)
    return {
        "total_funds": account.total_funds,
        "allocated_funds": round(allocated, 4),
        "equity": round(equity, 4),
        "available_funds": available,
        "updated_at": account.updated_at.isoformat() if account.updated_at else None,
    }


class AddFundsRequest(BaseModel):
    amount: float = Field(..., gt=0)


@router.post("/account/add-funds")
async def add_funds(req: AddFundsRequest, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
    account = await get_account(db)
    account.total_funds += req.amount
    account.total_deposited = (account.total_deposited or 0.0) + req.amount
    db.add(SandboxFundEvent(event_type="deposit", amount=req.amount))
    await db.commit()
    await db.refresh(account)
    # Recompute available after deposit
    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    available = await compute_available_cash(db, account, positions)
    await offload_simulated_state(db)
    return {
        "total_funds": account.total_funds,
        "available_funds": available,
        "added": req.amount,
    }


class WithdrawFundsRequest(BaseModel):
    amount: float = Field(..., gt=0)


@router.post("/account/withdraw-funds")
async def withdraw_funds(req: WithdrawFundsRequest, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
    from fastapi import HTTPException
    account = await get_account(db)
    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    available = await compute_available_cash(db, account, positions)
    allocated = sum(p.allocated_funds for p in positions)
    if req.amount > available:
        raise HTTPException(
            400,
            f"Insufficient available funds. "
            f"Available: ${available:.2f}, Requested: ${req.amount:.2f}. "
            f"Note: ${allocated:.2f} is allocated to positions and cannot be withdrawn."
        )
    account.total_funds -= req.amount
    account.total_deposited = max(0.0, (account.total_deposited or 0.0) - req.amount)
    db.add(SandboxFundEvent(event_type="withdrawal", amount=req.amount))
    await db.commit()
    await db.refresh(account)
    new_available = await compute_available_cash(db, account, positions)
    await offload_simulated_state(db)
    return {
        "total_funds": account.total_funds,
        "available_funds": round(new_available, 4),
        "withdrawn": req.amount,
    }


@router.get("/account/fund-events")
async def get_fund_events(limit: int = 200, db: AsyncSession = Depends(get_db)):
    fund_res = await db.execute(
        select(SandboxFundEvent).order_by(SandboxFundEvent.created_at.desc()).limit(limit)
    )
    alloc_res = await db.execute(
        select(SandboxAllocationEvent).order_by(SandboxAllocationEvent.created_at.desc()).limit(limit)
    )
    fund_events = fund_res.scalars().all()
    alloc_events = alloc_res.scalars().all()

    events = [
        {
            "id": f"f-{e.id}",
            "event_type": e.event_type,
            "amount": e.amount,
            "note": e.note,
            "from_symbol": None,
            "to_symbol": None,
            "created_at": e.created_at.astimezone().isoformat() if e.created_at else None,
        }
        for e in fund_events
    ] + [
        {
            "id": f"a-{e.id}",
            "event_type": e.event_type,
            "amount": e.amount,
            "note": e.note,
            "from_symbol": e.from_symbol,
            "to_symbol": e.to_symbol,
            "created_at": e.created_at.astimezone().isoformat() if e.created_at else None,
        }
        for e in alloc_events
    ]
    events.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return {"events": events[:limit]}


@router.post("/account/repair-funds")
async def repair_funds(db: AsyncSession = Depends(get_db)):
    """Rebuild all account and position state by replaying the full activity
    log in chronological order.

    Replay order:
      1. SandboxFundEvent  (deposit / withdrawal)   → total_funds
      2. SandboxAllocationEvent (allocate / deallocate / reallocate / deploy)
         → per-position allocated_funds, total_funds unchanged (reallocate
           keeps total constant; allocate/deallocate move between pool and pos)
      3. SandboxTrade  (BUY / SELL)
         → per-position shares, avg_cost, allocated_funds, realized_pnl
         → total_funds only changes on SELL (gains/losses realized)

    After replay the live DB values are updated to match.
    """
    ensure_sandbox_write_allowed()
    from app.models.sandbox import SandboxTrade

    account = await get_account(db)

    # ── load all events ────────────────────────────────────────────────── #
    fund_res = await db.execute(
        select(SandboxFundEvent).order_by(SandboxFundEvent.created_at)
    )
    fund_events = fund_res.scalars().all()

    alloc_res = await db.execute(
        select(SandboxAllocationEvent).order_by(SandboxAllocationEvent.created_at)
    )
    alloc_events = alloc_res.scalars().all()

    trades_res = await db.execute(
        select(SandboxTrade).order_by(SandboxTrade.created_at)
    )
    all_trades = trades_res.scalars().all()

    positions_res = await db.execute(select(SandboxPosition))
    positions = positions_res.scalars().all()
    known_symbols = {p.symbol for p in positions}

    # ── replay ────────────────────────────────────────────────────────── #
    total_funds: float = 0.0
    # per-symbol state
    alloc: dict[str, float] = {p.symbol: 0.0 for p in positions}
    shares: dict[str, float] = {p.symbol: 0.0 for p in positions}
    avg_cost: dict[str, float] = {p.symbol: 0.0 for p in positions}
    realized_pnl: dict[str, float] = {p.symbol: 0.0 for p in positions}

    # Merge everything into one timeline sorted by created_at
    timeline: list[tuple[str, object]] = (
        [("fund", e) for e in fund_events] +
        [("alloc", e) for e in alloc_events] +
        [("trade", t) for t in all_trades]
    )
    timeline.sort(key=lambda x: (x[1].created_at or ""))

    for kind, evt in timeline:
        if kind == "fund":
            if evt.event_type == "deposit":
                total_funds += evt.amount
            elif evt.event_type == "withdrawal":
                total_funds -= evt.amount

        elif kind == "alloc":
            amt = evt.amount
            etype = evt.event_type
            src = evt.from_symbol   # None = account pool
            dst = evt.to_symbol     # None = account pool

            if etype in ("allocate", "deploy"):
                # pool → position: total_funds unchanged, position alloc grows
                if dst and dst in alloc:
                    alloc[dst] = round(alloc[dst] + amt, 4)

            elif etype == "deallocate":
                # position → pool: total_funds unchanged, position alloc shrinks
                if src and src in alloc:
                    alloc[src] = round(max(0.0, alloc[src] - amt), 4)

            elif etype == "reallocate":
                # position → position: total_funds unchanged
                if src and src in alloc:
                    alloc[src] = round(max(0.0, alloc[src] - amt), 4)
                if dst and dst in alloc:
                    alloc[dst] = round(alloc[dst] + amt, 4)

        elif kind == "trade":
            sym = evt.symbol
            if sym not in known_symbols:
                continue
            if evt.side == "BUY":
                qty = evt.quantity
                cost = evt.total
                new_shares = shares[sym] + qty
                if new_shares > 0:
                    avg_cost[sym] = round(
                        (avg_cost[sym] * shares[sym] + cost) / new_shares, 6
                    )
                shares[sym] = round(new_shares, 6)
                alloc[sym] = round(max(0.0, alloc[sym] - cost), 4)
                # total_funds unchanged — cash is now equity, not gone
            elif evt.side == "SELL":
                qty = evt.quantity
                proceeds = evt.total
                pnl = round((evt.price - avg_cost[sym]) * qty, 4) if avg_cost[sym] else 0.0
                # Use stored pnl if available (more accurate)
                if evt.pnl is not None:
                    pnl = evt.pnl
                shares[sym] = round(max(0.0, shares[sym] - qty), 6)
                if shares[sym] == 0:
                    avg_cost[sym] = 0.0
                alloc[sym] = round(alloc[sym] + proceeds, 4)
                realized_pnl[sym] = round(realized_pnl[sym] + pnl, 4)
                total_funds = round(total_funds + pnl, 4)

    # ── apply to DB ───────────────────────────────────────────────────── #
    old_total = account.total_funds
    account.total_funds = round(total_funds, 4)
    account.total_deposited = round(
        sum(e.amount for e in fund_events if e.event_type == "deposit"), 4
    )

    for pos in positions:
        pos.allocated_funds = alloc[pos.symbol]
        pos.shares = shares[pos.symbol]
        pos.avg_cost = avg_cost[pos.symbol]
        pos.realized_pnl = realized_pnl[pos.symbol]

    await db.commit()
    await db.refresh(account)

    # Compute available after applying repaired state
    positions_res2 = await db.execute(select(SandboxPosition))
    positions_after = positions_res2.scalars().all()
    available = await compute_available_cash(db, account, positions_after)
    await offload_simulated_state(db)

    return {
        "repaired": True,
        "total_funds_before": round(old_total, 4),
        "total_funds_after": round(account.total_funds, 4),
        "available_funds": available,
        "correction": round(account.total_funds - old_total, 4),
        "net_deposits": round(
            sum(e.amount if e.event_type == "deposit" else -e.amount for e in fund_events), 4
        ),
        "total_realized_pnl": round(sum(realized_pnl.values()), 4),
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
            save_portfolio_activities_json(activities)
        else:
            save_portfolio_activities_csv(activities)

    if fmt == "json":
        content = records_to_json_bytes(activities)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="portfolio_activities.json"'},
        )

    content = records_to_csv_bytes(activities)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="portfolio_activities.csv"'},
    )


@router.get("/activities/local-storage/files")
async def list_portfolio_activity_files():
    """List all portfolio activity files saved to local PC storage."""
    return {"files": list_portfolio_activity_files()}
