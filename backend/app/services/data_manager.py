from __future__ import annotations

import asyncio
import json
import logging
import time
import zoneinfo
from datetime import datetime, time as dt_time
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.services.market_calendar import is_nyse_trading_day

logger = logging.getLogger(__name__)

_ET = zoneinfo.ZoneInfo("America/New_York")
_PRE_MARKET_OPEN = dt_time(4, 0)
_REGULAR_MARKET_OPEN = dt_time(9, 30)
_ENGINE_WARMUP_OPEN = dt_time(9, 20)
_REGULAR_MARKET_CLOSE = dt_time(16, 0)
_POST_MARKET_CLOSE = dt_time(20, 0)


def compute_us_equity_market_status(now_et: datetime | None = None) -> dict[str, Any]:
    """Return authoritative NYSE session status in America/New_York."""
    ts = now_et.astimezone(_ET) if now_et is not None else datetime.now(tz=_ET)
    day = ts.date()
    is_trading_day = is_nyse_trading_day(day)
    t = ts.time()

    if not is_trading_day:
        market_state = "CLOSED"
    elif _PRE_MARKET_OPEN <= t < _REGULAR_MARKET_OPEN:
        market_state = "PRE"
    elif _REGULAR_MARKET_OPEN <= t < _REGULAR_MARKET_CLOSE:
        market_state = "REGULAR"
    elif _REGULAR_MARKET_CLOSE <= t < _POST_MARKET_CLOSE:
        market_state = "POST"
    else:
        market_state = "CLOSED"

    market_active = is_trading_day and (_ENGINE_WARMUP_OPEN <= t < _REGULAR_MARKET_CLOSE)
    regular_session_open = is_trading_day and (_REGULAR_MARKET_OPEN <= t < _REGULAR_MARKET_CLOSE)

    return {
        "timezone": "America/New_York",
        "as_of": ts.isoformat(),
        "date": day.isoformat(),
        "is_trading_day": bool(is_trading_day),
        "market_state": market_state,
        "market_active": bool(market_active),
        "regular_session_open": bool(regular_session_open),
    }


class DataManager:
    """Centralized cache/pull manager with region-specific async locks.

    The manager stores values in a monotonic TTL cache and persists entries to disk
    so cached data survives restarts. Locks and wait events are scoped by cache key,
    so updating one symbol/region does not block unrelated keys.
    """

    def __init__(self, cache_dir: Path) -> None:
        self._cache_dir = Path(cache_dir)
        self._store: dict[str, tuple[Any, float]] = {}
        self._store_lock = asyncio.Lock()

        self._key_locks: dict[str, asyncio.Lock] = {}
        self._key_events: dict[str, asyncio.Event] = {}
        self._key_registry_lock = asyncio.Lock()

    def _key_to_filename(self, key: str) -> Path:
        safe = key.replace(":", "__").replace("/", "_")
        return self._cache_dir / f"{safe}.json"

    async def _ensure_key_primitives(self, key: str) -> tuple[asyncio.Lock, asyncio.Event]:
        async with self._key_registry_lock:
            lock = self._key_locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._key_locks[key] = lock

            event = self._key_events.get(key)
            if event is None:
                event = asyncio.Event()
                self._key_events[key] = event

            return lock, event

    def load_from_disk(self) -> None:
        if not self._cache_dir.exists():
            return

        now_wall = time.time()
        now_mono = time.monotonic()
        for path in self._cache_dir.glob("*.json"):
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
                key = entry["key"]
                value = entry["value"]
                saved_wall = float(entry["wall_ts"])
                age = now_wall - saved_wall
                mono_ts = now_mono - age
                self._store[key] = (value, mono_ts)
            except Exception:
                continue

    async def get(self, key: str, ttl: float) -> Any | None:
        async with self._store_lock:
            entry = self._store.get(key)
        if entry is None:
            return None

        value, ts = entry
        return value if (time.monotonic() - ts) < ttl else None

    async def set(self, key: str, value: Any) -> None:
        async with self._store_lock:
            self._store[key] = (value, time.monotonic())

        _, event = await self._ensure_key_primitives(key)
        event.set()

        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, self._write_disk, key, value)

    async def wait_for_data(self, key: str, ttl: float, timeout: float = 10.0) -> Any | None:
        cached = await self.get(key, ttl)
        if cached is not None:
            return cached

        _, event = await self._ensure_key_primitives(key)
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except TimeoutError:
            return None
        return await self.get(key, ttl)

    async def pull(
        self,
        key: str,
        ttl: float,
        fetcher: Callable[[], Awaitable[Any]],
        wait_timeout: float = 10.0,
    ) -> Any:
        """Get fresh data by key, using a key-scoped lock and wait path.

        If data is missing/stale and another coroutine is already refreshing this key,
        wait for that refresh to finish instead of issuing a duplicate upstream pull.
        """
        cached = await self.get(key, ttl)
        if cached is not None:
            return cached

        lock, event = await self._ensure_key_primitives(key)

        if lock.locked():
            waited = await self.wait_for_data(key, ttl, timeout=wait_timeout)
            if waited is not None:
                return waited

        async with lock:
            cached = await self.get(key, ttl)
            if cached is not None:
                return cached

            event.clear()
            try:
                value = await fetcher()
                await self.set(key, value)
                return value
            except Exception:
                event.set()
                raise

    def _write_disk(self, key: str, value: Any) -> None:
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            path = self._key_to_filename(key)
            payload = {"key": key, "value": value, "wall_ts": time.time()}
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:
            logger.debug("DataManager disk cache write failed for %s: %s", key, exc)
