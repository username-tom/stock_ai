"""Core backtesting engine – runs a strategy against historical OHLCV data."""
from __future__ import annotations

import math
import numpy as np
import pandas as pd
from typing import Any

from app.services.data_provider import DataSource, fetch_ohlcv
from app.services.strategies import get_strategy


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
) -> dict[str, Any]:
    """Calculate performance metrics from an equity curve."""
    final_value = float(equity.iloc[-1])
    total_return_pct = (final_value - initial_capital) / initial_capital * 100

    # Annualised return (252 = standard number of US trading days per year)
    n_years = len(equity) / 252
    if n_years > 0 and final_value > 0:
        annualized_return_pct = (
            (final_value / initial_capital) ** (1 / n_years) - 1
        ) * 100
    else:
        annualized_return_pct = 0.0

    # Sharpe ratio (assuming risk-free rate = 0)
    daily_returns = equity.pct_change().dropna()
    if len(daily_returns) > 1 and daily_returns.std() > 0:
        sharpe_ratio = float(
            (daily_returns.mean() / daily_returns.std()) * math.sqrt(252)
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

    Returns a dict with:
      - metrics (performance summary)
      - equity_curve (list of {date, value})
      - trades (list of executed round-trip trades)
      - ohlcv (price data for charting)
    """
    df = fetch_ohlcv(symbol, start_date, end_date, source=data_source)

    # stop_loss_pct is a universal safeguard param (0 = disabled)
    _raw_slp = strategy_params.pop("stop_loss_pct", 0.0)
    stop_loss_pct = float(_raw_slp) if str(_raw_slp).strip() != "" else 0.0

    if script_code is not None:
        from app.services.script_executor import execute_script
        df = execute_script(script_code, df, **strategy_params)
        # Derive position column if the script didn't add one
        if "position" not in df.columns:
            df = _derive_position(df)
    else:
        strategy = get_strategy(strategy_type, **strategy_params)
        df = strategy.generate_signals(df)

    cash = initial_capital
    shares = 0.0
    trades: list[dict] = []
    equity_values: list[float] = []
    entry_price: float | None = None
    entry_date: str | None = None

    stop_loss_mult = (1.0 - stop_loss_pct / 100.0) if stop_loss_pct > 0 else None

    for date, row in df.iterrows():
        price = float(row["Close"])
        position_change = float(row.get("position", 0))

        # Universal stop-loss safeguard (fires before strategy signals)
        if (
            stop_loss_mult is not None
            and shares > 0
            and entry_price is not None
            and price <= entry_price * stop_loss_mult
        ):
            proceeds = shares * price * (1 - commission)
            pnl = proceeds - (shares * entry_price * (1 + commission))
            trades.append(
                {
                    "entry_date": entry_date,
                    "exit_date": str(date.date()),
                    "side": "BUY",
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(price, 4),
                    "quantity": shares,
                    "pnl": round(pnl, 2),
                    "exit_reason": "stop_loss",
                }
            )
            cash += proceeds
            shares = 0.0
            entry_price = None
            entry_date = None
            portfolio_value = cash
            equity_values.append(portfolio_value)
            continue

        if position_change > 0 and shares == 0:
            # BUY
            shares_to_buy = math.floor(cash / (price * (1 + commission)))
            if shares_to_buy > 0:
                cost = shares_to_buy * price * (1 + commission)
                cash -= cost
                shares = shares_to_buy
                entry_price = price
                entry_date = str(date.date())

        elif position_change < 0 and shares > 0:
            # SELL
            proceeds = shares * price * (1 - commission)
            pnl = proceeds - (shares * entry_price * (1 + commission))
            exit_reason = str(row.get("signal_source", "")) or "strategy_exit"
            trades.append(
                {
                    "entry_date": entry_date,
                    "exit_date": str(date.date()),
                    "side": "BUY",
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(price, 4),
                    "quantity": shares,
                    "pnl": round(pnl, 2),
                    "exit_reason": exit_reason,
                }
            )
            cash += proceeds
            shares = 0.0
            entry_price = None
            entry_date = None

        portfolio_value = cash + shares * price
        equity_values.append(portfolio_value)

    final_shares = shares
    final_cash = cash
    final_entry_price = entry_price

    equity_series = pd.Series(equity_values, index=df.index)
    metrics = _calculate_metrics(equity_series, trades, initial_capital)

    equity_curve = [
        {"date": str(d.date()), "value": round(v, 2)}
        for d, v in zip(df.index, equity_values)
    ]

    ohlcv = [
        {
            "date": str(d.date()),
            "open": round(float(r["Open"]), 4),
            "high": round(float(r["High"]), 4),
            "low": round(float(r["Low"]), 4),
            "close": round(float(r["Close"]), 4),
            "volume": int(r["Volume"]),
            "signal": int(r.get("signal", 0)),
        }
        for d, r in df.iterrows()
    ]

    # Attach indicator values
    indicator_keys = [
        k for k in df.columns
        if k not in {"Open", "High", "Low", "Close", "Volume", "signal", "position"}
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
    }
