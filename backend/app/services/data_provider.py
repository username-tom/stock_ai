"""Data provider abstraction for fetching OHLCV data from multiple sources.

Supported sources
-----------------
* ``yfinance``  – Yahoo Finance via the yfinance library (always available, no auth).
* ``stooq``     – Stooq.com data via direct CSV download (free, no auth).
* ``ib``        – Interactive Brokers historical data (requires IB Gateway / TWS
                  connection).  Falls back to ``yfinance`` automatically when IB is
                  not connected.

Usage
-----
    from app.services.data_provider import fetch_ohlcv

    df = fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="yfinance")
"""
from __future__ import annotations

import io
import logging
from typing import Literal

import httpx
import pandas as pd
import yfinance as yf

from app.services.ib_service import IB_AVAILABLE, ib_service

logger = logging.getLogger(__name__)

DataSource = Literal["yfinance", "stooq", "ib"]

_FREE_SOURCES: tuple[str, ...] = ("yfinance", "stooq")


# --------------------------------------------------------------------------- #
# Internal per-source fetchers
# --------------------------------------------------------------------------- #

def _fetch_yfinance(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Download OHLCV data via yfinance (Yahoo Finance)."""
    df = yf.download(symbol, start=start, end=end, progress=False, auto_adjust=True)
    if df.empty:
        raise ValueError(f"yfinance: no data found for {symbol!r} between {start} and {end}.")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [col[0] for col in df.columns]
    df.index = pd.to_datetime(df.index)
    return df


def _fetch_stooq(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Download OHLCV data from Stooq.com via direct CSV URL.

    Stooq uses a ``.US`` suffix for US equities (e.g. ``AAPL.US``).  The
    symbol is lowercased and the suffix appended automatically if the input
    does not already contain a dot.
    """
    stooq_symbol = symbol.lower() if "." in symbol else f"{symbol.lower()}.us"
    url = (
        f"https://stooq.com/q/d/l/"
        f"?s={stooq_symbol}&d1={start.replace('-', '')}&d2={end.replace('-', '')}&i=d"
    )
    try:
        response = httpx.get(url, timeout=20, follow_redirects=True)
        response.raise_for_status()
        text = response.text.strip()
        if not text or text.startswith("No data"):
            raise ValueError(f"stooq: no data found for {symbol!r} between {start} and {end}.")
        df = pd.read_csv(io.StringIO(text), parse_dates=["Date"], index_col="Date")
        # Stooq column names are Title-Case; normalise to match yfinance style
        # Use .title() to correctly handle multi-word columns (e.g. 'Adj Close')
        df.columns = [c.strip().title() for c in df.columns]
        if df.empty:
            raise ValueError(f"stooq: empty response for {symbol!r} between {start} and {end}.")
        df.index = pd.to_datetime(df.index)
        df.sort_index(inplace=True)
        return df
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"stooq: failed to fetch data for {symbol!r}: {exc}") from exc


def _fetch_ib(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Fetch OHLCV data from Interactive Brokers.

    Requires an active IB connection (ib_service.is_connected == True).
    Raises ``ValueError`` when IB is not connected so callers can fall back.
    """
    if not IB_AVAILABLE:
        raise ValueError("ib_insync is not installed – IB data source unavailable.")
    if not ib_service.is_connected:
        raise ValueError("IB is not connected – cannot fetch data from Interactive Brokers.")

    # IB historical data is fetched asynchronously; run it in a new event loop
    # when called from a synchronous context (e.g. backtester thread).
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(
                    asyncio.run,
                    _ib_to_dataframe(symbol, start, end),
                )
                df = future.result(timeout=60)
        else:
            df = asyncio.run(_ib_to_dataframe(symbol, start, end))
    except Exception as exc:
        raise ValueError(f"IB historical data fetch failed for {symbol!r}: {exc}") from exc

    if df.empty:
        raise ValueError(f"IB: no data found for {symbol!r} between {start} and {end}.")
    return df


async def _ib_to_dataframe(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Async helper: convert IB bar list to a DataFrame."""
    import ib_insync as ibi
    from datetime import date

    start_dt = date.fromisoformat(start)
    end_dt = date.fromisoformat(end)
    delta_days = (end_dt - start_dt).days
    duration = f"{max(delta_days, 1)} D"

    contract = ibi.Stock(symbol, "SMART", "USD")
    bars = await ib_service._ib.reqHistoricalDataAsync(
        contract,
        endDateTime=end_dt.strftime("%Y%m%d %H:%M:%S"),
        durationStr=duration,
        barSizeSetting="1 day",
        whatToShow="ADJUSTED_LAST",
        useRTH=True,
    )
    if not bars:
        return pd.DataFrame()

    records = [
        {
            "Date": pd.to_datetime(str(b.date)),
            "Open": b.open,
            "High": b.high,
            "Low": b.low,
            "Close": b.close,
            "Volume": b.volume,
        }
        for b in bars
    ]
    df = pd.DataFrame(records).set_index("Date")
    df.index = pd.to_datetime(df.index)
    return df


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def fetch_ohlcv(
    symbol: str,
    start: str,
    end: str,
    source: DataSource = "yfinance",
) -> pd.DataFrame:
    """Fetch OHLCV data for *symbol* between *start* and *end*.

    Parameters
    ----------
    symbol:
        Ticker symbol (e.g. ``"AAPL"``).
    start:
        ISO-8601 start date string (``"YYYY-MM-DD"``).
    end:
        ISO-8601 end date string (``"YYYY-MM-DD"``).
    source:
        Data source to use.  One of ``"yfinance"``, ``"stooq"``, or ``"ib"``.
        When ``"ib"`` is requested but IB is not connected, the function
        automatically falls back to ``"yfinance"`` and logs a warning.

    Returns
    -------
    pd.DataFrame
        DataFrame with a DatetimeIndex and columns Open, High, Low, Close,
        Volume (at minimum).

    Raises
    ------
    ValueError
        When no data is found for the given symbol / date range.
    """
    fetchers = {
        "yfinance": _fetch_yfinance,
        "stooq": _fetch_stooq,
        "ib": _fetch_ib,
    }

    if source not in fetchers:
        raise ValueError(
            f"Unknown data source {source!r}. Valid options: {list(fetchers)}"
        )

    if source == "ib":
        try:
            return _fetch_ib(symbol, start, end)
        except ValueError as exc:
            logger.warning(
                "IB data unavailable (%s); falling back to yfinance for %s.", exc, symbol
            )
            source = "yfinance"

    if source == "yfinance":
        try:
            return _fetch_yfinance(symbol, start, end)
        except ValueError as exc:
            logger.warning(
                "yfinance failed (%s); falling back to stooq for %s.", exc, symbol
            )
            return _fetch_stooq(symbol, start, end)

    return fetchers[source](symbol, start, end)


def list_data_sources() -> list[dict]:
    """Return metadata about every supported data source."""
    return [
        {
            "id": "yfinance",
            "name": "Yahoo Finance (yfinance)",
            "description": "Free historical OHLCV data from Yahoo Finance. No authentication required.",
            "requires_auth": False,
            "available": True,
        },
        {
            "id": "stooq",
            "name": "Stooq",
            "description": "Free historical OHLCV data from Stooq.com. No authentication required.",
            "requires_auth": False,
            "available": True,
        },
        {
            "id": "ib",
            "name": "Interactive Brokers",
            "description": "Historical data via IB TWS/Gateway. Falls back to yfinance when not connected.",
            "requires_auth": True,
            "available": IB_AVAILABLE and ib_service.is_connected,
        },
    ]
