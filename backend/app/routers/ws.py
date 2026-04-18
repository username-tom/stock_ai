"""WebSocket endpoint for real-time price streaming (yfinance polling)."""
from __future__ import annotations

import asyncio
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import yfinance as yf

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])


@router.websocket("/ws/prices")
async def price_stream(websocket: WebSocket):
    """
    Accept a WebSocket connection.
    Clients send JSON: {"symbols": ["AAPL", "MSFT"], "interval": 5}
    The server streams price updates every `interval` seconds (default 10).
    """
    await websocket.accept()
    symbols: list[str] = []
    interval: int = 10

    try:
        # Wait for the initial config message
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        config = json.loads(raw)
        symbols = [s.upper() for s in config.get("symbols", [])]
        interval = max(5, int(config.get("interval", 10)))

        while True:
            prices = {}
            for sym in symbols:
                try:
                    ticker = yf.Ticker(sym)
                    info = ticker.fast_info
                    prices[sym] = {
                        "symbol": sym,
                        "price": info.last_price,
                        "previous_close": info.previous_close,
                        "change_pct": (
                            round(
                                (info.last_price - info.previous_close)
                                / info.previous_close * 100,
                                2,
                            )
                            if info.previous_close
                            else None
                        ),
                    }
                except Exception as exc:
                    prices[sym] = {"symbol": sym, "error": str(exc)}

            await websocket.send_json({"type": "prices", "data": prices})
            await asyncio.sleep(interval)

    except (WebSocketDisconnect, asyncio.TimeoutError):
        logger.info("WebSocket client disconnected.")
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
