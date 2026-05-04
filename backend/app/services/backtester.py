"""Core backtesting engine – runs a strategy against historical OHLCV data."""
from __future__ import annotations

import math
import numpy as np
import pandas as pd
from typing import Any

from app.services.data_provider import DataSource, fetch_ohlcv, fetch_ohlcv_intraday
from app.services.strategies import get_strategy


def _fmt_ts(ts) -> str:
    """Format a timestamp as ISO string, including time component when intraday."""
    if hasattr(ts, 'time') and ts.time().hour == 0 and ts.time().minute == 0 and ts.time().second == 0:
        return str(ts.date())
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
    commission: float = 0.001,
    script_code: str | None = None,
    data_source: DataSource = "yfinance",
    day_trade: bool = False,
    **strategy_params,
) -> dict[str, Any]:
    """
    Run a full backtest.

    When *script_code* is provided the custom Python script is used to generate
    signals instead of a built-in strategy.  In this case *strategy_type* is
    still stored for labelling purposes (use ``"custom_script"``).

    The *data_source* parameter selects where OHLCV data is fetched from.
    Supported values: ``"yfinance"`` (default), ``"stooq"``, ``"ib"``.
    When ``"ib"`` is requested but IB is not connected, the engine falls back
    to ``"yfinance"`` automatically.

    When *day_trade* is ``True`` the engine fetches intraday data using the
    finest available interval (1m → 2m → 5m) and scales all annualisation
    calculations accordingly.  Note that Yahoo Finance limits 1m data to the
    last 7 days and 2m/5m to the last 60 days.

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

    # Pre-compute the last regular-session bar index for each calendar date so
    # the engine can force-close open positions at the end of each trading day.
    last_regular_bar: set = set()
    if day_trade and "session" in df.columns:
        regular_mask = df["session"] == "regular"
        regular_df = df[regular_mask]
        if not regular_df.empty:
            # Group by calendar date (in ET) and take the last bar of each day
            et_dates = regular_df.index.tz_convert("America/New_York").date
            for _date in set(et_dates):
                day_bars = regular_df[
                    [d == _date for d in regular_df.index.tz_convert("America/New_York").date]
                ]
                if not day_bars.empty:
                    last_regular_bar.add(day_bars.index[-1])

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

        # ── Day-trade: force-close at end of last regular bar of the day ──── #
        if day_trade and date in last_regular_bar and shares > 0:
            proceeds = shares * price * (1 - commission)
            pnl = proceeds - (shares * entry_price * (1 + commission))
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
                    "exit_reason": "eod_close",
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
            shares_to_buy = math.floor(cash / (price * (1 + commission)))
            if shares_to_buy > 0:
                cost = shares_to_buy * price * (1 + commission)
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
            proceeds = shares * price * (1 - commission)
            pnl = proceeds - (shares * entry_price * (1 + commission))
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
                shares_to_buy = math.floor(cash / (price * (1 + commission)))
                if shares_to_buy > 0:
                    cost = shares_to_buy * price * (1 + commission)
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
            proceeds = shares * price * (1 - commission)
            pnl = proceeds - (shares * entry_price * (1 + commission))
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
