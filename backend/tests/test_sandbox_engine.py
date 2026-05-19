"""Unit tests for sandbox engine EOD timing and sell-window markers."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
import importlib.util
import sys
import types
import zoneinfo


_ET = zoneinfo.ZoneInfo("America/New_York")


class _FakeSessionCtx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeAsyncSessionLocal:
    def __call__(self):
        return _FakeSessionCtx()


def _load_sandbox_engine_module():
    """Load sandbox_engine.py with light stubs for unrelated dependencies."""
    # Stub third-party modules that are irrelevant to these tests.
    sys.modules.setdefault("pandas", types.SimpleNamespace(DataFrame=object))
    sys.modules.setdefault("numpy", types.SimpleNamespace())

    # Stub app module tree needed during import.
    app_pkg = types.ModuleType("app")
    app_pkg.__path__ = []
    sys.modules.setdefault("app", app_pkg)

    app_database = types.ModuleType("app.database")
    app_database.AsyncSessionLocal = _FakeAsyncSessionLocal()
    sys.modules.setdefault("app.database", app_database)

    app_models = types.ModuleType("app.models")
    app_models.__path__ = []
    sys.modules.setdefault("app.models", app_models)

    app_models_sandbox = types.ModuleType("app.models.sandbox")

    class SandboxPosition:
        pass

    class SandboxTrade:
        pass

    app_models_sandbox.SandboxPosition = SandboxPosition
    app_models_sandbox.SandboxTrade = SandboxTrade
    sys.modules.setdefault("app.models.sandbox", app_models_sandbox)

    app_services = types.ModuleType("app.services")
    app_services.__path__ = []
    sys.modules.setdefault("app.services", app_services)

    app_services_strategies = types.ModuleType("app.services.strategies")
    app_services_strategies.get_strategy = lambda *a, **k: None
    app_services_strategies.STRATEGY_MAP = {}
    sys.modules.setdefault("app.services.strategies", app_services_strategies)

    app_services_script_executor = types.ModuleType("app.services.script_executor")
    app_services_script_executor.execute_script = lambda code, df: df
    sys.modules.setdefault("app.services.script_executor", app_services_script_executor)

    module_name = "sandbox_engine_under_test"
    module_path = Path(__file__).resolve().parents[1] / "app" / "services" / "sandbox_engine.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    assert spec is not None and spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sandbox_engine = _load_sandbox_engine_module()


class _FixedDateTime(datetime):
    """Datetime shim used to freeze module-local now() calls in tests."""

    _now: datetime = datetime(2026, 5, 19, 14, 0, tzinfo=_ET)

    @classmethod
    def now(cls, tz=None):
        current = cls._now
        if tz is not None:
            return current.astimezone(tz)
        return current


def test_get_eod_window_starts_default_offsets():
    """Default policy: final sell starts 30 min before close, pre-sell starts 2h before that."""
    shutoff_start, final_sell_start = sandbox_engine._get_eod_window_starts(
        eod_sell_window_minutes=30,
        eod_engine_shutoff_minutes_before_sell=120,
    )
    assert shutoff_start.hour == 13 and shutoff_start.minute == 30
    assert final_sell_start.hour == 15 and final_sell_start.minute == 30


def test_is_in_pre_sell_engine_shutoff_window(monkeypatch):
    """Pre-sell window is active before final sell window, but not during it."""
    monkeypatch.setattr(sandbox_engine, "datetime", _FixedDateTime)

    # Inside pre-sell window for sell=30, shutoff-before-sell=120: 13:30..15:30 ET
    _FixedDateTime._now = datetime(2026, 5, 19, 14, 0, tzinfo=_ET)
    assert sandbox_engine._is_in_pre_sell_engine_shutoff_window(30, 120) is True

    # Inside final sell window, pre-sell window must be inactive.
    _FixedDateTime._now = datetime(2026, 5, 19, 15, 45, tzinfo=_ET)
    assert sandbox_engine._is_in_pre_sell_engine_shutoff_window(30, 120) is False


def test_mark_first_entry_into_final_sell_window_once_per_day(monkeypatch):
    """A symbol should trigger the final-sell-start marker once per trading day."""
    monkeypatch.setattr(sandbox_engine, "datetime", _FixedDateTime)
    sandbox_engine._final_sell_window_seen.clear()

    # In final sell window (15:30..16:00 ET for 30-minute window)
    _FixedDateTime._now = datetime(2026, 5, 19, 15, 35, tzinfo=_ET)
    assert sandbox_engine._mark_first_entry_into_final_sell_window("AAPL", 30) is True
    assert sandbox_engine._mark_first_entry_into_final_sell_window("AAPL", 30) is False

    # Next day should trigger again.
    _FixedDateTime._now = datetime(2026, 5, 20, 15, 35, tzinfo=_ET)
    assert sandbox_engine._mark_first_entry_into_final_sell_window("AAPL", 30) is True


def test_mark_first_entry_requires_final_sell_window(monkeypatch):
    """Marker should not trigger outside the final sell window."""
    monkeypatch.setattr(sandbox_engine, "datetime", _FixedDateTime)
    sandbox_engine._final_sell_window_seen.clear()

    _FixedDateTime._now = datetime(2026, 5, 19, 14, 0, tzinfo=_ET)
    assert sandbox_engine._mark_first_entry_into_final_sell_window("MSFT", 30) is False
