"""
Momentum Scalper — RSI + Stochastic + Volume Surge

A high-frequency scalping strategy combining RSI momentum, Stochastic %K/%D
crossover, and a volume-surge filter. All three must agree before entering.
Popular among retail scalpers who trade liquid large-cap stocks and ETFs on
1-minute or 5-minute intraday bars.

The key insight: a Stochastic crossover from oversold territory combined with
rising RSI and a volume spike signals institutional buying pressure and a
high-probability short-term momentum burst.

──────────────────────────────────────────────────────────────────────────────
Strategy logic:

  ENTRY — BUY when ALL of:
    • Stochastic %K crosses above %D (momentum inflection)
    • %K was in oversold zone (< stoch_oversold) on the prior bar
    • RSI > rsi_min and rising vs prior bar  (positive momentum)
    • Volume ≥ volume_mult × 20-bar average volume  (institutional interest)
    • EMA fast > EMA slow  (broad intraday uptrend, disableable)
    • At most max_trades_per_day entries per day
    • Cooldown of cooldown_bars bars after any exit

  EXIT — SELL when the FIRST of these triggers:
    • ATR take-profit : price ≥ entry + atr_tp_mult × ATR
    • ATR stop-loss   : price ≤ entry − atr_stop_mult × ATR
    • Trailing stop   : activates after trail_activation_mult × ATR profit;
                        trails at trail_mult × ATR below highest close
    • Stochastic overbought : %K > stoch_overbought and %K crossing below %D
    • RSI drops back below rsi_exit  (momentum exhaustion)
    • Time stop       : position held ≥ max_hold_bars and underwater
    • EOD close       : last bar of the regular session (hold_overnight=0)

──────────────────────────────────────────────────────────────────────────────
Parameters:

  stoch_k_period        int    14     Stochastic %K look-back period
  stoch_d_period        int    3      Stochastic %D smoothing period
  stoch_oversold        float  25.0   %K threshold defining oversold
  stoch_overbought      float  75.0   %K threshold defining overbought (exit trigger)
  rsi_period            int    14     RSI look-back period
  rsi_min               float  45.0   Minimum RSI value required for entry
  rsi_exit              float  30.0   RSI level that triggers an exit (momentum loss)
  volume_mult           float  1.5    Required volume vs 20-bar average for entry
  ema_fast              int    9      Fast EMA period (0 = disable trend filter)
  ema_slow              int    21     Slow EMA period
  atr_period            int    14     ATR period
  atr_stop_mult         float  1.5    Stop-loss distance in ATR below entry
  atr_tp_mult           float  2.5    Take-profit distance in ATR above entry
  trail_activation_mult float  1.0    ATR profit required to activate trailing stop
  trail_mult            float  1.0    Trailing stop distance in ATR below highest close
  max_trades_per_day    int    4      Max long entries per trading day
  cooldown_bars         int    5      Bars to wait after any exit
  max_hold_bars         int    30     Time-stop bar limit when underwater
  hold_overnight        int    0      0 = close at EOD, 1 = allow overnight holds
"""
import math
import numpy as np
import pandas as pd


def _ema(series, span):
    return series.ewm(span=span, adjust=False).mean()


def _rsi(close, period):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))


def _stochastic(high, low, close, k_period, d_period):
    """Return (%K, %D) as (Series, Series)."""
    lowest_low   = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    denom        = (highest_high - lowest_low).replace(0, float("nan"))
    k = 100 * (close - lowest_low) / denom
    d = k.rolling(d_period).mean()
    return k, d


def _atr(high, low, close, period):
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(com=period - 1, min_periods=period).mean()


def _i(v, d):
    try: return int(float(v)) if v is not None else d
    except: return d


def _f(v, d):
    try: return float(v) if v is not None else d
    except: return d


