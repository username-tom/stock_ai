from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.sandbox import SandboxPosition
from app.services.data_provider import get_intraday_cache_coverage, warm_intraday_cache
from app.services.ib_service import IB_AVAILABLE, ib_service

logger = logging.getLogger(__name__)

_DEFAULT_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "SPY"]
_verification_jobs: dict[str, asyncio.Task] = {}
_verification_state: dict[str, dict[str, object]] = {}
_VERIFICATION_FAILURE_BACKOFF_MIN = 30


def _parse_utc_iso(ts: object) -> datetime | None:
    if not isinstance(ts, str) or not ts.strip():
        return None
    text = ts.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _intraday_cache_covers_range(coverage: dict, start_date: str, end_date: str) -> bool:
    oldest = coverage.get("oldest")
    newest = coverage.get("newest")
    if not oldest or not newest:
        return False
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
        oldest_dt = datetime.fromisoformat(str(oldest)).date()
        newest_dt = datetime.fromisoformat(str(newest)).date()
    except ValueError:
        return False

    required_end = min(end_dt, datetime.now().date())
    while required_end.weekday() >= 5:
        required_end -= timedelta(days=1)
    return oldest_dt <= start_dt and (newest_dt + timedelta(days=3)) >= required_end


async def _tracked_symbols() -> list[str]:
    """Return all tracked sandbox symbols (watchlist + non-watchlist).

    This keeps background warmup active for positions that are not highlighted
    in the sidebar so downstream predictor inputs stay fresh.
    """
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(SandboxPosition.symbol).where(
                    SandboxPosition.symbol.is_not(None),
                )
            )
        ).all()

    symbols = sorted({str(row[0]).upper() for row in rows if row and row[0]})
    return symbols or list(_DEFAULT_SYMBOLS)


async def _warm_symbol(
    symbol: str,
    *,
    source: str,
    prefer_ib: bool,
    lookback_days: int,
) -> None:
    await asyncio.to_thread(
        warm_intraday_cache,
        symbol,
        lookback_days=max(1, int(lookback_days)),
        source=source,
        chunk_days=max(1, min(90, int(settings.DATA_MANAGER_AUTO_WARM_CHUNK_DAYS))),
        prefer_ib=bool(prefer_ib),
        ib_use_rth=False,
        ib_what_to_show="TRADES",
        ib_max_retries=2,
        ib_pause_ms=150,
    )


async def _verify_symbol_range(job_key: str, symbol: str, start_date: str, end_date: str, reason: str) -> None:
    state = _verification_state.get(job_key)
    if state is not None:
        state["status"] = "running"
        state["started_at"] = datetime.utcnow().isoformat() + "Z"
    try:
        try:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
            end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
            lookback_days = max(1, (end_dt - start_dt).days + 1)
            warm_lookback_days = max(lookback_days, (datetime.now().date() - start_dt).days + 1)
        except ValueError:
            warm_lookback_days = max(1, int(settings.DATA_MANAGER_AUTO_WARM_LOOKBACK_DAYS))

        await _warm_symbol(
            symbol,
            source="ib",
            prefer_ib=True,
            lookback_days=warm_lookback_days,
        )
        logger.info(
            "Queued IB verification completed for %s (%s→%s, reason=%s)",
            symbol,
            start_date,
            end_date,
            reason,
        )
        if state is not None:
            state["status"] = "completed"
            state["completed_at"] = datetime.utcnow().isoformat() + "Z"
            state["error"] = None
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Queued IB verification failed for %s (%s→%s, reason=%s): %s",
            symbol,
            start_date,
            end_date,
            reason,
            exc,
        )
        if state is not None:
            state["status"] = "failed"
            state["completed_at"] = datetime.utcnow().isoformat() + "Z"
            state["error"] = str(exc)


def get_ib_verification_status(*, limit: int = 50) -> dict[str, object]:
    """Return current and recent IB verification queue state."""
    active_jobs = sum(1 for task in _verification_jobs.values() if not task.done())
    items = list(_verification_state.values())
    items.sort(key=lambda x: str(x.get("queued_at") or ""), reverse=True)
    if limit > 0:
        items = items[:limit]
    return {
        "ib_connected": bool(IB_AVAILABLE and ib_service.is_connected),
        "active_jobs": int(active_jobs),
        "jobs": items,
    }


