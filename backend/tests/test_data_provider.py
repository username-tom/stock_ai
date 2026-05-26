"""Unit tests for the data provider service (offline – no network)."""
from __future__ import annotations

import io
import pandas as pd
import numpy as np
import pytest
from unittest.mock import patch, MagicMock

from app.services.data_provider import (
    fetch_ohlcv,
    list_data_sources,
    warm_intraday_cache,
    get_intraday_cache_coverage,
)


def _make_ohlcv(n=100, seed=42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    return pd.DataFrame(
        {
            "Open": close * 0.99,
            "High": close * 1.01,
            "Low": close * 0.98,
            "Close": close,
            "Volume": rng.integers(100_000, 10_000_000, n),
        },
        index=pd.date_range("2022-01-01", periods=n, freq="B"),
    )


_STOOQ_CSV = (
    "Date,Open,High,Low,Close,Volume\n"
    "2022-01-03,175.0,176.0,174.0,175.5,80000000\n"
    "2022-01-04,175.5,177.0,174.5,176.0,75000000\n"
)


# ------------------------------------------------------------------ #
# fetch_ohlcv – yfinance path
# ------------------------------------------------------------------ #

class TestFetchYfinance:
    def test_returns_dataframe(self):
        fake = _make_ohlcv()
        with patch("app.services.data_provider.yf.download", return_value=fake):
            df = fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="yfinance")
        assert isinstance(df, pd.DataFrame)
        assert not df.empty

    def test_raises_on_empty_response(self):
        empty = pd.DataFrame()
        with patch("app.services.data_provider.yf.download", return_value=empty):
            with pytest.raises(ValueError, match="yfinance"):
                fetch_ohlcv("XXXX", "2022-01-01", "2022-12-31", source="yfinance")

    def test_flattens_multiindex_columns(self):
        fake = _make_ohlcv()
        multi = fake.copy()
        multi.columns = pd.MultiIndex.from_tuples(
            [(c, "AAPL") for c in fake.columns]
        )
        with patch("app.services.data_provider.yf.download", return_value=multi):
            df = fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="yfinance")
        assert all(isinstance(c, str) for c in df.columns)


# ------------------------------------------------------------------ #
# fetch_ohlcv – stooq path
# ------------------------------------------------------------------ #

class TestFetchStooq:
    def test_returns_dataframe(self):
        mock_response = MagicMock()
        mock_response.text = _STOOQ_CSV
        mock_response.raise_for_status = MagicMock()
        with patch("app.services.data_provider.httpx.get", return_value=mock_response):
            df = fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="stooq")
        assert isinstance(df, pd.DataFrame)
        assert not df.empty
        assert "Close" in df.columns

    def test_raises_on_no_data_response(self):
        mock_response = MagicMock()
        mock_response.text = "No data"
        mock_response.raise_for_status = MagicMock()
        with patch("app.services.data_provider.httpx.get", return_value=mock_response):
            with pytest.raises(ValueError, match="stooq"):
                fetch_ohlcv("XXXX", "2022-01-01", "2022-12-31", source="stooq")

    def test_raises_on_http_error(self):
        import httpx
        with patch(
            "app.services.data_provider.httpx.get",
            side_effect=httpx.RequestError("timeout"),
        ):
            with pytest.raises(ValueError, match="stooq"):
                fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="stooq")


# ------------------------------------------------------------------ #
# fetch_ohlcv – IB path (fallback logic)
# ------------------------------------------------------------------ #

class TestFetchIBFallback:
    def test_falls_back_to_yfinance_when_ib_not_installed(self):
        fake = _make_ohlcv()
        with (
            patch("app.services.data_provider.IB_AVAILABLE", False),
            patch("app.services.data_provider.yf.download", return_value=fake),
        ):
            df = fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="ib")
        assert isinstance(df, pd.DataFrame)
        assert not df.empty

    def test_falls_back_to_yfinance_when_ib_not_connected(self):
        fake = _make_ohlcv()
        mock_ib_service = MagicMock()
        mock_ib_service.is_connected = False
        with (
            patch("app.services.data_provider.IB_AVAILABLE", True),
            patch("app.services.data_provider.ib_service", mock_ib_service),
            patch("app.services.data_provider.yf.download", return_value=fake),
        ):
            df = fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="ib")
        assert isinstance(df, pd.DataFrame)
        assert not df.empty


