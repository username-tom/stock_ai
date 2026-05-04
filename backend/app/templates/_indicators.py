"""Shared indicator calculation and parameter-parsing helpers.

Imported by all strategy templates to avoid duplication.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Indicator calculations
# ---------------------------------------------------------------------------

def calc_rsi(close: pd.Series, period: int) -> pd.Series:
    """Exponentially-smoothed RSI (Wilder method)."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))


def calc_macd(
    close: pd.Series,
    fast: int,
    slow: int,
    signal: int,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Return (macd_line, signal_line, histogram)."""
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line, macd_line - signal_line


def calc_ma(close: pd.Series, period: int, ma_type: str = "SMA") -> pd.Series:
    """Simple or exponential moving average."""
    if ma_type.upper() == "EMA":
        return close.ewm(span=period, adjust=False).mean()
    return close.rolling(window=period).mean()


def calc_bb(
    close: pd.Series,
    period: int,
    std_dev: float,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Return (upper, mid, lower) Bollinger Bands."""
    mid = close.rolling(window=period).mean()
    std = close.rolling(window=period).std()
    return mid + std_dev * std, mid, mid - std_dev * std


def calc_kdj(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    n: int,
    m1: int,
    m2: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (K, D, J) arrays for the KDJ stochastic indicator."""
    lowest = low.rolling(n).min()
    highest = high.rolling(n).max()
    hl_range = (highest - lowest).replace(0, np.nan)
    rsv = ((close - lowest) / hl_range * 100).fillna(50)

    k = np.full(len(close), 50.0)
    d = np.full(len(close), 50.0)
    rsv_arr = rsv.values
    for i in range(1, len(close)):
        k[i] = k[i - 1] * (m1 - 1) / m1 + rsv_arr[i] / m1
        d[i] = d[i - 1] * (m2 - 1) / m2 + k[i] / m2
    j = 3 * k - 2 * d
    return k, d, j


def calc_cci(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    period: int,
) -> pd.Series:
    """Commodity Channel Index."""
    tp = (high + low + close) / 3
    ma_tp = tp.rolling(period).mean()
    md = tp.rolling(period).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    return (tp - ma_tp) / (0.015 * md.replace(0, np.nan))


# ---------------------------------------------------------------------------
# Safe parameter coercion helpers
# ---------------------------------------------------------------------------

def safe_int(value, default: int) -> int:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def safe_float(value, default: float) -> float:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def safe_str(value, default: str) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    return str(value)


def safe_val(arr, i: int) -> float:
    """Return arr[i] as float, or NaN if out of bounds or None."""
    if i < 0 or i >= len(arr):
        return float("nan")
    v = arr[i]
    return float(v) if v is not None else float("nan")
