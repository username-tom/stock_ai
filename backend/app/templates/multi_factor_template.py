"""
Multi-Factor Strategy (MA + KDJ + RSI + CCI + VMA + MACD)

All enabled indicators must agree for a buy (AND logic).
Any enabled indicator's sell condition, stop-loss, or take-profit triggers a sell (OR logic).

Buy conditions (all enabled must be True):
  MA   : fast MA > slow MA, with both MAs trending up
  KDJ  : K crosses above D (bullish reversal) with J <= 40 and rising
  RSI  : RSI fast crosses above RSI slow, both trending up
  CCI  : CCI crosses up through -100 from below
  VMA  : short volume MA > long volume MA on the previous bar
  MACD : DIF > DEA, both rising, histogram rising, DIF > 0 and DEA > 0

Sell conditions (any True triggers sell while in position):
  MA   : RSI fast < RSI slow
  KDJ  : K crosses below D (bearish reversal) with J near 80 and falling
  RSI  : RSI fast crosses below RSI slow
  CCI  : CCI crosses back below -100
  VMA  : RSI fast < RSI slow
  MACD : DIF < DEA
  Stop-loss   : unrealised loss >= stop_loss_pct %
  Take-profit : unrealised gain >= take_profit_pct %

signal_source values:
  buy  : "multi_factor"
  sell : "ma_sell" | "kdj_sell" | "rsi_sell" | "cci_sell" | "vma_sell"
       | "macd_sell" | "stop_loss" | "take_profit"
"""

import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {
        # MA dual moving average: [fast, slow, enabled]
        "ma_fast": 5,
        "ma_slow": 15,
        "ma_enabled": 1,
        # KDJ: [n period, m1 smoothing, m2 smoothing, enabled]
        "kdj_n": 9,
        "kdj_m1": 3,
        "kdj_m2": 3,
        "kdj_enabled": 0,
        # RSI dual-period: [fast period, slow period, enabled]
        "rsi_fast": 7,
        "rsi_slow": 14,
        "rsi_enabled": 1,
        # CCI: [period, enabled]
        "cci_period": 14,
        "cci_enabled": 0,
        # Volume MA: [fast, slow, enabled]
        "vma_fast": 5,
        "vma_slow": 60,
        "vma_enabled": 1,
        # MACD: [fast EMA, slow EMA, signal EMA, enabled]
        "macd_fast": 12,
        "macd_slow": 26,
        "macd_signal": 9,
        "macd_enabled": 1,
        # Risk management
        "stop_loss_pct": 2.9,
        "take_profit_pct": 9.8,
    }


# ---------------------------------------------------------------------------
# Indicator helpers
# ---------------------------------------------------------------------------

def _calc_rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))


def _calc_kdj(high: pd.Series, low: pd.Series, close: pd.Series,
              n: int, m1: int, m2: int):
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


def _calc_cci(high: pd.Series, low: pd.Series, close: pd.Series,
              period: int) -> pd.Series:
    tp = (high + low + close) / 3
    ma_tp = tp.rolling(period).mean()
    md = tp.rolling(period).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    return (tp - ma_tp) / (0.015 * md.replace(0, np.nan))


def _calc_macd(close: pd.Series, fast: int, slow: int, signal: int):
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    dif = ema_fast - ema_slow
    dea = dif.ewm(span=signal, adjust=False).mean()
    hist = dif - dea
    return dif, dea, hist


# ---------------------------------------------------------------------------
# Safe parameter helpers
# ---------------------------------------------------------------------------

