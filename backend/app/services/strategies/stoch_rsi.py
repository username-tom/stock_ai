"""Stochastic RSI strategy.

StochRSI applies the Stochastic formula to RSI values instead of price,
producing an oscillator that is far more sensitive than either indicator alone.
It fires signals multiple times per session on 1-minute bars, making it ideal
for very short scalp trades and SHORT / STRONG SHORT positions.

Signal logic:
  BUY  when StochRSI crosses ABOVE the oversold threshold (k_prev < oversold).
  SELL when StochRSI crosses BELOW the overbought threshold (k_prev > overbought).
"""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class StochRSIStrategy(BaseStrategy):
    name = "stoch_rsi"
    description = (
        "Applies the stochastic formula to RSI values for ultra-sensitive "
        "oscillator signals; ideal for short-position scalping on intraday bars."
    )

    def __init__(
        self,
        rsi_period: int = 14,
        stoch_period: int = 14,
        d_period: int = 3,
        oversold: float = 20.0,
        overbought: float = 80.0,
        **kwargs,
    ):
        super().__init__(
            rsi_period=rsi_period, stoch_period=stoch_period,
            d_period=d_period, oversold=oversold, overbought=overbought,
            **kwargs,
        )
        self.rsi_period   = max(2, int(rsi_period))
        self.stoch_period = max(2, int(stoch_period))
        self.d_period     = max(1, int(d_period))
        self.oversold     = float(oversold)
        self.overbought   = float(overbought)

    @classmethod
    def get_default_params(cls) -> dict:
        return {
            "rsi_period": 14,
            "stoch_period": 14,
            "d_period": 3,
            "oversold": 20.0,
            "overbought": 80.0,
        }

    @staticmethod
    def _rsi(series: pd.Series, period: int) -> pd.Series:
        delta    = series.diff()
        gain     = delta.clip(lower=0)
        loss     = -delta.clip(upper=0)
        avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
        avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
        rs       = avg_gain / avg_loss.replace(0, float("inf"))
        return 100.0 - (100.0 / (1.0 + rs))

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()

        rsi = self._rsi(df["Close"], self.rsi_period)

        lowest  = rsi.rolling(self.stoch_period).min()
        highest = rsi.rolling(self.stoch_period).max()
        denom   = (highest - lowest).replace(0.0, float("nan"))
        stoch_k = 100.0 * (rsi - lowest) / denom
        stoch_d = stoch_k.rolling(self.d_period).mean()

        df["rsi"]     = rsi
        df["stochrsi_k"] = stoch_k
        df["stochrsi_d"] = stoch_d

        k_prev = stoch_k.shift(1)
        d_prev = stoch_d.shift(1)

        bullish = (stoch_k > stoch_d) & (k_prev <= d_prev) & (k_prev < self.oversold)
        bearish = (stoch_k < stoch_d) & (k_prev >= d_prev) & (k_prev > self.overbought)

        df["signal"] = 0
        df.loc[bullish, "signal"] = 1
        df.loc[bearish, "signal"] = -1

        df["position"] = df["signal"].copy()
        return df
