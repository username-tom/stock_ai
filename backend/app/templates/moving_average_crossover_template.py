"""
Moving Average Crossover Strategy Template

This template replicates the SMA/EMA crossover strategy using custom script format.
Generates buy signals when fast MA crosses above slow MA, sell signals on reverse crossover.
"""

import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {
        "fast_period": 10,
        "slow_period": 30,
        "ma_type": "SMA"  # "SMA" or "EMA"
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Moving Average Crossover Strategy
    
    Parameters:
    - fast_period: Period for fast moving average (default: 10)
    - slow_period: Period for slow moving average (default: 30)
    - ma_type: Type of moving average - "SMA" or "EMA" (default: "SMA")
    
    Signal logic:
    - Buy (+1) when fast MA crosses above slow MA
    - Sell (-1) when fast MA crosses below slow MA
    - Hold (0) otherwise
    """
    df = df.copy()
    
    # Extract parameters with defaults
    fast_period = params.get("fast_period", 10)
    slow_period = params.get("slow_period", 30)
    ma_type = params.get("ma_type", "SMA").upper()
    
    # Calculate moving averages
    if ma_type == "EMA":
        df["fast_ma"] = df["Close"].ewm(span=fast_period, adjust=False).mean()
        df["slow_ma"] = df["Close"].ewm(span=slow_period, adjust=False).mean()
    else:  # SMA
        df["fast_ma"] = df["Close"].rolling(window=fast_period).mean()
        df["slow_ma"] = df["Close"].rolling(window=slow_period).mean()
    
    # Generate basic signals
    df["signal"] = 0
    df.loc[df["fast_ma"] > df["slow_ma"], "signal"] = 1
    df.loc[df["fast_ma"] < df["slow_ma"], "signal"] = -1
    
    # Only trigger on crossover (change in signal)
    df["prev_signal"] = df["signal"].shift(1).fillna(0)
    df["crossover"] = (df["signal"] != df["prev_signal"]) & (df["signal"] != 0)
    
    # Set signal to 0 where there's no crossover
    df.loc[~df["crossover"], "signal"] = 0
    
    # Clean up temporary columns
    df = df.drop(["prev_signal", "crossover"], axis=1)
    
    return df