def _int(value, default: int) -> int:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _float(value, default: float) -> float:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe(arr, i) -> float:
    """Return arr[i] as float, or NaN if out of bounds."""
    if i < 0 or i >= len(arr):
        return float("nan")
    v = arr[i]
    return float(v) if v is not None else float("nan")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Multi-Factor Strategy: MA + KDJ + RSI + CCI + VMA + MACD.

    Parameters
    ----------
    ma_fast         : Fast MA period (default 5)
    ma_slow         : Slow MA period (default 15)
    ma_enabled      : Enable MA indicator, 1 = on, 0 = off (default 1)
    kdj_n           : KDJ lookback period (default 9)
    kdj_m1          : KDJ K smoothing factor (default 3)
    kdj_m2          : KDJ D smoothing factor (default 3)
    kdj_enabled     : Enable KDJ indicator, 1 = on, 0 = off (default 0)
    rsi_fast        : Fast RSI period (default 7)
    rsi_slow        : Slow RSI period (default 14)
    rsi_enabled     : Enable RSI indicator, 1 = on, 0 = off (default 1)
    cci_period      : CCI period (default 14)
    cci_enabled     : Enable CCI indicator, 1 = on, 0 = off (default 0)
    vma_fast        : Fast volume MA period (default 5)
    vma_slow        : Slow volume MA period (default 60)
    vma_enabled     : Enable VMA indicator, 1 = on, 0 = off (default 1)
    macd_fast       : MACD fast EMA period (default 12)
    macd_slow       : MACD slow EMA period (default 26)
    macd_signal     : MACD signal line period (default 9)
    macd_enabled    : Enable MACD indicator, 1 = on, 0 = off (default 1)
    stop_loss_pct   : Loss % from entry that forces a sell (default 2.9)
    take_profit_pct : Gain % from entry that forces a sell (default 9.8)
    """
    df = df.copy()

    # ── Parameters ──────────────────────────────────────────────────────────
    ma_fast         = _int(params.get("ma_fast"),         5)
    ma_slow         = _int(params.get("ma_slow"),         15)
    ma_enabled      = bool(_int(params.get("ma_enabled"), 1))

    kdj_n           = _int(params.get("kdj_n"),           9)
    kdj_m1          = _int(params.get("kdj_m1"),          3)
    kdj_m2          = _int(params.get("kdj_m2"),          3)
    kdj_enabled     = bool(_int(params.get("kdj_enabled"), 0))

    rsi_fast_p      = _int(params.get("rsi_fast"),        7)
    rsi_slow_p      = _int(params.get("rsi_slow"),        14)
    rsi_enabled     = bool(_int(params.get("rsi_enabled"), 1))

    cci_period      = _int(params.get("cci_period"),      14)
    cci_enabled     = bool(_int(params.get("cci_enabled"), 0))

    vma_fast        = _int(params.get("vma_fast"),        5)
    vma_slow        = _int(params.get("vma_slow"),        60)
    vma_enabled     = bool(_int(params.get("vma_enabled"), 1))

    macd_fast_p     = _int(params.get("macd_fast"),       12)
    macd_slow_p     = _int(params.get("macd_slow"),       26)
    macd_sig_p      = _int(params.get("macd_signal"),     9)
    macd_enabled    = bool(_int(params.get("macd_enabled"), 1))

    stop_loss_pct   = _float(params.get("stop_loss_pct"),   2.9)
    take_profit_pct = _float(params.get("take_profit_pct"), 9.8)

    # ── Indicators ──────────────────────────────────────────────────────────
    close  = df["Close"]
    high   = df["High"]
    low    = df["Low"]
    volume = df["Volume"]

    # MA
    ma_fast_s = close.rolling(ma_fast).mean()
    ma_slow_s = close.rolling(ma_slow).mean()

    # RSI (shared by MA sell, VMA sell, RSI indicator)
    rsi_fast_s = _calc_rsi(close, rsi_fast_p)
    rsi_slow_s = _calc_rsi(close, rsi_slow_p)

    # KDJ
    kdj_k, kdj_d, kdj_j = _calc_kdj(high, low, close, kdj_n, kdj_m1, kdj_m2)

    # CCI
    cci_s = _calc_cci(high, low, close, cci_period)

    # VMA
    vma_fast_s = volume.rolling(vma_fast).mean()
    vma_slow_s = volume.rolling(vma_slow).mean()

    # MACD
    dif_s, dea_s, hist_s = _calc_macd(close, macd_fast_p, macd_slow_p, macd_sig_p)

    # Convert to numpy arrays for fast indexed access in the loop
    ma_f   = ma_fast_s.values
    ma_sl  = ma_slow_s.values
    rsi_f  = rsi_fast_s.values
    rsi_sl = rsi_slow_s.values
    k_arr  = kdj_k
    d_arr  = kdj_d
    j_arr  = kdj_j
    cci_a  = cci_s.values
    vmaf   = vma_fast_s.values
    vmas   = vma_slow_s.values
    dif    = dif_s.values
    dea    = dea_s.values
    hist   = hist_s.values
    cls    = close.values

    n             = len(df)
    signals       = [0] * n
    position      = [0] * n
    signal_source = [""] * n

    in_position   = False
    entry_price   = 0.0
    sl_mult       = 1.0 - stop_loss_pct / 100.0
    tp_mult       = 1.0 + take_profit_pct / 100.0

    for i in range(1, n):
        price = float(cls[i])

        # ── Current and previous bar values ─────────────────────────────────
        maf_c,  maf_p  = _safe(ma_f,  i), _safe(ma_f,  i - 1)
        masl_c, masl_p = _safe(ma_sl, i), _safe(ma_sl, i - 1)
        rsif_c, rsif_p = _safe(rsi_f,  i), _safe(rsi_f,  i - 1)
        rsis_c, rsis_p = _safe(rsi_sl, i), _safe(rsi_sl, i - 1)
        k_c,  k_p      = _safe(k_arr, i), _safe(k_arr, i - 1)
        d_c,  d_p      = _safe(d_arr, i), _safe(d_arr, i - 1)
        j_c,  j_p      = _safe(j_arr, i), _safe(j_arr, i - 1)
        cci_c, cci_p   = _safe(cci_a, i), _safe(cci_a, i - 1)
        vmaf_c, vmaf_p = _safe(vmaf,  i), _safe(vmaf,  i - 1)
        vmas_c, vmas_p = _safe(vmas,  i), _safe(vmas,  i - 1)
        dif_c,  dif_p  = _safe(dif,   i), _safe(dif,   i - 1)
        dea_c,  dea_p  = _safe(dea,   i), _safe(dea,   i - 1)
        hist_c, hist_p = _safe(hist,  i), _safe(hist,  i - 1)

        # ── Buy conditions ──────────────────────────────────────────────────
        # MA: fast MA > slow MA with both trending up
        if ma_enabled:
            condBuy1 = (maf_c > masl_c and maf_c > maf_p and masl_c > masl_p)
        else:
            condBuy1 = True

        # KDJ: K crosses above D (death→golden), J <= 40 and rising
        if kdj_enabled:
            condBuy2 = (d_p > k_p and d_c <= k_c) and (abs(j_c) <= 40 and j_c > j_p)
        else:
            condBuy2 = True

        # RSI: fast crosses above slow, both trending up
        if rsi_enabled:
            condBuy3 = (rsif_c > rsis_c and rsif_p <= rsis_p
                        and rsif_c > rsif_p and rsis_c > rsis_p)
        else:
            condBuy3 = True

        # CCI: crosses up through -100
        if cci_enabled:
            condBuy4 = (cci_p <= -100 and cci_c > -100)
        else:
            condBuy4 = True

        # VMA: short vol MA > long vol MA on the previous bar
        if vma_enabled:
            condBuy5 = vmaf_p > vmas_p
        else:
            condBuy5 = True

        # MACD: DIF > DEA, both rising, histogram rising, DIF > 0, DEA > 0
        if macd_enabled:
            condBuy6 = (dif_c > dea_c and dif_c > dif_p and dea_c > dea_p
                        and hist_c > hist_p and dif_c > 0 and dea_c > 0)
        else:
            condBuy6 = True

        # ── Sell conditions ─────────────────────────────────────────────────
        # MA sell: RSI fast < RSI slow (any bar)
        condSell1 = ma_enabled and (rsif_c < rsis_c)

        # KDJ sell: K crosses below D (golden→death), J near 80 and falling
        condSell2 = kdj_enabled and (d_p <= k_p and d_c > k_c) and (abs(j_c - 80) <= 40 and j_c < j_p)

        # RSI sell: fast crosses below slow
        condSell3 = rsi_enabled and (rsif_c < rsis_c and rsif_p >= rsis_p)

        # CCI sell: crosses back below -100
        condSell4 = cci_enabled and (cci_p > -100 and cci_c <= -100)

        # VMA sell: RSI fast < RSI slow (any bar)
        condSell5 = vma_enabled and (rsif_c < rsis_c)

        # MACD sell: DIF < DEA (fast line below signal)
        condSell6 = macd_enabled and (dif_c < dea_c)

        # ── Signal logic ────────────────────────────────────────────────────
        if not in_position:
            if (condBuy1 and condBuy2 and condBuy3
                    and condBuy4 and condBuy5 and condBuy6):
                signals[i]       = 1
                position[i]      = 1
                signal_source[i] = "multi_factor"
                in_position      = True
                entry_price      = price
        else:
            # Stop-loss
            if stop_loss_pct > 0 and price <= entry_price * sl_mult:
                signals[i]       = -1
                position[i]      = -1
                signal_source[i] = "stop_loss"
                in_position      = False
                entry_price      = 0.0
                continue

            # Take-profit
            if take_profit_pct > 0 and price >= entry_price * tp_mult:
                signals[i]       = -1
                position[i]      = -1
                signal_source[i] = "take_profit"
                in_position      = False
                entry_price      = 0.0
                continue

            # Indicator sell conditions (OR logic)
            sell_reason = ""
            if condSell1:
                sell_reason = "ma_sell"
            elif condSell2:
                sell_reason = "kdj_sell"
            elif condSell3:
                sell_reason = "rsi_sell"
            elif condSell4:
                sell_reason = "cci_sell"
            elif condSell5:
                sell_reason = "vma_sell"
            elif condSell6:
                sell_reason = "macd_sell"

            if sell_reason:
                signals[i]       = -1
                position[i]      = -1
                signal_source[i] = sell_reason
                in_position      = False
                entry_price      = 0.0

    df["signal"]        = signals
    df["position"]      = position
    df["signal_source"] = signal_source

    return df
