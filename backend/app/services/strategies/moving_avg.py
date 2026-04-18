"""Moving Average Crossover strategy (SMA or EMA)."""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class MovingAverageCrossover(BaseStrategy):
    name = "sma_crossover"
    description = (
        "Generates a buy signal when the fast moving average crosses above "
        "the slow moving average, and a sell signal on the reverse crossover."
    )

    def __init__(self, fast_period: int = 10, slow_period: int = 30,
                 ma_type: str = "SMA", **kwargs):
        super().__init__(fast_period=fast_period, slow_period=slow_period,
                         ma_type=ma_type, **kwargs)
        self.fast_period = int(fast_period)
        self.slow_period = int(slow_period)
        self.ma_type = ma_type.upper()

    @classmethod
    def get_default_params(cls) -> dict:
        return {"fast_period": 10, "slow_period": 30, "ma_type": "SMA"}

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        col = "Close"

        if self.ma_type == "EMA":
            df["fast_ma"] = df[col].ewm(span=self.fast_period, adjust=False).mean()
            df["slow_ma"] = df[col].ewm(span=self.slow_period, adjust=False).mean()
        else:
            df["fast_ma"] = df[col].rolling(window=self.fast_period).mean()
            df["slow_ma"] = df[col].rolling(window=self.slow_period).mean()

        df["signal"] = 0
        df.loc[df["fast_ma"] > df["slow_ma"], "signal"] = 1
        df.loc[df["fast_ma"] < df["slow_ma"], "signal"] = -1

        # Only trigger on crossover (change in signal)
        df["position"] = df["signal"].diff()
        df.loc[df["signal"].shift(1) == df["signal"], "position"] = 0
        df["position"] = df["position"].fillna(0)

        return df
