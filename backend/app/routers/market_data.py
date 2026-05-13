"""Market data endpoints (IB-first when connected, Yahoo fallback)."""
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
    interval: str = Query(default="1d", description="Client display hint; server chooses best interval by period/source"),
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
async def get_movers(
    top_n: int = Query(default=10, ge=1, le=25),
    force: bool = Query(default=False, description="Bypass cache and force a fresh fetch"),
):
    """Return top daily gainers and losers from a liquid-stock universe (cached 5 min)."""
    try:
        return await market_service.get_movers(top_n, force_refresh=force)
    except Exception as exc:
        logger.error("movers failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/news")
async def get_news(
    symbols: str = Query(..., description="Comma-separated watchlist symbols, e.g. AAPL,MSFT"),
    force: bool = Query(default=False, description="Bypass cache and force a fresh fetch"),
):
    """Return merged financial news for watchlist symbols + general market topics (cached 15 min)."""
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not sym_list:
        raise HTTPException(status_code=422, detail="No symbols provided.")
    try:
        return await market_service.get_news(sym_list, force_refresh=force)
    except Exception as exc:
        logger.error("news failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/earnings")
async def get_earnings(
    symbols: str = Query(default="", description="Comma-separated watchlist symbols to prioritise"),
    force: bool = Query(default=False, description="Bypass cache and force a fresh fetch"),
):
    """Return upcoming earnings for a broad universe, watchlist symbols sorted first (cached 15 min)."""
    watchlist = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    try:
        return await market_service.get_earnings(watchlist, force_refresh=force)
    except Exception as exc:
        logger.error("earnings failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
