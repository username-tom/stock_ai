"""
Combined Strategy Template (RSI + Bollinger Bands + MA Crossover + MACD)

Each strategy can independently trigger a buy signal. The strategy that triggers
the buy is recorded in a companion ``signal_source`` column and is prioritised
when deciding the exit condition.

Buy priority order: RSI > BB > MA Crossover > MACD

A universal stop-loss safeguard closes any open position when the unrealised
loss from the entry price reaches ``stop_loss_pct`` percent (default 5 %).
"""

import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {
        # RSI
        "rsi_period": 14,
        "rsi_oversold": 30.0,
        "rsi_overbought": 70.0,
        # Bollinger Bands
        "bb_period": 20,
        "bb_std_dev": 2.0,
        # MA Crossover
        "ma_fast": 10,
        "ma_slow": 30,
        "ma_type": "SMA",          # "SMA" or "EMA"
        # MACD
        "macd_fast": 12,
        "macd_slow": 26,
        "macd_signal": 9,
        # MACD sell: minimum gain % before histogram-slope exit is considered
        "macd_profit_target": 5.0,
        # Stop-loss safeguard (% loss from entry price that forces a sell)
        "stop_loss_pct": 5.0,
    }


# ---------------------------------------------------------------------------
# Internal indicator helpers
# ---------------------------------------------------------------------------

def _calc_ma(close: pd.Series, period: int, ma_type: str) -> pd.Series:
    if ma_type.upper() == "EMA":
        return close.ewm(span=period, adjust=False).mean()
    return close.rolling(window=period).mean()


def _calc_macd(close: pd.Series, fast: int, slow: int, signal: int):
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line


def _calc_rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))


def _calc_bb(close: pd.Series, period: int, std_dev: float):
    mid = close.rolling(window=period).mean()
    std = close.rolling(window=period).std()
    return mid + std_dev * std, mid, mid - std_dev * std


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


