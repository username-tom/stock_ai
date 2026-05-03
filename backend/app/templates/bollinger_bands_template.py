"""
Bollinger Bands Strategy Template

This template replicates the Bollinger Bands mean-reversion strategy using custom script format.
Buys when price closes below lower band, sells when price closes above upper band.
"""

import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {
        "period": 20,
        "std_dev": 2.0
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Bollinger Bands Mean Reversion Strategy
    
    Parameters:
    - period: Period for moving average and standard deviation calculation (default: 20)
    - std_dev: Standard deviation multiplier for bands (default: 2.0)
    
    Signal logic:
    - Buy (+1) when price closes below lower Bollinger Band (oversold)
    - Sell (-1) when price closes above upper Bollinger Band (overbought)
    - Hold (0) otherwise
    """
    df = df.copy()
    
    # Extract parameters with defaults
    period = int(params.get("period", 20))
    std_dev = float(params.get("std_dev", 2.0))
    
    # Calculate Bollinger Bands components
    # Middle band = Simple Moving Average
    df["bb_middle"] = df["Close"].rolling(window=period).mean()
    
    # Standard deviation
    df["bb_std"] = df["Close"].rolling(window=period).std()
    
    # Upper and Lower bands
    df["bb_upper"] = df["bb_middle"] + (std_dev * df["bb_std"])
    df["bb_lower"] = df["bb_middle"] - (std_dev * df["bb_std"])
    
    # Calculate percentage position within bands (optional indicator)
    df["bb_percent"] = (df["Close"] - df["bb_lower"]) / (df["bb_upper"] - df["bb_lower"])
    
    # Generate signals based on band touches
    df["signal"] = 0
    df.loc[df["Close"] < df["bb_lower"], "signal"] = 1   # Buy when below lower band
    df.loc[df["Close"] > df["bb_upper"], "signal"] = -1  # Sell when above upper band
    
    # Only trigger on band crossings to avoid multiple signals
    df["prev_signal"] = df["signal"].shift(1).fillna(0)
    df["band_crossing"] = (df["signal"] != df["prev_signal"]) & (df["signal"] != 0)
    
    # Set signal to 0 where there's no new band crossing
    df.loc[~df["band_crossing"], "signal"] = 0
    
    # Clean up temporary columns
    df = df.drop(["prev_signal", "band_crossing"], axis=1)
    
    return df