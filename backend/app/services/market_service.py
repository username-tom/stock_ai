"""Async market data service using Yahoo Finance v8 API directly.

Bypasses the yfinance library (which sends headers Yahoo blocks from Docker)
and calls the JSON chart endpoint with a browser User-Agent.  Results are
kept in an in-memory TTL cache to minimise outbound requests and give the
dashboard instant responses after the first load.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# HTTP client config  – browser UA is required; Yahoo rejects scraper agents
# ---------------------------------------------------------------------------

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

_YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"

# period string → Yahoo "range" param
_PERIOD_MAP = {
    "1d": "1d", "5d": "5d", "1mo": "1mo", "3mo": "3mo",
    "6mo": "6mo", "1y": "1y", "2y": "2y", "5y": "5y", "10y": "10y",
}

# ---------------------------------------------------------------------------
# In-memory TTL cache
# ---------------------------------------------------------------------------

class _TTLCache:
    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float]] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str, ttl: float) -> Any | None:
        async with self._lock:
            entry = self._store.get(key)
        if entry is None:
            return None
        value, ts = entry
        return value if (time.monotonic() - ts) < ttl else None

    async def set(self, key: str, value: Any) -> None:
        async with self._lock:
            self._store[key] = (value, time.monotonic())


_cache = _TTLCache()

QUOTE_TTL   = 60      # seconds
HISTORY_TTL = 900     # 15 minutes

# ---------------------------------------------------------------------------
# Yahoo Finance v8 helpers
# ---------------------------------------------------------------------------

async def _yf_chart(symbol: str, range_: str = "5d", interval: str = "1d") -> dict:
    """Fetch the raw Yahoo Finance v8 chart JSON for *symbol*."""
    url = f"{_YF_BASE}/{symbol.upper()}"
    params = {"interval": interval, "range": range_}
    async with httpx.AsyncClient(headers=_HEADERS, timeout=15, follow_redirects=True) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        data = r.json()

    err = data.get("chart", {}).get("error")
    if err:
        raise ValueError(f"Yahoo Finance error for {symbol}: {err}")

    result = data.get("chart", {}).get("result")
    if not result:
        raise ValueError(f"No chart result returned for {symbol}")

    return result[0]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def get_quote(symbol: str) -> dict:
    """Return a quote dict for *symbol*, served from cache when fresh."""
    sym = symbol.upper()
    cached = await _cache.get(f"quote:{sym}", QUOTE_TTL)
    if cached is not None:
        return cached

    chart = await _yf_chart(sym, range_="5d", interval="1d")
    meta = chart["meta"]

    last_price   = meta.get("regularMarketPrice")
    prev_close   = meta.get("chartPreviousClose") or meta.get("previousClose")
    change_pct   = round((last_price - prev_close) / prev_close * 100, 2) if prev_close and last_price else None

    result: dict = {
        "symbol":         sym,
        "last_price":     last_price,
        "previous_close": prev_close,
        "open":           meta.get("regularMarketOpen"),
        "day_high":       meta.get("regularMarketDayHigh"),
        "day_low":        meta.get("regularMarketDayLow"),
        "volume":         meta.get("regularMarketVolume"),
        "market_cap":     None,
        "change_pct":     change_pct,
    }
    await _cache.set(f"quote:{sym}", result)
    return result


async def get_bulk_quotes(symbols: list[str]) -> dict[str, dict]:
    """Fetch quotes for multiple symbols concurrently."""
    async def _safe(sym: str) -> tuple[str, dict | None]:
        try:
            return sym, await get_quote(sym)
        except Exception as exc:
            logger.warning("quote failed for %s: %s", sym, exc)
            return sym, None

    results = await asyncio.gather(*[_safe(s) for s in symbols])
    return {sym: data for sym, data in results if data is not None}


async def get_history(symbol: str, period: str = "1y") -> list[dict]:
    """Return OHLCV records list for *symbol*, served from cache when fresh."""
    sym = symbol.upper()
    cache_key = f"history:{sym}:{period}"
    cached = await _cache.get(cache_key, HISTORY_TTL)
    if cached is not None:
        return cached

    yf_range = _PERIOD_MAP.get(period, "1y")
    chart = await _yf_chart(sym, range_=yf_range, interval="1d")

    timestamps = chart.get("timestamp", [])
    indicators  = chart.get("indicators", {}).get("quote", [{}])[0]
    opens   = indicators.get("open",   [])
    highs   = indicators.get("high",   [])
    lows    = indicators.get("low",    [])
    closes  = indicators.get("close",  [])
    volumes = indicators.get("volume", [])

    records = []
    for i, ts in enumerate(timestamps):
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        records.append({
            "date":   datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d"),
            "open":   round(float(opens[i]),   4) if i < len(opens)   and opens[i]   is not None else None,
            "high":   round(float(highs[i]),   4) if i < len(highs)   and highs[i]   is not None else None,
            "low":    round(float(lows[i]),    4) if i < len(lows)    and lows[i]    is not None else None,
            "close":  round(float(c),          4),
            "volume": int(volumes[i])               if i < len(volumes) and volumes[i] is not None else None,
        })

    if not records:
        raise ValueError(f"No OHLCV data returned for {sym}")

    await _cache.set(cache_key, records)
    return records


async def pre_warm(symbols: list[str], periods: list[str] | None = None) -> None:
    """Pre-populate the cache for *symbols* so the first dashboard load is fast."""
    periods = periods or ["1y"]
    logger.info("Pre-warming market cache for %s …", symbols)

    async def _warm_one(sym: str) -> None:
        try:
            await get_quote(sym)
        except Exception as exc:
            logger.warning("pre-warm quote failed %s: %s", sym, exc)
        for p in periods:
            try:
                await get_history(sym, p)
            except Exception as exc:
                logger.warning("pre-warm history failed %s/%s: %s", sym, p, exc)

    await asyncio.gather(*[_warm_one(s) for s in symbols])
    logger.info("Market cache pre-warm complete.")

