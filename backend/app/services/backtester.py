"""Core backtesting engine – runs a strategy against historical OHLCV data."""
from __future__ import annotations

import math
import random
import numpy as np
import pandas as pd
from typing import Any

from app.services.data_provider import DataSource, fetch_ohlcv, fetch_ohlcv_intraday
from app.services.strategies import get_strategy


def _fmt_ts(ts) -> str:
    """Format a timestamp as ISO string, including time component when intraday."""
    if hasattr(ts, 'time') and ts.time().hour == 0 and ts.time().minute == 0 and ts.time().second == 0:
        return str(ts.date())
    # Use a stable intraday display format without timezone suffix.
    # This keeps UI output readable and avoids downstream parser issues.
    try:
        return pd.Timestamp(ts).tz_localize(None).strftime("%Y-%m-%d_%H:%M:%S")
    except Exception:
        return str(ts)


def _derive_position(df: pd.DataFrame) -> pd.DataFrame:
    """Add a ``position`` column derived from ``signal`` changes.

    A non-zero position value signals a trade trigger: positive means switch
    to long, negative means exit long.  Using ``diff()`` naturally produces 0
    when the signal is unchanged, so no further filtering is needed.
    """
    df = df.copy()
    df["position"] = df["signal"].diff().fillna(0)
    return df


def _calculate_metrics(
    equity: pd.Series,
    trades: list[dict],
    initial_capital: float,
    bars_per_year: float = 252.0,
) -> dict[str, Any]:
    """Calculate performance metrics from an equity curve.

    Parameters
    ----------
    bars_per_year:
        Number of bars in a trading year used for annualisation.
        - Daily bars  → 252
        - 1-min bars  → 252 × 390 = 98_280
        - 5-min bars  → 252 × 78  = 19_656
    """
    final_value = float(equity.iloc[-1])
    total_return_pct = (final_value - initial_capital) / initial_capital * 100

    # Annualised return
    n_years = len(equity) / bars_per_year
    if n_years > 0 and final_value > 0:
        annualized_return_pct = (
            (final_value / initial_capital) ** (1 / n_years) - 1
        ) * 100
    else:
        annualized_return_pct = 0.0

    # Sharpe ratio (assuming risk-free rate = 0)
    bar_returns = equity.pct_change().dropna()
    if len(bar_returns) > 1 and bar_returns.std() > 0:
        sharpe_ratio = float(
            (bar_returns.mean() / bar_returns.std()) * math.sqrt(bars_per_year)
        )
    else:
        sharpe_ratio = 0.0

    # Max drawdown
    rolling_max = equity.cummax()
    drawdown = (equity - rolling_max) / rolling_max
    max_drawdown_pct = float(drawdown.min() * 100)

    # Win rate
    profitable = [t for t in trades if t.get("pnl", 0) > 0]
    win_rate_pct = (len(profitable) / len(trades) * 100) if trades else 0.0

    return {
        "final_value": round(final_value, 2),
        "total_return_pct": round(total_return_pct, 2),
        "annualized_return_pct": round(annualized_return_pct, 2),
        "sharpe_ratio": round(sharpe_ratio, 2),
        "max_drawdown_pct": round(max_drawdown_pct, 2),
        "win_rate_pct": round(win_rate_pct, 2),
        "total_trades": len(trades),
    }


