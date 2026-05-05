"""
VWAP Mean Reversion — Buy the Dip at VWAP / Lower Band

A widely-used intraday mean-reversion strategy. Price tends to revert to VWAP
throughout the day. When price dips below VWAP and then recrosses back above it
(with RSI recovering from oversold), it signals a long entry. The strategy
uses ATR-based exits to capture the reversion move back toward VWAP or beyond.

This is the mirror of momentum strategies: rather than chasing breakouts, it
fades overextended moves and profits from the snap-back to fair value.

──────────────────────────────────────────────────────────────────────────────
Strategy logic:

  ENTRY — BUY when ALL of:
    • Price was below VWAP on the previous bar and crosses back above it now
      (confirmed VWAP reclaim — the bounce, not the initial dip)
    • RSI was below rsi_oversold on the prior bar and is now rising
      (confirms the oversold-to-recovery inflection)
    • Price is within proximity_pct % of VWAP (not an extended parabolic move)
    • EMA fast > EMA slow  (overall intraday uptrend filter, disableable)
    • At most max_trades_per_day entries per trading day
    • Cooldown of cooldown_bars bars after any exit

  EXIT — SELL when the FIRST of these triggers:
    • ATR take-profit : price ≥ entry + atr_tp_mult × ATR
    • ATR stop-loss   : price ≤ entry − atr_stop_mult × ATR
    • Trailing stop   : activates after trail_activation_mult × ATR profit;
                        trails at trail_mult × ATR below the highest close
    • VWAP break-down : price closes back below VWAP (lost fair-value support)
    • Time stop       : position held ≥ max_hold_bars bars and underwater
    • EOD close       : last bar of the regular session (hold_overnight=0)

──────────────────────────────────────────────────────────────────────────────
Parameters:

  rsi_period            int    14     RSI look-back period
  rsi_oversold          float  40.0   RSI threshold for oversold condition
  proximity_pct         float  0.5    Max % distance from VWAP to allow entry
  ema_fast              int    9      Fast EMA period (0 = disable trend filter)
  ema_slow              int    21     Slow EMA period
  atr_period            int    14     ATR period
  atr_stop_mult         float  1.5    Stop-loss distance in ATR below entry
  atr_tp_mult           float  2.5    Take-profit distance in ATR above entry
  trail_activation_mult float  1.0    ATR profit required to activate trailing stop
  trail_mult            float  1.0    Trailing stop distance in ATR below highest close
  use_vwap_exit         int    1      1 = exit if price breaks below VWAP again
  max_trades_per_day    int    3      Max long entries per trading day
  cooldown_bars         int    5      Bars to wait after any exit before re-entering
  max_hold_bars         int    45     Time-stop bar limit when position is underwater
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


def _atr(high, low, close, period):
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(com=period - 1, min_periods=period).mean()


def _vwap(high, low, close, volume):
    tp = (high + low + close) / 3
    return (tp * volume).cumsum() / volume.cumsum().replace(0, float("nan"))


def _i(v, d):
    try: return int(float(v)) if v is not None else d
    except: return d


def _f(v, d):
    try: return float(v) if v is not None else d
    except: return d


def get_default_params():
    return {
        "rsi_period": 14,
        "rsi_oversold": 40.0,
        "proximity_pct": 0.5,
        "ema_fast": 9,
        "ema_slow": 21,
        "atr_period": 14,
        "atr_stop_mult": 1.5,
        "atr_tp_mult": 2.5,
        "trail_activation_mult": 1.0,
        "trail_mult": 1.0,
        "use_vwap_exit": 1,
        "max_trades_per_day": 3,
        "cooldown_bars": 5,
        "max_hold_bars": 45,
        "hold_overnight": 0,
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    df = df.copy()

    rsi_p          = _i(params.get("rsi_period"), 14)
    rsi_os         = _f(params.get("rsi_oversold"), 40.0)
    proximity_pct  = _f(params.get("proximity_pct"), 0.5) / 100.0
    ema_fast_p     = _i(params.get("ema_fast"), 9)
    ema_slow_p     = _i(params.get("ema_slow"), 21)
    atr_p          = _i(params.get("atr_period"), 14)
    atr_stop_mult  = _f(params.get("atr_stop_mult"), 1.5)
    atr_tp_mult    = _f(params.get("atr_tp_mult"), 2.5)
    trail_act_mult = _f(params.get("trail_activation_mult"), 1.0)
    trail_mult     = _f(params.get("trail_mult"), 1.0)
    use_vwap_exit  = bool(_i(params.get("use_vwap_exit"), 1))
    max_td         = max(0, _i(params.get("max_trades_per_day"), 3))
    cd_bars        = max(0, _i(params.get("cooldown_bars"), 5))
    max_hold       = max(0, _i(params.get("max_hold_bars"), 45))
    hold_overnight = bool(_i(params.get("hold_overnight"), 0))

    high, low, close, volume = df["High"], df["Low"], df["Close"], df["Volume"]

    use_ema = ema_fast_p > 0 and ema_slow_p > 0
    ema_f   = _ema(close, ema_fast_p) if use_ema else pd.Series(float("nan"), index=close.index)
    ema_s   = _ema(close, ema_slow_p) if use_ema else pd.Series(float("nan"), index=close.index)
    rsi     = _rsi(close, rsi_p)
    vwap    = _vwap(high, low, close, volume)
    atr_v   = _atr(high, low, close, atr_p)

    df["ema_fast"] = ema_f
    df["ema_slow"] = ema_s
    df["rsi"]      = rsi
    df["vwap"]     = vwap
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
    vwap_a   = vwap.values
    atr_a    = atr_v.values

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
            elif use_vwap_exit and not math.isnan(vwap_a[i]) and px < vwap_a[i]:
                reason = f"vwap_breakdown (price={px:.2f} vwap={vwap_a[i]:.2f})"
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
        if math.isnan(rsi_a[i]) or math.isnan(vwap_a[i]) or math.isnan(vwap_a[i - 1]):
            continue
        if cur_date is not None and max_td > 0 and _day_count.get(cur_date, 0) >= max_td:
            continue

        # VWAP reclaim: was below, now above
        prev_below_vwap = float(close_a[i - 1]) < float(vwap_a[i - 1])
        now_above_vwap  = px >= float(vwap_a[i])
        if not (prev_below_vwap and now_above_vwap):
            continue

        # Price must be close enough to VWAP (not an extended far-from-VWAP rally)
        vwap_dist_pct = abs(px - float(vwap_a[i])) / float(vwap_a[i])
        if proximity_pct > 0 and vwap_dist_pct > proximity_pct:
            continue

        # RSI was oversold and is now recovering
        if rsi_a[i - 1] > rsi_os:
            continue
        if rsi_a[i] <= rsi_a[i - 1]:
            continue

        # Optional EMA trend filter
        if use_ema and not (math.isnan(ema_f_a[i]) or math.isnan(ema_s_a[i])):
            if ema_f_a[i] <= ema_s_a[i]:
                continue

        parts = [
            f"vwap_reclaim (vwap={vwap_a[i]:.2f})",
            f"rsi_recovery ({rsi_a[i - 1]:.1f}→{rsi_a[i]:.1f})",
        ]
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
