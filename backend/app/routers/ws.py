"""WebSocket endpoint for real-time price streaming (stooq-backed, TTL-cached)."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services import market_service

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])


@router.websocket("/ws/prices")
async def price_stream(websocket: WebSocket):
    """
    Accept a WebSocket connection.
    Clients send JSON: {"symbols": ["AAPL", "MSFT"], "interval": 15}
    The server streams price updates every `interval` seconds (default 30).
    """
    await websocket.accept()
    symbols: list[str] = []
    interval: int = 30

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        import json
        config = json.loads(raw)
        symbols = [s.upper() for s in config.get("symbols", [])]
        interval = max(15, int(config.get("interval", 30)))

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
