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
import re
import time
import zoneinfo
from datetime import datetime, timezone, time as dt_time
from pathlib import Path
from typing import Any

import httpx

from app.services import symbol_registry
from app.services.ib_service import IB_AVAILABLE, ib_service
from app.services.market_calendar import is_nyse_trading_day

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
    "1d":  "5d",  "2d":  "5d",  "5d":  "5d",  "2w":  "1mo",
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
_IB_HIST_DISK_CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "ib_hist_cache"

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
IB_QUOTE_TTL = 5  # seconds
SECTOR_TTL = 86_400  # 24 hours

# IB historical-request hardening: smooth bursts and avoid pacing pressure.
_IB_HIST_MIN_GAP_S = 0.35
_IB_HIST_MAX_CONCURRENCY = 3
_IB_HIST_DEFAULT_LIMIT_GAP_S = 60.0
_IB_HIST_MAX_LIMIT_GAP_S = 600.0
_ib_hist_lock = asyncio.Lock()
_ib_hist_last_ts = 0.0
_ib_hist_semaphore = asyncio.Semaphore(_IB_HIST_MAX_CONCURRENCY)
_ib_hist_dynamic_gap_by_profile: dict[str, float] = {}
_ib_hist_result_cache: dict[str, tuple[list[dict], float]] = {}
_ib_hist_last_restriction_by_profile: dict[str, dict[str, Any]] = {}

# In-flight quote dedupe so concurrent callers for one symbol share one IB fetch.
_ib_quote_inflight: dict[str, asyncio.Task] = {}
_ib_quote_inflight_lock = asyncio.Lock()

# IB history background overlay — updated every 15 min; YF is the instant base.
_IB_HIST_OVERLAY_TTL = 900.0  # seconds (15 minutes)
_ib_hist_overlay_inflight: dict[str, asyncio.Task] = {}
_ib_hist_overlay_lock = asyncio.Lock()

# Long-lived IB volume patch — keeps per-minute IB volume values available for
# the full trading day so the chart shows IB volume even between overlay refreshes.
_IB_VOLUME_PATCH_TTL = 28800.0  # seconds (8 hours)

# ---------------------------------------------------------------------------
# Persistent HTTP client – reuses connections for lower latency
# ---------------------------------------------------------------------------

_http_client: httpx.AsyncClient | None = None
_yf_crumb: str | None = None
_yf_crumb_lock = asyncio.Lock()

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

async def _get_yf_crumb() -> str:
    """Return a valid Yahoo Finance crumb, initialising the cookie session if needed."""
    global _yf_crumb
    if _yf_crumb:
        return _yf_crumb
    async with _yf_crumb_lock:
        if _yf_crumb:
            return _yf_crumb
        client = _get_http_client()
        # Establish a cookie session with Yahoo Finance
        await client.get("https://finance.yahoo.com", headers={
            **_HEADERS, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"
        })
        r = await client.get(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            headers={**_HEADERS, "Accept": "*/*"},
        )
        crumb = r.text.strip()
        if not crumb or "{" in crumb:
            raise RuntimeError(f"Failed to obtain Yahoo Finance crumb: {crumb!r}")
        _yf_crumb = crumb
        return _yf_crumb

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


def _market_state_now() -> str:
    """Return the current US equity session in America/New_York."""
    now_et = datetime.now(tz=_ET)
    if not is_nyse_trading_day(now_et.date()):
        return "CLOSED"

    current_time = now_et.time()
    if dt_time(4, 0) <= current_time < dt_time(9, 30):
        return "PRE"
    if dt_time(9, 30) <= current_time < dt_time(16, 0):
        return "REGULAR"
    if dt_time(16, 0) <= current_time < dt_time(20, 0):
        return "POST"
    return "CLOSED"


def _session_for_dt(dt: datetime) -> str:
    """Classify an intraday bar timestamp into a US equity session."""
    current_time = dt.timetz().replace(tzinfo=None)
    if dt_time(4, 0) <= current_time < dt_time(9, 30):
        return "PRE"
    if dt_time(9, 30) <= current_time < dt_time(16, 0):
        return "REGULAR"
    if dt_time(16, 0) <= current_time < dt_time(20, 0):
        return "POST"
    return "CLOSED"


def _first_non_null(values: list[Any]) -> Any | None:
    for value in values:
        if value is not None:
            return value
    return None


def _build_quote_snapshot(chart: dict) -> dict[str, Any]:
    """Derive a session-aware quote snapshot from Yahoo intraday bars."""
    meta = chart.get("meta", {})
    timestamps = chart.get("timestamp", [])
    indicators = chart.get("indicators", {}).get("quote", [{}])[0]
    opens = indicators.get("open", [])
    highs = indicators.get("high", [])
    lows = indicators.get("low", [])
    closes = indicators.get("close", [])
    volumes = indicators.get("volume", [])

    rows: list[dict[str, Any]] = []
    for i, ts in enumerate(timestamps):
        close = closes[i] if i < len(closes) else None
        if close is None:
            continue

        dt = datetime.fromtimestamp(ts, tz=_ET)
        rows.append({
            "dt": dt,
            "session": _session_for_dt(dt),
            "open": float(opens[i]) if i < len(opens) and opens[i] is not None else None,
            "high": float(highs[i]) if i < len(highs) and highs[i] is not None else None,
            "low": float(lows[i]) if i < len(lows) and lows[i] is not None else None,
            "close": float(close),
            "volume": int(volumes[i]) if i < len(volumes) and volumes[i] is not None else 0,
        })

    if not rows:
        last_price = meta.get("regularMarketPrice")
        prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
        change = (last_price - prev_close) if last_price is not None and prev_close is not None else None
        change_pct = round(change / prev_close * 100, 2) if change is not None and prev_close else None
        return {
            "last_price": last_price,
            "previous_close": prev_close,
            "open": meta.get("regularMarketOpen"),
            "day_high": meta.get("regularMarketDayHigh"),
            "day_low": meta.get("regularMarketDayLow"),
            "volume": meta.get("regularMarketVolume"),
            "change": round(change, 4) if change is not None else None,
            "change_pct": change_pct,
            "market_state": _market_state_now(),
        }

    latest_day = rows[-1]["dt"].date()
    latest_day_rows = [row for row in rows if row["dt"].date() == latest_day]
    pre_rows = [row for row in latest_day_rows if row["session"] == "PRE"]
    regular_rows = [row for row in latest_day_rows if row["session"] == "REGULAR"]
    post_rows = [row for row in latest_day_rows if row["session"] == "POST"]

    market_state = _market_state_now()
    if market_state == "PRE" and pre_rows:
        stats_rows = pre_rows
    elif market_state == "POST" and post_rows:
        stats_rows = post_rows
    elif regular_rows:
        stats_rows = regular_rows
    else:
        stats_rows = latest_day_rows

    highs_in_scope = [row["high"] for row in stats_rows if row["high"] is not None]
    lows_in_scope = [row["low"] for row in stats_rows if row["low"] is not None]
    opens_in_scope = [row["open"] for row in stats_rows]
    session_open = _first_non_null(opens_in_scope)
    last_price = rows[-1]["close"]
    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose")
    change = (last_price - prev_close) if last_price is not None and prev_close is not None else None
    change_pct = round(change / prev_close * 100, 2) if change is not None and prev_close else None

    return {
        "last_price": round(float(last_price), 4) if last_price is not None else None,
        "previous_close": round(float(prev_close), 4) if prev_close is not None else None,
        "open": round(float(session_open), 4) if session_open is not None else None,
        "day_high": round(max(highs_in_scope), 4) if highs_in_scope else None,
        "day_low": round(min(lows_in_scope), 4) if lows_in_scope else None,
        "volume": sum(row["volume"] for row in stats_rows),
        "change": round(change, 4) if change is not None else None,
        "change_pct": change_pct,
        "market_state": market_state,
    }


