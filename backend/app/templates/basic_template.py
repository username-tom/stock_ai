"""
Basic Custom Script Template

This is a simple template showing the basic structure for custom trading scripts.
Use this as a starting point for creating your own custom strategies.
"""

import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {
        "example_param": 20,
        "threshold": 0.5
    }


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Basic Custom Strategy Template
    
    Parameters:
    - example_param: Example parameter (default: 20)
    - threshold: Example threshold (default: 0.5)
    
    Available DataFrame columns:
    - Open: Opening price
    - High: Highest price
    - Low: Lowest price
    - Close: Closing price
    - Volume: Trading volume
    
    Signal values:
    - +1: Buy signal
    - -1: Sell signal
    -  0: Hold/No action
    """
    df = df.copy()
    
    # Extract parameters with defaults
    example_param = params.get("example_param", 20)
    threshold = params.get("threshold", 0.5)
    
    # Initialize signal column
    df["signal"] = 0
    
    # ── Your strategy logic here ──────────────────────────────────────────
    
    # Example: Simple moving average crossover
    sma = df["Close"].rolling(window=example_param).mean()
    
    # Buy when price is above SMA by threshold%
    df.loc[df["Close"] > sma * (1 + threshold/100), "signal"] = 1
    
    # Sell when price is below SMA by threshold%
    df.loc[df["Close"] < sma * (1 - threshold/100), "signal"] = -1
    
    # ──────────────────────────────────────────────────────────────────────
    
    return df