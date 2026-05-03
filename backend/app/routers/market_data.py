"""Market data endpoints backed by Stooq via market_service (TTL-cached)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from app.services import market_service, symbol_registry

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
        result = await market_service.get_history(symbol, period)
        return {"symbol": symbol.upper(), "interval": interval, **result}
    except Exception as exc:
        logger.error("history failed for %s: %s", symbol.upper(), exc)
        raise HTTPException(status_code=404, detail=f"No data for {symbol.upper()}: {exc}")


@router.get("/search")
async def search_symbols(
    q: str = Query(..., min_length=1, description="Symbol prefix or name substring"),
    limit: int = Query(default=10, ge=1, le=25),
):
    """Search the local symbol registry by ticker prefix or company name."""
    return symbol_registry.search(q, limit)


@router.get("/movers")
async def get_movers(top_n: int = Query(default=10, ge=1, le=25)):
    """Return top daily gainers and losers from a liquid-stock universe (cached 5 min)."""
    try:
        return await market_service.get_movers(top_n)
    except Exception as exc:
        logger.error("movers failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