def run_backtest(
    symbol: str,
    strategy_type: str,
    start_date: str,
    end_date: str,
    initial_capital: float = 10_000.0,
    commission: float = 0.005,  # flat per-share fee (e.g. IB fixed $0.005/share)
    script_code: str | None = None,
    data_source: DataSource = "yfinance",
    day_trade: bool = False,
    hold_positions_overnight: bool = True,
    eod_sell_window_minutes: int = 30,
    **strategy_params,
) -> dict[str, Any]:
    """
    Run a full backtest.

    When *script_code* is provided the custom Python script is used to generate
    signals instead of a built-in strategy.  In this case *strategy_type* is
    still stored for labelling purposes (use ``"custom_script"``).

    The *data_source* parameter selects where OHLCV data is fetched from.
    Supported values: ``"auto"`` (default), ``"yfinance"``, ``"stooq"``, ``"ib"``.
    ``"auto"`` uses IB when connected and otherwise falls back to Yahoo Finance.

    When *day_trade* is ``True`` the engine fetches intraday data using the
    finest available interval (IB: 5s when available; Yahoo: 1m → 2m → 5m)
    and scales all annualisation calculations accordingly. Note that Yahoo
    Finance limits 1m data to the last 7 days and 2m/5m to the last 60 days.

    When *hold_positions_overnight* is ``False`` and *eod_sell_window_minutes* is set,
    positions are force-liquidated during the end-of-day sell window.

    Returns a dict with:
      - metrics (performance summary)
      - equity_curve (list of {date, value})
      - trades (list of executed round-trip trades)
      - ohlcv (price data for charting)
    """
    if day_trade:
        df = fetch_ohlcv_intraday(symbol, start_date, end_date, source=data_source)
    else:
        df = fetch_ohlcv(symbol, start_date, end_date, source=data_source)

    # Determine bars-per-year for correct Sharpe / annualisation scaling.
    # For day-trade mode count only regular-session bars so pre/post bars
    # don't dilute the per-bar statistics.
    interval = df.attrs.get("interval", "1d")
    _interval_bars: dict[str, float] = {
        "5s": 252 * 4680,
        "1m": 252 * 390,
        "2m": 252 * 195,
        "5m": 252 * 78,
        "15m": 252 * 26,
        "30m": 252 * 13,
        "60m": 252 * 6.5,
        "1h": 252 * 6.5,
        "1d": 252,
    }
    if day_trade and "session" in df.columns:
        n_regular = int((df["session"] == "regular").sum())
        n_total = len(df)
        regular_fraction = n_regular / n_total if n_total > 0 else 1.0
        bars_per_year = _interval_bars.get(interval, 252) * regular_fraction
    else:
        bars_per_year = _interval_bars.get(interval, 252)

    # Pre-compute bar indices for end-of-day sell window logic.
    # If hold_positions_overnight is False, force-close during the EOD window.
    # Otherwise, use the existing logic (force-close at last regular bar if day_trade).
    eod_sell_bars: set = set()
    last_regular_bar: set = set()
    
    if day_trade and "session" in df.columns:
        regular_mask = df["session"] == "regular"
        regular_df = df[regular_mask]
        if not regular_df.empty:
            # Group by calendar date (in ET) and identify bars in EOD window
            et_dates = regular_df.index.tz_convert("America/New_York")
            et_times = et_dates.time
            
            for _date in set(et_dates.date):
                day_bars = regular_df[
                    [d == _date for d in regular_df.index.tz_convert("America/New_York").date]
                ]
                if not day_bars.empty:
                    # Last bar of the day
                    last_bar_idx = day_bars.index[-1]
                    last_regular_bar.add(last_bar_idx)
                    
                    # EOD sell window: bars within eod_sell_window_minutes of 16:00 ET
                    if not hold_positions_overnight:
                        eod_start_hour = (16 * 60 - eod_sell_window_minutes) // 60
                        eod_start_min = (16 * 60 - eod_sell_window_minutes) % 60
                        from datetime import time as dt_time
                        eod_cutoff = dt_time(eod_start_hour, eod_start_min)
                        
                        for idx in day_bars.index:
                            bar_time = idx.tz_convert("America/New_York").time()
                            if bar_time >= eod_cutoff:
                                eod_sell_bars.add(idx)

    # stop_loss_pct is a universal safeguard param (0 = disabled)
    _raw_slp = strategy_params.pop("stop_loss_pct", 0.0)
    stop_loss_pct = float(_raw_slp) if str(_raw_slp).strip() != "" else 0.0

    if script_code is not None:
        from app.services.script_executor import execute_script
        df = execute_script(script_code, df, **strategy_params)
        # Scripts emit event-based signals (+1/-1 only on the action bar, 0
        # elsewhere).  Using diff() on such signals would create phantom trades
        # (the bar *after* a +1 buy signal becomes diff=-1, triggering an
        # immediate phantom sell).  Use the signal column directly as position.
        if "position" not in df.columns:
            df = df.copy()
            df["position"] = df["signal"].fillna(0)
    elif "signal" in df.columns:
        # If upstream already provided event signals (tests/custom feeds),
        # preserve them instead of regenerating strategy signals.
        df = df.copy()
        if "position" not in df.columns:
            df["position"] = df["signal"].fillna(0)
    else:
        strategy = get_strategy(strategy_type, **strategy_params)
        df = strategy.generate_signals(df)

    cash = initial_capital
    shares = 0.0
    trades: list[dict] = []
    equity_values: list[float] = []
    entry_price: float | None = None
    entry_date: str | None = None
    entry_reason: str | None = None
    # Pending buy: a buy signal fired in pre-market carries over to the open
    pending_buy_reason: str | None = None

    stop_loss_mult = (1.0 - stop_loss_pct / 100.0) if stop_loss_pct > 0 else None

    for date, row in df.iterrows():
        price = float(row["Close"])
        position_change = float(row.get("position", 0))
        session = str(row.get("session", "regular")) if day_trade else "regular"
        is_regular = session == "regular"

        # ── Intraday: force-close positions when needed ──────────────────────── #
        # If hold_positions_overnight is False, close during EOD window.
        # Otherwise (hold=True), close at end of day only if day_trade mode.
        should_force_close = False
        close_reason = None
        
        if day_trade:
            if not hold_positions_overnight and date in eod_sell_bars:
                should_force_close = True
                close_reason = "eod_liquidation"
            elif hold_positions_overnight and date in last_regular_bar:
                should_force_close = True
                close_reason = "eod_close"
        
        if should_force_close and shares > 0:
            proceeds = shares * price - shares * commission
            pnl = proceeds - (shares * entry_price + shares * commission)
            trades.append(
                {
                    "entry_date": entry_date,
                    "exit_date": _fmt_ts(date),
                    "side": "BUY",
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(price, 4),
                    "quantity": shares,
                    "pnl": round(pnl, 2),
                    "entry_reason": entry_reason or "signal",
                    "exit_reason": close_reason,
                }
            )
            cash += proceeds
            shares = 0.0
            entry_price = None
            entry_date = None
            entry_reason = None
            pending_buy_reason = None
            equity_values.append(cash)
            continue

        # ── Day-trade: execute a pending pre-market buy at first regular bar ─ #
        if day_trade and is_regular and pending_buy_reason is not None and shares == 0:
            shares_to_buy = math.floor(cash / (price + commission))
            if shares_to_buy > 0:
                cost = shares_to_buy * price + shares_to_buy * commission
                cash -= cost
                shares = shares_to_buy
                entry_price = price
                entry_date = _fmt_ts(date)
                entry_reason = pending_buy_reason
            pending_buy_reason = None
            equity_values.append(cash + shares * price)
            continue

        # Universal stop-loss safeguard (fires before strategy signals).
        # Only execute during regular session in day-trade mode.
        if (
            is_regular
            and stop_loss_mult is not None
            and shares > 0
            and entry_price is not None
            and price <= entry_price * stop_loss_mult
        ):
            proceeds = shares * price - shares * commission
            pnl = proceeds - (shares * entry_price + shares * commission)
            trades.append(
                {
                    "entry_date": entry_date,
                    "exit_date": _fmt_ts(date),
                    "side": "BUY",
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(price, 4),
                    "quantity": shares,
                    "pnl": round(pnl, 2),
                    "entry_reason": entry_reason or "signal",
                    "exit_reason": "stop_loss",
                }
            )
            cash += proceeds
            shares = 0.0
            entry_price = None
            entry_date = None
            entry_reason = None
            portfolio_value = cash
            equity_values.append(portfolio_value)
            continue

        if position_change > 0 and shares == 0:
            # BUY signal
            if is_regular:
                # Execute immediately during regular session
                shares_to_buy = math.floor(cash / (price + commission))
                if shares_to_buy > 0:
                    cost = shares_to_buy * price + shares_to_buy * commission
                    cash -= cost
                    shares = shares_to_buy
                    entry_price = price
                    entry_date = _fmt_ts(date)
                    entry_reason = str(row.get("signal_source", "")) or "signal"
            elif day_trade:
                # Pre/post-market signal: carry it to the next regular open
                pending_buy_reason = str(row.get("signal_source", "")) or "signal_premarket"

        elif position_change < 0 and shares > 0 and is_regular:
            # SELL — only during regular session
            proceeds = shares * price - shares * commission
            pnl = proceeds - (shares * entry_price + shares * commission)
            exit_reason = str(row.get("signal_source", "")) or "strategy_exit"
            trades.append(
                {
                    "entry_date": entry_date,
                    "exit_date": _fmt_ts(date),
                    "side": "BUY",
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(price, 4),
                    "quantity": shares,
                    "pnl": round(pnl, 2),
                    "entry_reason": entry_reason or "signal",
                    "exit_reason": exit_reason,
                }
            )
            cash += proceeds
            shares = 0.0
            entry_price = None
            entry_date = None
            entry_reason = None

        portfolio_value = cash + shares * price
        equity_values.append(portfolio_value)

    final_shares = shares
    final_cash = cash
    final_entry_price = entry_price
    max_shares_held = max((t["quantity"] for t in trades), default=0)

    equity_series = pd.Series(equity_values, index=df.index)
    metrics = _calculate_metrics(equity_series, trades, initial_capital, bars_per_year)

    equity_curve = [
        {"date": _fmt_ts(d), "value": round(v, 2)}
        for d, v in zip(df.index, equity_values)
    ]

    ohlcv = [
        {
            "date": _fmt_ts(d),
            "open": round(float(r["Open"]), 4),
            "high": round(float(r["High"]), 4),
            "low": round(float(r["Low"]), 4),
            "close": round(float(r["Close"]), 4),
            "volume": int(r["Volume"]),
            "signal": int(r.get("signal", 0)),
            **({"session": r["session"]} if "session" in df.columns else {}),
        }
        for d, r in df.iterrows()
    ]

    # Attach indicator values (exclude structural/non-numeric columns)
    indicator_keys = [
        k for k in df.columns
        if k not in {"Open", "High", "Low", "Close", "Volume", "signal", "position", "session"}
    ]
    for i, (d, r) in enumerate(df.iterrows()):
        for k in indicator_keys:
            val = r[k]
            if not pd.notna(val):
                ohlcv[i][k] = None
            elif isinstance(val, str):
                ohlcv[i][k] = val
            else:
                try:
                    ohlcv[i][k] = round(float(val), 4)
                except (TypeError, ValueError):
                    ohlcv[i][k] = str(val)

    return {
        "symbol": symbol,
        "strategy_type": strategy_type,
        "strategy_params": strategy_params,
        "data_source": data_source,
        "day_trade": day_trade,
        "interval": interval,
        "start_date": start_date,
        "end_date": end_date,
        "initial_capital": initial_capital,
        "metrics": metrics,
        "equity_curve": equity_curve,
        "trades": trades,
        "ohlcv": ohlcv,
        "final_shares": round(final_shares, 6),
        "final_cash": round(final_cash, 2),
        "final_entry_price": round(final_entry_price, 4) if final_entry_price else None,
        "max_shares_held": round(max_shares_held, 6),
    }



