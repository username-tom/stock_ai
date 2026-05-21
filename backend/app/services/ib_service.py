"""Interactive Brokers integration using the official ibapi package."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
from datetime import date, datetime, timezone
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

try:
    from ibapi.client import EClient
    from ibapi.common import BarData, OrderId, TickerId
    from ibapi.contract import Contract
    from ibapi.order import Order
    from ibapi.wrapper import EWrapper

    IB_AVAILABLE = True
except ImportError:
    EClient = object  # type: ignore[assignment]
    EWrapper = object  # type: ignore[assignment]
    Contract = object  # type: ignore[assignment]
    Order = object  # type: ignore[assignment]
    BarData = object  # type: ignore[assignment]
    OrderId = int  # type: ignore[assignment]
    TickerId = int  # type: ignore[assignment]
    IB_AVAILABLE = False
    logger.warning("ibapi not installed; IB features are unavailable.")


class _IBApiApp(EWrapper, EClient):
    def __init__(self) -> None:
        EWrapper.__init__(self)
        EClient.__init__(self, wrapper=self)
        self._lock = threading.Lock()
        self.connected_event = threading.Event()
        self.next_id_event = threading.Event()
        self.next_order_id: int | None = None

        self.account_summary_data: dict[int, dict] = {}
        self.account_summary_events: dict[int, threading.Event] = {}

        self.positions: list[dict] = []
        self.positions_event = threading.Event()

        self.market_data: dict[int, dict] = {}
        self.market_data_events: dict[int, threading.Event] = {}

        self.historical_data: dict[int, list[dict]] = {}
        self.historical_data_events: dict[int, threading.Event] = {}

        self.open_orders: dict[int, dict] = {}
        self.open_order_first_seen: dict[int, str] = {}
        self.open_orders_event = threading.Event()
        self.order_status: dict[int, str] = {}

        self.request_errors: dict[int, list[str]] = {}
        self.loop_error: str | None = None

    def start_loop(self) -> None:
        runner = getattr(self, "run", None)
        if not callable(runner):
            self.loop_error = "ibapi client loop method 'run' is unavailable. Verify ibapi is installed correctly."
            logger.error(self.loop_error)
            self.connected_event.set()
            self.next_id_event.set()
            return
        try:
            runner()
        except Exception as exc:
            self.loop_error = str(exc)
            logger.exception("IB network loop crashed: %s", exc)
            self.connected_event.set()
            self.next_id_event.set()

    def nextValidId(self, orderId: OrderId) -> None:
        with self._lock:
            self.next_order_id = int(orderId)
        self.connected_event.set()
        self.next_id_event.set()

    def error(
        self,
        reqId: int,
        errorCode: int,
        errorString: str,
        advancedOrderRejectJson: str = "",
    ) -> None:
        msg = f"[{errorCode}] {errorString}"
        with self._lock:
            self.request_errors.setdefault(int(reqId), []).append(msg)
        if errorCode not in (2104, 2106, 2158):
            logger.warning("IB error reqId=%s: %s", reqId, msg)

    def accountSummary(self, reqId: int, account: str, tag: str, value: str, currency: str) -> None:
        with self._lock:
            self.account_summary_data.setdefault(reqId, {})[tag] = {
                "value": value,
                "currency": currency,
            }

    def accountSummaryEnd(self, reqId: int) -> None:
        evt = self.account_summary_events.get(reqId)
        if evt is not None:
            evt.set()

    def position(self, account: str, contract: Any, pos: float, avgCost: float) -> None:
        with self._lock:
            self.positions.append(
                {
                    "symbol": contract.symbol,
                    "secType": contract.secType,
                    "exchange": contract.exchange,
                    "quantity": pos,
                    "avg_cost": round(avgCost, 4),
                    "market_value": round(pos * avgCost, 2),
                }
            )

    def positionEnd(self) -> None:
        self.positions_event.set()

    def tickPrice(self, reqId: TickerId, tickType: int, price: float, attrib) -> None:
        with self._lock:
            data = self.market_data.setdefault(int(reqId), {})
            if tickType == 1:
                data["bid"] = price
            elif tickType == 2:
                data["ask"] = price
            elif tickType == 4:
                data["last"] = price
            elif tickType == 9:
                data["close"] = price
            elif tickType == 14:
                data["open"] = price

    def tickSize(self, reqId: TickerId, tickType: int, size: int) -> None:
        if tickType == 8:
            with self._lock:
                data = self.market_data.setdefault(int(reqId), {})
                data["volume"] = size

    def tickSnapshotEnd(self, reqId: int) -> None:
        evt = self.market_data_events.get(reqId)
        if evt is not None:
            evt.set()

    def historicalData(self, reqId: int, bar: Any) -> None:
        with self._lock:
            self.historical_data.setdefault(reqId, []).append(
                {
                    "date": str(bar.date),
                    "open": bar.open,
                    "high": bar.high,
                    "low": bar.low,
                    "close": bar.close,
                    "volume": bar.volume,
                }
            )

    def historicalDataEnd(self, reqId: int, start: str, end: str) -> None:
        evt = self.historical_data_events.get(reqId)
        if evt is not None:
            evt.set()

    def openOrder(self, orderId: int, contract: Any, order: Any, orderState) -> None:
        with self._lock:
            created_at = self.open_order_first_seen.get(orderId)
            if created_at is None:
                created_at = datetime.now(timezone.utc).isoformat()
                self.open_order_first_seen[orderId] = created_at
            self.open_orders[orderId] = {
                "ib_order_id": orderId,
                "symbol": contract.symbol,
                "side": order.action,
                "quantity": float(order.totalQuantity),
                "remaining": float(order.totalQuantity),
                "filled": 0.0,
                "status": orderState.status,
                "order_type": getattr(order, "orderType", None),
                "limit_price": float(getattr(order, "lmtPrice", 0.0) or 0.0) if getattr(order, "orderType", "") == "LMT" else None,
                "tif": getattr(order, "tif", None),
                "created_at": created_at,
            }

    def openOrderEnd(self) -> None:
        self.open_orders_event.set()

    def orderStatus(
        self,
        orderId: OrderId,
        status: str,
        filled: float,
        remaining: float,
        avgFillPrice: float,
        permId: int,
        parentId: int,
        lastFillPrice: float,
        clientId: int,
        whyHeld: str,
        mktCapPrice: float,
    ) -> None:
        with self._lock:
            self.order_status[int(orderId)] = status
            if int(orderId) in self.open_orders:
                self.open_orders[int(orderId)]["status"] = status
                self.open_orders[int(orderId)]["filled"] = float(filled)
                self.open_orders[int(orderId)]["remaining"] = float(remaining)
                self.open_orders[int(orderId)]["avg_fill_price"] = float(avgFillPrice)


class IBService:
    def __init__(self) -> None:
        self._app: _IBApiApp | None = None
        self._thread: threading.Thread | None = None
        self._connected = False
        self._req_id_counter = 10_000
        self._lock = threading.Lock()

    def _next_req_id(self) -> int:
        with self._lock:
            self._req_id_counter += 1
            return self._req_id_counter

    async def _wait_event(self, event: threading.Event, timeout: float) -> bool:
        return await asyncio.to_thread(event.wait, timeout)

    def _is_running_in_docker(self) -> bool:
        return os.path.exists("/.dockerenv")

    def _effective_ib_host(self) -> str:
        host = (settings.IB_HOST or "").strip()
        if not host:
            return "127.0.0.1"
        if self._is_running_in_docker() and host in {"127.0.0.1", "localhost"}:
            # Inside containers, localhost points to the container itself.
            return "host.docker.internal"
        return host

    def _build_stock_contract(self, symbol: str) -> Any:
        contract = Contract()
        contract.symbol = symbol.upper()
        contract.secType = "STK"
        contract.exchange = "SMART"
        contract.currency = "USD"
        return contract

    def _pop_req_error(self, req_id: int) -> str | None:
        if not self._app:
            return None
        with self._app._lock:
            errs = self._app.request_errors.pop(req_id, None)
        if errs:
            return errs[-1]
        return None

    async def connect(self) -> dict:
        if not IB_AVAILABLE:
            return {"status": "error", "message": "ibapi not installed."}
        if self.is_connected:
            return {"status": "ok", "message": "Already connected."}

        try:
            app = _IBApiApp()
            effective_host = self._effective_ib_host()
            app.connect(effective_host, int(settings.IB_PORT), int(settings.IB_CLIENT_ID))
            thread = threading.Thread(target=app.start_loop, daemon=True, name="ibapi-loop")
            thread.start()

            connected = await self._wait_event(app.connected_event, timeout=10)
            got_id = await self._wait_event(app.next_id_event, timeout=10)
            if app.loop_error:
                app.disconnect()
                return {
                    "status": "error",
                    "message": f"IB client loop failed to start: {app.loop_error}",
                }
            if not connected or not got_id or not app.isConnected():
                app.disconnect()
                return {
                    "status": "error",
                    "message": f"Could not connect to Interactive Brokers at {effective_host}:{settings.IB_PORT}. Check host/port and that TWS or Gateway API socket is enabled.",
                }

            self._app = app
            self._thread = thread
            self._connected = True
            logger.info("Connected to IB on %s:%s", effective_host, settings.IB_PORT)
            return {"status": "ok", "message": "Connected to Interactive Brokers."}
        except Exception as exc:
            logger.error("IB connect failed: %s", exc)
            self._app = None
            self._thread = None
            self._connected = False
            return {
                "status": "error",
                "message": "Could not connect to Interactive Brokers. Check host/port and that TWS or Gateway API socket is enabled.",
            }

    async def disconnect(self) -> dict:
        if self._app is not None:
            try:
                self._app.disconnect()
                if self._thread and self._thread.is_alive():
                    await asyncio.to_thread(self._thread.join, 2)
            finally:
                self._app = None
                self._thread = None
                self._connected = False
        return {"status": "ok", "message": "Disconnected."}

    @property
    def is_connected(self) -> bool:
        return bool(self._connected and self._app is not None and self._app.isConnected())

    def connection_status(self) -> dict:
        return {
            "connected": self.is_connected,
            "host": settings.IB_HOST,
            "port": settings.IB_PORT,
            "client_id": settings.IB_CLIENT_ID,
            "mode": settings.TRADING_MODE,
            "market_data_type": settings.IB_MARKET_DATA_TYPE,
        }

    async def get_account_summary(self) -> dict:
        if not self.is_connected or not self._app:
            return {"error": "Not connected to IB."}
        req_id = self._next_req_id()
        evt = threading.Event()
        with self._app._lock:
            self._app.account_summary_data[req_id] = {}
            self._app.account_summary_events[req_id] = evt

        try:
            self._app.reqAccountSummary(
                req_id,
                "All",
                "$LEDGER:ALL,NetLiquidation,BuyingPower,AvailableFunds,TotalCashValue,"
                "GrossPositionValue,UnrealizedPnL,RealizedPnL",
            )
            done = await self._wait_event(evt, timeout=10)
            self._app.cancelAccountSummary(req_id)
            if not done:
                return {"error": "Timed out while fetching account summary."}

            with self._app._lock:
                result = dict(self._app.account_summary_data.get(req_id, {}))
            if not result:
                err = self._pop_req_error(req_id)
                if err:
                    return {"error": f"Failed to retrieve account summary: {err}"}
            return result
        except Exception as exc:
            logger.error("get_account_summary error: %s", exc)
            return {"error": "Failed to retrieve account summary."}
        finally:
            with self._app._lock:
                self._app.account_summary_events.pop(req_id, None)
                self._app.account_summary_data.pop(req_id, None)

    async def get_positions(self) -> list[dict]:
        if not self.is_connected or not self._app:
            return []
        try:
            self._app.positions_event.clear()
            with self._app._lock:
                self._app.positions = []
            self._app.reqPositions()
            done = await self._wait_event(self._app.positions_event, timeout=10)
            self._app.cancelPositions()
            if not done:
                return []
            with self._app._lock:
                return list(self._app.positions)
        except Exception as exc:
            logger.error("get_positions error: %s", exc)
            return []

    async def get_market_data(self, symbol: str) -> dict:
        if not self.is_connected or not self._app:
            return {"error": "Not connected to IB."}
        req_id = self._next_req_id()
        evt = threading.Event()
        with self._app._lock:
            self._app.market_data[req_id] = {}
            self._app.market_data_events[req_id] = evt
        try:
            contract = self._build_stock_contract(symbol)
            # Prefer delayed feed by default for accounts without paid real-time subscriptions.
            self._app.reqMarketDataType(int(settings.IB_MARKET_DATA_TYPE))
            self._app.reqMktData(req_id, contract, "", True, False, [])
            await self._wait_event(evt, timeout=6)
            self._app.cancelMktData(req_id)
            with self._app._lock:
                data = dict(self._app.market_data.get(req_id, {}))
            if not data:
                err = self._pop_req_error(req_id)
                if err:
                    return {"error": f"Failed to retrieve market data: {err}"}
                return {"error": "No ticker data."}
            return {
                "symbol": symbol.upper(),
                "bid": data.get("bid"),
                "ask": data.get("ask"),
                "last": data.get("last"),
                "close": data.get("close"),
                "volume": data.get("volume"),
                "halted": None,
            }
        except Exception as exc:
            logger.error("get_market_data error: %s", exc)
            return {"error": "Failed to retrieve market data."}
        finally:
            with self._app._lock:
                self._app.market_data_events.pop(req_id, None)
                self._app.market_data.pop(req_id, None)

    async def get_historical_bars(
        self,
        symbol: str,
        duration: str = "1 Y",
        bar_size: str = "1 day",
    ) -> list[dict]:
        if not self.is_connected:
            return []
        return await self.get_historical_bars_request(
            symbol=symbol,
            end_datetime="",
            duration=duration,
            bar_size=bar_size,
            what_to_show="ADJUSTED_LAST",
            use_rth=True,
        )

    async def get_historical_bars_range(
        self,
        symbol: str,
        start: str,
        end: str,
        bar_size: str = "1 day",
    ) -> list[dict]:
        start_dt = date.fromisoformat(start)
        end_dt = date.fromisoformat(end)
        delta_days = max((end_dt - start_dt).days, 1)
        duration = f"{delta_days} D"
        end_datetime = f"{end_dt.strftime('%Y%m%d')} 23:59:59"
        return await self.get_historical_bars_request(
            symbol=symbol,
            end_datetime=end_datetime,
            duration=duration,
            bar_size=bar_size,
            what_to_show="ADJUSTED_LAST",
            use_rth=True,
        )

    async def get_historical_bars_request(
        self,
        symbol: str,
        end_datetime: str,
        duration: str,
        bar_size: str,
        what_to_show: str,
        use_rth: bool,
    ) -> list[dict]:
        meta = await self.get_historical_bars_request_meta(
            symbol=symbol,
            end_datetime=end_datetime,
            duration=duration,
            bar_size=bar_size,
            what_to_show=what_to_show,
            use_rth=use_rth,
        )
        return list(meta.get("bars", []))

    async def get_historical_bars_request_meta(
        self,
        symbol: str,
        end_datetime: str,
        duration: str,
        bar_size: str,
        what_to_show: str,
        use_rth: bool,
    ) -> dict[str, Any]:
        if not self.is_connected or not self._app:
            return {
                "bars": [],
                "timed_out": False,
                "error": "Not connected to IB.",
                "error_code": None,
            }
        req_id = self._next_req_id()
        evt = threading.Event()
        with self._app._lock:
            self._app.historical_data[req_id] = []
            self._app.historical_data_events[req_id] = evt

        try:
            contract = self._build_stock_contract(symbol)
            self._app.reqHistoricalData(
                req_id,
                contract,
                end_datetime,
                duration,
                bar_size,
                what_to_show,
                1 if use_rth else 0,
                1,
                False,
                [],
            )
            done = await self._wait_event(evt, timeout=20)
            self._app.cancelHistoricalData(req_id)
            if not done:
                logger.warning("Historical data request timed out for %s", symbol)
            with self._app._lock:
                bars = list(self._app.historical_data.get(req_id, []))
            err = self._pop_req_error(req_id)
            if not bars and err:
                logger.warning("Historical data request failed for %s: %s", symbol, err)
            if not bars and not done and not err:
                err = "Historical data request timed out."

            err_code: int | None = None
            if err:
                match = re.search(r"\[(\d+)\]", err)
                if match:
                    try:
                        err_code = int(match.group(1))
                    except ValueError:
                        err_code = None

            return {
                "bars": bars,
                "timed_out": not done,
                "error": err,
                "error_code": err_code,
            }
        except Exception as exc:
            logger.error("get_historical_bars error: %s", exc)
            return {
                "bars": [],
                "timed_out": False,
                "error": f"Failed to retrieve historical bars: {exc}",
                "error_code": None,
            }
        finally:
            with self._app._lock:
                self._app.historical_data_events.pop(req_id, None)
                self._app.historical_data.pop(req_id, None)

    async def place_order(
        self,
        symbol: str,
        side: str,
        quantity: float,
        order_type: str = "MKT",
        limit_price: float | None = None,
    ) -> dict:
        if not self.is_connected or not self._app:
            return {"error": "Not connected to IB."}
        try:
            action = side.upper()
            kind = order_type.upper()
            if action not in {"BUY", "SELL"}:
                return {"error": "side must be BUY or SELL."}
            if kind == "LMT" and limit_price is None:
                return {"error": "limit_price is required for LMT orders."}

            contract = self._build_stock_contract(symbol)
            order = Order()
            order.action = action
            order.totalQuantity = float(quantity)
            order.orderType = kind
            order.tif = "DAY"
            # Some IB server builds reject legacy routing flags when present.
            # Explicitly disable them for broad compatibility.
            if hasattr(order, "eTradeOnly"):
                order.eTradeOnly = False
            if hasattr(order, "firmQuoteOnly"):
                order.firmQuoteOnly = False
            if kind == "LMT" and limit_price is not None:
                order.lmtPrice = float(limit_price)

            with self._app._lock:
                if self._app.next_order_id is None:
                    return {"error": "IB did not provide next valid order id."}
                order_id = int(self._app.next_order_id)
                self._app.next_order_id += 1

            self._app.placeOrder(order_id, contract, order)

            status = "Submitted"
            for _ in range(15):
                await asyncio.sleep(0.2)
                err = self._pop_req_error(order_id)
                if err:
                    return {"error": f"IB rejected order {order_id}: {err}"}
                with self._app._lock:
                    if order_id in self._app.order_status:
                        status = self._app.order_status[order_id]
                        break

            if status in {"Inactive", "Cancelled", "ApiCancelled"}:
                err = self._pop_req_error(order_id)
                if err:
                    return {"error": f"IB order {order_id} {status}: {err}"}
                return {"error": f"IB order {order_id} {status}. Check TWS/Gateway logs for details."}

            return {
                "ib_order_id": order_id,
                "status": status,
                "symbol": symbol.upper(),
                "side": action,
                "quantity": quantity,
                "order_type": kind,
                "limit_price": float(limit_price) if (kind == "LMT" and limit_price is not None) else None,
            }
        except Exception as exc:
            logger.error("place_order error: %s", exc)
            return {"error": "Failed to place order with Interactive Brokers."}

    async def cancel_order(self, ib_order_id: int) -> dict:
        if not self.is_connected or not self._app:
            return {"error": "Not connected to IB."}
        try:
            order_id = int(ib_order_id)
            # ibapi changed cancelOrder signatures across versions.
            # Try modern (orderId, manualCancelTime) first, then legacy (orderId).
            try:
                self._app.cancelOrder(order_id, "")
            except TypeError:
                self._app.cancelOrder(order_id)
            return {"status": "ok", "cancelled": ib_order_id}
        except Exception as exc:
            logger.error("cancel_order error: %s", exc)
            return {"error": f"Failed to cancel order: {exc}"}

    async def get_open_orders(self) -> list[dict]:
        if not self.is_connected or not self._app:
            return []
        try:
            self._app.open_orders_event.clear()
            with self._app._lock:
                self._app.open_orders = {}

            self._app.reqAllOpenOrders()
            await self._wait_event(self._app.open_orders_event, timeout=8)
            with self._app._lock:
                return list(self._app.open_orders.values())
        except Exception as exc:
            logger.error("get_open_orders error: %s", exc)
            return []


ib_service = IBService()
