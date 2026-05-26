"""Unit tests for the backtesting engine (offline – no network)."""
from __future__ import annotations

import pandas as pd
import numpy as np
import pytest
from unittest.mock import patch, MagicMock

from app.services.backtester import (
    _calculate_metrics,
    run_backtest,
    run_sandbox_portfolio_backtest,
)


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


def _make_intraday_ohlcv(n_pre=30, n_regular=390, n_post=60, seed=42) -> pd.DataFrame:
    """Simulate a full trading day: pre-market + regular + post-market 1-min bars.

    Pre-market:  04:00 – 09:29 ET  (n_pre bars)
    Regular:     09:30 – 16:00 ET  (n_regular bars, up to 390)
    Post-market: 16:00 – 20:00 ET  (n_post bars)
    """
    from zoneinfo import ZoneInfo
    rng = np.random.default_rng(seed)
    n_total = n_pre + n_regular + n_post
    close = 150 + np.cumsum(rng.normal(0, 0.05, n_total))

    pre_idx = pd.date_range("2024-01-15 04:00", periods=n_pre, freq="1min",
                            tz="America/New_York")
    reg_idx = pd.date_range("2024-01-15 09:30", periods=n_regular, freq="1min",
                            tz="America/New_York")
    post_idx = pd.date_range("2024-01-15 16:00", periods=n_post, freq="1min",
                             tz="America/New_York")
    idx = pre_idx.append(reg_idx).append(post_idx)

    df = pd.DataFrame(
        {
            "Open":   close * (1 - rng.uniform(0, 0.001, n_total)),
            "High":   close * (1 + rng.uniform(0, 0.002, n_total)),
            "Low":    close * (1 - rng.uniform(0, 0.002, n_total)),
            "Close":  close,
            "Volume": rng.integers(1_000, 100_000, n_total),
        },
        index=idx,
    )
    # Tag sessions (mirrors data_provider._tag_market_session)
    total_min = df.index.hour * 60 + df.index.minute
    df["session"] = ["pre" if t < 570 else ("post" if t >= 960 else "regular")
                     for t in total_min]
    df.attrs["interval"] = "1m"
    return df


# ------------------------------------------------------------------ #
# Day Trade backtest
# ------------------------------------------------------------------ #

