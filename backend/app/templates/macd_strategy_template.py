"""
MACD Strategy Template

This template replicates the MACD (Moving Average Convergence Divergence) strategy using custom script format.
Generates buy signals when MACD line crosses above signal line, sell signals on reverse crossover.
"""

import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {
        "fast_period": 12,
        "slow_period": 26,
        "signal_period": 9
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    MACD (Moving Average Convergence Divergence) Strategy
    
    Parameters:
    - fast_period: Fast EMA period (default: 12)
    - slow_period: Slow EMA period (default: 26)
    - signal_period: Signal line EMA period (default: 9)
    
    Signal logic:
    - Buy (+1) when MACD line crosses above signal line
    - Sell (-1) when MACD line crosses below signal line
    - Hold (0) otherwise
    """
    df = df.copy()
    
    # Extract parameters with defaults
    fast_period = int(params.get("fast_period", 12))
    slow_period = int(params.get("slow_period", 26))
    signal_period = int(params.get("signal_period", 9))
    
    # Calculate MACD components
    ema_fast = df["Close"].ewm(span=fast_period, adjust=False).mean()
    ema_slow = df["Close"].ewm(span=slow_period, adjust=False).mean()
    
    # MACD line = Fast EMA - Slow EMA
    df["macd"] = ema_fast - ema_slow
    
    # Signal line = EMA of MACD line
    df["macd_signal"] = df["macd"].ewm(span=signal_period, adjust=False).mean()
    
    # MACD Histogram = MACD - Signal line
    df["macd_hist"] = df["macd"] - df["macd_signal"]
    
    # Generate basic signals
    df["signal"] = 0
    df.loc[df["macd"] > df["macd_signal"], "signal"] = 1   # Bullish
    df.loc[df["macd"] < df["macd_signal"], "signal"] = -1  # Bearish
    
    # Only trigger on crossover (change in signal)
    df["prev_signal"] = df["signal"].shift(1).fillna(0)
    df["crossover"] = (df["signal"] != df["prev_signal"]) & (df["signal"] != 0)
    
    # Set signal to 0 where there's no crossover
    df.loc[~df["crossover"], "signal"] = 0
    
    # Clean up temporary columns
    df = df.drop(["prev_signal", "crossover"], axis=1)
    
    return df