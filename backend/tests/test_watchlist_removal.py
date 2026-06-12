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
        self.deleted = []
        self.committed = False

    async def execute(self, _query):
        return _ScalarResult(self.position)

    def add(self, row):
        self.added.append(row)

    async def delete(self, row):
        self.deleted.append(row)

    async def commit(self):
        self.committed = True


class _QueuedDb:
    """Returns queued scalar results in order, one per ``execute`` call."""

    def __init__(self, results):
        self._results = list(results)
        self.added = []
        self.deleted = []
        self.committed = False

    async def execute(self, _query):
        value = self._results.pop(0) if self._results else None
        return _ScalarResult(value)

    def add(self, row):
        self.added.append(row)

    async def delete(self, row):
        self.deleted.append(row)

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

    async def _no_positions():
        return []

    monkeypatch.setattr(
        positions_router,
        "ib_service",
        SimpleNamespace(is_connected=True, get_positions=_no_positions),
    )
    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", lambda allow_while_ib=False: None)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    result = await positions_router.remove_symbol("SPY", profile="paper", db=db)

    assert result == {
        "status": "ok",
        "symbol": "SPY",
        "watchlist_removed": True,
        "liquidated": None,
    }
    assert position.is_on_watchlist is False
    assert position.strategy_enabled is False
    assert position.pm_managed is False
    assert position.sentiment_mode is None
    assert position.allocated_funds == 0.0
    assert db.committed is True
    assert len(db.added) == 1
    assert db.added[0].event_type == "deallocate"


@pytest.mark.asyncio
async def test_ib_removal_liquidates_held_shares(monkeypatch):
    position = SimpleNamespace(
        symbol="AAPL",
        shares=0.0,
        avg_cost=0.0,
        pending_shares=0.0,
        pending_avg_cost=0.0,
        allocated_funds=0.0,
        is_on_watchlist=True,
        strategy_enabled=True,
        pm_managed=True,
        sentiment_mode=None,
    )
    db = _FakeDb(position)

    placed = {}

    async def _get_positions():
        return [{"symbol": "AAPL", "quantity": 10.0}]

    async def _place_order(symbol, side, quantity, order_type):
        placed.update(symbol=symbol, side=side, quantity=quantity, order_type=order_type)
        return {"status": "Submitted", "ib_order_id": 4242}

    monkeypatch.setattr(
        positions_router,
        "ib_service",
        SimpleNamespace(is_connected=True, get_positions=_get_positions, place_order=_place_order),
    )
    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", lambda allow_while_ib=False: None)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    result = await positions_router.remove_symbol("AAPL", profile="live", db=db)

    assert placed == {"symbol": "AAPL", "side": "SELL", "quantity": 10.0, "order_type": "MKT"}
    assert result["watchlist_removed"] is True
    assert result["liquidated"]["side"] == "SELL"
    assert result["liquidated"]["quantity"] == 10.0
    assert result["liquidated"]["ib_order_id"] == 4242
    # A Trade record should have been persisted for the SELL order.
    assert any(getattr(row, "side", None) is not None for row in db.added)
    assert position.is_on_watchlist is False


@pytest.mark.asyncio
async def test_simulated_removal_liquidates_held_shares(monkeypatch):
    position = SimpleNamespace(
        symbol="TSLA",
        shares=5.0,
        avg_cost=100.0,
        pending_shares=0.0,
        pending_avg_cost=0.0,
        allocated_funds=0.0,
        realized_pnl=0.0,
        strategy_name="template:rsi.py",
        is_on_watchlist=True,
        strategy_enabled=True,
        pm_managed=False,
        sentiment_mode=None,
    )
    account = SimpleNamespace(total_funds=1000.0)
    # First execute() -> position lookup; second -> account lookup.
    db = _QueuedDb([position, account])

    monkeypatch.setattr(positions_router, "ib_service", SimpleNamespace(is_connected=False))
    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", lambda allow_while_ib=False: None)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    async def _fake_price(_symbol):
        return 120.0

    monkeypatch.setattr(positions_router, "_resolve_simulated_exit_price", _fake_price)

    result = await positions_router.remove_symbol("TSLA", profile="simulated", db=db)

    assert result["watchlist_removed"] is False
    assert result["liquidated"] == {"side": "SELL", "quantity": 5.0, "price": 120.0, "pnl": 100.0}
    # Realized PnL credited to the account ledger.
    assert account.total_funds == 1100.0
    # SELL trade recorded.
    sell_trades = [row for row in db.added if getattr(row, "side", None) == "SELL"]
    assert len(sell_trades) == 1
    assert sell_trades[0].pnl == 100.0
    # Position row hard-deleted after liquidation.
    assert position in db.deleted


