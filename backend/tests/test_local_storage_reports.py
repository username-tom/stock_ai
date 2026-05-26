"""Unit tests for backtest report local storage helpers."""
from __future__ import annotations

from pathlib import Path

from app.services import local_storage


def test_backtest_report_roundtrip_uses_local_storage(tmp_path, monkeypatch):
    storage_dir = tmp_path / "local_storage"
    backtest_dir = storage_dir / "backtest_reports"
    backtest_dir.mkdir(parents=True)

    monkeypatch.setattr(local_storage, "_BACKTEST_DIR", backtest_dir)

    payload = {
        "id": 42,
        "name": "AAPL_demo_report",
        "result_data": {
            "equity_curve": [{"date": "2026-05-01", "value": 100000.0}],
            "trades": [{"entry_date": "2026-05-01", "exit_date": "2026-05-02"}],
            "ohlcv": [{"date": "2026-05-01", "close": 100.0}],
        },
    }

    saved_path = local_storage.save_backtest_report(payload["id"], payload["name"], payload)

    assert Path(saved_path).parent == backtest_dir
    assert Path(saved_path).exists()

    loaded = local_storage.load_backtest_report(payload["id"], payload["name"])
    assert loaded == payload