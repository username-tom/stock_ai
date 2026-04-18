"""
Interactive Brokers integration service using ib_insync.

Connects to TWS or IB Gateway (paper or live).  All public methods
return plain Python dicts so they are JSON-serialisable.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

try:
    import ib_insync as ibi
    IB_AVAILABLE = True
except ImportError:
    IB_AVAILABLE = False
    logger.warning("ib_insync not installed – IB features will be unavailable.")


class IBService:
    def __init__(self):
        self._ib: Any = None  # ibi.IB instance
        self._connected = False

    # ------------------------------------------------------------------ #
    # Connection management
    # ------------------------------------------------------------------ #

    async def connect(self) -> dict:
        if not IB_AVAILABLE:
            return {"status": "error", "message": "ib_insync not installed."}
        if self._connected:
            return {"status": "ok", "message": "Already connected."}
        try:
            self._ib = ibi.IB()
            await self._ib.connectAsync(
                settings.IB_HOST,
                settings.IB_PORT,
                clientId=settings.IB_CLIENT_ID,
                timeout=10,
            )
            self._connected = True
            logger.info("Connected to IB on %s:%s", settings.IB_HOST, settings.IB_PORT)
            return {"status": "ok", "message": "Connected to Interactive Brokers."}
        except Exception as exc:
            self._connected = False
            self._ib = None
            logger.error("IB connect failed: %s", exc)
            return {"status": "error", "message": "Could not connect to Interactive Brokers. Check host/port and that TWS/Gateway is running."}

    async def disconnect(self) -> dict:
        if self._ib and self._connected:
            self._ib.disconnect()
            self._connected = False
            self._ib = None
        return {"status": "ok", "message": "Disconnected."}

    @property
    def is_connected(self) -> bool:
        return self._connected and self._ib is not None

    def connection_status(self) -> dict:
        return {
            "connected": self.is_connected,
            "host": settings.IB_HOST,
            "port": settings.IB_PORT,
            "client_id": settings.IB_CLIENT_ID,
            "mode": settings.TRADING_MODE,
        }

    # ------------------------------------------------------------------ #
    # Account
    # ------------------------------------------------------------------ #

    async def get_account_summary(self) -> dict:
        if not self.is_connected:
            return {"error": "Not connected to IB."}
        try:
            summary = await self._ib.accountSummaryAsync()
            result: dict[str, Any] = {}
            for item in summary:
                result[item.tag] = {"value": item.value, "currency": item.currency}
            return result
        except Exception as exc:
            logger.error("get_account_summary error: %s", exc)
            return {"error": "Failed to retrieve account summary."}

    # ------------------------------------------------------------------ #
    # Positions
    # ------------------------------------------------------------------ #

    async def get_positions(self) -> list[dict]:
        if not self.is_connected:
            return []
        try:
            positions = await self._ib.reqPositionsAsync()
            return [
                {
                    "symbol": p.contract.symbol,
                    "secType": p.contract.secType,
                    "exchange": p.contract.exchange,
                    "quantity": p.position,
                    "avg_cost": round(p.avgCost, 4),
                    "market_value": round(p.position * p.avgCost, 2),
                }
                for p in positions
            ]
        except Exception as exc:
            logger.error("get_positions error: %s", exc)
            return []

    # ------------------------------------------------------------------ #
    # Market data (snapshot)
    # ------------------------------------------------------------------ #

    async def get_market_data(self, symbol: str) -> dict:
        if not self.is_connected:
            return {"error": "Not connected to IB."}
        try:
            contract = ibi.Stock(symbol, "SMART", "USD")
            tickers = await self._ib.reqTickersAsync(contract)
            if not tickers:
                return {"error": "No ticker data."}
            t = tickers[0]
            return {
                "symbol": symbol,
                "bid": t.bid,
                "ask": t.ask,
                "last": t.last,
                "close": t.close,
                "volume": t.volume,
                "halted": t.halted,
            }
        except Exception as exc:
            logger.error("get_market_data error: %s", exc)
            return {"error": "Failed to retrieve market data."}

    # ------------------------------------------------------------------ #
    # Historical data
    # ------------------------------------------------------------------ #

    async def get_historical_bars(
        self,
        symbol: str,
        duration: str = "1 Y",
        bar_size: str = "1 day",
    ) -> list[dict]:
        if not self.is_connected:
            return []
        try:
            contract = ibi.Stock(symbol, "SMART", "USD")
            bars = await self._ib.reqHistoricalDataAsync(
                contract,
                endDateTime="",
                durationStr=duration,
                barSizeSetting=bar_size,
                whatToShow="ADJUSTED_LAST",
                useRTH=True,
            )
            return [
                {
                    "date": str(b.date),
                    "open": b.open,
                    "high": b.high,
                    "low": b.low,
                    "close": b.close,
                    "volume": b.volume,
                }
                for b in bars
            ]
        except Exception as exc:
            logger.error("get_historical_bars error: %s", exc)
            return []

    # ------------------------------------------------------------------ #
    # Order placement
    # ------------------------------------------------------------------ #

    async def place_order(
        self,
        symbol: str,
        side: str,
        quantity: float,
        order_type: str = "MKT",
        limit_price: float | None = None,
    ) -> dict:
        if not self.is_connected:
            return {"error": "Not connected to IB."}
        try:
            contract = ibi.Stock(symbol, "SMART", "USD")
            action = side.upper()
            if order_type.upper() == "LMT" and limit_price:
                order = ibi.LimitOrder(action, quantity, limit_price)
            else:
                order = ibi.MarketOrder(action, quantity)

            trade = self._ib.placeOrder(contract, order)
            await asyncio.sleep(1)  # give IB time to acknowledge
            return {
                "ib_order_id": trade.order.orderId,
                "status": trade.orderStatus.status,
                "symbol": symbol,
                "side": side,
                "quantity": quantity,
                "order_type": order_type,
            }
        except Exception as exc:
            logger.error("place_order error: %s", exc)
            return {"error": "Failed to place order with Interactive Brokers."}

    async def cancel_order(self, ib_order_id: int) -> dict:
        if not self.is_connected:
            return {"error": "Not connected to IB."}
        try:
            open_trades = self._ib.openTrades()
            target = next(
                (t for t in open_trades if t.order.orderId == ib_order_id), None
            )
            if target is None:
                return {"error": f"Order {ib_order_id} not found."}
            self._ib.cancelOrder(target.order)
            return {"status": "ok", "cancelled": ib_order_id}
        except Exception as exc:
            logger.error("cancel_order error: %s", exc)
            return {"error": "Failed to cancel order."}

    async def get_open_orders(self) -> list[dict]:
        if not self.is_connected:
            return []
        try:
            trades = self._ib.openTrades()
            return [
                {
                    "ib_order_id": t.order.orderId,
                    "symbol": t.contract.symbol,
                    "side": t.order.action,
                    "quantity": t.order.totalQuantity,
                    "status": t.orderStatus.status,
                }
                for t in trades
            ]
        except Exception as exc:
            logger.error("get_open_orders error: %s", exc)
            return []


# Singleton instance
ib_service = IBService()
