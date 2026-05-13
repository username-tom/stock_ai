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
from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

import httpx
import pandas as pd
import yfinance as yf

from app.services.ib_service import IB_AVAILABLE, ib_service

logger = logging.getLogger(__name__)

_ET = ZoneInfo("America/New_York")

# Regular US equity market session: 09:30 – 16:00 ET
_MARKET_OPEN_TIME  = (9, 30)   # (hour, minute) inclusive
_MARKET_CLOSE_TIME = (16, 0)   # (hour, minute) exclusive


def _tag_market_session(df: pd.DataFrame) -> pd.DataFrame:
    """Add a ``session`` column: ``'pre'``, ``'regular'``, or ``'post'``.

    The DataFrame index must be timezone-aware.  All comparisons are done in
    US/Eastern time so daylight-saving transitions are handled correctly.

    Regular session: 09:30 ≤ bar_time < 16:00 ET.
    Pre-market:      bar_time < 09:30 ET.
    Post-market:     bar_time ≥ 16:00 ET.
    """
    df = df.copy()
    idx_et = df.index.tz_convert(_ET)
    hour   = idx_et.hour
    minute = idx_et.minute
    total_min = hour * 60 + minute
    open_min  = _MARKET_OPEN_TIME[0]  * 60 + _MARKET_OPEN_TIME[1]   # 570
    close_min = _MARKET_CLOSE_TIME[0] * 60 + _MARKET_CLOSE_TIME[1]  # 960

    session = pd.array(
        ["pre" if t < open_min else ("post" if t >= close_min else "regular")
         for t in total_min],
        dtype=object,
    )
    df["session"] = session
    return df

DataSource = Literal["auto", "yfinance", "stooq", "ib"]

_FREE_SOURCES: tuple[str, ...] = ("yfinance", "stooq")


def _ib_is_connected() -> bool:
    return bool(IB_AVAILABLE and ib_service.is_connected)


def _resolve_source(source: DataSource) -> DataSource:
    """Resolve requested source to the effective source.

    When IB is connected, Yahoo requests are upgraded to IB so the app uses
    the broker feed consistently.
    """
    if source == "auto":
        return "ib" if _ib_is_connected() else "yfinance"
    if source == "yfinance" and _ib_is_connected():
        return "ib"
    return source


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
        if "apikey" in text.lower() or text.startswith("Get your"):
            raise ValueError(
                "stooq: API key required. Stooq now requires authentication for data downloads."
            )
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
        raise ValueError("ibapi is not installed - IB data source unavailable.")
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


def _parse_ib_bar_datetime(raw: str) -> pd.Timestamp:
    """Parse IB historical bar date strings into timezone-aware ET timestamps."""
    text = str(raw).strip()
    for fmt in ("%Y%m%d  %H:%M:%S", "%Y%m%d %H:%M:%S", "%Y%m%d"):
        try:
            dt = datetime.strptime(text, fmt)
            ts = pd.Timestamp(dt)
            break
        except ValueError:
            continue
    else:
        ts = pd.to_datetime(text, errors="coerce")
        if pd.isna(ts):
            raise ValueError(f"Unparseable IB bar timestamp: {raw!r}")

    if ts.tzinfo is None:
        return ts.tz_localize(_ET)
    return ts.tz_convert(_ET)


async def _ib_intraday_to_dataframe(symbol: str, start: str, end: str, bar_size: str) -> pd.DataFrame:
    """Async helper: fetch IB intraday bars and convert to DataFrame."""
    start_dt = date.fromisoformat(start)
    end_dt = date.fromisoformat(end)
    delta_days = max((end_dt - start_dt).days, 1)
    duration = f"{delta_days} D"
    end_datetime = f"{end_dt.strftime('%Y%m%d')} 23:59:59"

    bars = await ib_service.get_historical_bars_request(
        symbol=symbol,
        end_datetime=end_datetime,
        duration=duration,
        bar_size=bar_size,
        what_to_show="TRADES",
        use_rth=False,
    )
    if not bars:
        return pd.DataFrame()

    records = []
    for b in bars:
        try:
            ts = _parse_ib_bar_datetime(str(b["date"]))
        except Exception:
            continue
        records.append(
            {
                "Date": ts,
                "Open": b["open"],
                "High": b["high"],
                "Low": b["low"],
                "Close": b["close"],
                "Volume": b["volume"],
            }
        )

    if not records:
        return pd.DataFrame()

    df = pd.DataFrame(records).set_index("Date")
    df.sort_index(inplace=True)
    return df