def enqueue_ib_verification(
    symbols: list[str],
    start_date: str,
    end_date: str,
    *,
    reason: str = "backtest",
) -> list[str]:
    """Queue non-blocking IB intraday verification jobs for the requested range."""
    if not (IB_AVAILABLE and ib_service.is_connected):
        return []

    loop = asyncio.get_running_loop()
    queued: list[str] = []
    now_utc = datetime.utcnow()
    for raw in symbols:
        sym = str(raw or "").strip().upper()
        if not sym:
            continue
        key = f"{sym}:{start_date}:{end_date}"

        prior = _verification_state.get(key)
        if prior:
            prior_status = str(prior.get("status") or "")
            completed_at = _parse_utc_iso(prior.get("completed_at"))
            if prior_status == "completed" and not prior.get("error"):
                # Same symbol/range already verified in this process lifetime.
                continue
            if prior_status == "failed" and completed_at is not None:
                # Avoid hammering IB repeatedly when a request range keeps failing.
                if now_utc - completed_at <= timedelta(minutes=_VERIFICATION_FAILURE_BACKOFF_MIN):
                    continue

        existing = _verification_jobs.get(key)
        if existing and not existing.done():
            continue
        _verification_state[key] = {
            "key": key,
            "symbol": sym,
            "start_date": start_date,
            "end_date": end_date,
            "reason": reason,
            "status": "queued",
            "queued_at": datetime.utcnow().isoformat() + "Z",
            "started_at": None,
            "completed_at": None,
            "error": None,
        }
        task = loop.create_task(_verify_symbol_range(key, sym, start_date, end_date, reason))
        _verification_jobs[key] = task

        def _clear_done(_: asyncio.Task, job_key: str = key) -> None:
            _verification_jobs.pop(job_key, None)

        task.add_done_callback(_clear_done)
        queued.append(sym)

    # Keep status history bounded.
    if len(_verification_state) > 500:
        stale_keys = sorted(
            _verification_state.keys(),
            key=lambda k: str(_verification_state[k].get("queued_at") or ""),
        )[: len(_verification_state) - 500]
        for stale in stale_keys:
            if stale not in _verification_jobs:
                _verification_state.pop(stale, None)
    return queued


async def run_data_manager_maintenance() -> None:
    """Background loop that keeps intraday cache warm for tracked symbols."""
    logger.info("Data manager maintenance loop started")

    while True:
        try:
            enabled = bool(settings.DATA_MANAGER_AUTO_WARM_ENABLED)
            interval_s = max(60, int(settings.DATA_MANAGER_AUTO_WARM_INTERVAL_MIN) * 60)

            if enabled:
                symbols = await _tracked_symbols()
                if symbols:
                    ib_connected = bool(IB_AVAILABLE and ib_service.is_connected)
                    if ib_connected:
                        # While IB is connected, continuously verify tracked symbol history
                        # against broker data. Keep about one year hot in app cache.
                        verify_days = max(365, int(settings.DATA_MANAGER_AUTO_WARM_LOOKBACK_DAYS))
                        end_date = datetime.now().date().isoformat()
                        start_date = (datetime.now().date() - timedelta(days=verify_days)).isoformat()
                        targets = []
                        for sym in symbols:
                            coverage_ib = get_intraday_cache_coverage(sym, "ib")
                            if not _intraday_cache_covers_range(coverage_ib, start_date, end_date):
                                targets.append(sym)
                        source = "ib"
                        prefer_ib = True
                        lookback_days = verify_days
                        interval_s = 60
                    else:
                        targets = list(symbols)
                        source = str(settings.DATA_MANAGER_AUTO_WARM_SOURCE or "auto")
                        prefer_ib = bool(settings.DATA_MANAGER_AUTO_WARM_PREFER_IB)
                        lookback_days = max(1, int(settings.DATA_MANAGER_AUTO_WARM_LOOKBACK_DAYS))

                    sem = asyncio.Semaphore(3)

                    async def _guarded_warm(sym: str):
                        async with sem:
                            try:
                                await _warm_symbol(
                                    sym,
                                    source=source,
                                    prefer_ib=prefer_ib,
                                    lookback_days=lookback_days,
                                )
                                return (sym, None)
                            except Exception as exc:  # noqa: BLE001
                                return (sym, str(exc))

                    results = await asyncio.gather(*[_guarded_warm(s) for s in targets]) if targets else []
                    failures = [sym for sym, err in results if err]
                    if failures:
                        logger.warning(
                            "Data manager warm cycle finished with %d/%d symbol failures: %s",
                            len(failures),
                            len(targets),
                            ", ".join(failures),
                        )
                    else:
                        logger.info(
                            "Data manager warm cycle refreshed %d/%d tracked symbols (source=%s)",
                            len(targets),
                            len(symbols),
                            source,
                        )

            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            logger.info("Data manager maintenance loop cancelled")
            raise
        except Exception:
            logger.exception("Data manager maintenance loop error")
            await asyncio.sleep(60)
