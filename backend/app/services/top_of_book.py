"""Top-of-book utilities for simulation/backtest and IB mode.

Design goals
------------
- In IB mode, consume actual Level-1 touch data (bid/ask + sizes) from IB.
- In sim/backtest mode, synthesize minute-level top-of-book from OHLCV bars.
- Provide one consistent fill-price helper so BUYs cross ask and SELLs hit bid.

The simulation model is intentionally lightweight and deterministic:
- Midpoint anchor: bar close (or quote last).
- Spread model: base spread + volatility term + inverse-liquidity term.
- Queue sizes: scaled from volume with a direction bias from bar impulse.

This follows common microstructure heuristics for minute bars where true tick
order-book updates are unavailable.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any


def _pos(value: Any, default: float = 0.0) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(num) or num <= 0.0:
        return default
    return num


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _estimate_spread_bps(*, mid: float, high: float, low: float, volume: float) -> float:
    if mid <= 0.0:
        return 5.0
    bar_range_bps = ((max(high, low) - min(high, low)) / mid) * 10_000.0 if high > 0 and low > 0 else 0.0
    lots = max(1.0, volume / 100.0)

    # Heuristic blend tuned for minute-bar simulation:
    # - tighter spreads in liquid/high-volume symbols
    # - wider spreads during high intrabar volatility
    spread_bps = 1.5 + (0.06 * bar_range_bps) + (14.0 / math.sqrt(lots))
    return _clamp(spread_bps, 1.0, 80.0)


def _estimate_book_sizes(*, volume: float, pressure: float) -> tuple[float, float]:
    base = _clamp(max(100.0, volume * 0.03), 100.0, 20_000.0)
    tilt = _clamp(pressure, -1.0, 1.0) * 0.25
    bid_size = _clamp(base * (1.0 + tilt), 100.0, 50_000.0)
    ask_size = _clamp(base * (1.0 - tilt), 100.0, 50_000.0)
    return round(bid_size, 2), round(ask_size, 2)


def _build_book(
    *,
    symbol: str,
    bid: float,
    ask: float,
    bid_size: float,
    ask_size: float,
    last_price: float,
    source: str,
) -> dict[str, Any]:
    bid_clean = max(0.0, float(bid or 0.0))
    ask_clean = max(0.0, float(ask or 0.0))
    if bid_clean <= 0.0 and ask_clean > 0.0:
        bid_clean = ask_clean
    if ask_clean <= 0.0 and bid_clean > 0.0:
        ask_clean = bid_clean
    if ask_clean < bid_clean:
        ask_clean = bid_clean

    mid = (bid_clean + ask_clean) / 2.0 if bid_clean > 0.0 and ask_clean > 0.0 else _pos(last_price, 0.0)
    spread = max(0.0, ask_clean - bid_clean) if bid_clean > 0.0 and ask_clean > 0.0 else 0.0
    spread_bps = (spread / mid * 10_000.0) if mid > 0.0 else 0.0

    bsz = _pos(bid_size, 100.0)
    asz = _pos(ask_size, 100.0)
    denom = bsz + asz
    if denom > 0 and bid_clean > 0 and ask_clean > 0:
        # Standard microprice uses opposite queue size as weights.
        micro = ((ask_clean * bsz) + (bid_clean * asz)) / denom
    else:
        micro = mid

    return {
        "symbol": str(symbol or "").upper(),
        "bid": round(bid_clean, 6) if bid_clean > 0 else None,
        "ask": round(ask_clean, 6) if ask_clean > 0 else None,
        "bid_size": round(bsz, 2),
        "ask_size": round(asz, 2),
        "mid": round(float(mid), 6) if mid > 0 else None,
        "microprice": round(float(micro), 6) if micro > 0 else None,
        "spread": round(float(spread), 6),
        "spread_bps": round(float(spread_bps), 4),
        "last_price": round(float(_pos(last_price, mid)), 6) if _pos(last_price, mid) > 0 else None,
        "source": source,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }


def simulate_top_of_book_from_bar(
    *,
    symbol: str,
    open_price: Any,
    high: Any,
    low: Any,
    close: Any,
    volume: Any,
    previous_close: Any = None,
) -> dict[str, Any]:
    close_px = _pos(close, _pos(previous_close, 0.0))
    if close_px <= 0.0:
        return _build_book(
            symbol=symbol,
            bid=0.0,
            ask=0.0,
            bid_size=100.0,
            ask_size=100.0,
            last_price=0.0,
            source="sim_bar",
        )

    open_px = _pos(open_price, close_px)
    high_px = _pos(high, max(open_px, close_px))
    low_px = _pos(low, min(open_px, close_px))
    vol = _pos(volume, 0.0)

    spread_bps = _estimate_spread_bps(mid=close_px, high=high_px, low=low_px, volume=vol)
    spread = close_px * (spread_bps / 10_000.0)
    half = spread / 2.0

    bid = max(0.01, close_px - half)
    ask = max(bid + 0.0001, close_px + half)

    denom = max(0.0001, high_px - low_px)
    pressure = _clamp((close_px - open_px) / denom, -1.0, 1.0)
    bid_size, ask_size = _estimate_book_sizes(volume=vol, pressure=pressure)

    return _build_book(
        symbol=symbol,
        bid=bid,
        ask=ask,
        bid_size=bid_size,
        ask_size=ask_size,
        last_price=close_px,
        source="sim_bar",
    )


def simulate_top_of_book_from_quote(symbol: str, quote: dict[str, Any] | None) -> dict[str, Any]:
    q = quote or {}
    bid = _pos(q.get("bid"), 0.0)
    ask = _pos(q.get("ask"), 0.0)
    bid_size = _pos(q.get("bid_size"), 0.0)
    ask_size = _pos(q.get("ask_size"), 0.0)
    last_px = _pos(q.get("last_price") or q.get("last") or q.get("close"), 0.0)

    if bid > 0.0 and ask > 0.0 and ask >= bid:
        if bid_size <= 0.0 or ask_size <= 0.0:
            est_bid, est_ask = _estimate_book_sizes(
                volume=_pos(q.get("volume"), 0.0),
                pressure=0.0,
            )
            bid_size = bid_size or est_bid
            ask_size = ask_size or est_ask
        return _build_book(
            symbol=symbol,
            bid=bid,
            ask=ask,
            bid_size=bid_size,
            ask_size=ask_size,
            last_price=last_px,
            source="quote_tob",
        )

    open_px = _pos(q.get("open"), last_px)
    high_px = _pos(q.get("day_high"), max(open_px, last_px))
    low_px = _pos(q.get("day_low"), min(open_px, last_px))
    vol = _pos(q.get("volume"), 0.0)

    return simulate_top_of_book_from_bar(
        symbol=symbol,
        open_price=open_px,
        high=high_px,
        low=low_px,
        close=last_px,
        volume=vol,
        previous_close=q.get("previous_close"),
    )


async def get_ib_top_of_book(symbol: str) -> dict[str, Any] | None:
    from app.services.ib_service import ib_service

    if not ib_service.is_connected:
        return None

    raw = await ib_service.get_market_data(symbol)
    if not isinstance(raw, dict) or raw.get("error"):
        return None

    bid = _pos(raw.get("bid"), 0.0)
    ask = _pos(raw.get("ask"), 0.0)
    last_px = _pos(raw.get("last") or raw.get("close"), 0.0)
    bid_size = _pos(raw.get("bid_size"), 0.0)
    ask_size = _pos(raw.get("ask_size"), 0.0)

    if bid <= 0.0 and ask <= 0.0 and last_px <= 0.0:
        return None

    if bid <= 0.0 or ask <= 0.0 or ask < bid:
        anchor = _pos(last_px, _pos(raw.get("close"), 0.0))
        if anchor <= 0.0:
            return None
        fallback_spread = max(anchor * 0.0003, 0.01)
        bid = bid if bid > 0.0 else anchor - (fallback_spread / 2.0)
        ask = ask if ask > 0.0 else anchor + (fallback_spread / 2.0)
        if ask < bid:
            ask = bid + 0.0001

    if bid_size <= 0.0 or ask_size <= 0.0:
        est_bid, est_ask = _estimate_book_sizes(volume=0.0, pressure=0.0)
        bid_size = bid_size or est_bid
        ask_size = ask_size or est_ask

    book = _build_book(
        symbol=symbol,
        bid=bid,
        ask=ask,
        bid_size=bid_size,
        ask_size=ask_size,
        last_price=last_px if last_px > 0.0 else (bid + ask) / 2.0,
        source="ib_tob",
    )
    market_data_type = int(raw.get("market_data_type") or 0)
    labels = {
        1: "live",
        2: "frozen",
        3: "delayed",
        4: "delayed-frozen",
    }
    book["market_data_type"] = market_data_type or None
    book["market_data_label"] = labels.get(market_data_type, "unknown")
    book["is_live_market_data"] = market_data_type == 1
    return book


def market_fill_price(book: dict[str, Any] | None, side: str, fallback_price: float = 0.0) -> float:
    if not isinstance(book, dict):
        return _pos(fallback_price, 0.0)
    s = str(side or "").upper()
    if s == "BUY":
        return _pos(book.get("ask"), _pos(book.get("mid"), _pos(fallback_price, 0.0)))
    if s == "SELL":
        return _pos(book.get("bid"), _pos(book.get("mid"), _pos(fallback_price, 0.0)))
    return _pos(book.get("mid"), _pos(fallback_price, 0.0))


def estimate_fill_probability_pct(
    *,
    side: str,
    quantity: Any,
    top_of_book: dict[str, Any] | None,
    base_rate_pct: Any,
) -> float:
    """Return an adjusted fill probability using order-size vs touch-size.

    The base rate remains the main control knob. We only nudge it by queue-size
    pressure so small lots at the touch fill more often than oversized clips.
    """
    base = _clamp(_pos(base_rate_pct, 0.0), 0.0, 100.0)
    qty = _pos(quantity, 0.0)
    if qty <= 0.0 or not isinstance(top_of_book, dict):
        return base

    side_u = str(side or "").upper()
    touch_size = _pos(
        top_of_book.get("ask_size") if side_u == "BUY" else top_of_book.get("bid_size"),
        0.0,
    )
    if touch_size <= 0.0:
        return base

    ratio = qty / touch_size
    if ratio <= 0.25:
        boost = 18.0
    elif ratio <= 0.50:
        boost = 12.0
    elif ratio <= 1.00:
        boost = 6.0
    elif ratio <= 1.50:
        boost = -4.0
    elif ratio <= 2.00:
        boost = -10.0
    else:
        boost = -18.0

    return _clamp(base + boost, 0.0, 100.0)