# ── Sentiment-switching backtest ──────────────────────────────────────────── #

_STRATEGY_ALIASES: dict[str, str] = {
    "bollinger": "bollinger_bands",
    "moving_avg": "sma_crossover",
    "sma": "sma_crossover",
    "bb": "bollinger_bands",
}


def _compute_sentiment_buckets(
    closes: pd.Series,
    min_persistence: int = 5,
    smooth_span: int = 5,
) -> pd.Series:
    """Vectorized per-bar sentiment bucket Series (crash/bearish/neutral/bullish/euphoric).

    Composite of three sub-signals, each contributing ±1/3 (RSI contributes ±2/3
    at extreme readings):
      1. RSI-14  – <30 crash, <40 bearish, >70 euphoric, >60 bullish
      2. MACD histogram (12/26/9)
      3. Close vs SMA-20

    To reduce intraday whip-saws, the composite score is EMA-smoothed (``smooth_span``)
    and bucket transitions require ``min_persistence`` consecutive bars of
    agreement before the active bucket flips. Set either to 0/1 to disable.
    """
    score = pd.Series(0.0, index=closes.index)

    # RSI (14-bar)
    delta = closes.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.where(loss != 0, np.nan)
    rsi = (100 - 100 / (1 + rs)).fillna(50)
    score += (rsi < 30).astype(float) * (-2 / 3)
    score += ((rsi >= 30) & (rsi < 40)).astype(float) * (-1 / 3)
    score += (rsi > 70).astype(float) * (2 / 3)
    score += ((rsi > 60) & (rsi <= 70)).astype(float) * (1 / 3)

    # MACD histogram (12/26/9)
    ema12 = closes.ewm(span=12, adjust=False).mean()
    ema26 = closes.ewm(span=26, adjust=False).mean()
    hist = ((ema12 - ema26) - (ema12 - ema26).ewm(span=9, adjust=False).mean()).fillna(0)
    score += (hist > 0).astype(float) * (1 / 3)
    score += (hist < 0).astype(float) * (-1 / 3)

    # SMA-20 trend
    sma20 = closes.rolling(20).mean().fillna(closes)
    score += (closes > sma20).astype(float) * (1 / 3)
    score += (closes < sma20).astype(float) * (-1 / 3)

    score = score.clip(-1.0, 1.0)
    if smooth_span and smooth_span > 1:
        score = score.ewm(span=smooth_span, adjust=False).mean()

    def _to_bucket(s: float) -> str:
        if s >= 0.5:
            return "euphoric"
        if s >= 0.1:
            return "bullish"
        if s > -0.1:
            return "neutral"
        if s > -0.5:
            return "bearish"
        return "crash"

    raw = score.apply(_to_bucket)
    if not min_persistence or min_persistence <= 1 or raw.empty:
        return raw

    # Hysteresis: a new bucket only becomes active after `min_persistence`
    # consecutive bars vote for it. Eliminates per-bar flapping driven by
    # MACD histogram sign flips in low-volatility intraday windows.
    current = raw.iloc[0]
    candidate: str | None = None
    candidate_count = 0
    debounced: list[str] = []
    for b in raw:
        if b == current:
            candidate = None
            candidate_count = 0
        else:
            if candidate == b:
                candidate_count += 1
            else:
                candidate = b
                candidate_count = 1
            if candidate_count >= min_persistence:
                current = b
                candidate = None
                candidate_count = 0
        debounced.append(current)
    return pd.Series(debounced, index=raw.index, dtype=object)


