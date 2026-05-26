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
import json
import logging
import time
import asyncio
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

import httpx
import pandas as pd
import yfinance as yf

from app.services.ib_service import IB_AVAILABLE, ib_service
from app.services.market_calendar import is_nyse_trading_day

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

_HIST_CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "historical_cache"
_DAILY_CACHE_LIMIT = 20_000
_INTRADAY_CACHE_LIMIT = 300_000
_INTRADAY_CACHE_RETENTION_DAYS = 370

_IB_IP_CONFLICT_PATTERNS: tuple[str, ...] = (
    "connected from a different ip address",
    "historical market data service error message",
)


def _is_ib_ip_conflict_error(message: str | None) -> bool:
    text = str(message or "").strip().lower()
    return bool(text) and any(p in text for p in _IB_IP_CONFLICT_PATTERNS)


def _is_closed_day_now_et() -> bool:
    now_et = datetime.now(_ET)
    return not is_nyse_trading_day(now_et.date())


def _cache_path(symbol: str, source: str, intraday: bool) -> Path:
    safe_symbol = symbol.upper().replace("/", "_")
    kind = "intraday" if intraday else "daily"
    return _HIST_CACHE_DIR / f"{safe_symbol}__{source}__{kind}.json"


def _load_cache_meta(symbol: str, source: str, intraday: bool) -> dict[str, object]:
    """Load lightweight cache-file metadata without materialising rows."""
    path = _cache_path(symbol, source, intraday)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return {}
        return payload
    except Exception:
        return {}


