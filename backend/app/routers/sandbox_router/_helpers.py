"""Shared helpers used across sandbox sub-routers."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.sandbox import SandboxAccount, SandboxPosition


async def get_account(db: AsyncSession) -> SandboxAccount:
    result = await db.execute(select(SandboxAccount).limit(1))
    account = result.scalar_one_or_none()
    if account is None:
        account = SandboxAccount(total_funds=0.0)
        db.add(account)
        await db.commit()
        await db.refresh(account)
    return account


def position_dict(p: SandboxPosition, market_price: float | None = None) -> dict:
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
    }