def run_sentiment_backtest(
    symbol: str,
    start_date: str,
    end_date: str,
    initial_capital: float = 10_000.0,
    commission: float = 0.005,
    data_source: DataSource = "yfinance",
    day_trade: bool = False,
    sentiment_strategies: "dict[str, str] | None" = None,
    sentiment_warmup: int = 35,
    stop_loss_pct: float = 0.0,
    take_profit_pct: float = 0.0,
    hold_positions_overnight: bool = True,
    eod_sell_window_minutes: int = 30,
    custom_scripts: "dict[int, str] | None" = None,
) -> "dict[str, Any]":
    """Backtest where the active strategy auto-switches based on rolling sentiment.

    Sentiment is derived from RSI + MACD + SMA computed on the OHLCV data.
    Open positions are force-closed whenever the active strategy changes.
    The first ``sentiment_warmup`` bars use the *neutral* bucket's strategy.

    When *hold_positions_overnight* is False, positions are force-liquidated
    during the end-of-day sell window (last eod_sell_window_minutes before market close).

    ``sentiment_strategies`` maps bucket labels to strategy type strings::

        {"crash": "rsi", "bearish": "macd", "neutral": "bollinger_bands",
         "bullish": "sma_crossover", "euphoric": "rsi"}
    """
    _DEFAULTS: dict[str, str] = {
        "crash": "rsi",
        "bearish": "macd",
        "neutral": "bollinger_bands",
        "bullish": "sma_crossover",
        "euphoric": "rsi",
    }
    if sentiment_strategies is None:
        strat_map: dict[str, str] = dict(_DEFAULTS)
    else:
        strat_map = {k: _STRATEGY_ALIASES.get(v, v) for k, v in sentiment_strategies.items()}
        for bucket, default_strat in _DEFAULTS.items():
            strat_map.setdefault(bucket, default_strat)

    if day_trade:
        df = fetch_ohlcv_intraday(symbol, start_date, end_date, source=data_source)
    else:
        df = fetch_ohlcv(symbol, start_date, end_date, source=data_source)

    interval = df.attrs.get("interval", "1d")
    _interval_bars: dict[str, float] = {
        "5s": 252 * 4680,
        "1m": 252 * 390, "2m": 252 * 195, "5m": 252 * 78,
        "15m": 252 * 26, "30m": 252 * 13, "60m": 252 * 6.5,
        "1h": 252 * 6.5, "1d": 252,
    }
    bars_per_year = _interval_bars.get(interval, 252)

    # Pre-compute bar indices for end-of-day sell window logic
    eod_sell_bars: set = set()
    if day_trade and "session" in df.columns:
        regular_mask = df["session"] == "regular"
        regular_df = df[regular_mask]
        if not regular_df.empty and not hold_positions_overnight:
            # Identify bars in EOD window
            et_dates = regular_df.index.tz_convert("America/New_York")
            eod_start_hour = (16 * 60 - eod_sell_window_minutes) // 60
            eod_start_min = (16 * 60 - eod_sell_window_minutes) % 60
            from datetime import time as dt_time
            eod_cutoff = dt_time(eod_start_hour, eod_start_min)
            
            for idx in regular_df.index:
                bar_time = idx.tz_convert("America/New_York").time()
                if bar_time >= eod_cutoff:
                    eod_sell_bars.add(idx)

    # Sentiment buckets; force neutral during warmup to avoid indicator noise
    buckets = _compute_sentiment_buckets(df["Close"])
    buckets.iloc[:sentiment_warmup] = "neutral"

    # Pre-generate signals for all unique strategies used in the map
    needed = set(strat_map.values())
    signals_by_strat: dict[str, pd.Series] = {}
    _scripts: dict[int, str] = custom_scripts or {}
    for stype in needed:
        try:
            if stype.startswith("custom:"):
                script_id = int(stype[7:])
                code = _scripts.get(script_id)
                if not code:
                    raise ValueError(f"Custom script {script_id} not found.")
                from app.services.script_executor import execute_script
                strat_df = execute_script(code, df.copy())
            elif stype.startswith("template:"):
                filename = stype[9:]
                if "/" in filename or "\\" in filename or ".." in filename:
                    raise ValueError(f"Invalid template filename: {filename}")
                from pathlib import Path
                tmpl_path = Path(__file__).resolve().parents[1] / "templates" / filename
                if not tmpl_path.exists():
                    raise ValueError(f"Template file not found: {filename}")
                from app.services.script_executor import execute_script
                strat_df = execute_script(tmpl_path.read_text(encoding="utf-8"), df.copy())
            else:
                strat_df = get_strategy(stype).generate_signals(df.copy())
            pos_col = (
                strat_df["position"]
                if "position" in strat_df.columns
                else strat_df["signal"].diff().fillna(0)
            )
            signals_by_strat[stype] = pos_col
        except Exception:
            signals_by_strat[stype] = pd.Series(0.0, index=df.index)

    # Execution loop
    cash = initial_capital
    shares = 0.0
    entry_price: float | None = None
    entry_date: str | None = None
    entry_strategy: str | None = None
    entry_bucket_str: str | None = None
    prev_strat: str | None = None
    trades: list[dict] = []
    equity_values: list[float] = []
    strategy_switches: list[dict] = []
    stop_loss_mult = (1.0 - stop_loss_pct / 100.0) if stop_loss_pct > 0 else None
    take_profit_mult = (1.0 + take_profit_pct / 100.0) if take_profit_pct > 0 else None

    for i, (date, row) in enumerate(df.iterrows()):
        price = float(row["Close"])
        bucket = str(buckets.iloc[i])
        active_strat = strat_map[bucket]

        # End-of-day liquidation: force-close positions during EOD window
        if day_trade and date in eod_sell_bars and shares > 0 and entry_price is not None:
            proceeds = shares * price - shares * commission
            pnl = proceeds - (shares * entry_price + shares * commission)
            trades.append({
                "entry_date": entry_date,
                "exit_date": _fmt_ts(date),
                "side": "BUY",
                "entry_price": round(entry_price, 4),
                "exit_price": round(price, 4),
                "quantity": shares,
                "pnl": round(pnl, 2),
                "entry_reason": entry_strategy or "signal",
                "exit_reason": "eod_liquidation",
                "entry_strategy": entry_strategy,
                "exit_strategy": active_strat,
                "entry_bucket": entry_bucket_str,
                "exit_bucket": bucket,
            })
            cash += proceeds
            shares = 0.0
            entry_price = None
            entry_date = None
            entry_strategy = None
            entry_bucket_str = None
            equity_values.append(cash)
            continue

        # Universal risk exits (optional): checked before strategy signals.
        if shares > 0 and entry_price is not None:
            risk_exit_reason = None
            if stop_loss_mult is not None and price <= entry_price * stop_loss_mult:
                risk_exit_reason = "stop_loss"
            elif take_profit_mult is not None and price >= entry_price * take_profit_mult:
                risk_exit_reason = "take_profit"

            if risk_exit_reason is not None:
                proceeds = shares * price - shares * commission
                pnl = proceeds - (shares * entry_price + shares * commission)
                trades.append({
                    "entry_date": entry_date,
                    "exit_date": _fmt_ts(date),
                    "side": "BUY",
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(price, 4),
                    "quantity": shares,
                    "pnl": round(pnl, 2),
                    "entry_reason": entry_strategy or "signal",
                    "exit_reason": risk_exit_reason,
                    "entry_strategy": entry_strategy,
                    "exit_strategy": active_strat,
                    "entry_bucket": entry_bucket_str,
                    "exit_bucket": bucket,
                })
                cash += proceeds
                shares = 0.0
                entry_price = None
                entry_date = None
                entry_strategy = None
                entry_bucket_str = None

        # Strategy change: hand the position over rather than always closing.
        # Only force-close if the new strategy currently signals an exit
        # (negative position_change). Avoids commission churn on no-op switches
        # while the underlying bar's intent is still "stay long".
        if active_strat != prev_strat:
            if prev_strat is not None:
                strategy_switches.append(
                    {"date": _fmt_ts(date), "from": prev_strat, "to": active_strat, "bucket": bucket}
                )
            if shares > 0 and entry_price is not None:
                new_sig = signals_by_strat.get(active_strat)
                new_pos_change = float(new_sig.iloc[i]) if new_sig is not None else 0.0
                if new_pos_change < 0:
                    proceeds = shares * price - shares * commission
                    pnl = proceeds - (shares * entry_price + shares * commission)
                    trades.append({
                        "entry_date": entry_date,
                        "exit_date": _fmt_ts(date),
                        "side": "BUY",
                        "entry_price": round(entry_price, 4),
                        "exit_price": round(price, 4),
                        "quantity": shares,
                        "pnl": round(pnl, 2),
                        "entry_reason": entry_strategy or "signal",
                        "exit_reason": "strategy_switch",
                        "entry_strategy": entry_strategy,
                        "exit_strategy": active_strat,
                        "entry_bucket": entry_bucket_str,
                        "exit_bucket": bucket,
                    })
                    cash += proceeds
                    shares = 0.0
                    entry_price = None
                    entry_date = None
                    entry_strategy = None
                    entry_bucket_str = None
                else:
                    # Re-label the live position under the new strategy/bucket.
                    entry_strategy = active_strat
                    entry_bucket_str = bucket
            prev_strat = active_strat

        position_change = float(
            signals_by_strat.get(active_strat, pd.Series(0.0, index=df.index)).iloc[i]
        )

        if position_change > 0 and shares == 0:
            shares_to_buy = math.floor(cash / (price + commission))
            if shares_to_buy > 0:
                cost = shares_to_buy * price + shares_to_buy * commission
                cash -= cost
                shares = shares_to_buy
                entry_price = price
                entry_date = _fmt_ts(date)
                entry_strategy = active_strat
                entry_bucket_str = bucket

        elif position_change < 0 and shares > 0:
            proceeds = shares * price - shares * commission
            pnl = proceeds - (shares * entry_price + shares * commission)
            trades.append({
                "entry_date": entry_date,
                "exit_date": _fmt_ts(date),
                "side": "BUY",
                "entry_price": round(entry_price, 4),
                "exit_price": round(price, 4),
                "quantity": shares,
                "pnl": round(pnl, 2),
                "entry_reason": entry_strategy or "signal",
                "exit_reason": "strategy_exit",
                "entry_strategy": entry_strategy,
                "exit_strategy": active_strat,
                "entry_bucket": entry_bucket_str,
                "exit_bucket": bucket,
            })
            cash += proceeds
            shares = 0.0
            entry_price = None
            entry_date = None
            entry_strategy = None
            entry_bucket_str = None

        equity_values.append(cash + shares * price)

    equity_series = pd.Series(equity_values, index=df.index)
    metrics = _calculate_metrics(equity_series, trades, initial_capital, bars_per_year)

    equity_curve = [
        {"date": _fmt_ts(d), "value": round(v, 2)}
        for d, v in zip(df.index, equity_values)
    ]
    ohlcv = [
        {
            "date": _fmt_ts(d),
            "open": round(float(r["Open"]), 4),
            "high": round(float(r["High"]), 4),
            "low": round(float(r["Low"]), 4),
            "close": round(float(r["Close"]), 4),
            "volume": int(r["Volume"]),
            "bucket": str(buckets.iloc[i]),
            "active_strategy": strat_map[str(buckets.iloc[i])],
        }
        for i, (d, r) in enumerate(df.iterrows())
    ]

    return {
        "symbol": symbol,
        "strategy_type": "sentiment_switching",
        "sentiment_strategies": strat_map,
        "data_source": str(data_source),
        "day_trade": day_trade,
        "interval": interval,
        "start_date": start_date,
        "end_date": end_date,
        "initial_capital": initial_capital,
        "metrics": metrics,
        "equity_curve": equity_curve,
        "trades": trades,
        "ohlcv": ohlcv,
        "strategy_switches": strategy_switches,
        "final_shares": round(shares, 6),
        "final_cash": round(cash, 2),
        "final_entry_price": round(entry_price, 4) if entry_price else None,
        "max_shares_held": round(max((t["quantity"] for t in trades), default=0), 6),
    }


