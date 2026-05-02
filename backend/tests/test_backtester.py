"""Unit tests for the backtesting engine (offline – no network)."""
from __future__ import annotations

import pandas as pd
import numpy as np
import pytest
from unittest.mock import patch, MagicMock

from app.services.backtester import _calculate_metrics, run_backtest


def _make_ohlcv(n=300, seed=7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    df = pd.DataFrame(
        {
            "Open": close * (1 - rng.uniform(0, 0.01, n)),
            "High": close * (1 + rng.uniform(0, 0.02, n)),
            "Low": close * (1 - rng.uniform(0, 0.02, n)),
            "Close": close,
            "Volume": rng.integers(100_000, 10_000_000, n),
        },
        index=pd.date_range("2022-01-01", periods=n, freq="B"),
    )
    return df


# ------------------------------------------------------------------ #
# _calculate_metrics
# ------------------------------------------------------------------ #

class TestCalculateMetrics:
    def test_returns_all_keys(self):
        equity = pd.Series([10000, 10100, 10050, 10200], dtype=float)
        trades = [{"pnl": 100}, {"pnl": -50}, {"pnl": 150}]
        m = _calculate_metrics(equity, trades, 10000.0)
        assert "final_value" in m
        assert "total_return_pct" in m
        assert "annualized_return_pct" in m
        assert "sharpe_ratio" in m
        assert "max_drawdown_pct" in m
        assert "win_rate_pct" in m
        assert "total_trades" in m

    def test_perfect_win_rate(self):
        equity = pd.Series([10000.0, 11000.0])
        trades = [{"pnl": 500}, {"pnl": 500}]
        m = _calculate_metrics(equity, trades, 10000.0)
        assert m["win_rate_pct"] == 100.0

    def test_zero_trades(self):
        equity = pd.Series([10000.0] * 50)
        m = _calculate_metrics(equity, [], 10000.0)
        assert m["win_rate_pct"] == 0.0
        assert m["total_trades"] == 0

    def test_max_drawdown_negative(self):
        equity = pd.Series([10000, 9500, 9000, 9200, 8500], dtype=float)
        m = _calculate_metrics(equity, [], 10000.0)
        assert m["max_drawdown_pct"] < 0


# ------------------------------------------------------------------ #
# run_backtest (mocked data fetch)
# ------------------------------------------------------------------ #

class TestRunBacktest:
    def _fake_download(self, *args, **kwargs):
        return _make_ohlcv()

    def test_sma_crossover(self):
        with patch("app.services.backtester.fetch_ohlcv", return_value=_make_ohlcv()):
            result = run_backtest(
                symbol="AAPL",
                strategy_type="sma_crossover",
                start_date="2022-01-01",
                end_date="2022-12-31",
                initial_capital=10_000,
                fast_period=5,
                slow_period=20,
            )
        assert result["symbol"] == "AAPL"
        assert "metrics" in result
        assert "equity_curve" in result
        assert "trades" in result
        assert "ohlcv" in result
        assert len(result["equity_curve"]) > 0

    def test_rsi_strategy(self):
        with patch("app.services.backtester.fetch_ohlcv", return_value=_make_ohlcv()):
            result = run_backtest(
                symbol="MSFT",
                strategy_type="rsi",
                start_date="2022-01-01",
                end_date="2022-12-31",
                initial_capital=10_000,
                period=14,
                oversold=30,
                overbought=70,
            )
        assert result["strategy_type"] == "rsi"
        assert isinstance(result["metrics"]["total_trades"], int)

    def test_bollinger_strategy(self):
        with patch("app.services.backtester.fetch_ohlcv", return_value=_make_ohlcv()):
            result = run_backtest(
                symbol="TSLA",
                strategy_type="bollinger_bands",
                start_date="2022-01-01",
                end_date="2022-12-31",
                initial_capital=50_000,
                period=20,
                std_dev=2.0,
            )
        assert "ohlcv" in result
        first = result["ohlcv"][0]
        assert "open" in first and "close" in first

    def test_unknown_strategy_raises(self):
        with patch("app.services.backtester.fetch_ohlcv", return_value=_make_ohlcv()):
            with pytest.raises(ValueError, match="Unknown strategy"):
                run_backtest(
                    symbol="AAPL",
                    strategy_type="nonexistent",
                    start_date="2022-01-01",
                    end_date="2022-12-31",
                )

    def test_equity_curve_length_matches_ohlcv(self):
        with patch("app.services.backtester.fetch_ohlcv", return_value=_make_ohlcv()):
            result = run_backtest(
                symbol="AAPL",
                strategy_type="sma_crossover",
                start_date="2022-01-01",
                end_date="2022-12-31",
                initial_capital=10_000,
            )
        assert len(result["equity_curve"]) == len(result["ohlcv"])

    def test_data_source_included_in_result(self):
        with patch("app.services.backtester.fetch_ohlcv", return_value=_make_ohlcv()) as mock_fetch:
            result = run_backtest(
                symbol="AAPL",
                strategy_type="sma_crossover",
                start_date="2022-01-01",
                end_date="2022-12-31",
                data_source="stooq",
            )
        assert result["data_source"] == "stooq"
        mock_fetch.assert_called_once_with("AAPL", "2022-01-01", "2022-12-31", source="stooq")

    def test_default_data_source_is_yfinance(self):
        with patch("app.services.backtester.fetch_ohlcv", return_value=_make_ohlcv()) as mock_fetch:
            result = run_backtest(
                symbol="AAPL",
                strategy_type="sma_crossover",
                start_date="2022-01-01",
                end_date="2022-12-31",
            )
        assert result["data_source"] == "yfinance"
        mock_fetch.assert_called_once_with("AAPL", "2022-01-01", "2022-12-31", source="yfinance")
