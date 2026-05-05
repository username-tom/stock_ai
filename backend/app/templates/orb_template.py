"""
Opening Range Breakout (ORB) — Pure Price-Action Day Trading

One of the most widely-used intraday strategies. The "opening range" is the
high/low formed during the first N minutes of the regular session. A breakout
above the range high (with volume confirmation) is a long entry signal.

──────────────────────────────────────────────────────────────────────────────
Strategy logic:

  ENTRY — BUY when ALL of:
    • Price closes above the opening-range HIGH for the first time today
    • Volume on the breakout bar ≥ volume_mult × 20-bar average volume
    • EMA fast > EMA slow  (trend filter, can be disabled)
    • RSI between rsi_min and rsi_max  (momentum guard)
    • At most max_trades_per_day entries per trading day

  EXIT — SELL when the FIRST of these triggers:
    • ATR take-profit : price ≥ entry + atr_tp_mult × ATR
    • ATR stop-loss   : price ≤ entry − atr_stop_mult × ATR
    • Trailing stop   : activates after trail_activation_mult × ATR profit;
                        trails at trail_mult × ATR below the highest close
    • Time stop       : position held for max_hold_bars with price < entry
    • EOD close       : last bar of the regular session (hold_overnight=0)

──────────────────────────────────────────────────────────────────────────────
Parameters:

  orb_minutes         int    15     Number of minutes that define the opening range
  volume_mult         float  1.5    Required volume vs 20-bar average on breakout bar
  ema_fast            int    9      Fast EMA period (set to 0 to disable trend filter)
  ema_slow            int    21     Slow EMA period
  rsi_period          int    14     RSI period
  rsi_min             float  45.0   Minimum RSI for entry
  rsi_max             float  75.0   Maximum RSI for entry
  atr_period          int    14     ATR period
  atr_stop_mult       float  1.5    Stop-loss = entry − atr_stop_mult × ATR
  atr_tp_mult         float  3.0    Take-profit = entry + atr_tp_mult × ATR
  trail_activation_mult float 1.5   Profit (in ATR) required to activate trailing stop
  trail_mult          float  1.0    Trailing stop distance in ATR below highest close
  max_trades_per_day  int    1      Max long entries per trading day
  max_hold_bars       int    60     Time-stop: close if bars held ≥ this and underwater
  hold_overnight      int    0      0 = close at EOD, 1 = allow overnight holds
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


def _i(v, d):
    try: return int(float(v)) if v is not None else d
    except: return d


def _f(v, d):
    try: return float(v) if v is not None else d
    except: return d


def get_default_params():
    return {
        "orb_minutes": 15,
        "volume_mult": 1.5,
        "ema_fast": 9,
        "ema_slow": 21,
        "rsi_period": 14,
        "rsi_min": 45.0,
        "rsi_max": 75.0,
        "atr_period": 14,
        "atr_stop_mult": 1.5,
        "atr_tp_mult": 3.0,
        "trail_activation_mult": 1.5,
        "trail_mult": 1.0,
        "max_trades_per_day": 1,
        "max_hold_bars": 60,
        "hold_overnight": 0,
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    df = df.copy()

    orb_minutes       = max(1, _i(params.get("orb_minutes"), 15))
    volume_mult       = _f(params.get("volume_mult"), 1.5)
    ema_fast_p        = _i(params.get("ema_fast"), 9)
    ema_slow_p        = _i(params.get("ema_slow"), 21)
    rsi_p             = _i(params.get("rsi_period"), 14)
    rsi_min_v         = _f(params.get("rsi_min"), 45.0)
    rsi_max_v         = _f(params.get("rsi_max"), 75.0)
    atr_p             = _i(params.get("atr_period"), 14)
    atr_stop_mult     = _f(params.get("atr_stop_mult"), 1.5)
    atr_tp_mult       = _f(params.get("atr_tp_mult"), 3.0)
    trail_act_mult    = _f(params.get("trail_activation_mult"), 1.5)
    trail_mult        = _f(params.get("trail_mult"), 1.0)
    max_td            = max(0, _i(params.get("max_trades_per_day"), 1))
    max_hold          = max(0, _i(params.get("max_hold_bars"), 60))
    hold_overnight    = bool(_i(params.get("hold_overnight"), 0))

    high, low, close, volume = df["High"], df["Low"], df["Close"], df["Volume"]

    use_ema = ema_fast_p > 0 and ema_slow_p > 0
    ema_f = _ema(close, ema_fast_p) if use_ema else pd.Series(float("nan"), index=close.index)
    ema_s = _ema(close, ema_slow_p) if use_ema else pd.Series(float("nan"), index=close.index)
    rsi   = _rsi(close, rsi_p)
    atr_v = _atr(high, low, close, atr_p)
    vol20 = volume.rolling(20).mean()

    df["ema_fast"] = ema_f
    df["ema_slow"] = ema_s
    df["rsi"]      = rsi
    df["atr"]      = atr_v

    # ── Build per-day opening-range and EOD index sets ──────────────────── #
    _eod_set   = set()
    _orb       = {}   # date -> {high, low, formed_at, triggered}
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
            if len(idxs) >= orb_minutes:
                orb_idxs = idxs[:orb_minutes]
                _orb[d] = {
                    "high": float(high.iloc[orb_idxs].max()),
                    "low":  float(low.iloc[orb_idxs].min()),
                    "formed_at": idxs[orb_minutes - 1],
                    "triggered": False,
                }

    n         = len(df)
    close_a   = close.values
    high_a    = high.values
    ema_f_a   = ema_f.values
    ema_s_a   = ema_s.values
    rsi_a     = rsi.values
    atr_a     = atr_v.values
    vol_a     = volume.values
    vol20_a   = vol20.values

    signals = np.zeros(n, dtype=int)
    src     = [""] * n

    in_pos       = False
    entry_px     = float("nan")
    entry_atr_v  = float("nan")
    entry_bar    = -1
    trail_high   = float("nan")
    trail_active = False

    for i in range(1, n):
        px       = float(close_a[i])
        cur_date = et_dates[i] if et_dates is not None else None
        orb_info = _orb.get(cur_date) if cur_date is not None else None

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
            continue

        # ── entry logic ──────────────────────────────────────────────────── #
        if math.isnan(atr_a[i]) or atr_a[i] == 0:
            continue
        if math.isnan(rsi_a[i]):
            continue
        if orb_info is None or orb_info["triggered"]:
            continue
        if i <= orb_info["formed_at"]:
            continue
        if cur_date is not None and max_td > 0 and _day_count.get(cur_date, 0) >= max_td:
            continue

        # Price must close above ORB high
        if px <= orb_info["high"]:
            continue

        # Volume surge on breakout bar
        vol_ok = True
        if volume_mult > 0 and not math.isnan(vol20_a[i]) and vol20_a[i] > 0:
            vol_ok = float(vol_a[i]) >= volume_mult * float(vol20_a[i])
        if not vol_ok:
            continue

        # RSI guard
        if not (rsi_min_v <= rsi_a[i] <= rsi_max_v):
            continue

        # EMA trend filter
        if use_ema and not (math.isnan(ema_f_a[i]) or math.isnan(ema_s_a[i])):
            if ema_f_a[i] <= ema_s_a[i]:
                continue

        parts = [f"orb_breakout (range_high={orb_info['high']:.2f})"]
        if vol_ok and volume_mult > 0:
            parts.append("vol_surge")
        if use_ema:
            parts.append("ema_bullish")
        parts.append(f"rsi={rsi_a[i]:.1f}")

        signals[i] = 1
        src[i]     = "+".join(parts)
        in_pos       = True
        entry_px     = px
        entry_atr_v  = float(atr_a[i])
        entry_bar    = i
        trail_high   = px
        trail_active = False
        orb_info["triggered"] = True

        if cur_date is not None:
            _day_count[cur_date] = _day_count.get(cur_date, 0) + 1

    df["signal"]        = signals
    df["signal_source"] = src
    return df
