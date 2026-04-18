"""RSI-based mean reversion strategy."""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class RSIStrategy(BaseStrategy):
    name = "rsi"
    description = (
        "Buys when RSI drops below the oversold level and sells when RSI "
        "rises above the overbought level."
    )

    def __init__(self, period: int = 14, oversold: float = 30.0,
                 overbought: float = 70.0, **kwargs):
        super().__init__(period=period, oversold=oversold,
                         overbought=overbought, **kwargs)
        self.period = int(period)
        self.oversold = float(oversold)
        self.overbought = float(overbought)

    @classmethod
    def get_default_params(cls) -> dict:
        return {"period": 14, "oversold": 30, "overbought": 70}

    @staticmethod
    def _compute_rsi(series: pd.Series, period: int) -> pd.Series:
        delta = series.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
        avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
        rs = avg_gain / avg_loss.replace(0, float("inf"))
        return 100 - (100 / (1 + rs))

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df["rsi"] = self._compute_rsi(df["Close"], self.period)

        df["signal"] = 0
        df.loc[df["rsi"] < self.oversold, "signal"] = 1
        df.loc[df["rsi"] > self.overbought, "signal"] = -1

        df["position"] = df["signal"].diff()
        df.loc[df["signal"].shift(1) == df["signal"], "position"] = 0
        df["position"] = df["position"].fillna(0)

        return df
