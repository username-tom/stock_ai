"""Bar predictor: Python port of the NextBarPredictor frontend component.

Computes a momentum bias in [-1, +1] from OHLCV bar data using:
  - Heikin-Ashi trend bias
  - MACD histogram bias
  - Recent slope bias

Weights match the NextBarPredictor T+1m projection:
  HA 0.52, MACD 0.20, slope 0.18  (book pressure omitted – not available in backtester)
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd


# ── helpers ───────────────────────────────────────────────────────────────── #

def _clamp(value: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _ema_list(values: list[float], period: int) -> float | None:
    """Exponential moving average over a list, skipping non-finite values."""
    finite = [v for v in values if math.isfinite(v)]
    if not finite:
        return None
    alpha = 2.0 / (period + 1)
    current = finite[0]
    for v in finite[1:]:
        current = v * alpha + current * (1.0 - alpha)
    return current


# ── per-bar computation ───────────────────────────────────────────────────── #

def compute_heikin_ashi_bias(bars: list[dict[str, Any]]) -> float:
    """Return Heikin-Ashi directional bias for the last bar in *bars*."""
    if not bars:
        return 0.0

    prev_ha_open = prev_ha_close = None
    last_bias = 0.0

    for bar in bars:
        o = bar.get("open") or bar.get("Open")
        h = bar.get("high") or bar.get("High")
        lo = bar.get("low") or bar.get("Low")
        c = bar.get("close") or bar.get("Close")
        if None in (o, h, lo, c):
            continue
        try:
            o, h, lo, c = float(o), float(h), float(lo), float(c)
        except (TypeError, ValueError):
            continue

        ha_close = (o + h + lo + c) / 4.0
        if prev_ha_open is None or prev_ha_close is None:
            ha_open = (o + c) / 2.0
        else:
            ha_open = (prev_ha_open + prev_ha_close) / 2.0

        prev_ha_open = ha_open
        prev_ha_close = ha_close
        rng = max(h - lo, abs(ha_close - ha_open), 1e-8)
        last_bias = _clamp((ha_close - ha_open) / rng)

    return last_bias


def compute_macd_bias(closes: list[float]) -> float:
    """MACD-histogram directional bias derived from close prices."""
    if len(closes) < 5:
        return 0.0
    fast = _ema_list(closes[-12:], min(12, len(closes)))
    slow = _ema_list(closes[-26:], min(26, len(closes)))
    if fast is None or slow is None:
        return 0.0
    diff = fast - slow
    scale = max(abs(slow), 1e-8)
    return _clamp(diff / scale * 18.0)


def compute_slope_bias(closes: list[float]) -> float:
    """Short-window price slope bias."""
    if len(closes) < 2:
        return 0.0
    recent = closes[-6:]
    if len(recent) < 2:
        return 0.0
    first, last = recent[0], recent[-1]
    avg = _ema_list(recent, min(5, len(recent))) or last
    scale = max(avg, 1e-8)
    return _clamp(((last - first) / scale) * 9.0)


def compute_bar_predictor_bias(
    bars: list[dict[str, Any]],
    lookback: int = 30,
) -> float:
    """Combine HA, MACD, and slope bias into a single momentum score.

    Parameters
    ----------
    bars:
        Recent OHLCV bars, oldest first. Accepts both lowercase
        (``open``/``close``/...) and title-case (``Open``/``Close``/...) keys.
    lookback:
        Maximum number of bars to use.

    Returns
    -------
    float in [-1, +1]; positive = bullish momentum, negative = bearish.
    """
    if not bars:
        return 0.0

    recent = bars[-lookback:]
    closes: list[float] = []
    for b in recent:
        c = b.get("close") or b.get("Close")
        if c is not None:
            try:
                closes.append(float(c))
            except (TypeError, ValueError):
                pass

    ha_bias = compute_heikin_ashi_bias(recent)
    macd_bias = compute_macd_bias(closes)
    slope_bias = compute_slope_bias(closes)

    return _clamp(ha_bias * 0.52 + macd_bias * 0.20 + slope_bias * 0.18)


# ── vectorised (backtester) ───────────────────────────────────────────────── #

def compute_bar_predictor_bias_series(
    df: pd.DataFrame,
    lookback: int = 30,
) -> pd.Series:
    """Compute a rolling bias Series from a price DataFrame.

    The bias at index *i* is computed from the bars [i-lookback+1 .. i],
    i.e. it is causal (no look-ahead) and suitable for backtesting.

    Parameters
    ----------
    df:
        DataFrame with ``Open``, ``High``, ``Low``, ``Close`` columns.
    lookback:
        Rolling window size (default 30 1-minute bars ≈ 30 minutes).

    Returns
    -------
    pd.Series with the same index as *df*, dtype float64, name
    ``"bar_predictor_bias"``.
    """
    closes = df["Close"].to_numpy(dtype=float)
    opens  = df["Open"].to_numpy(dtype=float)
    highs  = df["High"].to_numpy(dtype=float)
    lows   = df["Low"].to_numpy(dtype=float)
    n = len(df)
    bias_arr = np.zeros(n, dtype=float)

    for i in range(n):
        start = max(0, i - lookback + 1)
        if (i - start) < 1:
            continue
        c_win = closes[start : i + 1].tolist()
        bars_win = [
            {
                "Open": float(opens[j]),
                "High": float(highs[j]),
                "Low": float(lows[j]),
                "Close": float(closes[j]),
            }
            for j in range(start, i + 1)
        ]
        ha   = compute_heikin_ashi_bias(bars_win)
        macd = compute_macd_bias(c_win)
        slp  = compute_slope_bias(c_win)
        bias_arr[i] = max(-1.0, min(1.0, ha * 0.52 + macd * 0.20 + slp * 0.18))

    return pd.Series(bias_arr, index=df.index, name="bar_predictor_bias")
