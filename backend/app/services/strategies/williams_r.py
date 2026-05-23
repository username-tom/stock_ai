"""Williams %R strategy.

Williams %R is a momentum oscillator ranging from -100 to 0.  Readings near 0
signal overbought conditions; readings near -100 signal oversold.  It is one
of the most responsive of the standard oscillators, making it excellent for
very short positions and bearish / short sentiment buckets.

Signal logic:
  BUY  when %R crosses UP through the oversold level (e.g. -80 → -79).
  SELL when %R crosses DOWN through the overbought level (e.g. -20 → -21).
"""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class WilliamsRStrategy(BaseStrategy):
    name = "williams_r"
    description = (
        "Williams %R oscillator: buys when %R crosses up from oversold (<= -80) "
        "and sells when it crosses down from overbought (>= -20). "
        "Very responsive — ideal for short-term and bearish positions."
    )

    def __init__(
        self,
        period: int = 14,
        oversold: float = -80.0,
        overbought: float = -20.0,
        **kwargs,
    ):
        super().__init__(period=period, oversold=oversold, overbought=overbought, **kwargs)
        self.period     = max(2, int(period))
        self.oversold   = float(oversold)
        self.overbought = float(overbought)

    @classmethod
    def get_default_params(cls) -> dict:
        return {"period": 14, "oversold": -80.0, "overbought": -20.0}

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()

        highest = df["High"].rolling(self.period).max()
        lowest  = df["Low"].rolling(self.period).min()
        denom   = (highest - lowest).replace(0.0, float("nan"))
        wr      = -100.0 * (highest - df["Close"]) / denom

        df["williams_r"] = wr

        wr_prev = wr.shift(1)

        buy_signal  = (wr >= self.oversold)   & (wr_prev < self.oversold)
        sell_signal = (wr <= self.overbought)  & (wr_prev > self.overbought)

        df["signal"] = 0
        df.loc[buy_signal,  "signal"] = 1
        df.loc[sell_signal, "signal"] = -1

        df["position"] = df["signal"].copy()
        return df