class TestDayTradeBacktest:
    """Tests for the day_trade=True code path in run_backtest."""

    def test_day_trade_fetches_intraday(self):
        """With day_trade=True, fetch_ohlcv_intraday is called, not fetch_ohlcv."""
        intraday_df = _make_intraday_ohlcv()
        with (
            patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df) as mock_intra,
            patch("app.services.backtester.fetch_ohlcv") as mock_daily,
        ):
            result = run_backtest(
                symbol="SPY",
                strategy_type="sma_crossover",
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000,
                day_trade=True,
            )
        mock_intra.assert_called_once_with("SPY", "2024-01-15", "2024-01-15", source="yfinance")
        mock_daily.assert_not_called()
        assert result["day_trade"] is True

    def test_day_trade_result_contains_interval(self):
        """Result should expose the interval used (e.g. '1m')."""
        intraday_df = _make_intraday_ohlcv()
        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY",
                strategy_type="sma_crossover",
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000,
                day_trade=True,
            )
        assert result["interval"] == "1m"

    def test_day_trade_equity_curve_length_matches_ohlcv(self):
        intraday_df = _make_intraday_ohlcv()
        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY",
                strategy_type="sma_crossover",
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000,
                day_trade=True,
            )
        assert len(result["equity_curve"]) == len(result["ohlcv"]) == len(intraday_df)

    def test_day_trade_ohlcv_dates_include_time(self):
        """Intraday OHLCV entries should carry timestamps (not just date strings)."""
        intraday_df = _make_intraday_ohlcv()
        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY",
                strategy_type="sma_crossover",
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000,
                day_trade=True,
            )
        # At least some entries should include a time component (HH:MM)
        dates_with_time = [e["date"] for e in result["ohlcv"] if ":" in e["date"]]
        assert len(dates_with_time) > 0

    def test_day_trade_false_uses_daily_fetch(self):
        """day_trade=False (default) must still use fetch_ohlcv."""
        daily_df = _make_ohlcv()
        with (
            patch("app.services.backtester.fetch_ohlcv", return_value=daily_df) as mock_daily,
            patch("app.services.backtester.fetch_ohlcv_intraday") as mock_intra,
        ):
            result = run_backtest(
                symbol="AAPL",
                strategy_type="sma_crossover",
                start_date="2022-01-01",
                end_date="2022-12-31",
                initial_capital=10_000,
            )
        mock_daily.assert_called_once()
        mock_intra.assert_not_called()
        assert result["day_trade"] is False

    def test_day_trade_with_day_trade_template_script(self):
        """day_trade_template.py should run end-to-end against intraday data."""
        from pathlib import Path
        tmpl_path = (
            Path(__file__).resolve().parents[1]
            / "app" / "templates" / "day_trade_template.py"
        )
        script_code = tmpl_path.read_text(encoding="utf-8")

        # Use multi-day intraday data with enough bars for indicators to warm up
        rng = np.random.default_rng(99)
        n = 800  # ~2 days of 1m bars
        close = 200 + np.cumsum(rng.normal(0, 0.1, n))
        idx = pd.date_range("2024-01-10 09:30", periods=n, freq="1min", tz="America/New_York")
        intraday_df = pd.DataFrame(
            {
                "Open": close * (1 - rng.uniform(0, 0.001, n)),
                "High": close * (1 + rng.uniform(0.001, 0.003, n)),
                "Low": close * (1 - rng.uniform(0.001, 0.003, n)),
                "Close": close,
                "Volume": rng.integers(5_000, 500_000, n),
            },
            index=idx,
        )
        intraday_df.attrs["interval"] = "1m"

        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="QQQ",
                strategy_type="template:day_trade_template.py",
                start_date="2024-01-10",
                end_date="2024-01-11",
                initial_capital=25_000,
                commission=0.001,
                script_code=script_code,
                day_trade=True,
            )

        assert result["symbol"] == "QQQ"
        assert result["day_trade"] is True
        assert result["interval"] == "1m"
        assert "metrics" in result
        assert isinstance(result["metrics"]["total_trades"], int)
        assert len(result["equity_curve"]) == n
        assert len(result["ohlcv"]) == n
        # Indicator columns from the template should be attached to ohlcv
        first = result["ohlcv"][0]
        assert "open" in first and "close" in first and "signal" in first

    def test_day_trade_template_indicators_in_ohlcv(self):
        """day_trade_template should expose ema_fast, rsi, vwap etc. in ohlcv."""
        from pathlib import Path
        tmpl_path = (
            Path(__file__).resolve().parents[1]
            / "app" / "templates" / "day_trade_template.py"
        )
        script_code = tmpl_path.read_text(encoding="utf-8")

        rng = np.random.default_rng(7)
        n = 600
        close = 100 + np.cumsum(rng.normal(0, 0.08, n))
        idx = pd.date_range("2024-01-08 09:30", periods=n, freq="1min", tz="America/New_York")
        intraday_df = pd.DataFrame(
            {
                "Open": close * (1 - rng.uniform(0, 0.001, n)),
                "High": close * (1 + rng.uniform(0.001, 0.003, n)),
                "Low": close * (1 - rng.uniform(0.001, 0.003, n)),
                "Close": close,
                "Volume": rng.integers(10_000, 1_000_000, n),
            },
            index=idx,
        )
        intraday_df.attrs["interval"] = "1m"

        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="TSLA",
                strategy_type="template:day_trade_template.py",
                start_date="2024-01-08",
                end_date="2024-01-08",
                initial_capital=10_000,
                script_code=script_code,
                day_trade=True,
            )

        # After warmup bars, indicators should be present (non-None)
        warmed_up = result["ohlcv"][50:]
        assert any(bar.get("ema_fast") is not None for bar in warmed_up)
        assert any(bar.get("rsi") is not None for bar in warmed_up)
        assert any(bar.get("vwap") is not None for bar in warmed_up)


# ------------------------------------------------------------------ #
# Day Trade session-gating
# ------------------------------------------------------------------ #

