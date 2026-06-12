"""Shared helpers used across sandbox sub-routers."""
from __future__ import annotations

import asyncio

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.sandbox import SandboxAccount, SandboxPosition, SandboxTrade
from app.services.ib_service import ib_service
from app.services.local_storage import save_portfolio_state


async def get_account(db: AsyncSession) -> SandboxAccount:
    result = await db.execute(select(SandboxAccount).limit(1))
    account = result.scalar_one_or_none()
    if account is None:
        account = SandboxAccount(total_funds=0.0)
        db.add(account)
        await db.commit()
        await db.refresh(account)
    return account


async def compute_available_cash(
    db: AsyncSession | None,
    account: SandboxAccount | None = None,
    positions: list[SandboxPosition] | None = None,
) -> float:
    """Return the cash that is free to spend.

    Accounting model:
        total_funds   = net cash ledger (deposits - withdrawals + realized P/L)
        allocated     = cash reserved for a position but not yet spent on shares
        equity        = cash already converted to shares  (shares × avg_cost)
        available     = total_funds - allocated - equity

    Both ``allocated`` and ``equity`` represent cash that has already been
    committed, so subtracting only ``allocated`` (as the old code did) would
    ignore the equity portion and overstate availability after a BUY.
    """
    if account is None:
        account = await get_account(db)
    if positions is None:
        res = await db.execute(select(SandboxPosition))
        positions = res.scalars().all()
    allocated = sum(p.allocated_funds for p in positions)
    equity = sum(p.shares * p.avg_cost for p in positions)
    # Also include pending orders (cash committed to open orders not yet settled)
    pending_equity = sum(p.pending_shares * p.pending_avg_cost for p in positions)
    available = account.total_funds - allocated - equity - pending_equity
    return round(max(0.0, available), 4)


async def fetch_ib_market_prices(symbols: list[str]) -> dict[str, float]:
    requested = [str(symbol or "").upper().strip() for symbol in symbols if str(symbol or "").strip()]
    if not requested or not ib_service.is_connected:
        return {}

    try:
        from app.services.top_of_book import get_ib_top_of_book

        prices: dict[str, float] = {}
        missing = list(dict.fromkeys(requested))
        for attempt in range(3):
            if not missing:
                break
            books = await asyncio.gather(*[get_ib_top_of_book(symbol) for symbol in missing])
            next_missing: list[str] = []
            for symbol, book in zip(missing, books):
                if not isinstance(book, dict):
                    next_missing.append(symbol)
                    continue
                price = book.get("last_price")
                if price is None:
                    price = book.get("close")
                try:
                    numeric_price = float(price)
                except (TypeError, ValueError):
                    next_missing.append(symbol)
                    continue
                if numeric_price > 0:
                    prices[symbol] = numeric_price
                else:
                    next_missing.append(symbol)
            missing = next_missing
            if missing and attempt < 2:
                await asyncio.sleep(0.25)
        return prices
    except Exception:
        return {}


def position_dict(p: SandboxPosition, market_price: float | None = None) -> dict:
    runtime_status: dict = {}
    try:
        from app.services.sandbox_engine import get_symbol_runtime_status
        runtime_status = get_symbol_runtime_status(p.symbol)
    except Exception:
        runtime_status = {}

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
        "pm_managed": bool(getattr(p, "pm_managed", False)),
        "last_signal": p.last_signal,
        "last_run_at": p.last_run_at.isoformat() if p.last_run_at else None,
        "engine_error": p.engine_error,
        "realized_pnl": p.realized_pnl,
        "total_invested": p.total_invested,
        "unrealized_pnl": round(unrealised_pnl, 4),
        "market_value": round(market_val, 4),
        "is_on_watchlist": p.is_on_watchlist,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "pending_shares": p.pending_shares,
        "pending_avg_cost": p.pending_avg_cost,
        "pending_since": p.pending_since.isoformat() if p.pending_since else None,
        "pending_reroll_active": bool(runtime_status.get("pending_reroll_active", False)),
        "pending_reroll_side": runtime_status.get("pending_reroll_side"),
        "pending_reroll_attempts": int(runtime_status.get("pending_reroll_attempts") or 0),
        "pending_reroll_in_range": runtime_status.get("pending_reroll_in_range"),
        "pending_reroll_last_result": runtime_status.get("pending_reroll_last_result"),
        "pending_reroll_last_at": runtime_status.get("pending_reroll_last_at"),
        "max_allocation_mode": getattr(p, "max_allocation_mode", "dollar") or "dollar",
        "max_allocation_value": getattr(p, "max_allocation_value", None),
        "sentiment_mode": getattr(p, "sentiment_mode", None),
    }