def _ib_connected() -> bool:
    return bool(IB_AVAILABLE and ib_service.is_connected)


def _ib_data_pull_allowed_now() -> bool:
    """Return True when IB data pulls should run (NYSE extended session)."""
    if not _ib_connected():
        return False

    now_et = datetime.now(tz=_ET)
    if not is_nyse_trading_day(now_et.date()):
        return False

    t = now_et.time()
    return dt_time(4, 0) <= t < dt_time(20, 0)


def _parse_ib_bar_datetime(raw: Any) -> datetime | None:
    text = str(raw).strip()
    for fmt in ("%Y%m%d  %H:%M:%S", "%Y%m%d %H:%M:%S", "%Y%m%d"):
        try:
            dt = datetime.strptime(text, fmt)
            return dt.replace(tzinfo=_ET)
        except ValueError:
            continue
    return None


def _ib_hist_profile_key(bar_size: str, what_to_show: str, use_rth: bool) -> str:
    return f"{bar_size.strip().lower()}|{what_to_show.strip().upper()}|{int(use_rth)}"


def _ib_hist_cache_key(
    symbol: str,
    end_datetime: str,
    duration: str,
    bar_size: str,
    what_to_show: str,
    use_rth: bool,
) -> str:
    return "|".join(
        [
            symbol.upper(),
            end_datetime or "",
            duration.strip().upper(),
            bar_size.strip().lower(),
            what_to_show.strip().upper(),
            str(int(use_rth)),
        ]
    )


def _ib_effective_hist_gap(bar_size: str, what_to_show: str, use_rth: bool) -> float:
    profile = _ib_hist_profile_key(bar_size, what_to_show, use_rth)
    dynamic = _ib_hist_dynamic_gap_by_profile.get(profile, _IB_HIST_MIN_GAP_S)
    return max(_IB_HIST_MIN_GAP_S, dynamic)


def _ib_hist_telemetry(bar_size: str, what_to_show: str, use_rth: bool) -> dict[str, Any]:
    profile = _ib_hist_profile_key(bar_size, what_to_show, use_rth)
    gap_s = _ib_effective_hist_gap(bar_size, what_to_show, use_rth)
    last_restriction = _ib_hist_last_restriction_by_profile.get(profile, {})
    return {
        "bar_size": bar_size,
        "what_to_show": what_to_show,
        "use_rth": use_rth,
        "effective_request_gap_seconds": round(gap_s, 3),
        "pacing_limited": gap_s > (_IB_HIST_MIN_GAP_S + 1e-9),
        "last_pacing_error": last_restriction.get("error"),
        "last_pacing_error_code": last_restriction.get("error_code"),
        "last_pacing_detected_at": last_restriction.get("detected_at"),
    }


def _duration_to_seconds(duration: str) -> float | None:
    match = re.match(r"^\s*(\d+)\s*([SDWMY])\s*$", (duration or "").strip().upper())
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2)
    factors = {
        "S": 1,
        "D": 86_400,
        "W": 7 * 86_400,
        "M": 30 * 86_400,
        "Y": 365 * 86_400,
    }
    return float(amount * factors[unit])


