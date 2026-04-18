"""Market data endpoints (yfinance for public data)."""
from __future__ import annotations

import yfinance as yf
from fastapi import APIRouter, HTTPException, Query
from typing import Optional

router = APIRouter(prefix="/api/market-data", tags=["market-data"])


@router.get("/quote/{symbol}")
async def get_quote(symbol: str):
    """Get latest quote via yfinance."""
    try:
        ticker = yf.Ticker(symbol.upper())
        info = ticker.fast_info
        return {
            "symbol": symbol.upper(),
            "last_price": info.last_price,
            "previous_close": info.previous_close,
            "open": info.open,
            "day_high": info.day_high,
            "day_low": info.day_low,
            "volume": info.three_month_average_volume,
            "market_cap": info.market_cap,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/history/{symbol}")
async def get_history(
    symbol: str,
    period: str = Query(default="1y", description="e.g. 1d 5d 1mo 3mo 6mo 1y 2y"),
    interval: str = Query(default="1d", description="e.g. 1m 5m 15m 1h 1d 1wk"),
):
    """Get OHLCV history via yfinance."""
    try:
        df = yf.download(
            symbol.upper(), period=period, interval=interval,
            progress=False, auto_adjust=True
        )
        if df.empty:
            raise HTTPException(status_code=404, detail=f"No data for {symbol}.")
        if isinstance(df.columns, __import__("pandas").MultiIndex):
            df.columns = [col[0] for col in df.columns]
        records = []
        for date, row in df.iterrows():
            records.append({
                "date": str(date.date()) if hasattr(date, "date") else str(date),
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"]),
            })
        return {"symbol": symbol.upper(), "interval": interval, "data": records}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