def ensure_sandbox_write_allowed(*, allow_while_ib: bool = False) -> None:
    """Reject sandbox mutations while IB is connected unless explicitly allowed."""
    if ib_service.is_connected and not allow_while_ib:
        raise HTTPException(
            status_code=409,
            detail="Sandbox writes are disabled while IB is connected. Disconnect IB to edit simulated portfolio.",
        )


async def build_simulated_state_snapshot(db: AsyncSession) -> dict:
    """Build a full snapshot of the current simulated portfolio state."""
    account = await get_account(db)
    pos_res = await db.execute(select(SandboxPosition).order_by(SandboxPosition.symbol))
    positions = pos_res.scalars().all()
    tr_res = await db.execute(select(SandboxTrade).order_by(SandboxTrade.created_at))
    trades = tr_res.scalars().all()

    return {
        "profile": "simulated",
        "account": {
            "total_funds": account.total_funds,
            "total_deposited": account.total_deposited,
            "updated_at": account.updated_at.isoformat() if account.updated_at else None,
        },
        "positions": [position_dict(p) for p in positions],
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
        ],
    }


async def offload_simulated_state(db: AsyncSession) -> str:
    """Persist the simulated portfolio snapshot to local storage."""
    snapshot = await build_simulated_state_snapshot(db)
    return save_portfolio_state("simulated", snapshot)


async def reconcile_ib_realized_pnl(db: AsyncSession, mode) -> int:
    """Backfill local trade-ledger pnl from IB's own per-execution realized PnL.

    IB's ``commissionReport.realizedPNL`` is the authoritative realized result
    (IB cost basis, FIFO, commissions) that matches the TWS account window. Most
    IB SELL fills are recorded locally with ``pnl=None`` by the PM/engine, so the
    realized cards previously had to exclude them. This joins today's IB
    executions back to the FILLED SELL ``Trade`` rows (by ib_order_id) and writes
    the real pnl, making the ledger match IB. IB only returns current-day
    executions, so this runs incrementally each poll and accumulates over time.

    Returns the number of rows updated.
    """
    from app.models.trade import Trade, OrderSide, OrderStatus

    if not ib_service.is_connected:
        return 0

    try:
        executions = await ib_service.get_executions()
    except Exception:
        return 0
    if not executions:
        return 0

    # Aggregate IB realized pnl per order id across partial fills (SELLs only).
    realized_by_order: dict[int, float] = {}
    for ex in executions:
        if str(ex.get("side") or "").upper() != "SELL":
            continue
        rp = ex.get("realized_pnl")
        oid = int(ex.get("order_id") or 0)
        if rp is None or oid <= 0:
            continue
        realized_by_order[oid] = round(realized_by_order.get(oid, 0.0) + float(rp), 4)

    if not realized_by_order:
        return 0

    res = await db.execute(
        select(Trade).where(
            Trade.mode == mode,
            Trade.side == OrderSide.SELL,
            Trade.status == OrderStatus.FILLED,
            Trade.ib_order_id.in_(list(realized_by_order.keys())),
        )
    )
    rows = res.scalars().all()
    updated = 0
    for row in rows:
        target = realized_by_order.get(int(row.ib_order_id or 0))
        if target is None:
            continue
        # Only write when missing or materially different to avoid churn.
        if row.pnl is None or abs(float(row.pnl) - target) > 1e-6:
            row.pnl = target
            updated += 1
    if updated:
        await db.commit()
    return updated

