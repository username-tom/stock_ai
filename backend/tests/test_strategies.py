"""Unit tests for trading strategies."""
import pytest
import pandas as pd
import numpy as np

from app.services.strategies import get_strategy, list_strategies, STRATEGY_MAP
from app.services.strategies.moving_avg import MovingAverageCrossover
from app.services.strategies.rsi import RSIStrategy
from app.services.strategies.bollinger import BollingerBandsStrategy
from app.services.strategies.macd import MACDStrategy


def _make_ohlcv(n=200, seed=42) -> pd.DataFrame:
    """Generate synthetic OHLCV DataFrame."""
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
# Strategy registry
# ------------------------------------------------------------------ #

def test_list_strategies():
    strategies = list_strategies()
    assert len(strategies) == 4
    types = {s["type"] for s in strategies}
    assert types == {"sma_crossover", "rsi", "bollinger_bands", "macd"}


def test_get_strategy_unknown():
    with pytest.raises(ValueError, match="Unknown strategy"):
        get_strategy("unknown_xyz")


# ------------------------------------------------------------------ #
# Moving Average Crossover
# ------------------------------------------------------------------ #

class TestSMACrossover:
    def test_signal_column_exists(self):
        df = _make_ohlcv()
        strategy = MovingAverageCrossover(fast_period=5, slow_period=20)
        result = strategy.generate_signals(df)
        assert "signal" in result.columns
        assert "position" in result.columns

    def test_signal_values_are_valid(self):
        df = _make_ohlcv()
        strategy = MovingAverageCrossover(fast_period=5, slow_period=20)
        result = strategy.generate_signals(df)
        assert set(result["signal"].unique()).issubset({-1, 0, 1})

    def test_ema_variant(self):
        df = _make_ohlcv()
        strategy = MovingAverageCrossover(fast_period=5, slow_period=20, ma_type="EMA")
        result = strategy.generate_signals(df)
        assert "fast_ma" in result.columns
        assert "slow_ma" in result.columns

    def test_default_params(self):
        params = MovingAverageCrossover.get_default_params()
        assert params["fast_period"] == 10
        assert params["slow_period"] == 30

    def test_get_strategy_factory(self):
        s = get_strategy("sma_crossover", fast_period=5, slow_period=20)
        assert isinstance(s, MovingAverageCrossover)
        assert s.fast_period == 5
        assert s.slow_period == 20


# ------------------------------------------------------------------ #
# RSI Strategy
# ------------------------------------------------------------------ #

class TestRSIStrategy:
    def test_rsi_column_exists(self):
        df = _make_ohlcv()
        strategy = RSIStrategy(period=14, oversold=30, overbought=70)
        result = strategy.generate_signals(df)
        assert "rsi" in result.columns

    def test_rsi_bounds(self):
        df = _make_ohlcv(n=500)
        strategy = RSIStrategy(period=14)
        result = strategy.generate_signals(df)
        valid = result["rsi"].dropna()
        assert (valid >= 0).all() and (valid <= 100).all()

    def test_signals_produced(self):
        df = _make_ohlcv(n=500)
        strategy = RSIStrategy(period=14, oversold=40, overbought=60)
        result = strategy.generate_signals(df)
        assert result["signal"].abs().sum() > 0

    def test_default_params(self):
        params = RSIStrategy.get_default_params()
        assert params["period"] == 14


# ------------------------------------------------------------------ #
# Bollinger Bands Strategy
# ------------------------------------------------------------------ #

class TestBollingerBands:
    def test_band_columns_exist(self):
        df = _make_ohlcv()
        strategy = BollingerBandsStrategy(period=20, std_dev=2.0)
        result = strategy.generate_signals(df)
        assert "upper" in result.columns
        assert "lower" in result.columns
        assert "mid" in result.columns

    def test_upper_above_lower(self):
        df = _make_ohlcv(n=300)
        strategy = BollingerBandsStrategy(period=20, std_dev=2.0)
        result = strategy.generate_signals(df).dropna()
        assert (result["upper"] >= result["lower"]).all()

    def test_default_params(self):
        params = BollingerBandsStrategy.get_default_params()
        assert params["period"] == 20
        assert params["std_dev"] == 2.0


# ------------------------------------------------------------------ #
# MACD Strategy
# ------------------------------------------------------------------ #

class TestMACDStrategy:
    def test_macd_columns_exist(self):
        df = _make_ohlcv()
        strategy = MACDStrategy(fast_period=12, slow_period=26, signal_period=9)
        result = strategy.generate_signals(df)
        assert "macd" in result.columns
        assert "macd_signal" in result.columns
        assert "macd_hist" in result.columns

    def test_signal_values_are_valid(self):
        df = _make_ohlcv()
        strategy = MACDStrategy()
        result = strategy.generate_signals(df)
        assert set(result["signal"].unique()).issubset({-1, 0, 1})

    def test_signals_produced(self):
        df = _make_ohlcv(n=300)
        strategy = MACDStrategy()
        result = strategy.generate_signals(df)
        assert result["signal"].abs().sum() > 0

    def test_default_params(self):
        params = MACDStrategy.get_default_params()
        assert params["fast_period"] == 12
        assert params["slow_period"] == 26
        assert params["signal_period"] == 9

    def test_get_strategy_factory(self):
        s = get_strategy("macd", fast_period=12, slow_period=26, signal_period=9)
        assert isinstance(s, MACDStrategy)
        assert s.fast_period == 12
        assert s.slow_period == 26
        assert s.signal_period == 9