def _ensure_et_index(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    idx = pd.to_datetime(out.index, errors="coerce")
    if getattr(idx, "tz", None) is None:
        out.index = idx.tz_localize(_ET)
    else:
        out.index = idx.tz_convert(_ET)
    return out


def _slice_cached_range(df: pd.DataFrame, start: str, end: str, intraday: bool) -> pd.DataFrame:
    if df.empty:
        return df
    if intraday:
        scoped = _ensure_et_index(df)
        start_ts = pd.Timestamp(start).tz_localize(_ET)
        end_ts = (pd.Timestamp(end) + pd.Timedelta(days=1)).tz_localize(_ET)
        return scoped[(scoped.index >= start_ts) & (scoped.index < end_ts)]

    idx = pd.to_datetime(df.index, errors="coerce")
    scoped = df.copy()
    scoped.index = idx
    start_d = pd.Timestamp(start).date()
    end_d = pd.Timestamp(end).date()
    mask = (scoped.index.date >= start_d) & (scoped.index.date <= end_d)
    return scoped[mask]


def _load_cached_df(symbol: str, source: str, start: str, end: str, intraday: bool) -> pd.DataFrame | None:
    path = _cache_path(symbol, source, intraday)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows = payload.get("rows") or []
        if not rows:
            return None
        df = pd.DataFrame(rows)
        if "ts" not in df.columns:
            return None
        df["ts"] = pd.to_datetime(df["ts"], errors="coerce")
        df = df.dropna(subset=["ts"]).set_index("ts").sort_index()
        keep_cols = [c for c in ["Open", "High", "Low", "Close", "Volume", "session"] if c in df.columns]
        df = df[keep_cols]
        scoped = _slice_cached_range(df, start, end, intraday)
        if scoped.empty:
            return None
        interval = payload.get("interval")
        if isinstance(interval, str) and interval:
            scoped.attrs["interval"] = interval
        return scoped
    except Exception as exc:
        logger.debug("Failed loading historical cache for %s (%s): %s", symbol, source, exc)
        return None


def _save_cached_df(
    symbol: str,
    source: str,
    intraday: bool,
    df: pd.DataFrame,
    *,
    ib_verified: bool | None = None,
) -> None:
    if df.empty:
        return
    try:
        _HIST_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(symbol, source, intraday)
        existing = _load_cached_df(symbol, source, "1900-01-01", "2100-01-01", intraday)
        existing_meta = _load_cache_meta(symbol, source, intraday)
        merged = pd.concat([existing, df]) if existing is not None else df.copy()
        merged = merged[~merged.index.duplicated(keep="last")].sort_index()
        if intraday and not merged.empty:
            scoped = _ensure_et_index(merged)
            cutoff = datetime.now(_ET) - timedelta(days=_INTRADAY_CACHE_RETENTION_DAYS)
            merged = scoped[scoped.index >= cutoff]
        max_rows = _INTRADAY_CACHE_LIMIT if intraday else _DAILY_CACHE_LIMIT
        if len(merged) > max_rows:
            merged = merged.iloc[-max_rows:]
        out = merged.copy()
        out = out[[c for c in ["Open", "High", "Low", "Close", "Volume", "session"] if c in out.columns]]
        index_col_name = out.index.name
        out = out.reset_index()
        if "ts" not in out.columns:
            if index_col_name and index_col_name in out.columns:
                out = out.rename(columns={index_col_name: "ts"})
            elif "index" in out.columns:
                out = out.rename(columns={"index": "ts"})
            else:
                # Fallback: the first reset-index column is the timestamp axis.
                out = out.rename(columns={out.columns[0]: "ts"})
        out["ts"] = out["ts"].astype(str)
        effective_ib_verified = (
            bool(ib_verified)
            if ib_verified is not None
            else bool(existing_meta.get("ib_verified", source == "ib"))
        )
        ib_verified_at = existing_meta.get("ib_verified_at")
        if effective_ib_verified and not ib_verified_at:
            ib_verified_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        payload = {
            "symbol": symbol.upper(),
            "source": source,
            "intraday": intraday,
            "interval": df.attrs.get("interval"),
            "ib_verified": effective_ib_verified,
            "ib_verified_at": ib_verified_at,
            "rows": out.to_dict(orient="records"),
        }
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        logger.debug("Failed writing historical cache for %s (%s): %s", symbol, source, exc)


def get_intraday_cache_coverage(symbol: str, source: DataSource = "auto") -> dict[str, str | int | None]:
    """Return basic coverage metadata for a symbol's intraday local cache."""
    # Coverage inspection must honor explicit source selection. In IB-connected
    # sessions, resolving "yfinance" to "ib" would incorrectly hide Yahoo cache
    # rows and make auto-source coverage checks fail.
    resolved = _resolve_source(source) if source == "auto" else source
    cached = _load_cached_df(symbol, resolved, "1900-01-01", "2100-01-01", intraday=True)
    meta = _load_cache_meta(symbol, resolved, intraday=True)
    if cached is None or cached.empty:
        return {
            "symbol": symbol.upper(),
            "source": resolved,
            "rows": 0,
            "oldest": None,
            "newest": None,
            "ib_verified": bool(meta.get("ib_verified", resolved == "ib")),
            "ib_verified_at": str(meta.get("ib_verified_at") or "") or None,
        }
    return {
        "symbol": symbol.upper(),
        "source": resolved,
        "rows": int(len(cached)),
        "oldest": str(cached.index.min()),
        "newest": str(cached.index.max()),
        "ib_verified": bool(meta.get("ib_verified", resolved == "ib")),
        "ib_verified_at": str(meta.get("ib_verified_at") or "") or None,
    }


def warm_intraday_cache(
    symbol: str,
    *,
    lookback_days: int = 365,
    source: DataSource = "auto",
    chunk_days: int = 20,
    prefer_ib: bool = True,
    ib_use_rth: bool = False,
    ib_what_to_show: str = "TRADES",
    ib_max_retries: int = 2,
    ib_pause_ms: int = 150,
) -> dict[str, str | int | bool | None]:
    """Warm local 1-minute intraday cache over a lookback window.

    Notes
    -----
    - For IB, fetches in chunks and appends into the persistent local cache.
    - For Yahoo, 1m history is provider-limited (typically recent ~7 days).
      This helper still writes whatever is available so the cache can grow over
      time with periodic runs.
    """
    if lookback_days < 1:
        lookback_days = 1
    if chunk_days < 1:
        chunk_days = 1

    resolved = _resolve_source(source)
    # Allow callers to explicitly bypass IB even when connected.
    # This is used by backtest preflight to avoid IB historical stalls in
    # auto mode while still keeping IB as an optional second pass.
    if source in ("auto", "yfinance") and not prefer_ib:
        resolved = "yfinance"
    elif prefer_ib and _ib_is_connected():
        resolved = "ib"
    sym = symbol.upper()
    end_dt = datetime.now(_ET).date()
    start_dt = end_dt - timedelta(days=int(lookback_days))

    fetched_chunks = 0
    failed_chunks = 0
    fetched_rows = 0
    requests_made = 0
    last_error: str | None = None
    warning: str | None = None
    ib_ip_conflict_detected = False

    if resolved == "ib":
        what_to_show = str(ib_what_to_show or "TRADES").strip().upper() or "TRADES"
        retries = max(0, min(10, int(ib_max_retries)))
        pause_s = max(0.0, min(5.0, float(ib_pause_ms) / 1000.0))

        def _run_async(coro):
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    import concurrent.futures
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                        fut = executor.submit(asyncio.run, coro)
                        return fut.result(timeout=120)
            except RuntimeError:
                pass
            return asyncio.run(coro)

        def _fetch_ib_1m_chunk(chunk_start: date, chunk_end: date) -> pd.DataFrame:
            duration_days = max((chunk_end - chunk_start).days + 1, 1)
            end_datetime = f"{chunk_end.strftime('%Y%m%d')} 23:59:59"
            # IB can take substantially longer for larger intraday windows,
            # especially while other quote/account polling is active.
            request_timeout_s = max(25.0, min(90.0, float(duration_days * 3)))
            meta = _run_async(
                ib_service.get_historical_bars_request_meta(
                    symbol=sym,
                    end_datetime=end_datetime,
                    duration=f"{duration_days} D",
                    bar_size="1 min",
                    what_to_show=what_to_show,
                    use_rth=bool(ib_use_rth),
                    timeout_s=request_timeout_s,
                )
            )
            bars = list(meta.get("bars") or [])
            if not bars:
                err = meta.get("error")
                raise ValueError(str(err or "IB returned no bars"))

            rows: list[dict[str, float | int | pd.Timestamp]] = []
            for b in bars:
                try:
                    ts = _parse_ib_bar_datetime(str(b.get("date")))
                except Exception:
                    continue
                if ts.date() < chunk_start or ts.date() > chunk_end:
                    continue
                rows.append(
                    {
                        "Date": ts,
                        "Open": float(b.get("open")),
                        "High": float(b.get("high")),
                        "Low": float(b.get("low")),
                        "Close": float(b.get("close")),
                        "Volume": int(b.get("volume") or 0),
                    }
                )

            if not rows:
                raise ValueError("IB chunk returned bars outside requested date window")

            df_chunk = pd.DataFrame(rows).set_index("Date").sort_index()
            df_chunk = _tag_market_session(df_chunk)
            df_chunk.attrs["interval"] = "1m"
            return df_chunk

        cursor = start_dt
        while cursor <= end_dt:
            chunk_end = min(end_dt, cursor + timedelta(days=int(chunk_days) - 1))
            chunk_ok = False
            for attempt in range(retries + 1):
                requests_made += 1
                try:
                    df = _fetch_ib_1m_chunk(cursor, chunk_end)
                    if not df.empty:
                        _save_cached_df(sym, resolved, intraday=True, df=df, ib_verified=(resolved == "ib"))
                        fetched_rows += int(len(df))
                    chunk_ok = True
                    break
                except Exception as exc:
                    last_error = str(exc)
                    if _is_ib_ip_conflict_error(last_error):
                        ib_ip_conflict_detected = True
                    logger.debug(
                        "Warm intraday cache IB chunk failed for %s (%s→%s, attempt %d/%d): %s",
                        sym,
                        cursor,
                        chunk_end,
                        attempt + 1,
                        retries + 1,
                        exc,
                    )
                    if attempt < retries and pause_s > 0:
                        time.sleep(pause_s)

            if not chunk_ok:
                failed_chunks += 1
                if ib_ip_conflict_detected:
                    break
            fetched_chunks += 1
            cursor = chunk_end + timedelta(days=1)

        if ib_ip_conflict_detected and source in ("auto", "yfinance"):
            # IB may reject historical market data when the trading session is active from another IP.
            # In auto mode, gracefully degrade to Yahoo so warm-up can still populate recent cache.
            resolved = "yfinance"
            warning = (
                "IB historical data rejected because the trading session appears active from a different IP; "
                "fell back to Yahoo for warm-up."
            )
            logger.warning("%s symbol=%s", warning, sym)
    else:
        # Yahoo 1m lookback is short; request recent window and persist if available.
        # Use last 7 days to avoid guaranteed empty responses for older spans.
        pass

    if resolved == "yfinance":
        # Yahoo limits 1m history, so progressively widen the interval to cover
        # longer ranges while still keeping intraday bars in local cache.
        interval_windows = (
            ("1m", min(int(lookback_days), 7)),
            ("2m", min(int(lookback_days), 60)),
            ("5m", min(int(lookback_days), 60)),
        )
        ticker = yf.Ticker(sym)
        got_any_rows = False
        for interval, window_days in interval_windows:
            if window_days < 1:
                continue
            period = f"{int(window_days)}d"
            requests_made += 1
            try:
                # Period-based requests are more reliable on Yahoo intraday than
                # start/end windows for some symbols.
                df = ticker.history(period=period, interval=interval, prepost=True)
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = [col[0] for col in df.columns]
                if df.empty:
                    continue

                df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
                df.index = pd.to_datetime(df.index)
                cutoff_start = pd.Timestamp(end_dt - timedelta(days=window_days)).tz_localize(_ET)
                cutoff_end = (pd.Timestamp(end_dt) + pd.Timedelta(days=1)).tz_localize(_ET)
                scoped = _ensure_et_index(df)
                df = scoped[(scoped.index >= cutoff_start) & (scoped.index < cutoff_end)]
                if df.empty:
                    continue
                df = _tag_market_session(df)
                df.attrs["interval"] = interval
                _save_cached_df(sym, resolved, intraday=True, df=df, ib_verified=(resolved == "ib"))
                fetched_rows += int(len(df))
                got_any_rows = True
                fetched_chunks += 1
            except Exception as exc:
                last_error = str(exc)
                continue

        if not got_any_rows:
            failed_chunks = max(1, failed_chunks)
            fetched_chunks = max(1, fetched_chunks)
        elif failed_chunks > 0 and ib_ip_conflict_detected:
            failed_chunks = max(0, failed_chunks - 1)

    coverage = get_intraday_cache_coverage(sym, resolved)
    oldest = coverage.get("oldest")
    newest = coverage.get("newest")
    return {
        "symbol": sym,
        "source": resolved,
        "lookback_days": int(lookback_days),
        "requested_start": start_dt.isoformat(),
        "requested_end": end_dt.isoformat(),
        "chunks_attempted": int(fetched_chunks),
        "chunks_failed": int(failed_chunks),
        "requests_made": int(requests_made),
        "rows_fetched": int(fetched_rows),
        "rows_cached": int(coverage.get("rows") or 0),
        "cache_oldest": oldest,
        "cache_newest": newest,
        "ib_use_rth": bool(ib_use_rth) if resolved == "ib" else None,
        "ib_what_to_show": (str(ib_what_to_show or "").upper() if resolved == "ib" else None),
        "full_lookback_covered": bool(oldest and pd.Timestamp(oldest).date() <= start_dt),
        "ib_verified": bool(coverage.get("ib_verified", resolved == "ib")),
        "ib_verified_at": coverage.get("ib_verified_at"),
        "warning": warning,
        "error": last_error,
    }


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
        ("5s", "5 secs"),
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
    allow_remote_pull: bool = True,
) -> pd.DataFrame:
    """Fetch intraday OHLCV data using the finest available interval.

    For Interactive Brokers, tries ``5s`` first and then falls back to
    ``1m``, ``2m``, ``5m``. For yfinance, tries ``1m``, ``2m``, ``5m``.
    The first interval that returns data is used. Falls back gracefully when
    the date range exceeds what yfinance allows for a given interval.

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

    cached = _load_cached_df(symbol, source, start, end, intraday=True)
    if cached is not None:
        return cached

    if not allow_remote_pull and source != "ib":
        raise ValueError(
            f"No cached intraday data for {symbol!r} ({start}→{end}, source={source}). "
            "Backtest network pulls are disabled; warm cache via data manager workflows first."
        )

    if source == "yfinance" and _is_closed_day_now_et():
        raise ValueError(
            f"Cache miss for {symbol!r} intraday data on a closed market day; "
            "skip remote Yahoo pulls and use locally cached historical data."
        )

    if source == "ib":
        df = _fetch_ib_intraday(symbol, start, end)
        _save_cached_df(symbol, source, intraday=True, df=df, ib_verified=(source == "ib"))
        return df

    if source != "yfinance":
        logger.warning(
            "Intraday data is not supported for source '%s'; falling back to daily bars for %s.",
            source,
            symbol,
        )
        df = fetch_ohlcv(symbol, start, end, source=source)
        df.attrs["interval"] = "1d"
        _save_cached_df(symbol, source, intraday=False, df=df, ib_verified=(source == "ib"))
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
            _save_cached_df(symbol, source, intraday=True, df=df, ib_verified=(source == "ib"))
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
    allow_remote_pull: bool = True,
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

    requested_source = source
    source = _resolve_source(source)

    cached = _load_cached_df(symbol, source, start, end, intraday=False)
    if cached is not None:
        return cached

    if not allow_remote_pull and source != "ib":
        raise ValueError(
            f"No cached daily data for {symbol!r} ({start}→{end}, source={source}). "
            "Backtest network pulls are disabled; warm cache via data manager workflows first."
        )

    if source == "yfinance" and _is_closed_day_now_et():
        raise ValueError(
            f"Cache miss for {symbol!r} daily data on a closed market day; "
            "skip remote Yahoo pulls and use locally cached historical data."
        )

    if source not in fetchers:
        raise ValueError(
            f"Unknown data source {source!r}. Valid options: {list(fetchers)}"
        )

    if source == "ib":
        try:
            df = _fetch_ib(symbol, start, end)
            _save_cached_df(symbol, source, intraday=False, df=df, ib_verified=(source == "ib"))
            return df
        except ValueError as exc:
            logger.warning(
                "IB data unavailable (%s); falling back to yfinance for %s.", exc, symbol
            )
            source = "yfinance"

    if source == "yfinance":
        try:
            df = _fetch_yfinance(symbol, start, end)
            _save_cached_df(symbol, source, intraday=False, df=df, ib_verified=(source == "ib"))
            return df
        except ValueError as exc:
            if requested_source in ("auto", "ib"):
                logger.warning(
                    "yfinance failed (%s); falling back to stooq for %s.", exc, symbol
                )
                df = _fetch_stooq(symbol, start, end)
                _save_cached_df(symbol, "stooq", intraday=False, df=df, ib_verified=False)
                return df
            raise

    df = fetchers[source](symbol, start, end)
    _save_cached_df(symbol, source, intraday=False, df=df, ib_verified=(source == "ib"))
    return df


__all__ = [
    "fetch_ohlcv",
    "fetch_ohlcv_intraday",
    "list_data_sources",
    "DataSource",
    "_tag_market_session",
    "warm_intraday_cache",
    "get_intraday_cache_coverage",
]


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