def _str(value, default: str) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    return str(value)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Combined RSI + Bollinger Bands + MA Crossover + MACD strategy.

    Parameters
    ----------
    rsi_period          : RSI look-back period (default 14)
    rsi_oversold        : RSI level that triggers a buy (default 30)
    rsi_overbought      : RSI level that triggers a sell (default 70)
    bb_period           : Period for Bollinger Bands SMA/std (default 20)
    bb_std_dev          : Std-dev multiplier for bands (default 2.0)
    ma_fast             : Fast MA period for crossover (default 10)
    ma_slow             : Slow MA period for crossover (default 30)
    ma_type             : "SMA" or "EMA" (default "SMA")
    macd_fast           : Fast EMA period for MACD (default 12)
    macd_slow           : Slow EMA period for MACD (default 26)
    macd_signal         : Signal-line EMA period for MACD (default 9)
    macd_profit_target  : Min % gain before MACD histogram-slope exit (default 5.0)
    stop_loss_pct       : Unrealised loss % that forces a sell (default 5.0, 0 = disabled)

    Buy priority (first match on a bar wins, no re-entry while in position):
      1. RSI          — RSI crosses below oversold threshold
      2. BB           — Close crosses below lower Bollinger Band
      3. MA Crossover — fast MA crosses above slow MA
      4. MACD         — MACD line crosses above signal line

    Sell logic (evaluated in order each bar while in position):
      1. Stop-loss      : close <= entry_price * (1 - stop_loss_pct / 100)
      2. Primary exit   : exit condition of the strategy that opened the trade
           RSI source   → RSI rises above overbought threshold
           BB  source   → Close rises above upper Bollinger Band
           MA  source   → fast MA crosses back below slow MA
           MACD source  → gain >= macd_profit_target% AND MACD histogram
                          declining for 2 consecutive bars
      3. Fallback exit  : any non-MACD sell condition fires

    signal_source values:
      buy  : "rsi" | "bb" | "ma" | "macd"
      sell : "rsi_exit" | "bb_exit" | "ma_exit" | "macd_exit"
           | "stop_loss" | "fallback_exit"
    """
    df = df.copy()

    # ── Parameters ──────────────────────────────────────────────────────────
    rsi_period         = _int(params.get("rsi_period"),         14)
    rsi_oversold       = _float(params.get("rsi_oversold"),     30.0)
    rsi_overbought     = _float(params.get("rsi_overbought"),   70.0)
    bb_period          = _int(params.get("bb_period"),          20)
    bb_std_dev         = _float(params.get("bb_std_dev"),        2.0)
    ma_fast            = _int(params.get("ma_fast"),            10)
    ma_slow            = _int(params.get("ma_slow"),            30)
    ma_type            = _str(params.get("ma_type"),            "SMA")
    macd_fast          = _int(params.get("macd_fast"),          12)
    macd_slow          = _int(params.get("macd_slow"),          26)
    macd_sig           = _int(params.get("macd_signal"),         9)
    macd_profit_target = _float(params.get("macd_profit_target"), 5.0)
    stop_loss_pct      = _float(params.get("stop_loss_pct"),     5.0)

    # ── Indicators ──────────────────────────────────────────────────────────
    df["rsi"] = _calc_rsi(df["Close"], rsi_period)

    df["bb_upper"], df["bb_middle"], df["bb_lower"] = _calc_bb(
        df["Close"], bb_period, bb_std_dev
    )

    df["ma_fast_line"] = _calc_ma(df["Close"], ma_fast, ma_type)
    df["ma_slow_line"] = _calc_ma(df["Close"], ma_slow, ma_type)

    macd_line, macd_signal_line = _calc_macd(
        df["Close"], macd_fast, macd_slow, macd_sig
    )
    df["macd"]        = macd_line
    df["macd_signal"] = macd_signal_line
    df["macd_hist"]   = macd_line - macd_signal_line

    # ── Vectorised crossover flags ───────────────────────────────────────────
    # RSI
    rsi_over = df["rsi"] < rsi_oversold
    rsi_buy  = (rsi_over & ~rsi_over.shift(1).fillna(False)).values
    rsi_ob   = df["rsi"] > rsi_overbought
    rsi_sell = (rsi_ob & ~rsi_ob.shift(1).fillna(False)).values

    # BB
    bb_below = df["Close"] < df["bb_lower"]
    bb_buy   = (bb_below & ~bb_below.shift(1).fillna(False)).values
    bb_above = df["Close"] > df["bb_upper"]
    bb_sell  = (bb_above & ~bb_above.shift(1).fillna(False)).values

    # MA crossover
    ma_bull  = df["ma_fast_line"] > df["ma_slow_line"]
    ma_buy   = (ma_bull & ~ma_bull.shift(1).fillna(False)).values
    ma_sell  = (~ma_bull & ma_bull.shift(1).fillna(False)).values

    # MACD crossover
    macd_bull = macd_line > macd_signal_line
    macd_buy  = (macd_bull & ~macd_bull.shift(1).fillna(False)).values
    macd_hist_arr = df["macd_hist"].values

    # ── Stateful signal generation ───────────────────────────────────────────
    n             = len(df)
    signals       = [0] * n
    position      = [0] * n
    signal_source = [""] * n

    in_position    = False
    entry_price    = 0.0
    active_source  = ""
    stop_loss_mult = 1.0 - stop_loss_pct / 100.0
    profit_mult    = 1.0 + macd_profit_target / 100.0
    close_arr      = df["Close"].values

    for i in range(n):
        price = float(close_arr[i])

        if not in_position:
            # Priority: RSI > BB > MA > MACD
            if rsi_buy[i]:
                source = "rsi"
            elif bb_buy[i]:
                source = "bb"
            elif ma_buy[i]:
                source = "ma"
            elif macd_buy[i]:
                source = "macd"
            else:
                source = ""

            if source:
                signals[i]       = 1
                position[i]      = 1
                signal_source[i] = source
                in_position      = True
                entry_price      = price
                active_source    = source

        else:
            # ── 1. Stop-loss ─────────────────────────────────────────────────
            if stop_loss_pct > 0 and price <= entry_price * stop_loss_mult:
                signals[i]       = -1
                position[i]      = -1
                signal_source[i] = "stop_loss"
                in_position      = False
                entry_price      = 0.0
                active_source    = ""
                continue

            # ── 2. Primary exit ──────────────────────────────────────────────
            sell   = False
            reason = ""

            if active_source == "rsi" and rsi_sell[i]:
                sell   = True
                reason = "rsi_exit"

            elif active_source == "bb" and bb_sell[i]:
                sell   = True
                reason = "bb_exit"

            elif active_source == "ma" and ma_sell[i]:
                sell   = True
                reason = "ma_exit"

            elif active_source == "macd":
                # Sell when gain >= macd_profit_target% AND histogram has
                # declined for 2 consecutive bars (momentum fading)
                if price >= entry_price * profit_mult and i >= 2:
                    d1 = float(macd_hist_arr[i])   - float(macd_hist_arr[i - 1])
                    d2 = float(macd_hist_arr[i - 1]) - float(macd_hist_arr[i - 2])
                    if d1 < 0 and d2 < 0:
                        sell   = True
                        reason = "macd_exit"

            # ── 3. Fallback: any non-MACD sell condition fires ───────────────
            if not sell and (rsi_sell[i] or bb_sell[i] or ma_sell[i]):
                sell   = True
                reason = "fallback_exit"

            if sell:
                signals[i]       = -1
                position[i]      = -1
                signal_source[i] = reason
                in_position      = False
                entry_price      = 0.0
                active_source    = ""

    df["signal"]        = signals
    df["position"]      = position
    df["signal_source"] = signal_source

    return df



# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _calc_macd(close: pd.Series, fast: int, slow: int, signal: int):
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line


def _calc_rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))


def _calc_bb(close: pd.Series, period: int, std_dev: float):
    mid = close.rolling(window=period).mean()
    std = close.rolling(window=period).std()
    upper = mid + std_dev * std
    lower = mid - std_dev * std
    return upper, mid, lower


# ---------------------------------------------------------------------------
# Safe parameter helpers
# ---------------------------------------------------------------------------

def _int(value, default: int) -> int:
    """Convert value to int, falling back to default on empty/None/invalid."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _float(value, default: float) -> float:
    """Convert value to float, falling back to default on empty/None/invalid."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default