# ── Sandbox-style portfolio backtest ──────────────────────────────────────── #
# Coordinated multi-symbol backtest with a shared cash pool and per-position
# allocation floor/cap, mirroring how the live sandbox engine + PortfolioManager
# manage capital across the watchlist.

_INTERVAL_BARS: dict[str, float] = {
    "5s": 252 * 4680,
    "1m": 252 * 390, "2m": 252 * 195, "5m": 252 * 78,
    "15m": 252 * 26, "30m": 252 * 13, "60m": 252 * 6.5,
    "1h": 252 * 6.5, "1d": 252,
}


def _prepare_symbol_for_portfolio(
    symbol: str,
    start_date: str,
    end_date: str,
    data_source: DataSource,
    day_trade: bool,
    routing: str,                  # "sentiment" | "fixed"
    fixed_strategy: str | None,    # used when routing == "fixed"
    sentiment_strategies: "dict[str, str] | None",
    sentiment_warmup: int,
    custom_scripts: "dict[int, str] | None",
    hold_positions_overnight: bool,
    eod_sell_window_minutes: int,
) -> dict[str, Any]:
    """Build per-bar series for one symbol used by the portfolio coordinator."""
    if day_trade:
        df = fetch_ohlcv_intraday(symbol, start_date, end_date, source=data_source)
    else:
        df = fetch_ohlcv(symbol, start_date, end_date, source=data_source)

    interval = df.attrs.get("interval", "1d")

    # EOD / last-bar liquidation indices (day-trade only).
    eod_sell_bars: set = set()
    last_regular_bar: set = set()
    if day_trade and "session" in df.columns:
        regular_mask = df["session"] == "regular"
        regular_df = df[regular_mask]
        if not regular_df.empty:
            et_index = regular_df.index.tz_convert("America/New_York")
            from datetime import time as dt_time
            eod_start_hour = (16 * 60 - eod_sell_window_minutes) // 60
            eod_start_min = (16 * 60 - eod_sell_window_minutes) % 60
            eod_cutoff = dt_time(eod_start_hour, eod_start_min)
            unique_dates = sorted(set(et_index.date))
            for _date in unique_dates:
                day_mask = [d == _date for d in et_index.date]
                day_bars = regular_df[day_mask]
                if day_bars.empty:
                    continue
                last_regular_bar.add(day_bars.index[-1])
                if not hold_positions_overnight:
                    day_et = day_bars.index.tz_convert("America/New_York")
                    for idx, ts_et in zip(day_bars.index, day_et):
                        if ts_et.time() >= eod_cutoff:
                            eod_sell_bars.add(idx)

    # Sentiment buckets (always computed; cheap and lets us tag bars).
    buckets = _compute_sentiment_buckets(df["Close"])
    if sentiment_warmup > 0 and len(buckets) > 0:
        buckets.iloc[: min(sentiment_warmup, len(buckets))] = "neutral"

    # Determine the active strategy per bar.
    if routing == "sentiment":
        defaults = {
            "crash": "rsi", "bearish": "macd", "neutral": "bollinger_bands",
            "bullish": "sma_crossover", "euphoric": "rsi",
        }
        sm = dict(sentiment_strategies or {})
        strat_map = {b: _STRATEGY_ALIASES.get(sm.get(b, defaults[b]), sm.get(b, defaults[b])) for b in defaults}
        active_strategy = buckets.map(strat_map).astype(str)
    else:
        eff = (fixed_strategy or "sma_crossover").strip() or "sma_crossover"
        active_strategy = pd.Series(eff, index=df.index, dtype=object)
        strat_map = {b: eff for b in ("crash", "bearish", "neutral", "bullish", "euphoric")}

    # Pre-compute position-change series for every distinct strategy referenced.
    needed = set(active_strategy.unique().tolist())
    scripts = custom_scripts or {}
    signals_by_strat: dict[str, pd.Series] = {}
    for stype in needed:
        try:
            if isinstance(stype, str) and stype.startswith("custom:"):
                sid = int(stype[7:])
                code = scripts.get(sid)
                if not code:
                    raise ValueError(f"Custom script {sid} not found.")
                from app.services.script_executor import execute_script
                strat_df = execute_script(code, df.copy())
            elif isinstance(stype, str) and stype.startswith("template:"):
                filename = stype[9:]
                if "/" in filename or "\\" in filename or ".." in filename:
                    raise ValueError(f"Invalid template filename: {filename}")
                from pathlib import Path
                tmpl_path = Path(__file__).resolve().parents[1] / "templates" / filename
                if not tmpl_path.exists():
                    raise ValueError(f"Template file not found: {filename}")
                from app.services.script_executor import execute_script
                strat_df = execute_script(tmpl_path.read_text(encoding="utf-8"), df.copy())
            else:
                strat_df = get_strategy(stype).generate_signals(df.copy())
            if "position" in strat_df.columns:
                pos_col = strat_df["position"].fillna(0.0)
            else:
                pos_col = strat_df["signal"].diff().fillna(0.0)
            signals_by_strat[stype] = pos_col.reindex(df.index).fillna(0.0)
        except Exception:
            signals_by_strat[stype] = pd.Series(0.0, index=df.index)

    return {
        "symbol": symbol.upper(),
        "df": df,
        "interval": interval,
        "buckets": buckets,
        "active_strategy": active_strategy,
        "signals_by_strat": signals_by_strat,
        "eod_sell_bars": eod_sell_bars,
        "last_regular_bar": last_regular_bar,
    }


