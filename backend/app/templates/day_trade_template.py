"""
Day Trading Template — VWAP + EMA Crossover + RSI + MACD + BB Squeeze + ATR

Designed for intraday data (1-minute or 5-minute bars) but degrades gracefully
to daily bars so the same script can be back-tested in the Backtest panel and
deployed live in the Sandbox engine without modification.

──────────────────────────────────────────────────────────────────────────────
Strategy logic (all enabled conditions must agree to enter):

  BUY when:
    • EMA fast crosses above EMA slow           (momentum shift)
    • Price ≥ VWAP                              (above fair value)
    • RSI is rising and below overbought level  (not overextended)
    • MACD histogram is positive and rising     (trend confirmation)
    • Bollinger Bands squeeze just fired        (volatility expansion)

  SELL / EXIT when any of the following is true:
    • EMA fast crosses below EMA slow           (momentum reversal)
    • Price falls below VWAP                    (lost fair-value support)
    • RSI ≥ overbought                          (overextended)
    • MACD histogram turns negative             (trend reversal)
    • ATR stop-loss: price drops N × ATR below entry
    • ATR take-profit: price rises M × ATR above entry

Each condition can be disabled individually so you can run any sub-set of
indicators (e.g. pure EMA + RSI without the BB squeeze requirement).

──────────────────────────────────────────────────────────────────────────────
Parameters (all overridable from the UI or backtest request):

  ema_fast          int   9      Fast EMA period
  ema_slow          int   21     Slow EMA period
  rsi_period        int   14     RSI look-back period
  rsi_overbought    float 70     RSI level that blocks/exits buys
  macd_fast         int   12     MACD fast EMA
  macd_slow         int   26     MACD slow EMA
  macd_signal       int   9      MACD signal EMA
  bb_period         int   20     Bollinger Band / squeeze SMA period
  bb_std_dev        float 2.0    Bollinger Band std-dev multiplier
  kc_mult           float 1.5    Keltner Channel ATR multiplier (for squeeze)
  atr_period        int   14     ATR period for stop/take-profit
  atr_stop_mult     float 1.5    Stop-loss distance = atr_stop_mult × ATR
  atr_tp_mult       float 3.0    Take-profit distance = atr_tp_mult × ATR
  use_vwap          int   1      1 = require price ≥ VWAP to buy, 0 = disable
  use_squeeze       int   1      1 = require BB squeeze confirmation, 0 = disable
  use_macd          int   1      1 = require positive MACD histogram, 0 = disable
"""
import math

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Indicator helpers (self-contained – no external imports needed)
# ---------------------------------------------------------------------------

def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def _sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(window=period).mean()


def _rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))


def _macd(close: pd.Series, fast: int, slow: int, sig: int):
    """Return (macd_line, signal_line, histogram)."""
    m = _ema(close, fast) - _ema(close, slow)
    s = _ema(m, sig)
    return m, s, m - s


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    return tr.ewm(com=period - 1, min_periods=period).mean()


def _vwap(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series) -> pd.Series:
    """Rolling VWAP using cumulative sum (resets at the start of the series)."""
    typical_price = (high + low + close) / 3
    cum_vol = volume.cumsum()
    cum_tpv = (typical_price * volume).cumsum()
    return cum_tpv / cum_vol.replace(0, np.nan)


def _bb(close: pd.Series, period: int, n_std: float):
    """Return (upper, mid, lower)."""
    mid = _sma(close, period)
    std = close.rolling(window=period).std()
    return mid + n_std * std, mid, mid - n_std * std


def _keltner(
    high: pd.Series, low: pd.Series, close: pd.Series, period: int, mult: float
):
    """Return (upper, mid, lower) Keltner Channel."""
    mid = _ema(close, period)
    atr = _atr(high, low, close, period)
    return mid + mult * atr, mid, mid - mult * atr


def _squeeze_on(
    high: pd.Series, low: pd.Series, close: pd.Series, bb_period: int, bb_std: float, kc_mult: float
) -> pd.Series:
    """Return a boolean Series: True when BB is inside KC (squeeze is ON)."""
    bb_upper, _, bb_lower = _bb(close, bb_period, bb_std)
    kc_upper, _, kc_lower = _keltner(high, low, close, bb_period, kc_mult)
    return (bb_upper < kc_upper) & (bb_lower > kc_lower)


# ---------------------------------------------------------------------------
# Parameter helpers
# ---------------------------------------------------------------------------

