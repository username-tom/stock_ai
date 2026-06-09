from types import SimpleNamespace

import pytest

from app.routers.sandbox_router import positions as positions_router


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeDb:
    def __init__(self, position):
        self.position = position
        self.added = []
        self.committed = False

    async def execute(self, _query):
        return _ScalarResult(self.position)

    def add(self, row):
        self.added.append(row)

    async def commit(self):
        self.committed = True


@pytest.mark.asyncio
async def test_ib_watchlist_removal_clears_engine_and_pm_state(monkeypatch):
    position = SimpleNamespace(
        symbol="SPY",
        shares=0.0,
        avg_cost=0.0,
        pending_shares=0.0,
        pending_avg_cost=0.0,
        allocated_funds=1250.0,
        is_on_watchlist=True,
        strategy_enabled=True,
        pm_managed=True,
        sentiment_mode="market",
    )
    db = _FakeDb(position)

    monkeypatch.setattr(positions_router, "ib_service", SimpleNamespace(is_connected=True))
    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", lambda allow_while_ib=False: None)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    result = await positions_router.remove_symbol("SPY", profile="paper", db=db)

    assert result == {"status": "ok", "symbol": "SPY", "watchlist_removed": True}
    assert position.is_on_watchlist is False
    assert position.strategy_enabled is False
    assert position.pm_managed is False
    assert position.sentiment_mode is None
    assert position.allocated_funds == 0.0
    assert db.committed is True
    assert len(db.added) == 1
    assert db.added[0].event_type == "deallocate"