def run_sandbox_portfolio_backtest(
    symbol_specs: list[dict],          # [{symbol, routing, fixed_strategy, min_alloc, max_alloc}]
    start_date: str,
    end_date: str,
    initial_capital: float,
    commission: float = 0.005,         # flat per-share
    data_source: DataSource = "auto",
    day_trade: bool = True,
    sentiment_strategies: "dict[str, str] | None" = None,
    sentiment_warmup: int = 35,
    custom_scripts: "dict[int, str] | None" = None,
    stop_loss_pct: float = 0.0,
    take_profit_pct: float = 0.0,
    hold_positions_overnight: bool = True,
    eod_sell_window_minutes: int = 30,
    sim_buy_fill_rate_pct: float = 60.0,
    sim_sell_fill_rate_pct: float = 70.0,
    pending_price_drift_cancel_pct: float = 0.75,
    sim_pending_duration_bars: int = 1,
) -> dict[str, Any]:
    """Run a coordinated multi-symbol backtest with a shared cash pool.

    Each symbol has an earmark (``min_alloc``) and a cap (``max_alloc``).
    Excess cash beyond all earmarks lives in a centralised pool; any position
    placing a BUY may draw from the pool up to its cap. SELL proceeds first
    refill that position's earmark; excess flows back to the shared pool.
    """
    # Prepare each symbol's signals + market data.
    prepared: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    for spec in symbol_specs:
        sym = str(spec["symbol"]).upper()
        try:
            prepared.append(_prepare_symbol_for_portfolio(
                symbol=sym,
                start_date=start_date,
                end_date=end_date,
                data_source=data_source,
                day_trade=day_trade,
                routing=spec.get("routing", "sentiment"),
                fixed_strategy=spec.get("fixed_strategy"),
                sentiment_strategies=sentiment_strategies,
                sentiment_warmup=sentiment_warmup,
                custom_scripts=custom_scripts,
                hold_positions_overnight=hold_positions_overnight,
                eod_sell_window_minutes=eod_sell_window_minutes,
            ))
        except Exception as exc:  # noqa: BLE001
            errors[sym] = str(exc)

    if not prepared:
        return {
            "initial_capital": initial_capital,
            "final_value": initial_capital,
            "metrics": {
                "final_value": round(initial_capital, 2),
                "total_return_pct": 0.0,
                "annualized_return_pct": 0.0,
                "sharpe_ratio": 0.0,
                "max_drawdown_pct": 0.0,
                "win_rate_pct": 0.0,
                "total_trades": 0,
                "symbols_run": 0,
                "symbols_failed": len(errors),
            },
            "equity_curve": [],
            "per_symbol": [],
            "errors": errors,
        }

    # Per-symbol state (mirrors sandbox).
    spec_by_sym = {str(s["symbol"]).upper(): s for s in symbol_specs}
    state: dict[str, dict[str, Any]] = {}
    for p in prepared:
        sym = p["symbol"]
        spec = spec_by_sym.get(sym, {})
        min_alloc = max(0.0, float(spec.get("min_alloc", 0.0) or 0.0))
        max_alloc_raw = spec.get("max_alloc")
        max_alloc = float("inf") if max_alloc_raw in (None, 0, 0.0, "") else max(0.0, float(max_alloc_raw))
        state[sym] = {
            "shares": 0.0,
            "avg_cost": 0.0,
            "entry_price": None,
            "entry_date": None,
            "entry_strategy": None,
            "entry_bucket": None,
            "allocated_funds": min_alloc,
            "min_alloc": min_alloc,
            "max_alloc": max_alloc,
            "prev_strat": None,
            "last_price": float("nan"),
            "trades": [],
            "strategy_switches": [],
            "max_shares": 0.0,
            # Cumulative cost basis used across all opens (for return %).
            "cost_basis_total": 0.0,
            # Per-symbol equity curve: list of (timestamp, base + cum_realized + unrealized).
            "curve": [],
            "realized_pnl_total": 0.0,
            "pending_order": None,
        }

    total_earmark = sum(s["min_alloc"] for s in state.values())
    if total_earmark > initial_capital:
        # Scale earmarks down proportionally so the pool is never negative.
        scale = initial_capital / total_earmark if total_earmark > 0 else 0.0
        for s in state.values():
            s["min_alloc"] = s["min_alloc"] * scale
            s["allocated_funds"] = s["min_alloc"]
        total_earmark = sum(s["min_alloc"] for s in state.values())
    pool = max(0.0, initial_capital - total_earmark)

    # Merged sorted timeline across all symbols.
    union_index = sorted(set().union(*[p["df"].index for p in prepared]))
    by_sym = {p["symbol"]: p for p in prepared}
    sl_mult = (1.0 - stop_loss_pct / 100.0) if stop_loss_pct > 0 else None
    tp_mult = (1.0 + take_profit_pct / 100.0) if take_profit_pct > 0 else None
    buy_fill_prob = max(0.0, min(1.0, float(sim_buy_fill_rate_pct) / 100.0))
    sell_fill_prob = max(0.0, min(1.0, float(sim_sell_fill_rate_pct) / 100.0))
    drift_threshold_pct = max(0.0, float(pending_price_drift_cancel_pct or 0.0))
    pending_delay_bars = max(1, int(sim_pending_duration_bars or 1))

    portfolio_curve: list[tuple[Any, float]] = []

    def _pending_buy_reserved(st: dict[str, Any]) -> float:
        order = st.get("pending_order") or {}
        if str(order.get("side") or "").upper() != "BUY":
            return 0.0
        return float(order.get("reserved_cost") or 0.0)

    def _refund_pending_buy(sym: str) -> None:
        nonlocal pool
        st = state[sym]
        order = st.get("pending_order") or {}
        if str(order.get("side") or "").upper() != "BUY":
            st["pending_order"] = None
            return
        st["allocated_funds"] += float(order.get("reserved_from_allocated") or 0.0)
        pool += float(order.get("reserved_from_pool") or 0.0)
        st["pending_order"] = None

    def _price_within_pending_range(current_price: float, pending_price: float) -> bool:
        if current_price <= 0 or pending_price <= 0:
            return False
        drift_pct = abs(current_price - pending_price) / pending_price * 100.0
        return drift_pct <= drift_threshold_pct

    def _try_buy(sym: str, price: float, date, reason: str, bucket: str, active_strat: str, ts_idx: int):
        nonlocal pool
        st = state[sym]
        if st["shares"] > 0 or st["pending_order"] is not None or price <= 0:
            return
        committed = float(st["shares"]) * float(st["avg_cost"]) + float(st["allocated_funds"])
        cap_room = max(0.0, st["max_alloc"] - committed) if st["max_alloc"] != float("inf") else float("inf")
        draw_from_pool = min(pool, cap_room) if cap_room != float("inf") else pool
        available = st["allocated_funds"] + draw_from_pool
        per_share_cost = price + commission
        if per_share_cost <= 0 or available < per_share_cost:
            return
        qty = math.floor(available / per_share_cost)
        if qty <= 0:
            return
        cost = qty * price + qty * commission
        # Spend allocated_funds first, then draw the remainder from the pool.
        reserved_from_allocated = 0.0
        reserved_from_pool = 0.0
        if cost <= st["allocated_funds"]:
            st["allocated_funds"] -= cost
            reserved_from_allocated = cost
        else:
            extra = cost - st["allocated_funds"]
            reserved_from_allocated = st["allocated_funds"]
            reserved_from_pool = extra
            st["allocated_funds"] = 0.0
            pool -= extra
        st["pending_order"] = {
            "side": "BUY",
            "quantity": float(qty),
            "requested_price": float(price),
            "placed_index": int(ts_idx),
            "reason": reason,
            "entry_strategy": active_strat,
            "entry_bucket": bucket,
            "entry_date": _fmt_ts(date),
            "reserved_cost": float(cost),
            "reserved_from_allocated": float(reserved_from_allocated),
            "reserved_from_pool": float(reserved_from_pool),
        }

    def _try_queue_sell(sym: str, price: float, ts_idx: int, reason: str):
        st = state[sym]
        if st["shares"] <= 0 or st["pending_order"] is not None or price <= 0:
            return
        st["pending_order"] = {
            "side": "SELL",
            "quantity": float(st["shares"]),
            "requested_price": float(price),
            "placed_index": int(ts_idx),
            "reason": reason,
        }

    def _try_fill_pending(sym: str, price: float, ts, ts_idx: int) -> bool:
        st = state[sym]
        order = st.get("pending_order")
        if not order:
            return False

        if (int(ts_idx) - int(order.get("placed_index", ts_idx))) < pending_delay_bars:
            return True

        requested_price = float(order.get("requested_price") or 0.0)
        if not _price_within_pending_range(price, requested_price):
            # Drifted too far from requested fill price: cancel and release reserved cash.
            if str(order.get("side") or "").upper() == "BUY":
                _refund_pending_buy(sym)
            return True

        side = str(order.get("side") or "").upper()
        if side == "BUY":
            if random.random() > buy_fill_prob:
                return True
            qty = float(order.get("quantity") or 0.0)
            if qty <= 0:
                _refund_pending_buy(sym)
                return False
            st["shares"] = qty
            st["avg_cost"] = requested_price
            st["entry_price"] = requested_price
            st["entry_date"] = str(order.get("entry_date") or _fmt_ts(ts))
            st["entry_strategy"] = order.get("entry_strategy")
            st["entry_bucket"] = order.get("entry_bucket")
            st["cost_basis_total"] += qty * requested_price
            if qty > st["max_shares"]:
                st["max_shares"] = qty
            st["pending_order"] = None
            return True

        if side == "SELL":
            if random.random() > sell_fill_prob:
                return True
            exit_reason = str(order.get("reason") or "strategy_exit")
            st["pending_order"] = None
            _close_position(
                sym,
                price,
                ts,
                f"{exit_reason} | pending_fill",
                st.get("entry_bucket") or "neutral",
                st.get("entry_strategy") or "sma_crossover",
            )
            return True

        st["pending_order"] = None
        return False

    def _close_position(sym: str, price: float, date, exit_reason: str, bucket: str, active_strat: str):
        nonlocal pool
        st = state[sym]
        if st["shares"] <= 0 or st["entry_price"] is None:
            return
        qty = st["shares"]
        proceeds = qty * price - qty * commission
        pnl = proceeds - (qty * st["entry_price"] + qty * commission)
        st["realized_pnl_total"] += pnl
        st["trades"].append({
            "entry_date": st["entry_date"],
            "exit_date": _fmt_ts(date),
            "side": "BUY",
            "entry_price": round(st["entry_price"], 4),
            "exit_price": round(price, 4),
            "quantity": qty,
            "pnl": round(pnl, 2),
            "entry_reason": st["entry_strategy"] or "signal",
            "exit_reason": exit_reason,
            "entry_strategy": st["entry_strategy"],
            "exit_strategy": active_strat,
            "entry_bucket": st["entry_bucket"],
            "exit_bucket": bucket,
        })
        st["allocated_funds"] += proceeds
        st["shares"] = 0.0
        st["avg_cost"] = 0.0
        st["entry_price"] = None
        st["entry_date"] = None
        st["entry_strategy"] = None
        st["entry_bucket"] = None
        # Excess over earmark flows back to shared pool.
        if st["allocated_funds"] > st["min_alloc"]:
            excess = st["allocated_funds"] - st["min_alloc"]
            st["allocated_funds"] = st["min_alloc"]
            pool += excess

    for ts_idx, ts in enumerate(union_index):
        for sym, st in state.items():
            p = by_sym[sym]
            if ts not in p["df"].index:
                continue
            row = p["df"].loc[ts]
            raw_price = float(row["Close"])
            if math.isfinite(raw_price) and raw_price > 0:
                price = raw_price
                st["last_price"] = price
            else:
                # Ignore malformed ticks (e.g. 0/negative/NaN close) for
                # valuation and execution; keep the last known-good price.
                price = st["last_price"] if not math.isnan(st["last_price"]) else 0.0
                if price <= 0:
                    continue

            # Pending orders reroll once each bar when still in acceptance range.
            if _try_fill_pending(sym, price, ts, ts_idx):
                continue

            session = str(row.get("session", "regular")) if day_trade else "regular"
            is_regular = session == "regular"
            bucket = str(p["buckets"].loc[ts]) if ts in p["buckets"].index else "neutral"
            active_strat = str(p["active_strategy"].loc[ts]) if ts in p["active_strategy"].index else "sma_crossover"

            # 1. End-of-day liquidation / last-bar close.
            if day_trade:
                if not hold_positions_overnight and ts in p["eod_sell_bars"] and st["shares"] > 0:
                    _try_queue_sell(sym, price, ts_idx, "eod_liquidation")
                    continue
                if hold_positions_overnight and ts in p["last_regular_bar"] and st["shares"] > 0:
                    _try_queue_sell(sym, price, ts_idx, "eod_close")
                    continue

            # 2. Stop-loss / take-profit (regular session only when day-trading).
            if st["shares"] > 0 and st["entry_price"] is not None and (is_regular or not day_trade):
                if sl_mult is not None and price <= st["entry_price"] * sl_mult:
                    _try_queue_sell(sym, price, ts_idx, "stop_loss")
                    continue
                if tp_mult is not None and price >= st["entry_price"] * tp_mult:
                    _try_queue_sell(sym, price, ts_idx, "take_profit")
                    continue

            # 3. Strategy switch close (sentiment routing only).
            if st["prev_strat"] is not None and active_strat != st["prev_strat"]:
                st["strategy_switches"].append({
                    "date": _fmt_ts(ts), "from": st["prev_strat"], "to": active_strat, "bucket": bucket,
                })
                if st["shares"] > 0:
                    # Only force-close if the new strategy currently signals an
                    # exit. Otherwise hand the position over to the new strategy
                    # to avoid paying commission on a no-op switch and to let
                    # the move continue compounding under the new label.
                    new_sig = p["signals_by_strat"].get(active_strat)
                    new_pos_change = (
                        float(new_sig.loc[ts])
                        if (new_sig is not None and ts in new_sig.index)
                        else 0.0
                    )
                    if new_pos_change < 0:
                        _try_queue_sell(sym, price, ts_idx, "strategy_switch")
                    else:
                        st["entry_strategy"] = active_strat
                        st["entry_bucket"] = bucket
            st["prev_strat"] = active_strat

            # 4. Signal execution.
            sig_series = p["signals_by_strat"].get(active_strat)
            position_change = float(sig_series.loc[ts]) if (sig_series is not None and ts in sig_series.index) else 0.0
            if position_change > 0 and st["shares"] == 0 and (is_regular or not day_trade):
                _try_buy(sym, price, ts, str(row.get("signal_source", "")) or "signal", bucket, active_strat, ts_idx)
            elif position_change < 0 and st["shares"] > 0 and (is_regular or not day_trade):
                _try_queue_sell(sym, price, ts_idx, str(row.get("signal_source", "")) or "strategy_exit")

        # Snapshot portfolio + per-symbol values at this bar.
        port_val = pool
        for sym, st in state.items():
            lp = st["last_price"] if not math.isnan(st["last_price"]) else 0.0
            mv = st["shares"] * lp
            pending_reserved = _pending_buy_reserved(st)
            port_val += st["allocated_funds"] + mv + pending_reserved
            # Per-symbol equity = display base + realized + unrealized P&L.
            unrealized = (st["shares"] * (lp - (st["entry_price"] or 0.0))) if st["shares"] > 0 and st["entry_price"] is not None else 0.0
            base = max(st["min_alloc"], st["cost_basis_total"])
            st["curve"].append((ts, base + st["realized_pnl_total"] + unrealized + pending_reserved))
        portfolio_curve.append((ts, port_val))

    # Final liquidation valuation (mark-to-market at last seen price).
    final_value = pool + sum(
        st["allocated_funds"]
        + st["shares"] * (st["last_price"] if not math.isnan(st["last_price"]) else 0.0)
        + _pending_buy_reserved(st)
        for st in state.values()
    )

    # Build per-symbol summaries.
    intervals = [p["interval"] for p in prepared]
    bars_per_year = _INTERVAL_BARS.get(intervals[0], 252) if intervals else 252
    MAX_OHLCV_POINTS = 800
    per_symbol: list[dict[str, Any]] = []
    total_trades = 0
    wins = 0
    closed = 0
    for p in prepared:
        sym = p["symbol"]
        st = state[sym]
        trades = st["trades"]
        symbol_pnl = sum(float(t.get("pnl") or 0.0) for t in trades)
        lp = st["last_price"] if not math.isnan(st["last_price"]) else 0.0
        market_val = st["shares"] * lp
        unrealized = (st["shares"] * (lp - (st["entry_price"] or 0.0))) if st["shares"] > 0 and st["entry_price"] is not None else 0.0
        # Display capital basis for return %: max(min_alloc, peak cost basis).
        display_capital = max(st["min_alloc"], st["cost_basis_total"])
        display_final = display_capital + st["realized_pnl_total"] + unrealized
        total_return_pct = (
            round(((display_final - display_capital) / display_capital) * 100.0, 4)
            if display_capital > 0 else 0.0
        )

        # Per-symbol equity curve + risk metrics.
        curve_pts = st["curve"]
        equity_curve_sym = [
            {"date": _fmt_ts(d), "value": round(float(v), 2)}
            for d, v in curve_pts
        ]
        sharpe_sym = None
        max_dd_sym = None
        if len(curve_pts) > 1:
            vals = [float(v) for _, v in curve_pts]
            rets = [
                (vals[i] - vals[i - 1]) / vals[i - 1]
                for i in range(1, len(vals))
                if vals[i - 1] > 0
            ]
            if len(rets) > 1:
                mean_r = sum(rets) / len(rets)
                var_r = sum((x - mean_r) ** 2 for x in rets) / (len(rets) - 1)
                std_r = math.sqrt(var_r)
                sharpe_sym = round((mean_r / std_r) * math.sqrt(bars_per_year), 2) if std_r > 0 else 0.0
            peak = vals[0]
            worst = 0.0
            for v in vals:
                if v > peak:
                    peak = v
                if peak > 0:
                    dd = (v - peak) / peak
                    if dd < worst:
                        worst = dd
            max_dd_sym = round(worst * 100.0, 2)
        win_rate_sym = 0.0
        if trades:
            wsym = sum(1 for t in trades if t.get("pnl") is not None and float(t["pnl"]) > 0)
            csym = sum(1 for t in trades if t.get("pnl") is not None)
            win_rate_sym = round((wsym / csym * 100.0) if csym else 0.0, 2)

        # OHLCV passthrough (downsampled).
        df = p["df"]
        bars_all = [
            {
                "date": _fmt_ts(idx),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row.get("Volume", 0.0)),
            }
            for idx, row in df.iterrows()
        ]
        if len(bars_all) > MAX_OHLCV_POINTS:
            step = max(1, len(bars_all) // MAX_OHLCV_POINTS)
            ohlcv_out = bars_all[::step]
            if bars_all and ohlcv_out[-1] is not bars_all[-1]:
                ohlcv_out.append(bars_all[-1])
        else:
            ohlcv_out = bars_all

        per_symbol.append({
            "symbol": sym,
            "initial_capital": round(display_capital, 2),
            "max_alloc": None if st["max_alloc"] == float("inf") else st["max_alloc"],
            "min_alloc": st["min_alloc"],
            "final_value": round(display_final, 2),
            "market_value": round(market_val, 2),
            "allocated_funds": round(st["allocated_funds"], 2),
            "realized_pnl": round(symbol_pnl, 2),
            "unrealized_pnl": round(unrealized, 2),
            "total_return_pct": total_return_pct,
            "sharpe_ratio": sharpe_sym,
            "max_drawdown_pct": max_dd_sym,
            "win_rate_pct": win_rate_sym,
            "trades": trades,
            "total_trades": len(trades),
            "max_shares_held": st["max_shares"],
            "strategy": (
                spec_by_sym.get(sym, {}).get("fixed_strategy")
                or ("sentiment_switching" if spec_by_sym.get(sym, {}).get("routing") == "sentiment" else "sma_crossover")
            ),
            "strategy_switches": st["strategy_switches"],
            "interval": p["interval"],
            "ohlcv": ohlcv_out,
            "equity_curve": equity_curve_sym,
        })
        total_trades += len(trades)
        for t in trades:
            v = t.get("pnl")
            if v is None:
                continue
            closed += 1
            if float(v) > 0:
                wins += 1

    # Equity curve / metrics on the portfolio series.
    equity_index = [t[0] for t in portfolio_curve]
    equity_values = [t[1] for t in portfolio_curve]
    equity_series = pd.Series(equity_values, index=pd.Index(equity_index))
    metrics = _calculate_metrics(equity_series, [t for st in state.values() for t in st["trades"]], initial_capital, bars_per_year)
    # Override aggregate count/winrate to match per-symbol totals.
    metrics["total_trades"] = total_trades
    metrics["win_rate_pct"] = round((wins / closed * 100.0) if closed else 0.0, 2)
    metrics["symbols_run"] = len(prepared)
    metrics["symbols_failed"] = len(errors)
    metrics["final_value"] = round(final_value, 2)
    metrics["total_return_pct"] = round(
        ((final_value - initial_capital) / initial_capital * 100.0) if initial_capital > 0 else 0.0,
        4,
    )

    equity_curve = [
        {"date": _fmt_ts(d), "value": round(v, 2)}
        for d, v in zip(equity_index, equity_values)
    ]

    return {
        "initial_capital": initial_capital,
        "final_value": round(final_value, 2),
        "pool_final": round(pool, 2),
        "metrics": metrics,
        "equity_curve": equity_curve,
        "per_symbol": per_symbol,
        "errors": errors,
    }
