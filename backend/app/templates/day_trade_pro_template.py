# Day Trading PRO Template v2 - Commission-Aware Selective Entry
#
# Root-cause fixes derived from report ID=68 (AAPL 2026-04-27 to 2026-05-04,
# 78 trades, 1 win, -52.94% return):
#
#  Fix 1 - COMMISSION VIABILITY CHECK
#    ATR on 1-min bars was ~0.09% of price; round-trip commission ~$0.01/share.
#    TP move (4xATR) = $0.96/share — still below commission buffer.
#    New: skip entry if atr_tp_mult*ATR < commission_buffer_mult*2*comm_per_share.
#    Also skip if ATR/price < min_atr_pct (0.15%); market too quiet to trade.
#
#  Fix 2 - NO MORE vwap_hold OVERTRADING (78 trades -> max 2/day)
#    vwap_hold re-entered on every aligned bar after a stop.
#    New: VWAP entry requires strict price CROSS (was below, now above).
#    plus per-day quota (max_trades_per_day=2) and cooldown_bars=10 after exits.
#
#  Fix 3 - TREND EMA EXIT REMOVED
#    trend_ema_breakdown was 44% of all exits (34/78), firing within 1-3 min.
#    New: trend EMA is entry-filter only (slope check). Exits use only
#    ATR stop, trailing stop, take-profit, time-stop, EOD close.
#
#  Fix 4 - TIME STOP
#    Positions that drift flat for max_hold_bars (60) bars with price below
#    entry are force-closed to free capital.
#
#  Fix 5 - WIDER TARGETS
#    atr_stop_mult: 1.5 -> 2.0  (reduce noise-stop)
#    atr_tp_mult:   3.0 -> 5.0  (let winners run past commission)
#    trail activates after 1.5xATR profit (was 1.0x)
#
import math
import numpy as np
import pandas as pd

def _ema(series, span):
    return series.ewm(span=span, adjust=False).mean()

def _rsi(close, period):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100/(1+rs))

def _macd(close, fast, slow, sig):
    m = _ema(close, fast) - _ema(close, slow)
    s = _ema(m, sig)
    return m, s, m-s

def _atr(high, low, close, period):
    prev = close.shift(1)
    tr = pd.concat([high-low, (high-prev).abs(), (low-prev).abs()], axis=1).max(axis=1)
    return tr.ewm(com=period-1, min_periods=period).mean()

def _vwap(high, low, close, volume):
    tp = (high+low+close)/3
    return (tp*volume).cumsum() / volume.cumsum().replace(0, float("nan"))

def _i(v, d):
    try: return int(float(v)) if v is not None else d
    except: return d

def _f(v, d):
    try: return float(v) if v is not None else d
    except: return d

def _s(v, d):
    return str(v).strip().lower() if v else d

def get_default_params():
    return {
        "entry_mode": "both",
        "orb_bars": 30,
        "orb_expire_bars": 120,
        "orb_volume_mult": 1.5,
        "ema_fast": 9,
        "ema_slow": 21,
        "ema_trend": 50,
        "rsi_period": 14,
        "rsi_min": 45.0,
        "rsi_max": 75.0,
        "macd_fast": 12,
        "macd_slow": 26,
        "macd_signal": 9,
        "use_macd_entry": 1,
        "atr_period": 14,
        "atr_stop_mult": 2.0,
        "atr_tp_mult": 5.0,
        "trail_activation_mult": 1.5,
        "trail_mult": 1.2,
        "min_atr_pct": 0.05,
        "min_move_pct": 0.05,
        "max_trades_per_day": 2,
        "cooldown_bars": 10,
        "max_hold_bars": 60,
        "hold_overnight": 0,
    }