@pytest.mark.asyncio
async def test_simulated_removal_allowed_while_ib_connected(monkeypatch):
    """Removing a simulated-only position via the SIM tab must work while IB
    is connected (regression: it used to 409 and silently fail)."""
    position = SimpleNamespace(
        symbol="SPY",
        shares=3.0,
        avg_cost=400.0,
        pending_shares=0.0,
        pending_avg_cost=0.0,
        allocated_funds=0.0,
        realized_pnl=0.0,
        strategy_name=None,
        is_on_watchlist=True,
        strategy_enabled=False,
        pm_managed=False,
        sentiment_mode=None,
    )
    account = SimpleNamespace(total_funds=2000.0)
    db = _QueuedDb([position, account])

    # IB is connected, but the user is viewing the simulated portfolio.
    monkeypatch.setattr(positions_router, "ib_service", SimpleNamespace(is_connected=True))

    captured = {}

    def _guard(*, allow_while_ib=False):
        captured["allow_while_ib"] = allow_while_ib

    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", _guard)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    async def _fake_price(_symbol):
        return 410.0

    monkeypatch.setattr(positions_router, "_resolve_simulated_exit_price", _fake_price)

    result = await positions_router.remove_symbol("SPY", profile="simulated", db=db)

    # Write guard must have been invoked with allow_while_ib=True (not blocked).
    assert captured.get("allow_while_ib") is True
    assert result["watchlist_removed"] is False
    assert result["liquidated"] == {"side": "SELL", "quantity": 3.0, "price": 410.0, "pnl": 30.0}
    assert position in db.deleted


@pytest.mark.asyncio
async def test_ib_removal_skips_when_open_sell_already_covers(monkeypatch):
    """A second removal must not place another SELL while one is still working
    (regression: double-liquidation oversold into a negative/short position)."""
    position = SimpleNamespace(
        symbol="AAPL",
        shares=0.0,
        avg_cost=0.0,
        pending_shares=0.0,
        pending_avg_cost=0.0,
        allocated_funds=0.0,
        is_on_watchlist=True,
        strategy_enabled=True,
        pm_managed=True,
        sentiment_mode=None,
    )
    db = _FakeDb(position)

    placed = []

    async def _get_positions():
        return [{"symbol": "AAPL", "quantity": 10.0}]

    async def _get_open_orders():
        return [{"symbol": "AAPL", "side": "SELL", "remaining": 10.0, "status": "Submitted"}]

    async def _place_order(symbol, side, quantity, order_type):
        placed.append((symbol, side, quantity, order_type))
        return {"status": "Submitted", "ib_order_id": 999}

    monkeypatch.setattr(
        positions_router,
        "ib_service",
        SimpleNamespace(
            is_connected=True,
            get_positions=_get_positions,
            get_open_orders=_get_open_orders,
            place_order=_place_order,
        ),
    )
    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", lambda allow_while_ib=False: None)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    result = await positions_router.remove_symbol("AAPL", profile="paper", db=db)

    # No new SELL order should have been placed.
    assert placed == []
    assert result["liquidated"]["status"] == "ALREADY_PENDING"
    assert result["liquidated"]["quantity"] == 0.0
    assert position.is_on_watchlist is False


@pytest.mark.asyncio
async def test_ib_removal_only_sells_uncovered_remainder(monkeypatch):
    """When an open SELL partially covers the held quantity, only sell the rest."""
    position = SimpleNamespace(
        symbol="NVDA",
        shares=0.0,
        avg_cost=0.0,
        pending_shares=0.0,
        pending_avg_cost=0.0,
        allocated_funds=0.0,
        is_on_watchlist=True,
        strategy_enabled=True,
        pm_managed=True,
        sentiment_mode=None,
    )
    db = _FakeDb(position)

    placed = []

    async def _get_positions():
        return [{"symbol": "NVDA", "quantity": 10.0}]

    async def _get_open_orders():
        return [{"symbol": "NVDA", "side": "SELL", "remaining": 4.0, "status": "Submitted"}]

    async def _place_order(symbol, side, quantity, order_type):
        placed.append((symbol, side, quantity, order_type))
        return {"status": "Submitted", "ib_order_id": 1001}

    monkeypatch.setattr(
        positions_router,
        "ib_service",
        SimpleNamespace(
            is_connected=True,
            get_positions=_get_positions,
            get_open_orders=_get_open_orders,
            place_order=_place_order,
        ),
    )
    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", lambda allow_while_ib=False: None)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    result = await positions_router.remove_symbol("NVDA", profile="paper", db=db)

    # Only the uncovered remainder (10 - 4 = 6) should be sold.
    assert placed == [("NVDA", "SELL", 6.0, "MKT")]
    assert result["liquidated"]["quantity"] == 6.0


@pytest.mark.asyncio
async def test_ib_removal_never_sells_short_position(monkeypatch):
    """A non-positive held quantity (flat/short) must never trigger a SELL."""
    position = SimpleNamespace(
        symbol="TSLA",
        shares=0.0,
        avg_cost=0.0,
        pending_shares=0.0,
        pending_avg_cost=0.0,
        allocated_funds=0.0,
        is_on_watchlist=True,
        strategy_enabled=True,
        pm_managed=True,
        sentiment_mode=None,
    )
    db = _FakeDb(position)

    placed = []

    async def _get_positions():
        return [{"symbol": "TSLA", "quantity": -5.0}]

    async def _place_order(symbol, side, quantity, order_type):
        placed.append((symbol, side, quantity, order_type))
        return {"status": "Submitted", "ib_order_id": 1}

    monkeypatch.setattr(
        positions_router,
        "ib_service",
        SimpleNamespace(is_connected=True, get_positions=_get_positions, place_order=_place_order),
    )
    monkeypatch.setattr(positions_router, "ensure_sandbox_write_allowed", lambda allow_while_ib=False: None)

    async def _fake_offload(_db):
        return None

    monkeypatch.setattr(positions_router, "offload_simulated_state", _fake_offload)

    result = await positions_router.remove_symbol("TSLA", profile="paper", db=db)

    assert placed == []
    assert result["liquidated"] is None

