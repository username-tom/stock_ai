"""Historical data library endpoints.

Exposes read-only views over the locally stored 1-minute intraday cache so the
frontend Data Library tab can browse coverage, IB-verification status, trading
days, and chart-ready history for a date range.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.services.data_provider import (
    DataSource,
    choose_intraday_display_interval,
    list_intraday_cached_symbols,
    load_intraday_history_records,
)
from app.services.market_calendar import is_nyse_trading_day

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/data-library", tags=["data-library"])


@router.get("/symbols")
async def get_cached_symbols():
    """List every symbol with locally stored 1-minute intraday data."""
    symbols = await asyncio.to_thread(list_intraday_cached_symbols)
    return {"symbols": symbols}


@router.get("/trading-days")
async def get_trading_days(
    start: str = Query(..., description="ISO start date, e.g. 2024-01-01"),
    end: str = Query(..., description="ISO end date, e.g. 2024-01-31"),
):
    """Return NYSE trading-day status for each calendar day in the range."""
    try:
        start_d = datetime.strptime(start, "%Y-%m-%d").date()
        end_d = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD.")
    if end_d < start_d:
        raise HTTPException(status_code=422, detail="end must be on or after start.")
    if (end_d - start_d).days > 800:
        raise HTTPException(status_code=422, detail="Range too large (max ~2 years).")

    days: list[dict[str, object]] = []
    cursor = start_d
    while cursor <= end_d:
        days.append({"date": cursor.isoformat(), "trading": is_nyse_trading_day(cursor)})
        cursor += timedelta(days=1)
    return {"days": days}


@router.get("/history")
async def get_history(
    symbol: str = Query(..., description="Ticker symbol, e.g. AAPL"),
    start: str = Query(..., description="ISO start date, e.g. 2024-01-01"),
    end: str = Query(..., description="ISO end date, e.g. 2024-01-31"),
    source: DataSource = Query(default="auto"),
    interval: str | None = Query(default=None, description="Override display interval"),
):
    """Return chart-ready locally cached intraday history for a date range."""
    try:
        start_d = datetime.strptime(start, "%Y-%m-%d").date()
        end_d = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD.")
    if end_d < start_d:
        raise HTTPException(status_code=422, detail="end must be on or after start.")

    result = await asyncio.to_thread(
        load_intraday_history_records,
        symbol,
        start,
        end,
        source,
        interval,
    )
    return result


@router.get("/interval-hint")
async def get_interval_hint(
    start: str = Query(...),
    end: str = Query(...),
):
    """Return the display interval the library would pick for a date range."""
    return {"interval": choose_intraday_display_interval(start, end)}
