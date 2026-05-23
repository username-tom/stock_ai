"""External sentiment aggregator.

Phase 1 sources (no API keys required):
    * Yahoo Finance news headlines (reuses market_service._fetch_symbol_news)
    * StockTwits public message stream (Bullish/Bearish tagged messages + VADER on body)
    * SEC EDGAR recent filings (8-K event flag, neutral score but boosts ``event_flag``)

Each provider returns a :class:`SentimentSignal` with:
    * ``score``      — float in [-1, +1]   (negative = bearish, positive = bullish)
    * ``confidence`` — float in [0, 1]     (sample-size driven)
    * ``n_items``    — int                 (raw items considered)
    * ``headlines``  — list[dict]          (explainability payload)
    * ``event_flag`` — bool                (recent material filing / catalyst)

The aggregator weighted-averages provider scores and maps to the
PortfolioManager 5-bucket convention (crash / bearish / neutral / bullish / euphoric).

Result is cached per symbol for ``_CACHE_TTL_S`` seconds.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.services import market_service

logger = logging.getLogger(__name__)

_CACHE_TTL_S = 5 * 60
_PROVIDER_TIMEOUT_S = 4.0
_HEADLINE_LIMIT_PER_SOURCE = 6
_USER_AGENT = "stock-ai-sentiment/1.0 (+https://github.com/local/stock_ai)"
# SEC EDGAR requires an identifying email in the User-Agent header per their
# fair-access policy (https://www.sec.gov/os/accessing-edgar-data).
_SEC_CONTACT_EMAIL = os.environ.get("SEC_CONTACT_EMAIL", "stock-ai-bot@example.com")
_SEC_USER_AGENT = f"stock-ai-sentiment/1.0 {_SEC_CONTACT_EMAIL}"

# Bucket thresholds on a [-1, +1] aggregate score
_BUCKET_THRESHOLDS = (
    (-0.55, "crash"),
    (-0.20, "bearish"),
    (0.20, "neutral"),
    (0.55, "bullish"),
    (1.01, "euphoric"),
)

# Per-source default weights — Yahoo carries the most signal because it's
# professionally written; StockTwits is noisy retail buzz; SEC is event-only.
_DEFAULT_WEIGHTS: dict[str, float] = {
    "yahoo": 1.0,
    "stocktwits": 0.6,
    "sec_edgar": 0.0,  # contributes event_flag, not score
}

_cache: dict[str, tuple[dict[str, Any], float]] = {}
_cache_lock = asyncio.Lock()


# ── VADER analyser (lazy, with graceful fallback) ────────────────────────── #
_vader_analyzer: Any = None
_vader_unavailable = False


def _score_text(text: str) -> float:
    """Return a sentiment score in [-1, +1] for ``text`` using VADER when available."""
    global _vader_analyzer, _vader_unavailable
    if not text:
        return 0.0
    if _vader_analyzer is None and not _vader_unavailable:
        try:
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer  # type: ignore

            _vader_analyzer = SentimentIntensityAnalyzer()
        except Exception as exc:  # pragma: no cover - import guard
            logger.warning("vaderSentiment not available, using keyword fallback: %s", exc)
            _vader_unavailable = True

    if _vader_analyzer is not None:
        try:
            return float(_vader_analyzer.polarity_scores(text).get("compound", 0.0))
        except Exception:
            pass

    # Minimal keyword fallback so the service still produces a signal in dev.
    lowered = text.lower()
    pos = sum(w in lowered for w in ("beat", "surge", "soar", "upgrade", "rally", "strong", "record", "buy"))
    neg = sum(w in lowered for w in ("miss", "plunge", "downgrade", "fall", "weak", "loss", "cut", "sell", "fraud"))
    total = pos + neg
    return 0.0 if total == 0 else max(-1.0, min(1.0, (pos - neg) / total))


# ── Data classes ─────────────────────────────────────────────────────────── #
@dataclass
class SentimentSignal:
    source: str
    score: float = 0.0
    confidence: float = 0.0
    n_items: int = 0
    headlines: list[dict[str, Any]] = field(default_factory=list)
    event_flag: bool = False
    error: str | None = None


def _bucket_for(score: float) -> str:
    for upper, name in _BUCKET_THRESHOLDS:
        if score < upper:
            return name
    return "euphoric"


def _confidence_for(n: int) -> float:
    """Logistic-ish confidence that saturates around 8 items."""
    if n <= 0:
        return 0.0
    return max(0.0, min(1.0, n / 8.0))


# ── Providers ────────────────────────────────────────────────────────────── #
async def _fetch_yahoo(symbol: str) -> SentimentSignal:
    try:
        items = await market_service._fetch_symbol_news(symbol, count=_HEADLINE_LIMIT_PER_SOURCE)
    except Exception as exc:
        return SentimentSignal(source="yahoo", error=str(exc))
    if not items:
        return SentimentSignal(source="yahoo")

    scores: list[float] = []
    headlines: list[dict[str, Any]] = []
    for item in items:
        title = (item.get("title") or "").strip()
        if not title:
            continue
        s = _score_text(title)
        scores.append(s)
        headlines.append({
            "title": title,
            "url": item.get("url"),
            "publisher": item.get("source"),
            "published_at": item.get("published_at"),
            "score": round(s, 3),
        })

    if not scores:
        return SentimentSignal(source="yahoo")
    avg = sum(scores) / len(scores)
    return SentimentSignal(
        source="yahoo",
        score=max(-1.0, min(1.0, avg)),
        confidence=_confidence_for(len(scores)),
        n_items=len(scores),
        headlines=headlines,
    )


_STOCKTWITS_URL = "https://api.stocktwits.com/api/2/streams/symbol/{symbol}.json"


async def _fetch_stocktwits(symbol: str, client: httpx.AsyncClient) -> SentimentSignal:
    try:
        r = await client.get(
            _STOCKTWITS_URL.format(symbol=symbol),
            params={"limit": 30},
            headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
            timeout=_PROVIDER_TIMEOUT_S,
        )
        if r.status_code == 404:
            return SentimentSignal(source="stocktwits")
        r.raise_for_status()
        messages = r.json().get("messages", []) or []
    except Exception as exc:
        return SentimentSignal(source="stocktwits", error=str(exc))

    if not messages:
        return SentimentSignal(source="stocktwits")

    scores: list[float] = []
    bull = bear = 0
    headlines: list[dict[str, Any]] = []
    for msg in messages:
        body = (msg.get("body") or "").strip()
        tagged = ((msg.get("entities") or {}).get("sentiment") or {}).get("basic")
        if tagged == "Bullish":
            scores.append(0.8)
            bull += 1
        elif tagged == "Bearish":
            scores.append(-0.8)
            bear += 1
        elif body:
            s = _score_text(body)
            scores.append(s)
        else:
            continue
        if len(headlines) < _HEADLINE_LIMIT_PER_SOURCE and body:
            headlines.append({
                "title": body[:240],
                "url": f"https://stocktwits.com/symbol/{symbol}",
                "publisher": "StockTwits",
                "published_at": msg.get("created_at"),
                "tag": tagged,
                "score": round(scores[-1], 3),
            })

    if not scores:
        return SentimentSignal(source="stocktwits")
    avg = sum(scores) / len(scores)
    return SentimentSignal(
        source="stocktwits",
        score=max(-1.0, min(1.0, avg)),
        confidence=_confidence_for(len(scores)),
        n_items=len(scores),
        headlines=headlines,
        # rough conviction note: keep in headlines payload too
    )


_SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
_SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
_sec_ticker_map: dict[str, str] | None = None  # ticker -> 10-digit zero-padded CIK
_sec_ticker_lock = asyncio.Lock()
_SEC_EVENT_FORMS = {"8-K", "6-K"}
_SEC_LOOKBACK_HOURS = 36


async def _load_sec_ticker_map(client: httpx.AsyncClient) -> dict[str, str]:
    global _sec_ticker_map
    if _sec_ticker_map is not None:
        return _sec_ticker_map
    async with _sec_ticker_lock:
        if _sec_ticker_map is not None:
            return _sec_ticker_map
        try:
            r = await client.get(
                _SEC_TICKERS_URL,
                headers={"User-Agent": _SEC_USER_AGENT, "Accept": "application/json"},
                timeout=_PROVIDER_TIMEOUT_S,
            )
            r.raise_for_status()
            data = r.json()
            mapping = {
                str(entry["ticker"]).upper(): f"{int(entry['cik_str']):010d}"
                for entry in data.values()
                if "ticker" in entry and "cik_str" in entry
            }
            _sec_ticker_map = mapping
        except Exception as exc:
            logger.warning("SEC ticker map fetch failed: %s", exc)
            _sec_ticker_map = {}
    return _sec_ticker_map


async def _fetch_sec_edgar(symbol: str, client: httpx.AsyncClient) -> SentimentSignal:
    try:
        mapping = await _load_sec_ticker_map(client)
        cik = mapping.get(symbol.upper())
        if not cik:
            return SentimentSignal(source="sec_edgar")
        r = await client.get(
            _SEC_SUBMISSIONS_URL.format(cik=cik),
            headers={"User-Agent": _SEC_USER_AGENT, "Accept": "application/json"},
            timeout=_PROVIDER_TIMEOUT_S,
        )
        r.raise_for_status()
        recent = (r.json().get("filings") or {}).get("recent") or {}
    except Exception as exc:
        return SentimentSignal(source="sec_edgar", error=str(exc))

    forms = recent.get("form") or []
    dates = recent.get("filingDate") or []
    accessions = recent.get("accessionNumber") or []
    primary_docs = recent.get("primaryDocument") or []

    now = time.time()
    cutoff = now - _SEC_LOOKBACK_HOURS * 3600
    headlines: list[dict[str, Any]] = []
    event_count = 0
    for i, form in enumerate(forms[:25]):
        if form not in _SEC_EVENT_FORMS:
            continue
        date_str = dates[i] if i < len(dates) else ""
        try:
            ts = time.mktime(time.strptime(date_str, "%Y-%m-%d"))
        except Exception:
            ts = now
        if ts < cutoff:
            continue
        event_count += 1
        accession = accessions[i] if i < len(accessions) else ""
        doc = primary_docs[i] if i < len(primary_docs) else ""
        accession_clean = accession.replace("-", "")
        url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
            f"{accession_clean}/{doc}" if accession_clean and doc else None
        )
        headlines.append({
            "title": f"{form} filing on {date_str}",
            "url": url,
            "publisher": "SEC EDGAR",
            "published_at": date_str,
            "score": 0.0,
        })
        if len(headlines) >= _HEADLINE_LIMIT_PER_SOURCE:
            break

    return SentimentSignal(
        source="sec_edgar",
        score=0.0,
        confidence=0.3 if event_count else 0.0,
        n_items=event_count,
        headlines=headlines,
        event_flag=event_count > 0,
    )


# ── Public API ───────────────────────────────────────────────────────────── #
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(timeout=_PROVIDER_TIMEOUT_S)
    return _http_client


async def _gather_signals(symbol: str) -> list[SentimentSignal]:
    client = _get_client()
    results = await asyncio.gather(
        _fetch_yahoo(symbol),
        _fetch_stocktwits(symbol, client),
        _fetch_sec_edgar(symbol, client),
        return_exceptions=True,
    )
    signals: list[SentimentSignal] = []
    for res in results:
        if isinstance(res, SentimentSignal):
            signals.append(res)
        else:
            logger.warning("sentiment provider raised: %s", res)
    return signals


def _aggregate(signals: list[SentimentSignal], weights: dict[str, float]) -> dict[str, Any]:
    weighted_sum = 0.0
    weight_total = 0.0
    event_flag = False
    by_source: dict[str, dict[str, Any]] = {}
    headlines: list[dict[str, Any]] = []

    for sig in signals:
        w = max(0.0, float(weights.get(sig.source, _DEFAULT_WEIGHTS.get(sig.source, 0.0))))
        effective = w * sig.confidence
        if effective > 0:
            weighted_sum += sig.score * effective
            weight_total += effective
        if sig.event_flag:
            event_flag = True
        by_source[sig.source] = {
            "score": round(sig.score, 4),
            "confidence": round(sig.confidence, 3),
            "n_items": sig.n_items,
            "weight": w,
            "event_flag": sig.event_flag,
            "error": sig.error,
        }
        headlines.extend(sig.headlines)

    aggregate_score = weighted_sum / weight_total if weight_total > 0 else 0.0
    aggregate_score = max(-1.0, min(1.0, aggregate_score))
    return {
        "score": round(aggregate_score, 4),
        "bucket": _bucket_for(aggregate_score),
        "confidence": round(min(1.0, weight_total), 3),
        "event_flag": event_flag,
        "by_source": by_source,
        "headlines": headlines,
    }


async def get_sentiment(
    symbol: str,
    *,
    force_refresh: bool = False,
    weights: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Return an aggregated external sentiment payload for ``symbol``.

    The result is cached per uppercase symbol for ``_CACHE_TTL_S`` seconds.
    Pass ``force_refresh=True`` to bypass the cache. ``weights`` overrides
    per-source weights; missing sources fall back to defaults.
    """
    sym = symbol.upper().strip()
    if not sym:
        return {"symbol": "", "score": 0.0, "bucket": "neutral", "confidence": 0.0, "by_source": {}, "headlines": []}

    cache_key = sym
    if not force_refresh:
        async with _cache_lock:
            cached = _cache.get(cache_key)
            if cached and (time.time() - cached[1]) < _CACHE_TTL_S:
                return cached[0]

    signals = await _gather_signals(sym)
    aggregated = _aggregate(signals, weights or _DEFAULT_WEIGHTS)
    payload = {
        "symbol": sym,
        "as_of": int(time.time()),
        **aggregated,
    }

    async with _cache_lock:
        _cache[cache_key] = (payload, time.time())
    return payload


async def get_bulk_sentiment(
    symbols: list[str],
    *,
    force_refresh: bool = False,
    weights: dict[str, float] | None = None,
) -> dict[str, dict[str, Any]]:
    """Fetch sentiment for multiple symbols concurrently."""
    syms = [s.upper().strip() for s in symbols if s and s.strip()]
    if not syms:
        return {}
    results = await asyncio.gather(
        *(get_sentiment(s, force_refresh=force_refresh, weights=weights) for s in syms),
        return_exceptions=True,
    )
    out: dict[str, dict[str, Any]] = {}
    for sym, res in zip(syms, results):
        if isinstance(res, dict):
            out[sym] = res
        else:
            logger.warning("sentiment failed for %s: %s", sym, res)
    return out
