"""Unit tests for sandbox report helper utilities."""
from app.routers.backtest import _flatten_per_symbol_trades, _summarize_report_symbols


def test_summarize_report_symbols_compacts_without_trailing_comma():
    symbols = ["AAPL", "AMD", "GOOGL", "INTC", "LLY", "MSFT"]
    out = _summarize_report_symbols(symbols, max_len=20)

    assert len(out) <= 20
    assert not out.endswith(",")
    assert "+" in out


def test_summarize_report_symbols_full_when_short_enough():
    out = _summarize_report_symbols(["AAPL", "MSFT"], max_len=20)
    assert out == "AAPL,MSFT"


def test_flatten_per_symbol_trades_adds_symbol_and_sorts():
    per_symbol = [
        {
            "symbol": "MSFT",
            "trades": [
                {"entry_date": "2026-05-01_10:00:00", "exit_date": "2026-05-01_11:00:00", "pnl": 1.0},
            ],
        },
        {
            "symbol": "AAPL",
            "trades": [
                {"entry_date": "2026-05-01_09:30:00", "exit_date": "2026-05-01_10:30:00", "pnl": 2.0},
            ],
        },
    ]

    trades = _flatten_per_symbol_trades(per_symbol)

    assert len(trades) == 2
    assert trades[0]["symbol"] == "AAPL"
    assert trades[1]["symbol"] == "MSFT"
