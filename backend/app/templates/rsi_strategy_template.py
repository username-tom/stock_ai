"""
RSI Strategy Template

This template replicates the RSI mean-reversion strategy using custom script format.
Buys when RSI drops below oversold level, sells when RSI rises above overbought level.
"""

import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {
        "period": 14,
        "oversold": 30.0,
        "overbought": 70.0
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    RSI Mean Reversion Strategy
    
    Parameters:
    - period: RSI calculation period (default: 14)
    - oversold: Oversold threshold for buy signals (default: 30)
    - overbought: Overbought threshold for sell signals (default: 70)
    
    Signal logic:
    - Buy (+1) when RSI drops below oversold level
    - Sell (-1) when RSI rises above overbought level
    - Hold (0) otherwise
    """
    df = df.copy()
    
    # Extract parameters with defaults
    period = int(params.get("period", 14))
    oversold = float(params.get("oversold", 30.0))
    overbought = float(params.get("overbought", 70.0))
    
    # Calculate RSI
    def calculate_rsi(series: pd.Series, period: int) -> pd.Series:
        delta = series.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        
        # Use exponential weighted moving average
        avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
        avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
        
        # Avoid division by zero
        rs = avg_gain / avg_loss.replace(0, float("inf"))
        rsi = 100 - (100 / (1 + rs))
        return rsi
    
    df["rsi"] = calculate_rsi(df["Close"], period)
    
    # Generate signals based on RSI levels
    df["signal"] = 0
    df.loc[df["rsi"] < oversold, "signal"] = 1   # Buy when oversold
    df.loc[df["rsi"] > overbought, "signal"] = -1  # Sell when overbought
    
    # Only trigger on level crossings to avoid multiple signals
    df["prev_signal"] = df["signal"].shift(1).fillna(0)
    df["signal_change"] = (df["signal"] != df["prev_signal"]) & (df["signal"] != 0)
    
    # Set signal to 0 where there's no new crossing
    df.loc[~df["signal_change"], "signal"] = 0
    
    # Clean up temporary columns
    df = df.drop(["prev_signal", "signal_change"], axis=1)
    
    return df