# ------------------------------------------------------------------ #
# fetch_ohlcv – invalid source
# ------------------------------------------------------------------ #

class TestFetchInvalidSource:
    def test_raises_on_unknown_source(self):
        with pytest.raises(ValueError, match="Unknown data source"):
            fetch_ohlcv("AAPL", "2022-01-01", "2022-12-31", source="unknown_source")  # type: ignore[arg-type]


# ------------------------------------------------------------------ #
# list_data_sources
# ------------------------------------------------------------------ #

class TestListDataSources:
    def test_returns_list(self):
        sources = list_data_sources()
        assert isinstance(sources, list)
        assert len(sources) >= 2

    def test_contains_yfinance_and_stooq(self):
        ids = {s["id"] for s in list_data_sources()}
        assert "yfinance" in ids
        assert "stooq" in ids
        assert "ib" in ids

    def test_yfinance_always_available(self):
        sources = {s["id"]: s for s in list_data_sources()}
        assert sources["yfinance"]["available"] is True

    def test_stooq_always_available(self):
        sources = {s["id"]: s for s in list_data_sources()}
        assert sources["stooq"]["available"] is True

    def test_ib_unavailable_when_not_connected(self):
        mock_ib_service = MagicMock()
        mock_ib_service.is_connected = False
        with (
            patch("app.services.data_provider.IB_AVAILABLE", False),
            patch("app.services.data_provider.ib_service", mock_ib_service),
        ):
            sources = {s["id"]: s for s in list_data_sources()}
        assert sources["ib"]["available"] is False

    def test_required_fields_present(self):
        for s in list_data_sources():
            assert "id" in s
            assert "name" in s
            assert "description" in s
            assert "requires_auth" in s
            assert "available" in s


# ------------------------------------------------------------------ #
# warm_intraday_cache – source resolution / IB bypass
# ------------------------------------------------------------------ #

class TestWarmIntradayCache:
    def test_auto_source_can_bypass_ib_when_prefer_ib_false(self):
        intraday_df = pd.DataFrame(
            {
                "Open": [100.0, 101.0],
                "High": [101.0, 102.0],
                "Low": [99.0, 100.5],
                "Close": [100.5, 101.5],
                "Volume": [1000, 1200],
            },
            index=pd.date_range("2026-05-20 09:30:00", periods=2, freq="1min", tz="US/Eastern"),
        )

        ticker = MagicMock()
        ticker.history.return_value = intraday_df

        with (
            patch("app.services.data_provider._ib_is_connected", return_value=True),
            patch("app.services.data_provider.yf.Ticker", return_value=ticker),
            patch("app.services.data_provider._save_cached_df"),
            patch(
                "app.services.data_provider.get_intraday_cache_coverage",
                return_value={
                    "symbol": "AAPL",
                    "source": "yfinance",
                    "rows": 2,
                    "oldest": "2026-05-20 09:30:00-04:00",
                    "newest": "2026-05-20 09:31:00-04:00",
                },
            ),
        ):
            result = warm_intraday_cache(
                "AAPL",
                lookback_days=5,
                source="auto",
                prefer_ib=False,
            )

        assert result["source"] == "yfinance"
        assert ticker.history.called


class TestIntradayCacheCoverage:
    def test_explicit_yfinance_coverage_not_upgraded_to_ib(self):
        fake_cache = pd.DataFrame(
            {
                "Open": [100.0],
                "High": [101.0],
                "Low": [99.0],
                "Close": [100.5],
                "Volume": [1000],
            },
            index=pd.DatetimeIndex([pd.Timestamp("2026-05-20 09:30:00", tz="US/Eastern")]),
        )

        with (
            patch("app.services.data_provider._ib_is_connected", return_value=True),
            patch("app.services.data_provider._load_cached_df", return_value=fake_cache) as mock_load,
        ):
            cov = get_intraday_cache_coverage("AAPL", "yfinance")

        assert cov["source"] == "yfinance"
        assert cov["rows"] == 1
        assert cov["ib_verified"] is False
        call_args = mock_load.call_args.args
        assert call_args[1] == "yfinance"
