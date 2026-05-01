"""MACD (Moving Average Convergence Divergence) trend-following strategy."""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class MACDStrategy(BaseStrategy):
    name = "macd"
    description = (
        "Generates a buy signal when the MACD line crosses above the signal line "
        "and a sell signal when it crosses below."
    )

    def __init__(self, fast_period: int = 12, slow_period: int = 26,
                 signal_period: int = 9, **kwargs):
        super().__init__(fast_period=fast_period, slow_period=slow_period,
                         signal_period=signal_period, **kwargs)
        self.fast_period = int(fast_period)
        self.slow_period = int(slow_period)
        self.signal_period = int(signal_period)

    @classmethod
    def get_default_params(cls) -> dict:
        return {"fast_period": 12, "slow_period": 26, "signal_period": 9}

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        ema_fast = df["Close"].ewm(span=self.fast_period, adjust=False).mean()
        ema_slow = df["Close"].ewm(span=self.slow_period, adjust=False).mean()
        df["macd"] = ema_fast - ema_slow
        df["macd_signal"] = df["macd"].ewm(span=self.signal_period, adjust=False).mean()
        df["macd_hist"] = df["macd"] - df["macd_signal"]

        df["signal"] = 0
        df.loc[df["macd"] > df["macd_signal"], "signal"] = 1
        df.loc[df["macd"] < df["macd_signal"], "signal"] = -1

        df["position"] = df["signal"].diff()
        df.loc[df["signal"].shift(1) == df["signal"], "position"] = 0
        df["position"] = df["position"].fillna(0)

        return df