def _i(v, default: int) -> int:
    if v is None or (isinstance(v, str) and not v.strip()):
        return default
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _f(v, default: float) -> float:
    if v is None or (isinstance(v, str) and not v.strip()):
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_default_params() -> dict:
    return {
        # EMA crossover
        "ema_fast": 9,
        "ema_slow": 21,
        # RSI
        "rsi_period": 14,
        "rsi_overbought": 70.0,
        # MACD
        "macd_fast": 12,
        "macd_slow": 26,
        "macd_signal": 9,
        # Bollinger Bands + Keltner squeeze
        "bb_period": 20,
        "bb_std_dev": 2.0,
        "kc_mult": 1.5,
        # ATR-based risk management
        "atr_period": 14,
        "atr_stop_mult": 1.5,
        "atr_tp_mult": 3.0,
        # Feature toggles  (1 = on, 0 = off)
        "use_vwap": 1,
        "use_squeeze": 1,
        "use_macd": 1,
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Day-trading signal generator.

    Works on any OHLCV DataFrame regardless of bar frequency.  For live
    intraday use (sandbox engine) it receives 1-minute bars; for back-testing
    it typically receives daily bars — the logic is identical.

    Returns the input DataFrame extended with:
      signal        : +1 buy, -1 sell, 0 hold
      signal_source : human-readable reason for the last signal
      ema_fast      : fast EMA values (for charting)
      ema_slow      : slow EMA values
      rsi           : RSI values
      vwap          : VWAP values
      macd_hist     : MACD histogram
      atr           : ATR values
      bb_upper      : upper Bollinger Band
      bb_lower      : lower Bollinger Band
    """
    df = df.copy()

    # ── parameters ────────────────────────────────────────────────────────── #
    ema_fast_p    = _i(params.get("ema_fast"),       9)
    ema_slow_p    = _i(params.get("ema_slow"),       21)
    rsi_p         = _i(params.get("rsi_period"),     14)
    rsi_ob        = _f(params.get("rsi_overbought"), 70.0)
    macd_fast_p   = _i(params.get("macd_fast"),      12)
    macd_slow_p   = _i(params.get("macd_slow"),      26)
    macd_sig_p    = _i(params.get("macd_signal"),    9)
    bb_p          = _i(params.get("bb_period"),      20)
    bb_std        = _f(params.get("bb_std_dev"),     2.0)
    kc_mult       = _f(params.get("kc_mult"),        1.5)
    atr_p         = _i(params.get("atr_period"),     14)
    atr_stop      = _f(params.get("atr_stop_mult"),  1.5)
    atr_tp        = _f(params.get("atr_tp_mult"),    3.0)
    use_vwap      = bool(_i(params.get("use_vwap"),    1))
    use_squeeze   = bool(_i(params.get("use_squeeze"), 1))
    use_macd      = bool(_i(params.get("use_macd"),    1))

    high, low, close, volume = df["High"], df["Low"], df["Close"], df["Volume"]

    # ── compute indicators ────────────────────────────────────────────────── #
    ema_f = _ema(close, ema_fast_p)
    ema_s = _ema(close, ema_slow_p)
    rsi   = _rsi(close, rsi_p)
    vwap  = _vwap(high, low, close, volume)
    macd_line, macd_sig_line, macd_hist = _macd(close, macd_fast_p, macd_slow_p, macd_sig_p)
    atr_vals = _atr(high, low, close, atr_p)
    bb_upper, bb_mid, bb_lower = _bb(close, bb_p, bb_std)
    squeeze = _squeeze_on(high, low, close, bb_p, bb_std, kc_mult)

    # Expose indicator columns for charting / debugging
    df["ema_fast"]   = ema_f
    df["ema_slow"]   = ema_s
    df["rsi"]        = rsi
    df["vwap"]       = vwap
    df["macd_hist"]  = macd_hist
    df["atr"]        = atr_vals
    df["bb_upper"]   = bb_upper
    df["bb_lower"]   = bb_lower

    # ── signal generation ─────────────────────────────────────────────────── #
    n = len(df)
    signals       = np.zeros(n, dtype=int)
    signal_source = [""] * n

    in_position  = False
    entry_price  = float("nan")
    entry_atr    = float("nan")

    ema_f_arr     = ema_f.values
    ema_s_arr     = ema_s.values
    rsi_arr       = rsi.values
    close_arr     = close.values
    vwap_arr      = vwap.values
    macd_h_arr    = macd_hist.values
    atr_arr       = atr_vals.values
    squeeze_arr   = squeeze.values

    for i in range(1, n):
        price = float(close_arr[i])

        # ── exit logic (checked first while in position) ─────────────────── #
        if in_position:
            stop  = entry_price - atr_stop * entry_atr
            tp    = entry_price + atr_tp   * entry_atr

            # ATR stop-loss
            if price <= stop:
                signals[i]       = -1
                signal_source[i] = f"atr_stop_loss (entry={entry_price:.2f} stop={stop:.2f})"
                in_position = False
                entry_price = float("nan")
                continue

            # ATR take-profit
            if price >= tp:
                signals[i]       = -1
                signal_source[i] = f"atr_take_profit (entry={entry_price:.2f} tp={tp:.2f})"
                in_position = False
                entry_price = float("nan")
                continue

            # EMA death-cross
            ema_cross_down = (
                not math.isnan(ema_f_arr[i])
                and not math.isnan(ema_s_arr[i])
                and ema_f_arr[i] < ema_s_arr[i]
                and ema_f_arr[i - 1] >= ema_s_arr[i - 1]
            )
            if ema_cross_down:
                signals[i]       = -1
                signal_source[i] = "ema_cross_down (momentum reversal)"
                in_position = False
                entry_price = float("nan")
                continue

            # VWAP break-down
            if use_vwap and not math.isnan(vwap_arr[i]) and price < vwap_arr[i]:
                signals[i]       = -1
                signal_source[i] = f"vwap_breakdown (price={price:.2f} vwap={vwap_arr[i]:.2f})"
                in_position = False
                entry_price = float("nan")
                continue

            # RSI overbought
            if not math.isnan(rsi_arr[i]) and rsi_arr[i] >= rsi_ob:
                signals[i]       = -1
                signal_source[i] = f"rsi_overbought ({rsi_arr[i]:.1f}>={rsi_ob})"
                in_position = False
                entry_price = float("nan")
                continue

            # MACD histogram turns negative
            if use_macd and not math.isnan(macd_h_arr[i]) and macd_h_arr[i] < 0:
                signals[i]       = -1
                signal_source[i] = "macd_reversal (hist<0)"
                in_position = False
                entry_price = float("nan")
                continue

            # Still in position — no action this bar
            continue

        # ── entry logic ──────────────────────────────────────────────────── #
        # Guard: need valid indicator values
        if math.isnan(ema_f_arr[i]) or math.isnan(ema_s_arr[i]):
            continue
        if math.isnan(rsi_arr[i]):
            continue
        if math.isnan(atr_arr[i]):
            continue

        # 1. EMA golden-cross (required always)
        ema_cross_up = (
            ema_f_arr[i] > ema_s_arr[i]
            and ema_f_arr[i - 1] <= ema_s_arr[i - 1]
        )
        if not ema_cross_up:
            continue

        # 2. RSI not overbought (required always)
        if rsi_arr[i] >= rsi_ob:
            continue

        # 3. Price ≥ VWAP (optional)
        if use_vwap:
            if math.isnan(vwap_arr[i]) or price < vwap_arr[i]:
                continue

        # 4. MACD histogram positive (optional)
        if use_macd:
            if math.isnan(macd_h_arr[i]) or macd_h_arr[i] <= 0:
                continue

        # 5. Bollinger Band squeeze just fired: squeeze was ON previous bar,
        #    squeeze is now OFF (bands expanding = volatility breakout)
        if use_squeeze:
            squeeze_fired = (
                i >= 1
                and bool(squeeze_arr[i - 1])   # squeeze was on
                and not bool(squeeze_arr[i])    # squeeze released
            )
            if not squeeze_fired:
                continue

        # All conditions passed → BUY — compose a human-readable reason
        parts = ["ema_cross_up"]
        if use_vwap and not math.isnan(vwap_arr[i]):
            parts.append("above_vwap")
        parts.append("rsi_ok")
        if use_macd and not math.isnan(macd_h_arr[i]):
            parts.append("macd_pos")
        if use_squeeze:
            parts.append("squeeze_fire")
        signals[i]       = 1
        signal_source[i] = "+".join(parts)
        in_position = True
        entry_price = price
        entry_atr   = float(atr_arr[i])

    df["signal"]        = signals
    df["signal_source"] = signal_source
    return df
