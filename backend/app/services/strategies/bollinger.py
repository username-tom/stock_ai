"""Bollinger Bands mean-reversion strategy."""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class BollingerBandsStrategy(BaseStrategy):
    name = "bollinger_bands"
    description = (
        "Buys when price closes below the lower Bollinger Band "
        "and sells when price closes above the upper band."
    )

    def __init__(self, period: int = 20, std_dev: float = 2.0, **kwargs):
        super().__init__(period=period, std_dev=std_dev, **kwargs)
        self.period = int(period)
        self.std_dev = float(std_dev)

    @classmethod
    def get_default_params(cls) -> dict:
        return {"period": 20, "std_dev": 2.0}

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df["mid"] = df["Close"].rolling(window=self.period).mean()
        df["std"] = df["Close"].rolling(window=self.period).std()
        df["upper"] = df["mid"] + self.std_dev * df["std"]
        df["lower"] = df["mid"] - self.std_dev * df["std"]

        df["signal"] = 0
        df.loc[df["Close"] < df["lower"], "signal"] = 1
        df.loc[df["Close"] > df["upper"], "signal"] = -1

        df["position"] = df["signal"].diff()
        df.loc[df["signal"].shift(1) == df["signal"], "position"] = 0
        df["position"] = df["position"].fillna(0)

        return df
