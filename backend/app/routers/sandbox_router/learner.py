"""Learner insights endpoints — ML-based stock directional tag service."""
from __future__ import annotations

from fastapi import APIRouter

from app.services.stock_learner import classify_symbols, get_learner_history

router = APIRouter()


@router.get("/learner/insights")
async def get_learner_insights(symbols: str = ""):
    requested = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not requested:
        return {"insights": {}}
    try:
        return {"insights": await classify_symbols(requested)}
    except Exception:
        return {"insights": {}}


@router.get("/learner/history/{symbol}")
async def get_learner_history_endpoint(symbol: str):
    return {"history": await get_learner_history(symbol)}
