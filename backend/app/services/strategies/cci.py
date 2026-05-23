"""CCI (Commodity Channel Index) strategy.

CCI measures the deviation of price from its statistical mean.  Values above
+100 indicate overbought conditions; below -100 indicate oversold.  With a
short period the indicator cycles rapidly, generating frequent entries and exits
well-suited to intraday scalping and bearish / short sentiment buckets.

Signal logic:
  BUY  when CCI crosses ABOVE the oversold level (crosses up through -oversold).
  SELL when CCI crosses BELOW the overbought level (crosses down through +overbought).
"""
import pandas as pd
from app.services.strategies.base import BaseStrategy


class CCIStrategy(BaseStrategy):
    name = "cci"
    description = (
        "Commodity Channel Index oscillator: buys when CCI crosses up from oversold "
        "and sells when CCI crosses down from overbought. "
        "Short periods produce high-frequency scalp signals."
    )

    def __init__(
        self,
        period: int = 14,
        oversold: float = -100.0,
        overbought: float = 100.0,
        **kwargs,
    ):
        super().__init__(period=period, oversold=oversold, overbought=overbought, **kwargs)
        self.period     = max(2, int(period))
        self.oversold   = float(oversold)
        self.overbought = float(overbought)

    @classmethod
    def get_default_params(cls) -> dict:
        return {"period": 14, "oversold": -100.0, "overbought": 100.0}

    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()

        typical_price = (df["High"] + df["Low"] + df["Close"]) / 3.0
        sma  = typical_price.rolling(self.period).mean()
        mad  = typical_price.rolling(self.period).apply(
            lambda x: (x - x.mean()).abs().mean(), raw=True
        )
        cci  = (typical_price - sma) / (0.015 * mad.replace(0, float("nan")))

        df["cci"] = cci

        cci_prev = cci.shift(1)

        buy_signal  = (cci >= self.oversold)   & (cci_prev < self.oversold)
        sell_signal = (cci <= self.overbought)  & (cci_prev > self.overbought)

        df["signal"] = 0
        df.loc[buy_signal,  "signal"] = 1
        df.loc[sell_signal, "signal"] = -1

        df["position"] = df["signal"].copy()
        return df
