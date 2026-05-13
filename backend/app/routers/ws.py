"""WebSocket endpoint for real-time price streaming (IB-first, cached)."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services import market_service
from app.services.ib_service import IB_AVAILABLE, ib_service

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])

IB_WS_DEFAULT_INTERVAL = 5
IB_WS_WATCHLIST_LIMIT = 20
IB_WS_OVER_LIMIT_INTERVAL = 15


@router.websocket("/ws/prices")
async def price_stream(websocket: WebSocket):
    """
    Accept a WebSocket connection.
    Clients send JSON: {"symbols": ["AAPL", "MSFT"], "interval": 15}
    The server streams price updates every `interval` seconds.
    Default interval is 5s when IB is connected, otherwise 30s.
    Minimum interval is 5s when IB is connected, otherwise 15s.
    For large symbol sets (> 20), IB-connected minimum/default are 15s.
    """
    await websocket.accept()
    symbols: list[str] = []
    interval: int = 30

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        import json
        config = json.loads(raw)
        symbols = [s.upper() for s in config.get("symbols", [])]
        ib_connected = bool(IB_AVAILABLE and ib_service.is_connected)
        over_limit = ib_connected and len(symbols) > IB_WS_WATCHLIST_LIMIT
        min_interval = (
            IB_WS_OVER_LIMIT_INTERVAL
            if over_limit
            else (IB_WS_DEFAULT_INTERVAL if ib_connected else 15)
        )
        default_interval = (
            IB_WS_OVER_LIMIT_INTERVAL
            if over_limit
            else (IB_WS_DEFAULT_INTERVAL if ib_connected else 30)
        )
        requested_interval = config.get("interval")
        interval = default_interval if requested_interval is None else int(requested_interval)
        interval = max(min_interval, interval)

        while True:
            prices = await market_service.get_bulk_quotes(symbols)
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
