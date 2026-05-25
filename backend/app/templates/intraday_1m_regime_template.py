"""
Intraday 1m Regime Template — ORB + VWAP Reversion + VSA Climax + ROC/Volume

Purpose
-------
A 1-minute day-trading template focused on low-lag, volume-aware logic:

1) Opening Range Breakout (ORB, first 5 regular-session 1m bars)
2) VWAP mean reversion using a VWAP +/- sigma band
3) VSA climax scalp (high-volume absorption candle)
4) ROC + volume momentum continuation

Regime behavior (derived from 1m price/volume state)
-----------------------------------------------------
- bullish/euphoric:
  - allow breakout + momentum + reversion longs
  - euphoric widens TP and keeps trailing stop active
- neutral:
  - allow all long entries, standard risk
- bearish:
  - suppress new longs (engine stays defensive)
- crash:
  - enable only fast mean-reversion scalps (VWAP reclaim / VSA)

Important implementation note
-----------------------------
The sandbox engine in this repository is long-only (BUY to open, SELL to close).
So "short-mode" is represented here as suppressing long entries and accelerating
risk exits, not by opening short positions.
"""

import math
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd


_ET = ZoneInfo("America/New_York")


def _coerce_et_index(df: pd.DataFrame) -> tuple[pd.Index, pd.DatetimeIndex | None]:
    """Return (day_keys, et_index_or_none) from index or common datetime columns.

    Some execution paths provide a non-datetime index (e.g. RangeIndex). In
    that case we attempt to recover timestamps from common columns; otherwise we
    fall back to a single pseudo-day key to keep logic deterministic.
    """
    idx = df.index
    if isinstance(idx, pd.DatetimeIndex):
        idx_et = idx.tz_localize(_ET) if idx.tz is None else idx.tz_convert(_ET)
        return pd.Index(idx_et.date), idx_et

    for col in ("Datetime", "datetime", "Date", "date", "timestamp"):
        if col not in df.columns:
            continue
        ts = pd.to_datetime(df[col], errors="coerce")
        if ts.notna().sum() == 0:
            continue
        ts_et = ts.dt.tz_localize(_ET) if ts.dt.tz is None else ts.dt.tz_convert(_ET)
        idx_et = pd.DatetimeIndex(ts_et)
        return pd.Index(idx_et.date), idx_et

    return pd.Index(np.zeros(len(df), dtype=int)), None


def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> pd.Series:
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(com=period - 1, min_periods=period).mean()


def _session_vwap(df: pd.DataFrame, day: pd.Index) -> pd.Series:
    tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
    vol = df["Volume"].astype(float)
    pv = tp * vol
    cum_pv = pv.groupby(day).cumsum()
    cum_v = vol.groupby(day).cumsum()
    return cum_pv / cum_v.replace(0.0, np.nan)


def _session_sigma(close: pd.Series, vwap: pd.Series, day: pd.Index) -> pd.Series:
    dev = close - vwap
    # Expanding intraday stdev of deviation from VWAP.
    return dev.groupby(day).transform(lambda s: s.expanding(min_periods=10).std())


def _i(v, d):
    try:
        return int(float(v)) if v is not None else d
    except Exception:
        return d


def _f(v, d):
    try:
        return float(v) if v is not None else d
    except Exception:
        return d


