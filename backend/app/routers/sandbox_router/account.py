"""Account and fund management endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxPosition
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
    await db.commit()
    await db.refresh(account)
    return {"total_funds": account.total_funds, "added": req.amount}