def _fetch_ib_intraday(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Fetch intraday OHLCV data from IB using the finest available interval."""
    if not IB_AVAILABLE:
        raise ValueError("ibapi is not installed - IB data source unavailable.")
    if not ib_service.is_connected:
        raise ValueError("IB is not connected – cannot fetch intraday data from Interactive Brokers.")

    interval_map = (
        ("1m", "1 min"),
        ("2m", "2 mins"),
        ("5m", "5 mins"),
    )

    import asyncio

    for interval, ib_bar_size in interval_map:
        try:
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    import concurrent.futures

                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                        future = executor.submit(
                            asyncio.run,
                            _ib_intraday_to_dataframe(symbol, start, end, ib_bar_size),
                        )
                        df = future.result(timeout=60)
                else:
                    df = asyncio.run(_ib_intraday_to_dataframe(symbol, start, end, ib_bar_size))
            except RuntimeError:
                df = asyncio.run(_ib_intraday_to_dataframe(symbol, start, end, ib_bar_size))

            if df.empty:
                continue

            df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
            df = _tag_market_session(df)
            df.attrs["interval"] = interval
            n_regular = int((df["session"] == "regular").sum())
            logger.info(
                "IB intraday fetch: using interval=%s for %s (%s → %s), %d total bars (%d regular-session)",
                interval,
                symbol,
                start,
                end,
                len(df),
                n_regular,
            )
            return df
        except Exception as exc:
            logger.debug("IB intraday interval %s failed for %s: %s", interval, symbol, exc)
            continue

    raise ValueError(
        f"No IB intraday data available for {symbol!r} between {start} and {end}."
    )


async def _ib_to_dataframe(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Async helper: convert IB bar list to a DataFrame."""
    bars = await ib_service.get_historical_bars_range(
        symbol=symbol,
        start=start,
        end=end,
        bar_size="1 day",
    )
    if not bars:
        return pd.DataFrame()

    records = [
        {
            "Date": pd.to_datetime(str(b["date"])),
            "Open": b["open"],
            "High": b["high"],
            "Low": b["low"],
            "Close": b["close"],
            "Volume": b["volume"],
        }
        for b in bars
    ]
    df = pd.DataFrame(records).set_index("Date")
    df.index = pd.to_datetime(df.index)
    return df


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def fetch_ohlcv_intraday(
    symbol: str,
    start: str,
    end: str,
    source: DataSource = "auto",
) -> pd.DataFrame:
    """Fetch intraday OHLCV data using the finest available interval.

    Tries intervals in order: ``1m``, ``2m``, ``5m``.  The first interval that
    returns data is used.  Falls back gracefully when the date range exceeds
    what yfinance allows for a given interval (e.g. 1m is limited to the last
    7 days).

    Parameters
    ----------
    symbol, start, end, source:
        Same as :func:`fetch_ohlcv`.

    Returns
    -------
    pd.DataFrame
        DataFrame with a DatetimeIndex (timezone-aware) and columns
        Open, High, Low, Close, Volume.  An ``interval`` attribute is set on
        the returned DataFrame indicating the interval that was used.

    Raises
    ------
    ValueError
        When no intraday data could be fetched for any supported interval.
    """
    source = _resolve_source(source)

    if source == "ib":
        return _fetch_ib_intraday(symbol, start, end)

    if source != "yfinance":
        logger.warning(
            "Intraday data is not supported for source '%s'; falling back to daily bars for %s.",
            source,
            symbol,
        )
        df = fetch_ohlcv(symbol, start, end, source=source)
        df.attrs["interval"] = "1d"
        return df

    for interval in ("1m", "2m", "5m"):
        try:
            ticker = yf.Ticker(symbol)
            df = ticker.history(start=start, end=end, interval=interval, prepost=True)
            if df.empty:
                continue
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = [col[0] for col in df.columns]
            # Normalise column names to match daily data (yfinance Ticker.history
            # uses Title Case already, but ensure Dividends/Stock Splits are dropped)
            df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
            df.index = pd.to_datetime(df.index)
            # Tag each bar with its market session (pre / regular / post)
            df = _tag_market_session(df)
            df.attrs["interval"] = interval
            n_regular = int((df["session"] == "regular").sum())
            logger.info(
                "Intraday fetch: using interval=%s for %s (%s → %s), "
                "%d total bars (%d regular-session)",
                interval, symbol, start, end, len(df), n_regular,
            )
            return df
        except Exception as exc:
            logger.debug("Intraday interval %s failed for %s: %s", interval, symbol, exc)
            continue

    raise ValueError(
        f"No intraday data available for {symbol!r} between {start} and {end}. "
        "Note: 1m data is limited to the last 7 days and 2m/5m to the last 60 days on Yahoo Finance."
    )


def fetch_ohlcv(
    symbol: str,
    start: str,
    end: str,
    source: DataSource = "auto",
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

    source = _resolve_source(source)

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


__all__ = ["fetch_ohlcv", "fetch_ohlcv_intraday", "list_data_sources", "DataSource", "_tag_market_session"]


def list_data_sources() -> list[dict]:
    """Return metadata about every supported data source."""
    return [
        {
            "id": "auto",
            "name": "Auto (IB first)",
            "description": "Uses Interactive Brokers when connected, otherwise Yahoo Finance.",
            "requires_auth": False,
            "available": True,
        },
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