class TestDayTradeSessionGating:
    """Verify pre/post-market restrictions and EOD flat rule."""

    def test_session_column_in_ohlcv(self):
        """Each OHLCV bar must carry a 'session' field when day_trade=True."""
        intraday_df = _make_intraday_ohlcv()
        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY", strategy_type="sma_crossover",
                start_date="2024-01-15", end_date="2024-01-15",
                initial_capital=10_000, day_trade=True,
            )
        assert all("session" in bar for bar in result["ohlcv"])
        sessions = {bar["session"] for bar in result["ohlcv"]}
        assert sessions <= {"pre", "regular", "post"}

    def test_no_entry_during_premarket(self):
        """A buy signal on a pre-market bar must not open a position at that bar."""
        intraday_df = _make_intraday_ohlcv()
        # Inject a buy signal on the very first (pre-market) bar only
        intraday_df["signal"] = 0
        intraday_df.iloc[0, intraday_df.columns.get_loc("signal")] = 1
        intraday_df["position"] = intraday_df["signal"]

        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY", strategy_type="sma_crossover",
                start_date="2024-01-15", end_date="2024-01-15",
                initial_capital=10_000, day_trade=True,
            )
        # Any trade that occurred must have entered at a regular-session bar (09:30+)
        for trade in result["trades"]:
            entry_time = trade["entry_date"]
            # entry_date includes time → check hour >= 09:30
            if "T" in entry_time or " " in entry_time:
                from datetime import datetime
                dt = datetime.fromisoformat(entry_time.replace(" ", "T").split("+")[0].split("-0")[0])
                assert (dt.hour, dt.minute) >= (9, 30), (
                    f"Trade entered outside regular session: {entry_time}"
                )

    def test_no_entry_during_postmarket(self):
        """A buy signal on a post-market bar must not open a position at all that day."""
        intraday_df = _make_intraday_ohlcv()
        n_pre = 30
        n_regular = 390
        # Signal only on first post-market bar
        post_idx = n_pre + n_regular
        intraday_df["signal"] = 0
        intraday_df["position"] = 0
        intraday_df.iloc[post_idx, intraday_df.columns.get_loc("signal")] = 1
        intraday_df.iloc[post_idx, intraday_df.columns.get_loc("position")] = 1

        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY", strategy_type="sma_crossover",
                start_date="2024-01-15", end_date="2024-01-15",
                initial_capital=10_000, day_trade=True,
            )
        # No position should have been opened (post-market signal has no next open to carry to)
        assert result["metrics"]["total_trades"] == 0

    def test_eod_force_close(self):
        """An open position must be closed at the last regular bar of the day."""
        intraday_df = _make_intraday_ohlcv()
        n_pre = 30
        # Buy at the first regular bar, never sell
        reg_start = n_pre
        intraday_df["signal"] = 0
        intraday_df["position"] = 0
        intraday_df.iloc[reg_start, intraday_df.columns.get_loc("signal")] = 1
        intraday_df.iloc[reg_start, intraday_df.columns.get_loc("position")] = 1

        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY", strategy_type="sma_crossover",
                start_date="2024-01-15", end_date="2024-01-15",
                initial_capital=10_000, day_trade=True,
            )
        # Should have exactly one round-trip (entry + EOD close)
        assert result["metrics"]["total_trades"] == 1
        assert result["trades"][0]["exit_reason"] == "eod_close"
        # Should be flat at end of day (final_shares == 0)
        assert result["final_shares"] == 0.0

    def test_premarket_signal_carries_to_open(self):
        """A buy signal fired in pre-market should execute at the first regular bar."""
        intraday_df = _make_intraday_ohlcv()
        n_pre = 30
        # Signal only during pre-market, nothing else
        intraday_df["signal"] = 0
        intraday_df["position"] = 0
        intraday_df.iloc[5, intraday_df.columns.get_loc("signal")] = 1
        intraday_df.iloc[5, intraday_df.columns.get_loc("position")] = 1

        with patch("app.services.backtester.fetch_ohlcv_intraday", return_value=intraday_df):
            result = run_backtest(
                symbol="SPY", strategy_type="sma_crossover",
                start_date="2024-01-15", end_date="2024-01-15",
                initial_capital=10_000, day_trade=True,
            )
        # The pending buy should have been executed at market open → EOD close
        assert result["metrics"]["total_trades"] == 1
        assert result["trades"][0]["exit_reason"] == "eod_close"
        # Entry must be at 09:30 (first regular bar)
        entry = result["trades"][0]["entry_date"]
        assert "09:30" in entry


