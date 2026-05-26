"""Unit tests for backtest report detail loading."""
from __future__ import annotations

from app.models.report import BacktestReport
from app.routers import backtest


class DummyDb:
    def __init__(self, report):
        self._report = report

    async def get(self, model, report_id):
        return self._report


def _make_report(*, result_data):
    return BacktestReport(
        id=101,
        name="demo-report",
        symbol="AAPL",
        strategy_type="mean_reversion",
        parameters={},
        start_date="2026-01-01",
        end_date="2026-02-01",
        initial_capital=100000.0,
        final_value=105000.0,
        total_return_pct=5.0,
        annualized_return_pct=12.5,
        sharpe_ratio=1.2,
        max_drawdown_pct=-2.5,
        win_rate_pct=60.0,
        total_trades=3,
        result_data=result_data,
        script_snapshot="print('demo')",
    )


async def test_get_report_uses_db_payload_when_local_file_missing(monkeypatch):
    report = _make_report(result_data={"trades": [{"entry_date": "2026-01-05"}]})
    db = DummyDb(report)
    offload_calls = []

    monkeypatch.setattr(backtest, "load_backtest_report", lambda *args, **kwargs: None)

    async def fake_offload(*args, **kwargs):
        offload_calls.append((args, kwargs))

    monkeypatch.setattr(backtest, "_offload_report_payload", fake_offload)

    out = await backtest.get_report(101, db=db)

    assert out["data_warning"] is None
    assert out["result_data"] == report.result_data
    assert offload_calls, "Expected opportunistic offload to run for legacy DB payloads"


async def test_get_report_warns_when_payload_is_genuinely_missing(monkeypatch):
    report = _make_report(result_data=None)
    db = DummyDb(report)

    monkeypatch.setattr(backtest, "load_backtest_report", lambda *args, **kwargs: None)

    async def fake_offload(*args, **kwargs):
        raise AssertionError("offload should not run when there is no payload to migrate")

    monkeypatch.setattr(backtest, "_offload_report_payload", fake_offload)

    out = await backtest.get_report(101, db=db)

    assert out["result_data"] == {}
    assert out["data_warning"] is not None
    assert "Detailed trade/ohlcv payload is unavailable" in out["data_warning"]