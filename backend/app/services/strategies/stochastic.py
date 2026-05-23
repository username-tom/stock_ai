"""Stochastic Oscillator (%K/%D crossover) strategy.

High-frequency oscillator well-suited to short bearish positions.
Short periods (e.g. k_period=5) generate signals much more frequently
than RSI or MACD and are therefore a natural fit for the SHORT /
STRONG SHORT AI-tag slots or the 'crash'/'bearish' sentiment buckets.

Signal logic:
  BUY  when %K crosses ABOVE %D from the oversold zone (%K_prev < oversold).
  SELL when %K crosses BELOW %D from the overbought zone (%K_prev > overbought).
"""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class StochasticStrategy(BaseStrategy):
    name = "stochastic"
    description = (
        "High-frequency stochastic oscillator: buys on %K/%D bullish crossover from "
        "oversold territory and sells on bearish crossover from overbought territory."
    )

    def __init__(
        self,
        k_period: int = 5,
        d_period: int = 3,
        oversold: float = 20.0,
        overbought: float = 80.0,
        **kwargs,
    ):
        super().__init__(
            k_period=k_period, d_period=d_period,
            oversold=oversold, overbought=overbought,
            **kwargs,
        )
        self.k_period = max(2, int(k_period))
        self.d_period = max(1, int(d_period))
        self.oversold = float(oversold)
        self.overbought = float(overbought)

    @classmethod
    def get_default_params(cls) -> dict:
        return {"k_period": 5, "d_period": 3, "oversold": 20.0, "overbought": 80.0}

    @staticmethod
    def _stoch(high: pd.Series, low: pd.Series, close: pd.Series,
               k_period: int, d_period: int):
        lowest  = low.rolling(k_period).min()
        highest = high.rolling(k_period).max()
        denom   = (highest - lowest).replace(0.0, float("nan"))
        k = 100.0 * (close - lowest) / denom
        d = k.rolling(d_period).mean()
        return k, d

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        k, d = self._stoch(df["High"], df["Low"], df["Close"],
                           self.k_period, self.d_period)
        df["stoch_k"] = k
        df["stoch_d"] = d

        k_prev = k.shift(1)
        d_prev = d.shift(1)

        bullish_cross = (k > d) & (k_prev <= d_prev) & (k_prev < self.oversold)
        bearish_cross = (k < d) & (k_prev >= d_prev) & (k_prev > self.overbought)

        df["signal"] = 0
        df.loc[bullish_cross, "signal"] = 1
        df.loc[bearish_cross, "signal"] = -1

        df["position"] = df["signal"].copy()
        return df