class TestSandboxPortfolioEodLiquidation:
    def test_eod_liquidation_is_forced_even_with_zero_sell_fill_rate(self):
        idx = pd.DatetimeIndex([
            pd.Timestamp("2024-01-15 15:58:00", tz="America/New_York"),
            pd.Timestamp("2024-01-15 15:59:00", tz="America/New_York"),
            pd.Timestamp("2024-01-15 16:00:00", tz="America/New_York"),
        ])
        df = pd.DataFrame(
            {
                "Open": [100.0, 100.2, 101.0],
                "High": [100.5, 100.7, 101.5],
                "Low": [99.5, 99.8, 100.5],
                "Close": [100.0, 100.2, 101.0],
                "Volume": [1000, 1000, 1000],
                "session": ["regular", "regular", "regular"],
            },
            index=idx,
        )
        df.attrs["interval"] = "1m"
        prepared_symbol = {
            "symbol": "TXN",
            "df": df,
            "interval": "1m",
            "buckets": pd.Series(["neutral", "neutral", "neutral"], index=idx),
            "active_strategy": pd.Series(["sma_crossover", "sma_crossover", "sma_crossover"], index=idx),
            "signals_by_strat": {
                "sma_crossover": pd.Series([1.0, 0.0, 0.0], index=idx),
            },
            "eod_sell_bars": {idx[2]},
            "last_regular_bar": {idx[2]},
        }

        with patch("app.services.backtester._prepare_symbol_for_portfolio", return_value=prepared_symbol):
            result = run_sandbox_portfolio_backtest(
                symbol_specs=[
                    {
                        "symbol": "TXN",
                        "routing": "fixed",
                        "fixed_strategy": "sma_crossover",
                        "min_alloc": 10_000.0,
                        "max_alloc": 10_000.0,
                    }
                ],
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000.0,
                commission=0.0,
                day_trade=True,
                hold_positions_overnight=False,
                eod_sell_window_minutes=1,
                sim_buy_fill_rate_pct=100.0,
                sim_sell_fill_rate_pct=0.0,
                sim_pending_duration_bars=1,
            )

        symbol_row = result["per_symbol"][0]
        assert symbol_row["total_trades"] == 1
        assert symbol_row["market_value"] == 0.0
        assert symbol_row["unrealized_pnl"] == 0.0
        assert symbol_row["trades"][0]["exit_reason"] == "eod_liquidation"


