"""Base strategy class for the backtesting engine."""
from abc import ABC, abstractmethod
import pandas as pd
from typing import Optional


class BaseStrategy(ABC):
    """Abstract base class for all trading strategies."""

    name: str = "base"
    description: str = ""

    def __init__(self, **params):
        self.params = params

    @abstractmethod
    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Given a DataFrame with OHLCV data, return the same DataFrame
        with an added 'signal' column: +1 = buy, -1 = sell, 0 = hold.
        """

    @classmethod
    def get_default_params(cls) -> dict:
        return {}

    def validate_params(self) -> None:
        """Override to validate strategy-specific parameters."""
