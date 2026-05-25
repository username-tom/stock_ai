from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.sandbox import SandboxPosition
from app.services.data_provider import warm_intraday_cache

logger = logging.getLogger(__name__)

_DEFAULT_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "SPY"]


async def _watchlist_symbols() -> list[str]:
    """Return active watchlist symbols, with a small fallback list."""
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(SandboxPosition.symbol).where(
                    SandboxPosition.symbol.is_not(None),
                    SandboxPosition.is_on_watchlist == True,  # noqa: E712
                )
            )
        ).all()

    symbols = sorted({str(row[0]).upper() for row in rows if row and row[0]})
    return symbols or list(_DEFAULT_SYMBOLS)


async def _warm_symbol(symbol: str) -> None:
    await asyncio.to_thread(
        warm_intraday_cache,
        symbol,
        lookback_days=max(1, int(settings.DATA_MANAGER_AUTO_WARM_LOOKBACK_DAYS)),
        source=str(settings.DATA_MANAGER_AUTO_WARM_SOURCE or "auto"),
        chunk_days=max(1, min(90, int(settings.DATA_MANAGER_AUTO_WARM_CHUNK_DAYS))),
        prefer_ib=bool(settings.DATA_MANAGER_AUTO_WARM_PREFER_IB),
        ib_use_rth=False,
        ib_what_to_show="TRADES",
        ib_max_retries=2,
        ib_pause_ms=150,
    )


async def run_data_manager_maintenance() -> None:
    """Background loop that keeps intraday cache warm for watchlist symbols."""
    logger.info("Data manager maintenance loop started")

    while True:
        try:
            enabled = bool(settings.DATA_MANAGER_AUTO_WARM_ENABLED)
            interval_s = max(60, int(settings.DATA_MANAGER_AUTO_WARM_INTERVAL_MIN) * 60)

            if enabled:
                symbols = await _watchlist_symbols()
                if symbols:
                    sem = asyncio.Semaphore(3)

                    async def _guarded_warm(sym: str):
                        async with sem:
                            try:
                                await _warm_symbol(sym)
                                return (sym, None)
                            except Exception as exc:  # noqa: BLE001
                                return (sym, str(exc))

                    results = await asyncio.gather(*[_guarded_warm(s) for s in symbols])
                    failures = [sym for sym, err in results if err]
                    if failures:
                        logger.warning(
                            "Data manager warm cycle finished with %d/%d symbol failures: %s",
                            len(failures),
                            len(symbols),
                            ", ".join(failures),
                        )
                    else:
                        logger.info(
                            "Data manager warm cycle refreshed %d watchlist symbols",
                            len(symbols),
                        )

            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            logger.info("Data manager maintenance loop cancelled")
            raise
        except Exception:
            logger.exception("Data manager maintenance loop error")
            await asyncio.sleep(60)