def get_default_params() -> dict:
    return {
        # Core windows
        "orb_bars": 5,
        "vwap_band_std": 2.0,
        "roc_period": 7,
        "atr_period": 14,
        # Volume filters
        "orb_breakout_volume_mult": 1.5,
        "roc_volume_mult": 1.5,
        "vsa_top_pct": 0.95,
        # Generic ATR risk model
        "atr_sl_mult": 1.5,
        "atr_tp_mult": 2.0,
        # Optional absolute risk targets ($ per share from entry)
        "numeric_sl_value": 0.0,
        "numeric_tp_value": 0.0,
        # ORB rule-set
        "orb_rr": 2.0,
        # VSA scalp rule-set
        "vsa_sl_pct": 0.15,
        "vsa_tp_pct": 0.40,
        # Session safety
        "max_trades_per_day": 12,
        "cooldown_bars": 1,
        # Max bars to hold any open position (0 = no cap)
        "max_hold_bars": 20,
        "hold_overnight": 0,
        # Optional overrides
        "allow_bearish_longs": 0,
        "allow_crash_scalps": 1,
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    df = df.copy()

    orb_bars = _i(params.get("orb_bars"), 5)
    vwap_band_std = _f(params.get("vwap_band_std"), 2.0)
    roc_period = _i(params.get("roc_period"), 7)
    atr_period = _i(params.get("atr_period"), 14)

    orb_vol_mult = _f(params.get("orb_breakout_volume_mult"), 1.5)
    roc_vol_mult = _f(params.get("roc_volume_mult"), 1.5)
    vsa_top_pct = _f(params.get("vsa_top_pct"), 0.95)

    atr_sl_mult = _f(params.get("atr_sl_mult"), 1.5)
    atr_tp_mult = _f(params.get("atr_tp_mult"), 2.0)
    numeric_sl_value = _f(params.get("numeric_sl_value"), 0.0)
    numeric_tp_value = _f(params.get("numeric_tp_value"), 0.0)
    orb_rr = _f(params.get("orb_rr"), 2.0)

    vsa_sl_pct = _f(params.get("vsa_sl_pct"), 0.15) / 100.0
    vsa_tp_pct = _f(params.get("vsa_tp_pct"), 0.40) / 100.0

    max_trades_per_day = _i(params.get("max_trades_per_day"), 12)
    cooldown_bars = _i(params.get("cooldown_bars"), 1)
    max_hold_bars = _i(params.get("max_hold_bars"), 20)
    hold_overnight = bool(_i(params.get("hold_overnight"), 0))
    allow_bearish_longs = bool(_i(params.get("allow_bearish_longs"), 0))
    allow_crash_scalps = bool(_i(params.get("allow_crash_scalps"), 1))

    close = df["Close"].astype(float)
    high = df["High"].astype(float)
    low = df["Low"].astype(float)
    open_ = df["Open"].astype(float)
    volume = df["Volume"].astype(float)

    day, idx_et = _coerce_et_index(df)

    vwap = _session_vwap(df, day)
    sigma = _session_sigma(close, vwap, day).fillna(0.0)
    upper_band = vwap + vwap_band_std * sigma
    lower_band = vwap - vwap_band_std * sigma

    roc = close.pct_change(roc_period)
    atr = _atr(high, low, close, atr_period)
    vol_ma5 = volume.rolling(5).mean()
    vol_ma10 = volume.rolling(10).mean()

    # ORB range for first N regular bars per day.
    orb_high = pd.Series(np.nan, index=df.index, dtype=float)
    orb_low = pd.Series(np.nan, index=df.index, dtype=float)
    orb_formed_idx: dict[object, int] = {}
    eod_set: set[int] = set()
    day_trade_count: dict[object, int] = {}

    if "session" in df.columns:
        sess = df["session"].values
        day_regular: dict[object, list[int]] = {}
        for j, (d, s) in enumerate(zip(day, sess)):
            if s == "regular":
                day_regular.setdefault(d, []).append(j)

        for d, idxs in day_regular.items():
            day_trade_count[d] = 0
            if not hold_overnight and idxs:
                eod_set.add(idxs[-1])
            if len(idxs) >= orb_bars:
                r = idxs[:orb_bars]
                orb_h = float(high.iloc[r].max())
                orb_l = float(low.iloc[r].min())
                formed_at = r[-1]
                orb_formed_idx[d] = formed_at
                for i in idxs[formed_at - idxs[0] + 1 :]:
                    orb_high.iloc[i] = orb_h
                    orb_low.iloc[i] = orb_l
    else:
        # Fallback if no session column: infer pseudo-day boundaries from ET date.
        for d in np.unique(day):
            idxs = np.where(day == d)[0].tolist()
            if not idxs:
                continue
            day_trade_count[d] = 0
            if not hold_overnight:
                eod_set.add(idxs[-1])
            if len(idxs) >= orb_bars:
                r = idxs[:orb_bars]
                orb_h = float(high.iloc[r].max())
                orb_l = float(low.iloc[r].min())
                formed_at = r[-1]
                orb_formed_idx[d] = formed_at
                for i in idxs[formed_at - idxs[0] + 1 :]:
                    orb_high.iloc[i] = orb_h
                    orb_low.iloc[i] = orb_l

    # VSA event bookkeeping (enter next bar after a climax candle).
    vsa_long_next = np.zeros(len(df), dtype=bool)
    day_vol_quantile = volume.groupby(day).transform(lambda s: s.expanding(min_periods=20).quantile(vsa_top_pct))

    for i in range(1, len(df) - 1):
        candle_range = max(1e-12, float(high.iloc[i] - low.iloc[i]))
        body = abs(float(close.iloc[i] - open_.iloc[i]))
        lower_wick = min(float(open_.iloc[i]), float(close.iloc[i])) - float(low.iloc[i])
        upper_wick = float(high.iloc[i]) - max(float(open_.iloc[i]), float(close.iloc[i]))

        vol_spike = float(volume.iloc[i]) >= float(day_vol_quantile.iloc[i] or 0.0)
        narrow_body = body / candle_range <= 0.25
        long_lower_wick = lower_wick / candle_range >= 0.45
        down_into_bar = float(close.iloc[i]) < float(close.iloc[i - 1])
        absorption = vol_spike and narrow_body and long_lower_wick and down_into_bar and lower_wick > upper_wick

        if absorption:
            vsa_long_next[i + 1] = True

    # Regime classification from low-lag price/volume state.
    regime = np.array(["neutral"] * len(df), dtype=object)
    for i in range(1, len(df)):
        px = float(close.iloc[i])
        vw = float(vwap.iloc[i]) if not math.isnan(vwap.iloc[i]) else px
        up = float(upper_band.iloc[i]) if not math.isnan(upper_band.iloc[i]) else px
        r = float(roc.iloc[i]) if not math.isnan(roc.iloc[i]) else 0.0
        r1 = (px / float(close.iloc[i - 1]) - 1.0) if close.iloc[i - 1] > 0 else 0.0
        vm10 = float(vol_ma10.iloc[i]) if not math.isnan(vol_ma10.iloc[i]) else 0.0
        vol_ratio = (float(volume.iloc[i]) / vm10) if vm10 > 0 else 1.0

        if px < vw and (r <= -0.008 or r1 <= -0.012) and vol_ratio >= 1.8:
            regime[i] = "crash"
        elif px < vw and r <= -0.0025:
            regime[i] = "bearish"
        elif px > up and vol_ratio >= 1.6:
            regime[i] = "euphoric"
        elif px > vw and r >= 0.002:
            regime[i] = "bullish"
        else:
            regime[i] = "neutral"

    signals = np.zeros(len(df), dtype=int)
    signal_source = [""] * len(df)

    in_pos = False
    entry_price = float("nan")
    entry_bar = -1
    stop_price = float("nan")
    take_profit = float("nan")
    trailing_on = False
    trail_anchor = float("nan")
    entry_setup = ""
    cooldown = 0
    last_pierce_low = float("nan")

    for i in range(1, len(df)):
        px = float(close.iloc[i])
        d = day[i]

        if cooldown > 0:
            cooldown -= 1

        if in_pos:
            # Regime-aware trailing in euphoric tape.
            reg = str(regime[i])
            if reg == "euphoric":
                if math.isnan(trail_anchor) or px > trail_anchor:
                    trail_anchor = px
                if not trailing_on and px >= entry_price * 1.004:
                    trailing_on = True
                if trailing_on:
                    euphoric_trail = trail_anchor * (1.0 - 0.003)
                    stop_price = max(stop_price, euphoric_trail)

            exit_reason = ""
            if px <= stop_price:
                exit_reason = f"risk_stop ({stop_price:.2f})"
            elif px >= take_profit:
                exit_reason = f"target_hit ({take_profit:.2f})"
            elif max_hold_bars > 0 and entry_bar >= 0 and (i - entry_bar) >= max_hold_bars:
                exit_reason = f"time_exit ({max_hold_bars} bars)"
            elif i in eod_set:
                exit_reason = "eod_close"

            if exit_reason:
                signals[i] = -1
                signal_source[i] = exit_reason
                in_pos = False
                entry_price = float("nan")
                entry_bar = -1
                stop_price = float("nan")
                take_profit = float("nan")
                trailing_on = False
                trail_anchor = float("nan")
                entry_setup = ""
                cooldown = cooldown_bars
            continue

        if cooldown > 0:
            continue
        if day_trade_count.get(d, 0) >= max_trades_per_day:
            continue
        if math.isnan(atr.iloc[i]) or atr.iloc[i] <= 0:
            continue

        reg = str(regime[i])
        allow_long = reg in {"neutral", "bullish", "euphoric"}
        if reg == "bearish" and allow_bearish_longs:
            allow_long = True
        if reg == "crash" and allow_crash_scalps:
            allow_long = True

        # Track pierce below lower band for VWAP reversion setup.
        pierced_lower_now = (
            not math.isnan(lower_band.iloc[i])
            and float(low.iloc[i]) < float(lower_band.iloc[i])
        )
        if pierced_lower_now:
            last_pierce_low = float(low.iloc[i])

        # Avoid VWAP reversion during first 30 min.
        in_first_30m = False
        if idx_et is not None:
            mins = idx_et[i].hour * 60 + idx_et[i].minute
            in_first_30m = 9 * 60 + 30 <= mins < 10 * 60

        # Entry candidates.
        reason = ""
        sl = float("nan")
        tp = float("nan")

        # 1) ORB breakout with 5-bar pre-breakout volume check.
        formed_at = orb_formed_idx.get(d)
        can_orb = formed_at is not None and i > formed_at and not math.isnan(orb_high.iloc[i])
        if allow_long and can_orb and px > float(orb_high.iloc[i]):
            prev5 = volume.iloc[max(0, i - 5):i]
            prev5_avg = float(prev5.mean()) if len(prev5) > 0 else 0.0
            vol_ok = prev5_avg > 0 and float(volume.iloc[i]) >= orb_vol_mult * prev5_avg
            if vol_ok:
                vw = float(vwap.iloc[i]) if not math.isnan(vwap.iloc[i]) else px - atr_sl_mult * float(atr.iloc[i])
                sl = min(vw, px - atr_sl_mult * float(atr.iloc[i]))
                risk = max(0.0001, px - sl)
                tp = px + orb_rr * risk
                reason = "orb_breakout"

        # 2) VWAP mean reversion: previous pierce + close back inside lower band.
        if not reason and allow_long and not in_first_30m and not math.isnan(lower_band.iloc[i]):
            if not math.isnan(last_pierce_low) and px >= float(lower_band.iloc[i]):
                # In crash, this is one of the preferred setups.
                sl = min(last_pierce_low * 0.999, px - atr_sl_mult * float(atr.iloc[i]))
                tp = float(vwap.iloc[i]) if not math.isnan(vwap.iloc[i]) else px + atr_tp_mult * float(atr.iloc[i])
                if reg == "euphoric":
                    tp = max(tp, px + 1.5 * atr_tp_mult * float(atr.iloc[i]))
                reason = "vwap_reclaim"

        # 3) VSA climax scalp trigger (enter on bar after climax candle).
        if not reason and allow_long and vsa_long_next[i]:
            sl = px * (1.0 - vsa_sl_pct)
            tp = px * (1.0 + vsa_tp_pct)
            reason = "vsa_absorption_scalp"

        # 4) ROC + volume momentum with VWAP structural filter.
        if not reason and allow_long:
            vm10 = float(vol_ma10.iloc[i]) if not math.isnan(vol_ma10.iloc[i]) else 0.0
            vol_ok = vm10 > 0 and float(volume.iloc[i]) >= roc_vol_mult * vm10
            roc_ok = not math.isnan(roc.iloc[i]) and float(roc.iloc[i]) >= 0.002
            vwap_ok = not math.isnan(vwap.iloc[i]) and px >= float(vwap.iloc[i])
            if vol_ok and roc_ok and vwap_ok:
                sl = px - atr_sl_mult * float(atr.iloc[i])
                tp_mult = atr_tp_mult * (1.5 if reg == "euphoric" else 1.0)
                tp = px + tp_mult * float(atr.iloc[i])
                reason = "roc_volume_momentum"

        if reason:
            if numeric_sl_value > 0:
                sl = px - numeric_sl_value
            if numeric_tp_value > 0:
                tp = px + numeric_tp_value
            sl = min(sl, px - 1e-6)
            tp = max(tp, px + 1e-6)
            signals[i] = 1
            signal_source[i] = f"{reason} [{reg}]"
            in_pos = True
            entry_price = px
            entry_bar = i
            stop_price = sl
            take_profit = tp
            trailing_on = False
            trail_anchor = px
            entry_setup = reason
            day_trade_count[d] = day_trade_count.get(d, 0) + 1
            # Consume the reversion pierce so we do not repeatedly re-enter off one event.
            if reason == "vwap_reclaim":
                last_pierce_low = float("nan")

    df["vwap"] = vwap
    df["vwap_upper"] = upper_band
    df["vwap_lower"] = lower_band
    df["roc"] = roc
    df["atr"] = atr
    df["pm_regime"] = regime
    df["signal"] = signals
    df["signal_source"] = signal_source
    return df
