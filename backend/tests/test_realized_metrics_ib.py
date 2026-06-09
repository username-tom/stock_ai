from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.models.trade import TradingMode
from app.routers.sandbox_router import trades as trades_router


class _ScalarListResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)


class _FakeDb:
    def __init__(self, rows):
        self._rows = rows

    async def execute(self, _query):
        return _ScalarListResult(self._rows)


@pytest.mark.asyncio
async def test_ib_realized_metrics_derives_missing_sell_pnl(monkeypatch):
    trades = [
        SimpleNamespace(
            id=1,
            symbol="AAPL",
            side=SimpleNamespace(value="BUY"),
            quantity=10.0,
            price=100.0,
            status=SimpleNamespace(value="FILLED"),
            mode=TradingMode.PAPER,
            pnl=None,
            created_at=datetime(2026, 6, 9, 13, 30, tzinfo=timezone.utc),
            filled_at=datetime(2026, 6, 9, 13, 31, tzinfo=timezone.utc),
        ),
        SimpleNamespace(
            id=2,
            symbol="AAPL",
            side=SimpleNamespace(value="SELL"),
            quantity=4.0,
            price=110.0,
            status=SimpleNamespace(value="FILLED"),
            mode=TradingMode.PAPER,
            pnl=None,
            created_at=datetime(2026, 6, 9, 14, 0, tzinfo=timezone.utc),
            filled_at=datetime(2026, 6, 9, 14, 5, tzinfo=timezone.utc),
        ),
        SimpleNamespace(
            id=3,
            symbol="AAPL",
            side=SimpleNamespace(value="SELL"),
            quantity=3.0,
            price=90.0,
            status=SimpleNamespace(value="FILLED"),
            mode=TradingMode.PAPER,
            pnl=0.0,
            created_at=datetime(2026, 6, 9, 15, 0, tzinfo=timezone.utc),
            filled_at=datetime(2026, 6, 9, 15, 1, tzinfo=timezone.utc),
        ),
    ]

    monkeypatch.setattr(trades_router, "ib_service", SimpleNamespace(is_connected=True))
    monkeypatch.setattr(trades_router, "count_nyse_trading_days", lambda start, end: 1)

    class _FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            current = datetime(2026, 6, 9, 16, 0, tzinfo=timezone.utc)
            return current if tz is None else current.astimezone(tz)

    monkeypatch.setattr(trades_router, "datetime", _FixedDateTime)

    result = await trades_router.get_realized_metrics(profile="paper", db=_FakeDb(trades))

    assert result["realized_pnl_sum"] == 10.0
    assert result["daily_realized_pnl"] == 10.0
    assert result["weekly_realized_pnl"] == 10.0
    assert result["monthly_realized_pnl"] == 10.0
    assert result["realized_trade_days"] == 1