def _seconds_to_duration(seconds: float) -> str:
    total = max(1, int(seconds))
    if total < 86_400:
        return f"{total} S"
    days = max(1, (total + 86_399) // 86_400)
    return f"{days} D"


def _bar_size_to_seconds(bar_size: str) -> float | None:
    text = (bar_size or "").strip().lower()
    fixed = {
        "5 secs": 5.0,
        "1 min": 60.0,
        "2 mins": 120.0,
        "5 mins": 300.0,
        "15 mins": 900.0,
        "1 hour": 3600.0,
        "1 day": 86_400.0,
        "1 week": 7 * 86_400.0,
        "1 month": 30 * 86_400.0,
    }
    return fixed.get(text)


# ---------------------------------------------------------------------------
# IB historical data — persistent disk cache
# Completed (past) bars never change, so we persist them and only fetch
# the incremental gap on each request.  This turns a full "1 Y" IB pull
# into a single-day fetch after the first load.
# ---------------------------------------------------------------------------

def _ib_disk_cache_path(symbol: str, bar_size: str, what_to_show: str, use_rth: bool) -> Path:
    safe_bar = bar_size.strip().lower().replace(" ", "_")
    return _IB_HIST_DISK_CACHE_DIR / f"{symbol.upper()}__{safe_bar}__{what_to_show.upper()}__{int(use_rth)}.json"


def _ib_disk_cache_load(symbol: str, bar_size: str, what_to_show: str, use_rth: bool) -> list[dict]:
    """Return persisted bars from disk, or [] on any error."""
    path = _ib_disk_cache_path(symbol, bar_size, what_to_show, use_rth)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        bars = data.get("bars", [])
        if not isinstance(bars, list):
            return []
        return bars
    except Exception:
        return []


def _ib_disk_cache_save(
    symbol: str, bar_size: str, what_to_show: str, use_rth: bool, bars: list[dict]
) -> None:
    """Persist *bars* to disk (runs in executor — must be thread-safe)."""
    try:
        _IB_HIST_DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _ib_disk_cache_path(symbol, bar_size, what_to_show, use_rth)
        payload = {
            "symbol": symbol.upper(),
            "bar_size": bar_size,
            "what_to_show": what_to_show.upper(),
            "use_rth": int(use_rth),
            "saved_at": time.time(),
            "bars": bars,
        }
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        logger.debug("IB hist disk cache write failed (%s %s): %s", symbol, bar_size, exc)


def _ib_filter_completed_bars(bars: list[dict]) -> list[dict]:
    """Return bars that are safe to persist to the disk cache.

    Only bars from *before* today are considered fully settled.  Today's bars
    may still be in-progress or pacing-delayed, so we never write them to disk.
    This prevents stale/synthetic prices from being baked into the cache.
    """
    today_et = datetime.now(tz=_ET).date()
    past: list[dict] = []
    for bar in bars:
        dt = _parse_ib_bar_datetime(bar.get("date"))
        if dt is None:
            continue
        if dt.astimezone(_ET).date() < today_et:
            past.append(bar)
    return past


def _ib_merge_bars(cached: list[dict], fresh: list[dict]) -> list[dict]:
    """Merge two bar lists, deduplicating by raw date string; *fresh* wins on conflict."""
    merged: dict[str, dict] = {bar["date"]: bar for bar in cached}
    for bar in fresh:
        merged[bar["date"]] = bar
    return sorted(merged.values(), key=lambda b: b["date"])


def _ib_compute_incremental_duration(
    cached_bars: list[dict], full_duration: str, bar_size: str
) -> str:
    """Return the shortest IB duration string needed to top-up cached data.

    For example, if we have daily bars up to yesterday and the full request is
    "1 Y", this returns "3 D" (gap to cover yesterday→today + 2-day buffer)
    instead of the full year — cutting the IB wait dramatically.
    """
    if not cached_bars:
        return full_duration

    latest_dt: datetime | None = None
    for bar in cached_bars:
        dt = _parse_ib_bar_datetime(bar.get("date"))
        if dt is not None and (latest_dt is None or dt > latest_dt):
            latest_dt = dt

    if latest_dt is None:
        return full_duration

    now_et = datetime.now(tz=_ET)
    gap_seconds = max(0.0, (now_et - latest_dt).total_seconds())

    bar_secs = _bar_size_to_seconds(bar_size)
    is_intraday = bar_secs is not None and bar_secs < 86_400

    if is_intraday:
        # For intraday charts, always re-fetch at least today's full session
        # from IB so the live chart stays current.  The disk cache already
        # holds all previous sessions, so this is the only IB work needed.
        needed = max(gap_seconds + (bar_secs or 60) * 10, 86_400.0)
    else:
        # For daily/weekly/monthly bars a 2-day buffer around the gap is enough.
        needed = gap_seconds + 2 * 86_400.0

    full_s = _duration_to_seconds(full_duration)
    if full_s is not None:
        needed = min(needed, full_s)

    incremental = _seconds_to_duration(needed)
    logger.debug(
        "IB disk cache: using incremental duration %s instead of %s for %s",
        incremental, full_duration, bar_size,
    )
    return incremental


def _expand_duration_for_gap(duration: str, bar_size: str, min_gap_s: float) -> str:
    current_s = _duration_to_seconds(duration)
    bar_s = _bar_size_to_seconds(bar_size)
    if current_s is None or bar_s is None:
        return duration

    if bar_s >= 86_400:
        return duration

    target_s = max(current_s, min_gap_s + (bar_s * 2))
    if target_s <= current_s:
        return duration
    return _seconds_to_duration(target_s)


def _ib_extract_wait_seconds_from_error(error: str) -> float | None:
    text = (error or "").lower()

    minute_matches = re.findall(r"(\d+)\s*(?:minute|min)\b", text)
    if minute_matches:
        return float(max(int(m) for m in minute_matches) * 60)

    second_matches = re.findall(r"(\d+)\s*(?:second|sec)\b", text)
    if second_matches:
        return float(max(int(s) for s in second_matches))

    return None


def _ib_is_historical_pacing_error(error_code: int | None, error: str | None) -> bool:
    if error_code in {162, 420}:
        return True
    text = (error or "").lower()
    return "historical" in text and (
        "pacing" in text
        or "too many" in text
        or "limit" in text
        or "exceeded" in text
    )


async def _get_ib_quote(symbol: str) -> dict[str, Any]:
    quote = await ib_service.get_market_data(symbol)
    quote_error = quote.get("error") if isinstance(quote, dict) else None
    if quote_error:
        logger.warning("IB snapshot quote unavailable for %s: %s", symbol, quote_error)

    last_price = quote.get("last") if isinstance(quote, dict) else None
    prev_close = quote.get("close") if isinstance(quote, dict) else None
    open_price = quote.get("open") if isinstance(quote, dict) else None
    day_high = None
    day_low = None
    day_volume = quote.get("volume") if isinstance(quote, dict) else None

    # Only fetch historical fallback when snapshot fields are missing.
    if last_price is None or prev_close is None:
        try:
            intraday = await _ib_historical_request(
                symbol=symbol,
                end_datetime="",
                duration="1800 S",
                bar_size="5 secs",
                what_to_show="TRADES",
                use_rth=False,
            )
            if intraday:
                parsed = []
                for bar in intraday:
                    dt = _parse_ib_bar_datetime(bar.get("date"))
                    if dt is None:
                        continue
                    parsed.append((dt, bar))
                if parsed:
                    parsed.sort(key=lambda x: x[0])
                    last_bar = parsed[-1][1]
                    if last_price is None:
                        last_price = last_bar.get("close")

                    all_days = sorted({dt.astimezone(_ET).date() for dt, _ in parsed})
                    today_et = datetime.now(tz=_ET).date()
                    today_bars = [b for dt, b in parsed if dt.astimezone(_ET).date() == today_et]
                    scope = today_bars or [b for _, b in parsed]
                    if scope:
                        open_price = scope[0].get("open")
                        highs = [float(b["high"]) for b in scope if b.get("high") is not None]
                        lows = [float(b["low"]) for b in scope if b.get("low") is not None]
                        vols = [int(b["volume"]) for b in scope if b.get("volume") is not None]
                        if highs:
                            day_high = max(highs)
                        if lows:
                            day_low = min(lows)
                        if vols:
                            day_volume = sum(vols)

                    if prev_close is None:
                        past_days = [d for d in all_days if d < today_et]
                        if past_days:
                            prev_day = past_days[-1]
                            prev_day_bars = [b for dt, b in parsed if dt.astimezone(_ET).date() == prev_day]
                            if prev_day_bars:
                                prev_close = prev_day_bars[-1].get("close")
        except Exception as exc:
            logger.debug("IB intraday quote fallback failed for %s: %s", symbol, exc)

    # Lightweight final fallback for previous close only.
    if prev_close is None:
        try:
            bars = await _ib_historical_request(
                symbol=symbol,
                end_datetime="",
                duration="3 D",
                bar_size="1 day",
                what_to_show="TRADES",
                use_rth=True,
            )
            if bars:
                _today = datetime.now(tz=_ET).date()
                _last_dt = _parse_ib_bar_datetime(bars[-1].get("date"))
                _last_date = _last_dt.astimezone(_ET).date() if _last_dt else None
                if _last_date == _today and len(bars) >= 2:
                    prev_close = bars[-2].get("close")
                elif _last_date != _today and bars[-1].get("close") is not None:
                    prev_close = bars[-1].get("close")
        except Exception as exc:
            logger.debug("IB daily previous-close fallback failed for %s: %s", symbol, exc)

    if last_price is None:
        raise ValueError(
            f"Failed to retrieve IB quote for {symbol}: no last/close price available"
        )

    change = (
        (float(last_price) - float(prev_close))
        if last_price is not None and prev_close is not None
        else None
    )
    change_pct = (
        round(change / float(prev_close) * 100, 2)
        if change is not None and prev_close not in (None, 0)
        else None
    )

    reg_info = symbol_registry.lookup(symbol)
    company_name = reg_info["name"] if reg_info else symbol
    return {
        "symbol": symbol,
        "company_name": company_name,
        "last_price": round(float(last_price), 4) if last_price is not None else None,
        "previous_close": round(float(prev_close), 4) if prev_close is not None else None,
        "open": round(float(open_price), 4) if open_price is not None else None,
        "day_high": round(float(day_high), 4) if day_high is not None else None,
        "day_low": round(float(day_low), 4) if day_low is not None else None,
        "volume": int(day_volume) if day_volume is not None else None,
        "market_cap": None,
        "change": round(change, 4) if change is not None else None,
        "change_pct": change_pct,
        "market_state": _market_state_now(),
        "ib_telemetry": _ib_hist_telemetry("5 secs", "TRADES", False),
    }


def _ib_period_request(period: str) -> tuple[str, str, bool]:
    mapping: dict[str, tuple[str, str, bool]] = {
        "1d": ("3 D", "1 min", False),
        "2d": ("4 D", "1 min", False),
        "5d": ("10 D", "15 mins", True),
        "2w": ("20 D", "15 mins", True),
        "1mo": ("2 M", "1 day", True),
        "3mo": ("4 M", "1 day", True),
        "6mo": ("7 M", "1 day", True),
        "1y": ("1 Y", "1 day", True),
        "2y": ("2 Y", "1 day", True),
        "5y": ("5 Y", "1 week", True),
        "max": ("10 Y", "1 month", True),
    }
    return mapping.get(period, ("1 Y", "1 day", True))


def _format_dt_for_period(dt: datetime, intraday: bool, period: str) -> str:
    dt_et = dt.astimezone(_ET)
    if not intraday:
        return dt_et.strftime("%Y-%m-%d")
    return dt_et.strftime("%m/%d %H:%M")


async def _get_ib_history(symbol: str, period: str) -> dict[str, Any]:
    duration, bar_size, use_rth = _ib_period_request(period)

    # ------------------------------------------------------------------
    # Disk-cache layer: historical (past) bars never change, so load what
    # we already have and only request the incremental gap from IB.
    # ------------------------------------------------------------------
    cached_raw = _ib_disk_cache_load(symbol, bar_size, "TRADES", use_rth)
    # Strip today's bars from the disk cache before merging.  Old cache files
    # may have been written when the injection code was active, so today's
    # entries could carry stale/synthetic prices.  Fresh IB data always covers
    # today, so this is safe.
    today_et = datetime.now(tz=_ET).date()
    cached_raw = [
        b for b in cached_raw
        if (_parse_ib_bar_datetime(b.get("date")) or datetime.fromtimestamp(0, tz=_ET)).astimezone(_ET).date() < today_et
    ]
    incremental_duration = _ib_compute_incremental_duration(cached_raw, duration, bar_size)

    fresh_bars = await _ib_historical_request(
        symbol=symbol,
        end_datetime="",
        duration=incremental_duration,
        bar_size=bar_size,
        what_to_show="TRADES",
        use_rth=use_rth,
    )

    # Merge fresh IB bars into cached bars; fresh always wins on overlap.
    if fresh_bars or cached_raw:
        merged_raw = _ib_merge_bars(cached_raw, fresh_bars)
        # Persist only completed (past) bars back to disk, non-blocking.
        completed = _ib_filter_completed_bars(merged_raw)
        if completed:
            asyncio.get_event_loop().run_in_executor(
                None,
                lambda: _ib_disk_cache_save(symbol, bar_size, "TRADES", use_rth, completed),
            )
        # Trim to the originally requested duration before formatting.
        full_s = _duration_to_seconds(duration)
        if full_s is not None and len(merged_raw) > 0:
            cutoff = datetime.now(tz=_ET).timestamp() - full_s
            merged_raw = [
                b for b in merged_raw
                if (_parse_ib_bar_datetime(b.get("date")) or datetime.fromtimestamp(0, tz=_ET)).timestamp() >= cutoff
            ]
        bars = merged_raw
    else:
        bars = []

    if not bars:
        raise ValueError(f"No IB OHLCV data returned for {symbol}")

    intraday = "min" in bar_size or "hour" in bar_size
    records: list[dict[str, Any]] = []
    for bar in bars:
        dt = _parse_ib_bar_datetime(bar.get("date"))
        if dt is None:
            continue
        records.append(
            {
                "date": _format_dt_for_period(dt, intraday, period),
                "open": round(float(bar["open"]), 4),
                "high": round(float(bar["high"]), 4),
                "low": round(float(bar["low"]), 4),
                "close": round(float(bar["close"]), 4),
                "volume": int(bar["volume"]) if bar.get("volume") is not None else None,
                "_dt": dt,
            }
        )

    if not records:
        raise ValueError(f"No parseable IB OHLCV data returned for {symbol}")

    result: dict[str, Any] = {"data": records}
    if period in ("1d", "2d"):
        n_days = 1 if period == "1d" else 2
        all_days = sorted({r["_dt"].astimezone(_ET).date() for r in records})
        keep_days = set(all_days[-n_days:])
        prev_days = [d for d in all_days if d not in keep_days]
        prev_close = None
        if prev_days:
            prev_day = prev_days[-1]
            prev_records = [r for r in records if r["_dt"].astimezone(_ET).date() == prev_day]
            if prev_records:
                prev_close = prev_records[-1]["close"]
        records = [r for r in records if r["_dt"].astimezone(_ET).date() in keep_days]
        result["data"] = records
        if prev_close is not None:
            result["prev_close"] = round(float(prev_close), 4)

    if period == "2w":
        result["data"] = result["data"][-260:]

    for row in result["data"]:
        row.pop("_dt", None)

    result["ib_telemetry"] = _ib_hist_telemetry(bar_size, "TRADES", use_rth)
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def get_quote(symbol: str, source_preference: str | None = None) -> dict:
    """Return a quote dict for *symbol*, served from cache when fresh."""
    sym = symbol.upper()
    if source_preference in {"ib", "yf"}:
        source = source_preference
    else:
        source = "ib" if _ib_data_pull_allowed_now() else "yf"
    ttl = IB_QUOTE_TTL if source == "ib" else QUOTE_TTL
    cache_key = f"quote:{source}:{sym}"
    cached = await _cache.get(cache_key, ttl)
    if cached is not None:
        if source == "ib" and isinstance(cached, dict) and "ib_telemetry" not in cached:
            cached["ib_telemetry"] = _ib_hist_telemetry("5 secs", "TRADES", False)
        return cached

    if source == "ib":
        result = await _get_ib_quote_deduped(sym)
        await _cache.set(cache_key, result)
        return result

    chart = await _yf_chart(sym, range_="1d", interval="1m", include_pre_post=True)
    meta = chart["meta"]
    snapshot = _build_quote_snapshot(chart)

    reg_info     = symbol_registry.lookup(sym)
    company_name = (
        reg_info["name"] if reg_info
        else meta.get("shortName") or meta.get("longName")
    )

    result: dict = {
        "symbol":         sym,
        "company_name":   company_name,
        "last_price":     snapshot["last_price"],
        "previous_close": snapshot["previous_close"],
        "open":           snapshot["open"],
        "day_high":       snapshot["day_high"],
        "day_low":        snapshot["day_low"],
        "volume":         snapshot["volume"],
        "market_cap":     None,
        "change":         snapshot["change"],
        "change_pct":     snapshot["change_pct"],
        "market_state":   snapshot["market_state"],
    }
    await _cache.set(cache_key, result)
    return result


async def get_bulk_quotes(symbols: list[str], source_preference: str | None = None) -> dict[str, dict]:
    """Fetch quotes for multiple symbols concurrently."""
    async def _safe(sym: str) -> tuple[str, dict | None]:
        try:
            return sym, await get_quote(sym, source_preference=source_preference)
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


async def _fetch_yf_history(sym: str, period: str) -> dict:
    """Fetch OHLCV history from Yahoo Finance and return the formatted result dict."""
    yf_range    = _PERIOD_RANGE_MAP.get(period, "1y")
    yf_interval = _PERIOD_INTERVAL_MAP.get(period, "1d")
    intraday    = "m" in yf_interval or "h" in yf_interval

    chart = await _yf_chart(sym, range_=yf_range, interval=yf_interval,
                            include_pre_post=(period in ("1d", "2d")))

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

    if period in ("1d", "2d"):
        n_days = 1 if period == "1d" else 2
        days_seen: list[str] = []
        for r in records:
            day = r["date"][:5]
            if day not in days_seen:
                days_seen.append(day)
        keep = set(days_seen[-n_days:])
        prev_day_records = [r for r in records if r["date"][:5] not in keep]
        regular_prev = [r for r in prev_day_records if "09:30" <= r["date"][6:] <= "16:00"]
        prev_day_close_records = regular_prev if regular_prev else prev_day_records
        if prev_day_close_records:
            prev_close = prev_day_close_records[-1]["close"]
        records = [r for r in records if r["date"][:5] in keep]

    if period == "2w":
        records = records[-260:]

    result: dict = {"data": records}
    if period in ("1d", "2d") and prev_close is not None:
        result["prev_close"] = round(float(prev_close), 4)
    return result


def _patch_yf_volume_with_ib(yf_data: dict, vol_map: dict[str, int | None]) -> dict:
    """Return a copy of *yf_data* with the volume field replaced by IB values
    only for bars where YF reports zero or null volume (typically extended-hours
    bars).  RTH bars where YF already has real consolidated market volume are
    left unchanged — IB only tracks a subset of exchanges and its per-bar
    volume is far lower than the true market total."""
    if not vol_map:
        return yf_data
    patched = []
    for bar in yf_data.get("data", []):
        d = bar.get("date")
        yf_vol = bar.get("volume")
        # Only substitute IB volume where YF has no data (0 or None).
        if d in vol_map and vol_map[d] is not None and (yf_vol is None or yf_vol == 0):
            bar = {**bar, "volume": vol_map[d]}
        patched.append(bar)
    return {**yf_data, "data": patched}


def _merge_ib_onto_yf(ib_result: dict, yf_result: dict) -> dict:
    """Merge IB-verified bars onto the YF base.

    IB wins for any bar both sources share (more accurate prices).
    YF bars that IB does not cover (typically the last ~15 min due to IB
    pacing) are kept so no candles are ever erased.
    """
    ib_bars = ib_result.get("data", [])
    yf_bars = yf_result.get("data", [])

    if not ib_bars:
        return yf_result
    if not yf_bars:
        return ib_result

    ib_by_date: dict[str, dict] = {b["date"]: b for b in ib_bars}

    # Walk YF bars in order; replace with IB where available, keep YF otherwise.
    # For volume: keep YF volume when it is non-zero (YF consolidated market
    # volume is more accurate than IB's partial feed during RTH).  Only fill
    # in IB volume where YF has zero or null (extended-hours bars).
    merged: list[dict] = []
    seen: set[str] = set()
    for bar in yf_bars:
        d = bar["date"]
        ib_bar = ib_by_date.get(d)
        if ib_bar is not None:
            yf_vol = bar.get("volume")
            ib_vol = ib_bar.get("volume")
            # Use IB OHLC (more accurate price) but prefer YF volume when present.
            merged_bar = {**ib_bar}
            if yf_vol is not None and yf_vol != 0:
                merged_bar["volume"] = yf_vol
            elif ib_vol is not None:
                merged_bar["volume"] = ib_vol
            merged.append(merged_bar)
        else:
            merged.append(bar)
        seen.add(d)

    # Append any IB bars that YF didn't have at all (edge-case: IB emitted
    # a bar that YF hasn't published yet for the current minute).
    # Guard: only include bars whose calendar-day prefix is already present
    # in the YF data.  This prevents a new day's pre-market bar from being
    # tacked onto the previous session's candles when YF hasn't rolled over
    # to the new day yet (visible as a rogue candle at the end of the chart).
    seen_days = {d[:5] for d in seen}
    for bar in ib_bars:
        if bar["date"] not in seen and bar["date"][:5] in seen_days:
            merged.append(bar)

    result: dict = {"data": merged}
    prev_close = ib_result.get("prev_close") or yf_result.get("prev_close")
    if prev_close is not None:
        result["prev_close"] = prev_close
    if "ib_telemetry" in ib_result:
        result["ib_telemetry"] = ib_result["ib_telemetry"]
    return result


async def _ib_history_overlay_task(sym: str, period: str) -> None:
    """Background task: fetch IB history and cache the raw IB result only.

    We deliberately do NOT merge with YF here.  The merge happens on every
    get_history() call so the chart always reflects the latest YF bars —
    storing a pre-merged snapshot would freeze the chart for the full TTL.
    """
    ib_cache_key = f"history:ib:{sym}:{period}"
    try:
        ib_result = await _get_ib_history(sym, period)
        await _cache.set(ib_cache_key, ib_result)
        logger.debug("IB history overlay refreshed for %s %s", sym, period)
    except Exception as exc:
        logger.debug("IB history overlay failed for %s %s: %s", sym, period, exc)
    finally:
        async with _ib_hist_overlay_lock:
            _ib_hist_overlay_inflight.pop(f"{sym}:{period}", None)


async def get_history(symbol: str, period: str = "1y") -> list[dict]:
    """Return OHLCV records list for *symbol*, served from cache when fresh.

    In IB mode Yahoo Finance is always the instant base source.  An IB fetch
    runs in the background and its result replaces the YF data once available,
    refreshing every 15 minutes.  This eliminates IB pacing delays on page load
    while still surfacing IB-verified data shortly after.
    """
    sym = symbol.upper()

    if _ib_data_pull_allowed_now():
        # ---- IB mode: YF always fresh; IB merged per-request ----
        # Always serve current YF data so the chart never shows a stale
        # snapshot.  IB bars (cached separately) are merged on every call,
        # providing price verification for historical bars while YF covers
        # the most recent candles that IB hasn't emitted yet.
        yf_cache_key = f"history:yf:{sym}:{period}"
        ttl = _HISTORY_TTL_MAP.get(period, 900)
        yf_data = await _cache.get(yf_cache_key, ttl)
        if yf_data is None:
            yf_data = await _fetch_yf_history(sym, period)
            await _cache.set(yf_cache_key, yf_data)

        # Check IB cache and fire a background refresh when stale.
        ib_cache_key = f"history:ib:{sym}:{period}"
        ib_cached = await _cache.get(ib_cache_key, _IB_HIST_OVERLAY_TTL)
        inflight_key = f"{sym}:{period}"
        async with _ib_hist_overlay_lock:
            if ib_cached is None and inflight_key not in _ib_hist_overlay_inflight:
                task = asyncio.create_task(_ib_history_overlay_task(sym, period))
                _ib_hist_overlay_inflight[inflight_key] = task

        # Re-merge IB-verified bars onto current YF data every request.
        vol_patch_key = f"history:ibvol:{sym}:{period}"
        if ib_cached is not None:
            merged = _merge_ib_onto_yf(ib_cached, yf_data)
            # Persist IB volumes in a long-lived patch cache so they survive
            # between 15-min overlay refreshes and backend restarts.
            ib_vol_map: dict[str, int | None] = {
                b["date"]: b.get("volume")
                for b in merged.get("data", [])
                if b.get("volume") is not None
            }
            if ib_vol_map:
                await _cache.set(vol_patch_key, ib_vol_map)
            return merged

        # IB overlay not yet ready — apply last known IB volume patch so the
        # chart shows detailed per-minute volume instead of Yahoo's sparse bars.
        vol_patch = await _cache.get(vol_patch_key, _IB_VOLUME_PATCH_TTL)
        if vol_patch:
            return _patch_yf_volume_with_ib(yf_data, vol_patch)

        return yf_data

    # ---- Pure YF mode ----
    cache_key = f"history:yf:{sym}:{period}"
    ttl = _HISTORY_TTL_MAP.get(period, 900)
    cached = await _cache.get(cache_key, ttl)
    if cached is not None:
        return cached

    result = await _fetch_yf_history(sym, period)
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


async def get_movers(top_n: int = 10, force_refresh: bool = False) -> dict:
    """Return the top N daily gainers and losers from a liquid-stock universe."""
    if not force_refresh:
        cached = await _cache.get("movers", MOVERS_TTL)
        if cached is not None:
            return cached

    # Keep movers on Yahoo quotes even when IB is connected to avoid extra IB load.
    quotes = await get_bulk_quotes(_MOVERS_UNIVERSE, source_preference="yf")
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
EARNINGS_TTL = 900  # 15 minutes

# Broad universe for earnings scanning (large-caps + ETFs that report)
_EARNINGS_UNIVERSE = [
    "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","JPM","V","UNH",
    "XOM","JNJ","WMT","MA","PG","HD","CVX","MRK","ABBV","LLY",
    "AVGO","PEP","KO","COST","PFE","TMO","MCD","ACN","DHR","NKE",
    "BAC","ADBE","INTC","CRM","DIS","NFLX","AMD","QCOM","TXN","GS",
    "MS","SCHW","BLK","AXP","SPGI","NOW","INTU","AMAT","LRCX","KLAC",
    "MU","MRVL","SNPS","CDNS","PANW","CRWD","FTNT","ZS","OKTA","DDOG",
    "NET","SNOW","MDB","HUBS","TTD","UBER","LYFT","ABNB","DASH","RBLX",
    "COIN","SQ","PYPL","SHOP","SE","MELI","BIDU","JD","PDD","BABA",
    "TSM","ASML","SAP","NXPI","STX","WDC","DELL","HPE","IBM","ORCL",
    "CSCO","F","GM","RIVN","LCID","NIO","BA","LMT","RTX","NOC",
    "GE","CAT","DE","MMM","HON","EMR","ETN","PH","ROK","SWK",
    "UPS","FDX","DAL","UAL","AAL","LUV","MAR","HLT","MGM","WYNN",
    "AMGN","GILD","BIIB","REGN","VRTX","MRNA","BNTX","ZTS","IDXX","EW",
    "SYK","MDT","BSX","ABT","BAX","BDX","CAH","MCK","CVS","CI",
    "HUM","MOH","CNC","WFC","C","USB","PNC","TFC","MTB","KEY",
    "RF","CFG","FITB","HBAN","ZION","CMA","DFS","COF","SYF","ALLY",
    # Canadian large-caps listed on US exchanges
    "SU","CNQ","ENB","TRP","RY","TD","BNS","BMO","CM","MFC","SLF",
    "NTR","CCO","ABX","WPM","K","IFC","POW","FFH","BAM","BN",
]


async def get_earnings(watchlist: list[str], force_refresh: bool = False) -> dict:
    """Return upcoming earnings for a broad universe with watchlist items flagged and sorted first."""
    watchlist_set = {s.upper() for s in watchlist}
    # Combine watchlist + universe, deduplicated, watchlist first
    all_symbols = list(watchlist_set) + [s for s in _EARNINGS_UNIVERSE if s not in watchlist_set]

    cache_key = f"earnings:{','.join(sorted(watchlist_set))}"
    if not force_refresh:
        cached = await _cache.get(cache_key, EARNINGS_TTL)
        if cached is not None:
            return cached

    results = await asyncio.gather(*[_fetch_earnings(s) for s in all_symbols])
    recent_results = await asyncio.gather(*[_fetch_recent_earnings(s) for s in watchlist_set])

    items = []
    seen: set[str] = set()
    for item in results:
        if item and item["id"] not in seen:
            seen.add(item["id"])
            symbol = item["related"][0] if item.get("related") else None
            item["watchlist_match"] = symbol in watchlist_set if symbol else False
            items.append(item)

    # Sort: watchlist first, then by days_until ascending
    items.sort(key=lambda x: (not x["watchlist_match"], x.get("days_until", 99)))

    recent_items: list[dict] = []
    recent_seen: set[str] = set()
    for batch in recent_results:
        for item in batch:
            if item["id"] in recent_seen:
                continue
            recent_seen.add(item["id"])
            recent_items.append(item)
    recent_items.sort(key=lambda x: x.get("published_at", 0), reverse=True)

    result = {
        "items": items,
        "recent_items": recent_items,
        "as_of": datetime.now(tz=timezone.utc).isoformat(),
    }
    await _cache.set(cache_key, result)
    return result

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
        crumb = await _get_yf_crumb()
        url = _YF_EARNINGS_URL.format(symbol=symbol.upper())
        r = await client.get(url, params={"modules": "calendarEvents", "crumb": crumb})
        if r.status_code == 401:
            # Crumb expired – reset and retry once
            global _yf_crumb
            _yf_crumb = None
            crumb = await _get_yf_crumb()
            r = await client.get(url, params={"modules": "calendarEvents", "crumb": crumb})
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
        # Compare calendar dates in Eastern Time so "tomorrow" doesn't collapse
        # into "today" when the earnings timestamp is early morning ET but fewer
        # than 24 hours away from the current UTC wall-clock time.
        et = zoneinfo.ZoneInfo("America/New_York")
        today_et = datetime.now(tz=et).date()
        earnings_date_et = dt.astimezone(et).date()
        diff_days = (earnings_date_et - today_et).days
        if diff_days < 0 or diff_days > 30:
            return None
        return {
            "id":          f"earnings:{symbol}:{raw_ts}",
            "title":       f"{symbol} earnings expected {dt.strftime('%b %d, %Y')}",
            "url":         f"https://finance.yahoo.com/quote/{symbol}/",
            "source":      "Yahoo Finance",
            "published_at": int(datetime.now(tz=timezone.utc).timestamp()),
            "thumbnail":   None,
            "related":     [symbol],
            "tags":        [symbol],
            "type":        "earnings",
            "days_until":  diff_days,
        }
    except Exception as exc:
        logger.warning("earnings fetch failed for %s: %s", symbol, exc)
        return None


def _num(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, dict):
        raw = v.get("raw")
        if isinstance(raw, (int, float)):
            return float(raw)
    return None


def _build_recent_earnings_item(symbol: str, event: dict) -> dict | None:
    quarter = event.get("quarter") or {}
    quarter_raw = quarter.get("raw")
    if quarter_raw is None:
        return None

    dt = datetime.fromtimestamp(int(quarter_raw), tz=timezone.utc)
    et = zoneinfo.ZoneInfo("America/New_York")
    days_since = (datetime.now(tz=et).date() - dt.astimezone(et).date()).days
    if days_since < 0 or days_since > 90:
        return None

    eps_actual = _num(event.get("epsActual"))
    eps_estimate = _num(event.get("epsEstimate"))
    surprise_pct = _num(event.get("surprisePercent"))

    status = "in_line"
    if eps_actual is not None and eps_estimate is not None:
        if eps_actual > eps_estimate:
            status = "beat"
        elif eps_actual < eps_estimate:
            status = "miss"

    tags: list[str] = []
    if status == "beat":
        tags.append("Earnings Beat")
    elif status == "miss":
        tags.append("Earnings Miss")
    else:
        tags.append("In Line")
    if surprise_pct is not None:
        tags.append(f"Surprise {surprise_pct:+.2f}%")
    if eps_actual is not None:
        tags.append(f"EPS {eps_actual:.2f}")
    if eps_estimate is not None:
        tags.append(f"Est {eps_estimate:.2f}")

    return {
        "id": f"recent-earnings:{symbol}:{int(quarter_raw)}",
        "title": f"{symbol} reported on {dt.strftime('%b %d, %Y')}",
        "url": f"https://finance.yahoo.com/quote/{symbol}/",
        "source": "Yahoo Finance",
        "published_at": int(quarter_raw),
        "thumbnail": None,
        "related": [symbol],
        "tags": tags,
        "type": "recent_earnings",
        "days_since": days_since,
        "eps_actual": eps_actual,
        "eps_estimate": eps_estimate,
        "surprise_pct": surprise_pct,
        "status": status,
        "watchlist_match": True,
    }


async def _fetch_recent_earnings(symbol: str) -> list[dict]:
    """Fetch recent earnings results for a symbol from Yahoo earningsHistory."""
    client = _get_http_client()
    try:
        crumb = await _get_yf_crumb()
        url = _YF_EARNINGS_URL.format(symbol=symbol.upper())
        r = await client.get(url, params={"modules": "earningsHistory", "crumb": crumb})
        if r.status_code == 401:
            global _yf_crumb
            _yf_crumb = None
            crumb = await _get_yf_crumb()
            r = await client.get(url, params={"modules": "earningsHistory", "crumb": crumb})
        r.raise_for_status()
        data = r.json()
        history = (
            data.get("quoteSummary", {})
            .get("result", [{}])[0]
            .get("earningsHistory", {})
            .get("history", [])
        )
        items: list[dict] = []
        for event in history:
            item = _build_recent_earnings_item(symbol, event)
            if item is not None:
                items.append(item)
        items.sort(key=lambda x: x.get("published_at", 0), reverse=True)
        return items[:2]
    except Exception as exc:
        logger.debug("recent earnings fetch failed for %s: %s", symbol, exc)
        return []


# Any article whose title or source contains one of these terms (case-insensitive)
# is excluded from the news feed.
_BLOCKED_TERMS = {"cramer", "mad money"}


def _is_blocked(item: dict) -> bool:
    """Return True if the article should be excluded from the feed."""
    text = ((item.get("title") or "") + " " + (item.get("source") or "")).lower()
    return any(term in text for term in _BLOCKED_TERMS)


async def get_news(watchlist: list[str], extra_topics: list[str] | None = None, force_refresh: bool = False) -> dict:
    """Return merged, deduplicated news for *watchlist* symbols + general market topics."""
    cache_key = f"news:{','.join(sorted(watchlist))}"
    if not force_refresh:
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


async def _fetch_symbol_sector(symbol: str) -> str | None:
    sym = symbol.upper()
    cache_key = f"sector:{sym}"
    cached = await _cache.get(cache_key, SECTOR_TTL)
    if cached is not None:
        return cached

    client = _get_http_client()
    try:
        crumb = await _get_yf_crumb()
        url = _YF_EARNINGS_URL.format(symbol=sym)
        r = await client.get(url, params={"modules": "assetProfile,summaryProfile", "crumb": crumb})
        if r.status_code == 401:
            global _yf_crumb
            _yf_crumb = None
            crumb = await _get_yf_crumb()
            r = await client.get(url, params={"modules": "assetProfile,summaryProfile", "crumb": crumb})
        r.raise_for_status()
        data = r.json()
        root = data.get("quoteSummary", {}).get("result", [{}])[0]
        profile = root.get("assetProfile") or root.get("summaryProfile") or {}
        sector = profile.get("sector")
        if not isinstance(sector, str) or not sector.strip():
            sector = None
        await _cache.set(cache_key, sector)
        return sector
    except Exception as exc:
        logger.debug("sector lookup failed for %s: %s", sym, exc)
        await _cache.set(cache_key, None)
        return None


async def get_symbol_sectors(symbols: list[str]) -> dict[str, str | None]:
    """Return a map of symbol -> sector (Yahoo profile, cached 24h)."""
    unique_symbols = []
    seen: set[str] = set()
    for symbol in symbols:
        sym = (symbol or "").upper().strip()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        unique_symbols.append(sym)

    async def _safe(sym: str) -> tuple[str, str | None]:
        try:
            return sym, await _fetch_symbol_sector(sym)
        except Exception:
            return sym, None

    pairs = await asyncio.gather(*[_safe(s) for s in unique_symbols])
    return {sym: sector for sym, sector in pairs}


INTRADAY_DF_TTL = 55   # seconds – just under the 60 s engine tick so each tick gets a fresh bar
IB_INTRADAY_DF_TTL = 60

async def get_intraday_df(symbol: str, range_: str = "5d", interval: str = "1m",
                          include_pre_post: bool = False, force_yf: bool = False) -> Any:
    """Return a pandas DataFrame of recent OHLCV bars for *symbol*.

    This is a shared helper used by the sandbox engine and portfolio manager
    so bar-fetching logic lives in one place.  Results are cached for
    INTRADAY_DF_TTL seconds so that multiple engine positions tracking the
    same symbol only trigger one Yahoo Finance request per tick cycle, and
    Yahoo rate-limits (429) are avoided.
    """
    import pandas as pd  # optional heavy import – kept local

    sym = symbol.upper()
    source = "yf" if force_yf else ("ib" if _ib_data_pull_allowed_now() else "yf")
    # Yahoo does not support second-level bars; gracefully degrade to 1m when
    # callers persist an IB-only interval like "5s".
    resolved_interval = interval
    if source == "yf" and interval.endswith("s"):
        resolved_interval = "1m"

    ib_bar_size = "1 min"
    if source == "ib":
        ib_bar_size_map = {
            "5s": "5 secs",
            "1m": "1 min",
            "2m": "2 mins",
            "5m": "5 mins",
            "15m": "15 mins",
            "1h": "1 hour",
            "1d": "1 day",
        }
        ib_bar_size = ib_bar_size_map.get(resolved_interval, "1 min")

    cache_key = f"intraday_df:{source}:{sym}:{range_}:{resolved_interval}:{'pre' if include_pre_post else 'reg'}"
    ttl = (
        max(IB_INTRADAY_DF_TTL, _ib_effective_hist_gap(ib_bar_size, "TRADES", not include_pre_post))
        if source == "ib"
        else INTRADAY_DF_TTL
    )
    cached = await _cache.get(cache_key, ttl)
    if cached is not None:
        df = pd.DataFrame(cached)
        df.index = pd.RangeIndex(len(df))
        return df

    if source == "ib":
        duration_map = {
            "1d": "2 D",
            "2d": "3 D",
            "5d": "7 D",
            "2w": "20 D",
            "1mo": "2 M",
            "3mo": "4 M",
        }
        bars = await _ib_historical_request(
            symbol=sym,
            end_datetime="",
            duration=duration_map.get(range_, "7 D"),
            bar_size=ib_bar_size,
            what_to_show="TRADES",
            use_rth=not include_pre_post,
        )
        rows: list[dict[str, Any]] = []
        for bar in bars:
            rows.append(
                {
                    "Open": float(bar["open"]),
                    "High": float(bar["high"]),
                    "Low": float(bar["low"]),
                    "Close": float(bar["close"]),
                    "Volume": int(bar["volume"]) if bar.get("volume") is not None else 0,
                }
            )
        if not rows:
            raise ValueError(f"No intraday data returned for {symbol}")

        await _cache.set(cache_key, rows)
        df = pd.DataFrame(rows)
        df.index = pd.RangeIndex(len(df))
        return df

    chart = await _yf_chart(sym, range_=range_, interval=resolved_interval,
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

    await _cache.set(cache_key, rows)
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


async def _ib_historical_request(
    symbol: str,
    end_datetime: str,
    duration: str,
    bar_size: str,
    what_to_show: str,
    use_rth: bool,
) -> list[dict]:
    """Adaptive, restriction-aware wrapper around IB historical requests."""
    global _ib_hist_last_ts

    profile_key = _ib_hist_profile_key(bar_size, what_to_show, use_rth)
    cache_key = _ib_hist_cache_key(symbol, end_datetime, duration, bar_size, what_to_show, use_rth)
    effective_gap = _ib_effective_hist_gap(bar_size, what_to_show, use_rth)
    now = time.monotonic()

    cached_entry = _ib_hist_result_cache.get(cache_key)
    if cached_entry is not None:
        cached_bars, cached_ts = cached_entry
        if cached_bars and (now - cached_ts) < effective_gap:
            return cached_bars

    request_duration = _expand_duration_for_gap(duration, bar_size, effective_gap)

    async with _ib_hist_semaphore:
        async with _ib_hist_lock:
            now = time.monotonic()
            effective_gap = _ib_effective_hist_gap(bar_size, what_to_show, use_rth)
            wait_for = effective_gap - (now - _ib_hist_last_ts)
            if wait_for > 0:
                await asyncio.sleep(wait_for)
            _ib_hist_last_ts = time.monotonic()

        response = await ib_service.get_historical_bars_request_meta(
            symbol=symbol,
            end_datetime=end_datetime,
            duration=request_duration,
            bar_size=bar_size,
            what_to_show=what_to_show,
            use_rth=use_rth,
        )
        bars = list(response.get("bars", []))
        error = response.get("error")
        error_code = response.get("error_code")

        if bars:
            _ib_hist_result_cache[cache_key] = (bars, time.monotonic())
            # Slowly relax previously elevated pacing gaps after successful requests.
            current_gap = _ib_hist_dynamic_gap_by_profile.get(profile_key, _IB_HIST_MIN_GAP_S)
            if current_gap > _IB_HIST_MIN_GAP_S:
                _ib_hist_dynamic_gap_by_profile[profile_key] = max(
                    _IB_HIST_MIN_GAP_S,
                    current_gap * 0.9,
                )
            return bars

        if _ib_is_historical_pacing_error(error_code, error):
            wait_hint = _ib_extract_wait_seconds_from_error(str(error or ""))
            new_gap = wait_hint if wait_hint is not None else _IB_HIST_DEFAULT_LIMIT_GAP_S
            new_gap = min(max(new_gap, _IB_HIST_MIN_GAP_S), _IB_HIST_MAX_LIMIT_GAP_S)
            prev_gap = _ib_hist_dynamic_gap_by_profile.get(profile_key, _IB_HIST_MIN_GAP_S)
            _ib_hist_dynamic_gap_by_profile[profile_key] = max(prev_gap, new_gap)
            _ib_hist_last_restriction_by_profile[profile_key] = {
                "error": error,
                "error_code": error_code,
                "detected_at": datetime.now(tz=timezone.utc).isoformat(),
            }
            logger.warning(
                "IB historical pacing/restriction detected for %s (%s). "
                "Using adaptive request gap %.1fs.",
                symbol,
                bar_size,
                _ib_hist_dynamic_gap_by_profile[profile_key],
            )

            cached_entry = _ib_hist_result_cache.get(cache_key)
            if cached_entry is not None:
                cached_bars, _ = cached_entry
                if cached_bars:
                    return cached_bars

        if error:
            logger.debug("IB historical request returned no bars for %s: %s", symbol, error)

        return []


async def _get_ib_quote_deduped(symbol: str) -> dict[str, Any]:
    """Return one shared in-flight IB quote task per symbol."""
    owner = False
    async with _ib_quote_inflight_lock:
        task = _ib_quote_inflight.get(symbol)
        if task is None:
            task = asyncio.create_task(_get_ib_quote(symbol))
            _ib_quote_inflight[symbol] = task
            owner = True
    try:
        return await task
    finally:
        if owner:
            async with _ib_quote_inflight_lock:
                existing = _ib_quote_inflight.get(symbol)
                if existing is task:
                    _ib_quote_inflight.pop(symbol, None)

