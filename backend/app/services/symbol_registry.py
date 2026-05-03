"""
Symbol registry – downloads and caches trading symbol listings from public sources.

Sources (free / no auth required):
  • NASDAQ Trader FTP  – covers NASDAQ, NYSE, NYSE MKT, NYSE ARCA, BATS

The registry is stored as  backend/data/symbol_registry.json  and refreshed
automatically on startup if the file is missing or older than 24 h.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Storage paths
# ---------------------------------------------------------------------------
_DATA_DIR       = Path(__file__).resolve().parents[2] / "data"   # backend/data/
_REGISTRY_FILE  = _DATA_DIR / "symbol_registry.json"
_MAX_AGE        = 86_400   # 24 hours in seconds

# In-memory index: { "AAPL": {"name": "Apple Inc.", "exchange": "NASDAQ"}, … }
_index: dict[str, dict] = {}
_index_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

_NASDAQ_URL = "https://ftp.nasdaqlisted.com/SymbolDirectory/nasdaqlisted.txt"
_OTHER_URL  = "https://ftp.nasdaqlisted.com/SymbolDirectory/otherlisted.txt"

_EXCH_CODE: dict[str, str] = {
    "A": "NYSE American",
    "N": "NYSE",
    "P": "NYSE Arca",
    "Q": "NASDAQ",
    "Z": "BATS",
    "V": "IEX",
}


def _parse_nasdaq(text: str) -> list[dict]:
    """nasdaqlisted.txt — pipe-delimited, header on line 0."""
    rows = []
    for line in text.splitlines()[1:]:
        if line.startswith("File Creation Time"):
            break
        parts = line.split("|")
        if len(parts) < 2:
            continue
        sym, name = parts[0].strip(), parts[1].strip()
        if sym and name and sym != "Symbol":
            rows.append({"symbol": sym, "name": name, "exchange": "NASDAQ"})
    return rows


def _parse_other(text: str) -> list[dict]:
    """otherlisted.txt — pipe-delimited, exchange code in column 2."""
    rows = []
    for line in text.splitlines()[1:]:
        if line.startswith("File Creation Time"):
            break
        parts = line.split("|")
        if len(parts) < 3:
            continue
        sym, name, code = parts[0].strip(), parts[1].strip(), parts[2].strip()
        if sym and name and sym != "ACT Symbol":
            rows.append({"symbol": sym, "name": name, "exchange": _EXCH_CODE.get(code, code)})
    return rows


async def _download_registry() -> dict[str, dict]:
    entries: dict[str, dict] = {}
    async with httpx.AsyncClient(headers=_HEADERS, follow_redirects=True, timeout=30) as client:
        for url, parser in [(_NASDAQ_URL, _parse_nasdaq), (_OTHER_URL, _parse_other)]:
            try:
                r = await client.get(url)
                r.raise_for_status()
                for row in parser(r.text):
                    entries[row["symbol"]] = {"name": row["name"], "exchange": row["exchange"]}
                logger.info("Registry: loaded %d symbols so far (from %s)", len(entries), url)
            except Exception as exc:
                logger.warning("Registry download failed for %s: %s", url, exc)
    return entries


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def ensure_registry(force: bool = False) -> None:
    """Called at startup – loads the file or refreshes it if stale / missing."""
    global _index
    _DATA_DIR.mkdir(parents=True, exist_ok=True)

    stale = force
    if not stale and _REGISTRY_FILE.exists():
        age = time.time() - _REGISTRY_FILE.stat().st_mtime
        stale = age >= _MAX_AGE
    elif not stale:
        stale = True  # file missing

    if stale:
        logger.info("Symbol registry is missing or stale – downloading …")
        data = await _download_registry()
        if data:
            _REGISTRY_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            logger.info("Symbol registry saved: %d symbols", len(data))
            async with _index_lock:
                _index = data
            return
        else:
            logger.warning("Registry download returned no data – will try loading from file.")

    if _REGISTRY_FILE.exists():
        try:
            raw = json.loads(_REGISTRY_FILE.read_text(encoding="utf-8"))
            async with _index_lock:
                _index = raw
            logger.info("Symbol registry loaded: %d symbols", len(_index))
        except Exception as exc:
            logger.error("Failed to load registry file: %s", exc)


def lookup(symbol: str) -> dict | None:
    """Return {name, exchange} for *symbol*, or None."""
    return _index.get(symbol.upper())


def search(q: str, limit: int = 10) -> list[dict]:
    """
    Return up to *limit* matches.
    Symbol-prefix matches come first, then name-substring matches.
    """
    if not q or not _index:
        return []
    q_up = q.upper().strip()
    q_lo = q.lower().strip()
    seen: set[str] = set()
    results: list[dict] = []

    # 1. Exact symbol-prefix matches
    for sym, info in _index.items():
        if sym.startswith(q_up):
            results.append({"symbol": sym, **info})
            seen.add(sym)
            if len(results) >= limit:
                return results

    # 2. Name substring matches
    for sym, info in _index.items():
        if sym not in seen and q_lo in info["name"].lower():
            results.append({"symbol": sym, **info})
            if len(results) >= limit:
                break

    return results
