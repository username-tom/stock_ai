"""Sandbox router package — assembles sub-routers into a single router."""
from fastapi import APIRouter

from app.routers.sandbox_router import account, positions, trades, engine, snapshot, learner

router = APIRouter(prefix="/api/sandbox", tags=["sandbox"])

router.include_router(account.router)
router.include_router(positions.router)
router.include_router(trades.router)
router.include_router(engine.router)
router.include_router(snapshot.router)
router.include_router(learner.router)
