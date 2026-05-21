"""Regression tests for stock learner tag thresholds and agreement math."""
from __future__ import annotations

from pathlib import Path
import importlib.util
import sys
import types


def _load_stock_learner_module():
    app_pkg = types.ModuleType("app")
    app_pkg.__path__ = []
    sys.modules.setdefault("app", app_pkg)

    app_services = types.ModuleType("app.services")
    app_services.__path__ = []
    sys.modules.setdefault("app.services", app_services)

    app_services_market = types.ModuleType("app.services.market_service")

    async def get_history(symbol: str, period: str):
        return {"data": []}

    app_services_market.get_history = get_history
    sys.modules["app.services.market_service"] = app_services_market

    module_name = "stock_learner_under_test"
    module_path = Path(__file__).resolve().parents[1] / "app" / "services" / "stock_learner.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    assert spec is not None and spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


stock_learner = _load_stock_learner_module()


def test_directional_agreement_is_symmetric_for_bearish_consensus():
    assert stock_learner._directional_agreement([0.8, 0.9, 0.7]) == 1.0
    assert stock_learner._directional_agreement([0.2, 0.1, 0.3]) == 1.0
    assert stock_learner._directional_agreement([0.8, 0.7, 0.2]) == 2 / 3


def test_short_tag_reachable_with_moderate_bearish_score_and_strong_agreement():
    assert stock_learner._tag_from_score(-0.2, 0.52) == "SHORT"


def test_strong_short_still_requires_higher_confidence():
    assert stock_learner._tag_from_score(-0.6, 0.7) == "STRONG SHORT"
    assert stock_learner._tag_from_score(-0.6, 0.6) == "SHORT"