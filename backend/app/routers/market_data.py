"""Market data endpoints backed by Stooq via market_service (TTL-cached)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from app.services import market_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/market-data", tags=["market-data"])


@router.get("/quote/{symbol}")
async def get_quote(symbol: str):
    """Return the latest quote for *symbol* (cached up to 60 s)."""
    try:
        return await market_service.get_quote(symbol)
    except Exception as exc:
        logger.error("quote failed for %s: %s", symbol.upper(), exc)
        raise HTTPException(status_code=400, detail=f"Could not fetch quote for {symbol.upper()}: {exc}")


@router.get("/bulk-quotes")
async def get_bulk_quotes(
    symbols: str = Query(..., description="Comma-separated list, e.g. AAPL,MSFT,GOOGL"),
):
    """Return quotes for multiple symbols in one request (concurrent, cached)."""
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not sym_list:
        raise HTTPException(status_code=422, detail="No symbols provided.")
    result = await market_service.get_bulk_quotes(sym_list)
    if not result:
        raise HTTPException(status_code=400, detail="Could not fetch any quotes.")
    return result


@router.get("/history/{symbol}")
async def get_history(
    symbol: str,
    period: str = Query(default="1y", description="e.g. 1d 5d 1mo 3mo 6mo 1y 2y"),
    interval: str = Query(default="1d", description="Only 1d supported (Stooq daily data)"),
):
    """Return OHLCV history for *symbol* (cached up to 15 min)."""
    try:
        records = await market_service.get_history(symbol, period)
        return {"symbol": symbol.upper(), "interval": interval, "data": records}
    except Exception as exc:
        logger.error("history failed for %s: %s", symbol.upper(), exc)
        raise HTTPException(status_code=404, detail=f"No data for {symbol.upper()}: {exc}")