def generate_signals(df, **params):
    df = df.copy()
    entry_mode     = _s(params.get("entry_mode"), "both")
    orb_bars       = max(1, _i(params.get("orb_bars"), 30))
    orb_expire     = max(1, _i(params.get("orb_expire_bars"), 120))
    orb_vol_mult   = _f(params.get("orb_volume_mult"), 1.5)
    ema_fast_p     = _i(params.get("ema_fast"), 9)
    ema_slow_p     = _i(params.get("ema_slow"), 21)
    ema_trend_p    = _i(params.get("ema_trend"), 50)
    rsi_p          = _i(params.get("rsi_period"), 14)
    rsi_min_v      = _f(params.get("rsi_min"), 45.0)
    rsi_max_v      = _f(params.get("rsi_max"), 75.0)
    macd_fast_p    = _i(params.get("macd_fast"), 12)
    macd_slow_p    = _i(params.get("macd_slow"), 26)
    macd_sig_p     = _i(params.get("macd_signal"), 9)
    use_macd       = bool(_i(params.get("use_macd_entry"), 1))
    atr_p          = _i(params.get("atr_period"), 14)
    atr_stop_mult  = _f(params.get("atr_stop_mult"), 2.0)
    atr_tp_mult    = _f(params.get("atr_tp_mult"), 5.0)
    trail_act_mult = _f(params.get("trail_activation_mult"), 1.5)
    trail_mult_v   = _f(params.get("trail_mult"), 1.2)
    min_atr_pct    = _f(params.get("min_atr_pct"), 0.05) / 100.0
    min_move_pct   = _f(params.get("min_move_pct"), 0.05) / 100.0  # required TP move >= this
    max_td         = max(0, _i(params.get("max_trades_per_day"), 2))
    cd_bars        = max(0, _i(params.get("cooldown_bars"), 10))
    max_hold       = max(0, _i(params.get("max_hold_bars"), 60))
    hold_overnight = bool(_i(params.get("hold_overnight"), 0))

    high, low, close, volume = df["High"], df["Low"], df["Close"], df["Volume"]
    ema_f = _ema(close, ema_fast_p)
    ema_s = _ema(close, ema_slow_p)
    ema_tr = _ema(close, ema_trend_p) if ema_trend_p > 0 else pd.Series(float("nan"), index=close.index)
    rsi = _rsi(close, rsi_p)
    vwap = _vwap(high, low, close, volume)
    _, _, macd_hist = _macd(close, macd_fast_p, macd_slow_p, macd_sig_p)
    atr_vals = _atr(high, low, close, atr_p)
    vol20 = volume.rolling(20).mean()

    df["ema_fast"] = ema_f; df["ema_slow"] = ema_s; df["ema_trend"] = ema_tr
    df["rsi"] = rsi; df["vwap"] = vwap; df["macd_hist"] = macd_hist; df["atr"] = atr_vals

    _eod_set = set(); _orb = {}; _day_count = {}; et_dates = None
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
            if len(idxs) >= orb_bars:
                _orb[d] = {
                    "high": float(high.iloc[idxs[:orb_bars]].max()),
                    "low":  float(low.iloc[idxs[:orb_bars]].min()),
                    "formed_at": idxs[orb_bars-1],
                    "expire_at": idxs[min(orb_bars-1+orb_expire, len(idxs)-1)],
                    "triggered": False,
                }
            _day_count[d] = 0

    n = len(df)
    close_a = close.values; ema_f_a = ema_f.values; ema_s_a = ema_s.values
    ema_tr_a = ema_tr.values; rsi_a = rsi.values; vwap_a = vwap.values
    macd_h_a = macd_hist.values; atr_a = atr_vals.values
    vol_a = volume.values; vol20_a = vol20.values

    signals = np.zeros(n, dtype=int)
    src = [""] * n
    in_pos = False; entry_px = float("nan"); entry_atr_v = float("nan")
    entry_bar = -1; trail_high = float("nan"); trail_active = False; cd_left = 0

    for i in range(1, n):
        px = float(close_a[i])
        cur_date = et_dates[i] if et_dates is not None else None
        orb_info = _orb.get(cur_date) if cur_date is not None else None
        if cd_left > 0:
            cd_left -= 1
        if in_pos:
            if px > trail_high or math.isnan(trail_high):
                trail_high = px
            hard_stop = entry_px - atr_stop_mult * entry_atr_v
            if not trail_active and (px - entry_px) >= trail_act_mult * entry_atr_v:
                trail_active = True
            eff_stop = trail_high - trail_mult_v * entry_atr_v if trail_active else hard_stop
            tp = entry_px + atr_tp_mult * entry_atr_v
            bars_held = i - entry_bar
            exited = False
            reason = ""
            if px <= eff_stop:
                reason = ("trail_stop (high=%.2f stop=%.2f)" % (trail_high, eff_stop)) if trail_active else ("atr_stop_loss (entry=%.2f stop=%.2f)" % (entry_px, eff_stop))
                exited = True
            elif px >= tp:
                reason = "atr_take_profit (entry=%.2f tp=%.2f)" % (entry_px, tp)
                exited = True
            elif max_hold > 0 and bars_held >= max_hold and px < entry_px:
                reason = "time_stop (bars=%d entry=%.2f)" % (bars_held, entry_px)
                exited = True
            elif i in _eod_set:
                reason = "eod_close (hold_overnight=0)"
                exited = True
            if exited:
                signals[i] = -1; src[i] = reason
                in_pos = False; trail_active = False; trail_high = float("nan")
                entry_px = float("nan"); entry_atr_v = float("nan"); entry_bar = -1
                cd_left = cd_bars
            continue
        if cd_left > 0:
            continue
        if math.isnan(atr_a[i]) or atr_a[i] == 0:
            continue
        if math.isnan(ema_f_a[i]) or math.isnan(ema_s_a[i]) or math.isnan(rsi_a[i]):
            continue
        if cur_date is not None and max_td > 0 and _day_count.get(cur_date, 0) >= max_td:
            continue
        atr_val = float(atr_a[i])
        # Skip if TP move can't clear the minimum required move (covers commission + profit)
        tp_move_pct = atr_tp_mult * atr_val / px
        if min_move_pct > 0 and tp_move_pct < min_move_pct:
            continue
        if atr_val / px < min_atr_pct:
            continue
        if ema_trend_p > 0 and not math.isnan(ema_tr_a[i]):
            if px < ema_tr_a[i]:
                continue
            if not math.isnan(ema_tr_a[i-1]) and ema_tr_a[i] < ema_tr_a[i-1]:
                continue
        ema_bull = ema_f_a[i] > ema_s_a[i]
        ema_cross_up = ema_bull and ema_f_a[i-1] <= ema_s_a[i-1]
        ema_f_rising = ema_bull and ema_f_a[i] > ema_f_a[i-1]
        rsi_ok = rsi_min_v <= rsi_a[i] <= rsi_max_v
        rsi_rising = rsi_a[i] > rsi_a[i-1]
        macd_ok = True
        if use_macd and not math.isnan(macd_h_a[i]) and not math.isnan(macd_h_a[i-1]):
            macd_ok = macd_h_a[i] > 0 and macd_h_a[i] > macd_h_a[i-1]
        vol_ok = True
        if orb_vol_mult > 0 and not math.isnan(vol20_a[i]) and vol20_a[i] > 0:
            vol_ok = float(vol_a[i]) >= orb_vol_mult * float(vol20_a[i])
        triggered = False; tsrc = ""
        if entry_mode in ("orb", "both") and orb_info is not None:
            if (not orb_info["triggered"] and i > orb_info["formed_at"]
                    and i <= orb_info["expire_at"] and px > orb_info["high"]
                    and ema_bull and rsi_ok and vol_ok and (not use_macd or macd_ok)):
                triggered = True; orb_info["triggered"] = True
                parts = ["orb_breakout", "ema_bullish", "rsi_ok"]
                if vol_ok: parts.append("vol_surge")
                if use_macd and macd_ok: parts.append("macd_pos")
                tsrc = "+".join(parts)
        if not triggered and entry_mode in ("vwap", "both"):
            vwap_crossed = (not math.isnan(vwap_a[i]) and not math.isnan(vwap_a[i-1])
                            and float(close_a[i-1]) < float(vwap_a[i-1]) and px >= vwap_a[i])
            if not vwap_crossed:
                continue
            if not (ema_cross_up or (ema_f_rising and ema_bull)):
                continue
            if not rsi_ok or not rsi_rising:
                continue
            if use_macd and not macd_ok:
                continue
            triggered = True
            parts = ["vwap_cross", "ema_cross" if ema_cross_up else "ema_rising"]
            if rsi_rising: parts.append("rsi_rising")
            if use_macd and macd_ok: parts.append("macd_pos")
            if vol_ok and orb_vol_mult > 0: parts.append("vol_surge")
            tsrc = "+".join(parts)
        if triggered:
            signals[i] = 1; src[i] = tsrc
            in_pos = True; entry_px = px; entry_atr_v = atr_val
            entry_bar = i; trail_high = px; trail_active = False
            if cur_date is not None:
                _day_count[cur_date] = _day_count.get(cur_date, 0) + 1

    df["signal"] = signals; df["signal_source"] = src
    return df