class TestSandboxPortfolioPendingFills:
    def test_pending_buy_only_fills_when_requested_price_is_inside_bar_range(self):
        idx = pd.DatetimeIndex([
            pd.Timestamp("2024-01-15 09:30:00", tz="America/New_York"),
            pd.Timestamp("2024-01-15 09:31:00", tz="America/New_York"),
        ])
        df = pd.DataFrame(
            {
                "Open": [100.0, 102.0],
                "High": [100.5, 102.5],
                "Low": [99.5, 101.5],
                "Close": [100.0, 102.0],
                "Volume": [10_000, 10_000],
                "session": ["regular", "regular"],
            },
            index=idx,
        )
        df.attrs["interval"] = "1m"
        prepared_symbol = {
            "symbol": "TXN",
            "df": df,
            "interval": "1m",
            "buckets": pd.Series(["neutral", "neutral"], index=idx),
            "active_strategy": pd.Series(["sma_crossover", "sma_crossover"], index=idx),
            "signals_by_strat": {
                "sma_crossover": pd.Series([1.0, 0.0], index=idx),
            },
            "eod_sell_bars": set(),
            "last_regular_bar": {idx[1]},
        }

        with patch("app.services.backtester._prepare_symbol_for_portfolio", return_value=prepared_symbol):
            result = run_sandbox_portfolio_backtest(
                symbol_specs=[
                    {
                        "symbol": "TXN",
                        "routing": "fixed",
                        "fixed_strategy": "sma_crossover",
                        "min_alloc": 10_000.0,
                        "max_alloc": 10_000.0,
                    }
                ],
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000.0,
                commission=0.0,
                day_trade=True,
                hold_positions_overnight=True,
                sim_buy_fill_rate_pct=100.0,
                sim_sell_fill_rate_pct=100.0,
                sim_pending_duration_bars=1,
                pending_price_drift_cancel_pct=200.0,
            )

        symbol_row = result["per_symbol"][0]
        assert symbol_row["total_trades"] == 0
        assert symbol_row["market_value"] == 0.0
        assert symbol_row["unrealized_pnl"] == 0.0
        assert symbol_row["pending_buy_reserved"] > 0.0

    def test_pending_buy_requires_sufficient_bar_volume(self):
        idx = pd.DatetimeIndex([
            pd.Timestamp("2024-01-15 09:30:00", tz="America/New_York"),
            pd.Timestamp("2024-01-15 09:31:00", tz="America/New_York"),
        ])
        df = pd.DataFrame(
            {
                "Open": [100.0, 100.0],
                "High": [100.5, 100.5],
                "Low": [99.5, 99.5],
                "Close": [100.0, 100.0],
                "Volume": [10_000, 50],
                "session": ["regular", "regular"],
            },
            index=idx,
        )
        df.attrs["interval"] = "1m"
        prepared_symbol = {
            "symbol": "TXN",
            "df": df,
            "interval": "1m",
            "buckets": pd.Series(["neutral", "neutral"], index=idx),
            "active_strategy": pd.Series(["sma_crossover", "sma_crossover"], index=idx),
            "signals_by_strat": {
                "sma_crossover": pd.Series([1.0, 0.0], index=idx),
            },
            "eod_sell_bars": set(),
            "last_regular_bar": {idx[1]},
        }

        with patch("app.services.backtester._prepare_symbol_for_portfolio", return_value=prepared_symbol):
            result = run_sandbox_portfolio_backtest(
                symbol_specs=[
                    {
                        "symbol": "TXN",
                        "routing": "fixed",
                        "fixed_strategy": "sma_crossover",
                        "min_alloc": 10_000.0,
                        "max_alloc": 10_000.0,
                    }
                ],
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000.0,
                commission=0.0,
                day_trade=True,
                hold_positions_overnight=True,
                sim_buy_fill_rate_pct=100.0,
                sim_sell_fill_rate_pct=100.0,
                sim_pending_duration_bars=1,
                pending_price_drift_cancel_pct=200.0,
            )

        symbol_row = result["per_symbol"][0]
        assert symbol_row["total_trades"] == 0
        assert symbol_row["market_value"] == 0.0
        assert symbol_row["unrealized_pnl"] == 0.0
        assert symbol_row["pending_buy_reserved"] > 0.0

    def test_pending_buy_cancels_when_requested_price_leaves_high_low_drift_band(self):
        idx = pd.DatetimeIndex([
            pd.Timestamp("2024-01-15 09:30:00", tz="America/New_York"),
            pd.Timestamp("2024-01-15 09:31:00", tz="America/New_York"),
        ])
        df = pd.DataFrame(
            {
                "Open": [100.0, 101.5],
                "High": [100.5, 101.8],
                "Low": [99.5, 101.2],
                "Close": [100.0, 101.5],
                "Volume": [10_000, 10_000],
                "session": ["regular", "regular"],
            },
            index=idx,
        )
        df.attrs["interval"] = "1m"
        prepared_symbol = {
            "symbol": "TXN",
            "df": df,
            "interval": "1m",
            "buckets": pd.Series(["neutral", "neutral"], index=idx),
            "active_strategy": pd.Series(["sma_crossover", "sma_crossover"], index=idx),
            "signals_by_strat": {
                "sma_crossover": pd.Series([1.0, 0.0], index=idx),
            },
            "eod_sell_bars": set(),
            "last_regular_bar": {idx[1]},
        }

        with patch("app.services.backtester._prepare_symbol_for_portfolio", return_value=prepared_symbol):
            result = run_sandbox_portfolio_backtest(
                symbol_specs=[
                    {
                        "symbol": "TXN",
                        "routing": "fixed",
                        "fixed_strategy": "sma_crossover",
                        "min_alloc": 10_000.0,
                        "max_alloc": 10_000.0,
                    }
                ],
                start_date="2024-01-15",
                end_date="2024-01-15",
                initial_capital=10_000.0,
                commission=0.0,
                day_trade=True,
                hold_positions_overnight=True,
                sim_buy_fill_rate_pct=100.0,
                sim_sell_fill_rate_pct=100.0,
                sim_pending_duration_bars=1,
                pending_price_drift_cancel_pct=10.0,
            )

        symbol_row = result["per_symbol"][0]
        assert symbol_row["total_trades"] == 0
        assert symbol_row["market_value"] == 0.0
        assert symbol_row["unrealized_pnl"] == 0.0
        assert symbol_row["pending_buy_reserved"] == 0.0
        assert symbol_row["final_value"] == pytest.approx(10_000.0)