def get_default_params():
    return {
        "stoch_k_period": 14,
        "stoch_d_period": 3,
        "stoch_oversold": 25.0,
        "stoch_overbought": 75.0,
        "rsi_period": 14,
        "rsi_min": 45.0,
        "rsi_exit": 30.0,
        "volume_mult": 1.5,
        "ema_fast": 9,
        "ema_slow": 21,
        "atr_period": 14,
        "atr_stop_mult": 1.5,
        "atr_tp_mult": 2.5,
        "trail_activation_mult": 1.0,
        "trail_mult": 1.0,
        "max_trades_per_day": 4,
        "cooldown_bars": 5,
        "max_hold_bars": 30,
        "hold_overnight": 0,
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    df = df.copy()

    k_p            = max(2, _i(params.get("stoch_k_period"), 14))
    d_p            = max(1, _i(params.get("stoch_d_period"), 3))
    stoch_os       = _f(params.get("stoch_oversold"), 25.0)
    stoch_ob       = _f(params.get("stoch_overbought"), 75.0)
    rsi_p          = _i(params.get("rsi_period"), 14)
    rsi_min_v      = _f(params.get("rsi_min"), 45.0)
    rsi_exit_v     = _f(params.get("rsi_exit"), 30.0)
    vol_mult       = _f(params.get("volume_mult"), 1.5)
    ema_fast_p     = _i(params.get("ema_fast"), 9)
    ema_slow_p     = _i(params.get("ema_slow"), 21)
    atr_p          = _i(params.get("atr_period"), 14)
    atr_stop_mult  = _f(params.get("atr_stop_mult"), 1.5)
    atr_tp_mult    = _f(params.get("atr_tp_mult"), 2.5)
    trail_act_mult = _f(params.get("trail_activation_mult"), 1.0)
    trail_mult     = _f(params.get("trail_mult"), 1.0)
    max_td         = max(0, _i(params.get("max_trades_per_day"), 4))
    cd_bars        = max(0, _i(params.get("cooldown_bars"), 5))
    max_hold       = max(0, _i(params.get("max_hold_bars"), 30))
    hold_overnight = bool(_i(params.get("hold_overnight"), 0))

    high, low, close, volume = df["High"], df["Low"], df["Close"], df["Volume"]

    use_ema = ema_fast_p > 0 and ema_slow_p > 0
    ema_f   = _ema(close, ema_fast_p) if use_ema else pd.Series(float("nan"), index=close.index)
    ema_s   = _ema(close, ema_slow_p) if use_ema else pd.Series(float("nan"), index=close.index)
    rsi     = _rsi(close, rsi_p)
    stoch_k, stoch_d = _stochastic(high, low, close, k_p, d_p)
    atr_v   = _atr(high, low, close, atr_p)
    vol20   = volume.rolling(20).mean()

    df["ema_fast"] = ema_f
    df["ema_slow"] = ema_s
    df["rsi"]      = rsi
    df["stoch_k"]  = stoch_k
    df["stoch_d"]  = stoch_d
    df["atr"]      = atr_v

    # ── EOD set and daily trade counter ─────────────────────────────────── #
    _eod_set   = set()
    _day_count = {}
    et_dates   = None

    if "session" in df.columns:
        try:
            from zoneinfo import ZoneInfo
            et_dates = df.index.tz_convert(ZoneInfo("America/New_York")).date
        except Exception:
            et_dates = df.index.date

        sess = df["session"].values
        day_reg = {}
        for j, (d, s) in enumerate(zip(et_dates, sess)):
            if s == "regular":
                day_reg.setdefault(d, []).append(j)
        for d, idxs in day_reg.items():
            if not hold_overnight and idxs:
                _eod_set.add(idxs[-1])
            _day_count[d] = 0

    n        = len(df)
    close_a  = close.values
    ema_f_a  = ema_f.values
    ema_s_a  = ema_s.values
    rsi_a    = rsi.values
    k_a      = stoch_k.values
    d_a      = stoch_d.values
    atr_a    = atr_v.values
    vol_a    = volume.values
    vol20_a  = vol20.values

    signals = np.zeros(n, dtype=int)
    src     = [""] * n

    in_pos       = False
    entry_px     = float("nan")
    entry_atr_v  = float("nan")
    entry_bar    = -1
    trail_high   = float("nan")
    trail_active = False
    cd_left      = 0

    for i in range(1, n):
        px       = float(close_a[i])
        cur_date = et_dates[i] if et_dates is not None else None

        if cd_left > 0:
            cd_left -= 1

        # ── exit logic ───────────────────────────────────────────────────── #
        if in_pos:
            if math.isnan(trail_high) or px > trail_high:
                trail_high = px

            hard_stop = entry_px - atr_stop_mult * entry_atr_v
            if not trail_active and (px - entry_px) >= trail_act_mult * entry_atr_v:
                trail_active = True
            eff_stop = (trail_high - trail_mult * entry_atr_v) if trail_active else hard_stop
            tp = entry_px + atr_tp_mult * entry_atr_v

            exited = False
            reason = ""

            if px <= eff_stop:
                reason = (
                    f"trail_stop (high={trail_high:.2f} stop={eff_stop:.2f})"
                    if trail_active
                    else f"atr_stop_loss (entry={entry_px:.2f} stop={eff_stop:.2f})"
                )
                exited = True
            elif px >= tp:
                reason = f"atr_take_profit (entry={entry_px:.2f} tp={tp:.2f})"
                exited = True
            elif (not math.isnan(k_a[i]) and not math.isnan(d_a[i])
                  and not math.isnan(k_a[i - 1]) and not math.isnan(d_a[i - 1])
                  and k_a[i] > stoch_ob and k_a[i] < d_a[i] and k_a[i - 1] >= d_a[i - 1]):
                reason = f"stoch_overbought_cross (k={k_a[i]:.1f} d={d_a[i]:.1f})"
                exited = True
            elif not math.isnan(rsi_a[i]) and rsi_a[i] < rsi_exit_v:
                reason = f"rsi_momentum_loss (rsi={rsi_a[i]:.1f})"
                exited = True
            elif max_hold > 0 and (i - entry_bar) >= max_hold and px < entry_px:
                reason = f"time_stop (bars={i - entry_bar} entry={entry_px:.2f})"
                exited = True
            elif i in _eod_set:
                reason = "eod_close (hold_overnight=0)"
                exited = True

            if exited:
                signals[i] = -1
                src[i]     = reason
                in_pos       = False
                trail_active = False
                trail_high   = float("nan")
                entry_px     = float("nan")
                entry_atr_v  = float("nan")
                entry_bar    = -1
                cd_left      = cd_bars
            continue

        # ── entry logic ──────────────────────────────────────────────────── #
        if cd_left > 0:
            continue
        if math.isnan(atr_a[i]) or atr_a[i] == 0:
            continue
        if math.isnan(rsi_a[i]):
            continue
        if math.isnan(k_a[i]) or math.isnan(d_a[i]) or math.isnan(k_a[i - 1]) or math.isnan(d_a[i - 1]):
            continue
        if cur_date is not None and max_td > 0 and _day_count.get(cur_date, 0) >= max_td:
            continue

        # Stochastic %K crosses above %D from oversold
        stoch_cross_up = k_a[i] > d_a[i] and k_a[i - 1] <= d_a[i - 1]
        if not stoch_cross_up:
            continue
        if k_a[i - 1] > stoch_os:
            continue  # crossover must come from oversold zone

        # RSI rising and above minimum
        if rsi_a[i] < rsi_min_v:
            continue
        if rsi_a[i] <= rsi_a[i - 1]:
            continue

        # Volume surge
        vol_ok = True
        if vol_mult > 0 and not math.isnan(vol20_a[i]) and vol20_a[i] > 0:
            vol_ok = float(vol_a[i]) >= vol_mult * float(vol20_a[i])
        if not vol_ok:
            continue

        # EMA trend filter
        if use_ema and not (math.isnan(ema_f_a[i]) or math.isnan(ema_s_a[i])):
            if ema_f_a[i] <= ema_s_a[i]:
                continue

        parts = [
            f"stoch_cross_up (k={k_a[i]:.1f} d={d_a[i]:.1f})",
            f"rsi_rising ({rsi_a[i - 1]:.1f}→{rsi_a[i]:.1f})",
        ]
        if vol_ok and vol_mult > 0:
            parts.append("vol_surge")
        if use_ema:
            parts.append("ema_bullish")

        signals[i] = 1
        src[i]     = "+".join(parts)
        in_pos       = True
        entry_px     = px
        entry_atr_v  = float(atr_a[i])
        entry_bar    = i
        trail_high   = px
        trail_active = False

        if cur_date is not None:
            _day_count[cur_date] = _day_count.get(cur_date, 0) + 1

    df["signal"]        = signals
    df["signal_source"] = src
    return df
