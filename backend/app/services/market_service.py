"""Async market data service using Yahoo Finance v8 API directly.

Bypasses the yfinance library (which sends headers Yahoo blocks from Docker)
and calls the JSON chart endpoint with a browser User-Agent.  Results are
kept in an in-memory TTL cache to minimise outbound requests and give the
dashboard instant responses after the first load.

A disk cache (backend/data/market_cache/) is also maintained so that the
in-memory cache survives container restarts — the last known values are
served immediately on startup while fresh data is fetched in the background.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import zoneinfo
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from app.services import symbol_registry

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

# period string → Yahoo "range" param ("2w" fetched as 1mo then trimmed)
_PERIOD_RANGE_MAP: dict[str, str] = {
    "1d":  "5d",  "2d":  "5d",  "5d":  "5d",  "2w":  "5d",
    "1mo": "1mo", "3mo": "3mo", "6mo": "6mo",
    "1y":  "1y",  "2y":  "2y",  "5y":  "5y",  "max": "max",
}

# period string → Yahoo "interval" param
_PERIOD_INTERVAL_MAP: dict[str, str] = {
    "1d":  "1m",  "2d":  "1m",  "5d":  "15m", "2w":  "15m",
    "1mo": "1d",  "3mo": "1d",  "6mo": "1d",
    "1y":  "1d",  "2y":  "1d",  "5y":  "1wk", "max": "1mo",
}

# History TTL per period (seconds)
_HISTORY_TTL_MAP: dict[str, float] = {
    "1d": 60, "2d": 60,  "5d": 300, "2w": 300,
    "1mo": 900, "3mo": 900, "6mo": 900,
    "1y": 900, "2y": 900, "5y": 900, "max": 900,
}

# ---------------------------------------------------------------------------
# Disk + in-memory TTL cache
# ---------------------------------------------------------------------------

_DISK_CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "market_cache"

def _key_to_filename(key: str) -> Path:
    """Convert a cache key like 'quote:AAPL' to a safe filename."""
    safe = key.replace(":", "__").replace("/", "_")
    return _DISK_CACHE_DIR / f"{safe}.json"


class _TTLCache:
    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float]] = {}
        self._lock = asyncio.Lock()

    def load_from_disk(self) -> None:
        """Load all persisted cache entries from disk into memory at startup."""
        if not _DISK_CACHE_DIR.exists():
            return
        now_wall = time.time()
        now_mono = time.monotonic()
        for path in _DISK_CACHE_DIR.glob("*.json"):
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
                key = entry["key"]
                value = entry["value"]
                saved_wall = entry["wall_ts"]
                # Convert the wall-clock save time to an equivalent monotonic timestamp
                age = now_wall - saved_wall          # seconds elapsed since save
                mono_ts = now_mono - age             # equivalent monotonic point in the past
                self._store[key] = (value, mono_ts)
            except Exception:
                pass  # corrupt file — ignore

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
        # Persist to disk (non-blocking)
        asyncio.get_event_loop().run_in_executor(None, self._write_disk, key, value)

    def _write_disk(self, key: str, value: Any) -> None:
        try:
            _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path = _key_to_filename(key)
            payload = {"key": key, "value": value, "wall_ts": time.time()}
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            logger.debug("Disk cache write failed for %s: %s", key, exc)


_cache = _TTLCache()

QUOTE_TTL = 60  # seconds

# ---------------------------------------------------------------------------
# Persistent HTTP client – reuses connections for lower latency
# ---------------------------------------------------------------------------

_http_client: httpx.AsyncClient | None = None

def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            headers=_HEADERS,
            timeout=15,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _http_client

# ---------------------------------------------------------------------------
# Yahoo Finance v8 helpers
# ---------------------------------------------------------------------------

async def _yf_chart(symbol: str, range_: str = "5d", interval: str = "1d", include_pre_post: bool = False) -> dict:
    """Fetch the raw Yahoo Finance v8 chart JSON for *symbol*."""
    url = f"{_YF_BASE}/{symbol.upper()}"
    params: dict = {"interval": interval, "range": range_}
    if include_pre_post:
        params["includePrePost"] = "true"
    client = _get_http_client()
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
    market_state = meta.get("marketState", "CLOSED")   # REGULAR | PRE | POST | CLOSED

    reg_info     = symbol_registry.lookup(sym)
    company_name = (
        reg_info["name"] if reg_info
        else meta.get("shortName") or meta.get("longName")
    )

    result: dict = {
        "symbol":         sym,
        "company_name":   company_name,
        "last_price":     last_price,
        "previous_close": prev_close,
        "open":           meta.get("regularMarketOpen"),
        "day_high":       meta.get("regularMarketDayHigh"),
        "day_low":        meta.get("regularMarketDayLow"),
        "volume":         meta.get("regularMarketVolume"),
        "market_cap":     None,
        "change_pct":     change_pct,
        "market_state":   market_state,
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


_ET = zoneinfo.ZoneInfo("America/New_York")

def _fmt_ts(ts: int, intraday: bool, period: str) -> str:
    """Format a Unix timestamp to a display string for the chart X-axis."""
    tz = _ET
    dt = datetime.fromtimestamp(ts, tz=tz)
    if not intraday:
        return dt.strftime("%Y-%m-%d")
    # 1d spans 2 calendar days so include the date for uniqueness
    return dt.strftime("%m/%d %H:%M")


async def get_history(symbol: str, period: str = "1y") -> list[dict]:
    """Return OHLCV records list for *symbol*, served from cache when fresh."""
    sym = symbol.upper()
    cache_key = f"history:{sym}:{period}"
    ttl = _HISTORY_TTL_MAP.get(period, 900)
    cached = await _cache.get(cache_key, ttl)
    if cached is not None:
        return cached

    yf_range    = _PERIOD_RANGE_MAP.get(period, "1y")
    yf_interval = _PERIOD_INTERVAL_MAP.get(period, "1d")
    intraday    = "m" in yf_interval or "h" in yf_interval

    chart = await _yf_chart(sym, range_=yf_range, interval=yf_interval, include_pre_post=(period in ("1d", "2d")))

    timestamps = chart.get("timestamp", [])
    indicators  = chart.get("indicators", {}).get("quote", [{}])[0]
    opens   = indicators.get("open",   [])
    highs   = indicators.get("high",   [])
    lows    = indicators.get("low",    [])
    closes  = indicators.get("close",  [])
    volumes = indicators.get("volume", [])

    meta = chart.get("meta", {})
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")

    records = []
    for i, ts in enumerate(timestamps):
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        records.append({
            "date":   _fmt_ts(ts, intraday, period),
            "open":   round(float(opens[i]),   4) if i < len(opens)   and opens[i]   is not None else None,
            "high":   round(float(highs[i]),   4) if i < len(highs)   and highs[i]   is not None else None,
            "low":    round(float(lows[i]),    4) if i < len(lows)    and lows[i]    is not None else None,
            "close":  round(float(c),          4),
            "volume": int(volumes[i])               if i < len(volumes) and volumes[i] is not None else None,
        })

    if not records:
        raise ValueError(f"No OHLCV data returned for {sym}")

    # "1d"/"2d" are fetched as 5d at 1m with pre/post – keep only the last
    # N trading days. Yahoo never returns weekend bars, so on Saturday/Sunday
    # this naturally surfaces the most recent trading day(s).
    if period in ("1d", "2d"):
        n_days = 1 if period == "1d" else 2
        days_seen: list[str] = []
        for r in records:
            day = r["date"][:5]  # "MM/DD"
            if day not in days_seen:
                days_seen.append(day)
        keep = set(days_seen[-n_days:])
        records = [r for r in records if r["date"][:5] in keep]

    # "2w" is fetched as 1mo – trim to the last 260 bars (10 trading days × 26 fifteen-minute bars)
    if period == "2w":
        records = records[-260:]

    result = {"data": records}
    if period in ("1d", "2d") and prev_close is not None:
        result["prev_close"] = round(float(prev_close), 4)

    await _cache.set(cache_key, result)
    return result


# Liquid large-cap universe used for the movers screen
_MOVERS_UNIVERSE = [
    "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","BRK-B","JPM","V",
    "UNH","XOM","JNJ","WMT","MA","PG","HD","CVX","MRK","ABBV",
    "LLY","AVGO","PEP","KO","COST","PFE","TMO","MCD","ACN","DHR",
    "NKE","BAC","ADBE","INTC","CRM","DIS","NFLX","AMD","QCOM","TXN",
    "SPY","QQQ","IWM","DIA","GLD","SLV","USO","TLT","HYG","VXX",
]

MOVERS_TTL = 300  # 5 minutes


async def get_movers(top_n: int = 10) -> dict:
    """Return the top N daily gainers and losers from a liquid-stock universe."""
    cached = await _cache.get("movers", MOVERS_TTL)
    if cached is not None:
        return cached

    quotes = await get_bulk_quotes(_MOVERS_UNIVERSE)
    ranked = sorted(
        [q for q in quotes.values() if q.get("change_pct") is not None],
        key=lambda q: q["change_pct"],
    )
    result = {
        "losers":  ranked[:top_n],
        "gainers": list(reversed(ranked[-top_n:])),
        "as_of":   datetime.now(tz=timezone.utc).isoformat(),
    }
    await _cache.set("movers", result)
    return result


NEWS_TTL = 900  # 15 minutes

_YF_NEWS_URL = "https://query1.finance.yahoo.com/v1/finance/search"
_YF_EARNINGS_URL = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}"


async def _fetch_symbol_news(symbol: str, count: int = 5) -> list[dict]:
    """Fetch recent news items for a single symbol from Yahoo Finance search API."""
    client = _get_http_client()
    try:
        r = await client.get(
            _YF_NEWS_URL,
            params={"q": symbol, "newsCount": count, "quotesCount": 0, "lang": "en-US"},
        )
        r.raise_for_status()
        items = r.json().get("news", [])
        results = []
        for item in items:
            thumbnail = None
            thumbs = item.get("thumbnail", {}).get("resolutions", [])
            if thumbs:
                thumbnail = thumbs[0].get("url")
            results.append({
                "id":          item.get("uuid"),
                "title":       item.get("title"),
                "url":         item.get("link"),
                "source":      item.get("publisher"),
                "published_at": item.get("providerPublishTime"),
                "thumbnail":   thumbnail,
                "related":     item.get("relatedTickers", []),
                "tags":        [symbol],
                "type":        "news",
            })
        return results
    except Exception as exc:
        logger.warning("news fetch failed for %s: %s", symbol, exc)
        return []


async def _fetch_earnings(symbol: str) -> dict | None:
    """Fetch next earnings date for a symbol via Yahoo Finance quoteSummary."""
    client = _get_http_client()
    try:
        url = _YF_EARNINGS_URL.format(symbol=symbol.upper())
        r = await client.get(url, params={"modules": "calendarEvents"})
        r.raise_for_status()
        data = r.json()
        cal = (
            data.get("quoteSummary", {})
            .get("result", [{}])[0]
            .get("calendarEvents", {})
        )
        earnings_dates = cal.get("earnings", {}).get("earningsDate", [])
        if not earnings_dates:
            return None
        raw_ts = earnings_dates[0].get("raw")
        if raw_ts is None:
            return None
        dt = datetime.fromtimestamp(raw_ts, tz=timezone.utc)
        # Only surface upcoming earnings within the next 30 days
        now = datetime.now(tz=timezone.utc)
        diff_days = (dt - now).days
        if diff_days < 0 or diff_days > 30:
            return None
        return {
            "id":          f"earnings:{symbol}:{raw_ts}",
            "title":       f"{symbol} earnings expected {dt.strftime('%b %d, %Y')}",
            "url":         f"https://finance.yahoo.com/calendar/earnings?symbol={symbol}",
            "source":      "Yahoo Finance",
            "published_at": int(now.timestamp()),
            "thumbnail":   None,
            "related":     [symbol],
            "tags":        [symbol],
            "type":        "earnings",
            "days_until":  diff_days,
        }
    except Exception as exc:
        logger.warning("earnings fetch failed for %s: %s", symbol, exc)
        return None


# Any article whose title or source contains one of these terms (case-insensitive)
# is excluded from the news feed.
_BLOCKED_TERMS = {"cramer", "mad money"}


def _is_blocked(item: dict) -> bool:
    """Return True if the article should be excluded from the feed."""
    text = ((item.get("title") or "") + " " + (item.get("source") or "")).lower()
    return any(term in text for term in _BLOCKED_TERMS)


async def get_news(watchlist: list[str], extra_topics: list[str] | None = None) -> dict:
    """Return merged, deduplicated news for *watchlist* symbols + general market topics."""
    cache_key = f"news:{','.join(sorted(watchlist))}"
    cached = await _cache.get(cache_key, NEWS_TTL)
    if cached is not None:
        return cached

    topics = list(watchlist) + (extra_topics or ["stock market", "S&P 500", "Federal Reserve", "earnings"])

    # Fetch news for watchlist symbols (prioritised) + market topics
    news_tasks = [_fetch_symbol_news(t, count=5) for t in topics]
    earnings_tasks = [_fetch_earnings(s) for s in watchlist]

    news_batches, earnings_results = await asyncio.gather(
        asyncio.gather(*news_tasks),
        asyncio.gather(*earnings_tasks),
    )

    seen_ids: set[str] = set()
    merged: list[dict] = []

    # Earnings notifications first
    for earning in earnings_results:
        if earning and earning["id"] not in seen_ids:
            seen_ids.add(earning["id"])
            merged.append(earning)

    # Watchlist symbol news first (higher priority)
    for i, batch in enumerate(news_batches[:len(watchlist)]):
        for item in batch:
            if item["id"] and item["id"] not in seen_ids and not _is_blocked(item):
                seen_ids.add(item["id"])
                # Mark watchlist-related items
                item["watchlist_match"] = True
                merged.append(item)

    # General market topic news
    for batch in news_batches[len(watchlist):]:
        for item in batch:
            if item["id"] and item["id"] not in seen_ids and not _is_blocked(item):
                seen_ids.add(item["id"])
                merged.append(item)

    # Sort: earnings first, then by recency
    merged.sort(key=lambda x: (x["type"] != "earnings", -(x.get("published_at") or 0)))

    result = {"items": merged, "as_of": datetime.now(tz=timezone.utc).isoformat()}
    await _cache.set(cache_key, result)
    return result


async def get_intraday_df(symbol: str, range_: str = "5d", interval: str = "1m",
                          include_pre_post: bool = False) -> "pd.DataFrame":
    """Return a pandas DataFrame of recent OHLCV bars for *symbol*.

    This is a shared helper used by the sandbox engine and portfolio manager
    so bar-fetching logic lives in one place.
    """
    import pandas as pd  # optional heavy import – kept local

    chart = await _yf_chart(symbol.upper(), range_=range_, interval=interval,
                            include_pre_post=include_pre_post)
    timestamps = chart.get("timestamp", [])
    quotes = chart.get("indicators", {}).get("quote", [{}])[0]

    opens   = quotes.get("open",   [])
    highs   = quotes.get("high",   [])
    lows    = quotes.get("low",    [])
    closes  = quotes.get("close",  [])
    volumes = quotes.get("volume", [])

    rows = []
    for i, ts in enumerate(timestamps):  # noqa: F841 – ts unused but kept for alignment
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        rows.append({
            "Open":   float(opens[i])   if i < len(opens)   and opens[i]   is not None else float(c),
            "High":   float(highs[i])   if i < len(highs)   and highs[i]   is not None else float(c),
            "Low":    float(lows[i])    if i < len(lows)    and lows[i]    is not None else float(c),
            "Close":  float(c),
            "Volume": int(volumes[i])   if i < len(volumes) and volumes[i] is not None else 0,
        })

    if not rows:
        raise ValueError(f"No intraday data returned for {symbol}")

    df = pd.DataFrame(rows)
    df.index = pd.RangeIndex(len(df))
    return df


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

