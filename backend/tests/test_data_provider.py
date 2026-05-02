"""Unit tests for the data provider service (offline – no network)."""
from __future__ import annotations

import io
import pandas as pd
import numpy as np
import pytest
from unittest.mock import patch, MagicMock

from app.services.data_provider import fetch_ohlcv, list_data_sources


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
