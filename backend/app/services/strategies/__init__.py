from app.services.strategies.base import BaseStrategy
from app.services.strategies.moving_avg import MovingAverageCrossover
from app.services.strategies.rsi import RSIStrategy
from app.services.strategies.bollinger import BollingerBandsStrategy
from app.services.strategies.macd import MACDStrategy

STRATEGY_MAP: dict[str, type[BaseStrategy]] = {
    "sma_crossover": MovingAverageCrossover,
    "rsi": RSIStrategy,
    "bollinger_bands": BollingerBandsStrategy,
    "macd": MACDStrategy,
}


def get_strategy(strategy_type: str, **params) -> BaseStrategy:
    cls = STRATEGY_MAP.get(strategy_type)
    if cls is None:
        raise ValueError(f"Unknown strategy: {strategy_type}. "
                         f"Available: {list(STRATEGY_MAP.keys())}")
    return cls(**params)


def list_strategies() -> list[dict]:
    return [
        {
            "type": cls.name,
            "description": cls.description,
            "default_params": cls.get_default_params(),
        }
        for cls in STRATEGY_MAP.values()
    ]


__all__ = [
    "BaseStrategy",
    "MovingAverageCrossover",
    "RSIStrategy",
    "BollingerBandsStrategy",
    "MACDStrategy",
    "STRATEGY_MAP",
    "get_strategy",
    "list_strategies",
]
