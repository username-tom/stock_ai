"""Interactive Brokers integration using the official ibapi package."""
from __future__ import annotations

import asyncio
import logging
import math
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
    from ibapi.execution import ExecutionFilter
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
    ExecutionFilter = object  # type: ignore[assignment]
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

        # Account code(s) reported by IB on connect; required for reqPnL.
        self.managed_accounts: list[str] = []
        # Account-level PnL (reqPnL) keyed by reqId: dailyPnL/unrealizedPnL/realizedPnL.
        self.pnl_data: dict[int, dict] = {}
        self.pnl_events: dict[int, threading.Event] = {}
        # Per-position PnL (reqPnLSingle) keyed by reqId: value/unrealizedPnL etc.
        self.pnl_single_data: dict[int, dict] = {}
        self.pnl_single_events: dict[int, threading.Event] = {}

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
        self.order_avg_fill_price: dict[int, float] = {}

        # Executions + commission reports (authoritative realized PnL per fill).
        # Keyed by reqId for the execution list; commission reports are keyed by
        # execId and joined to executions after execDetailsEnd.
        self.executions: dict[int, list[dict]] = {}
        self.executions_event: dict[int, threading.Event] = {}
        self.commission_reports: dict[str, dict] = {}

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

    def managedAccounts(self, accountsList: str) -> None:
        accounts = [a.strip() for a in str(accountsList or "").split(",") if a.strip()]
        with self._lock:
            self.managed_accounts = accounts

    def pnl(self, reqId: int, dailyPnL: float, unrealizedPnL: float, realizedPnL: float) -> None:
        with self._lock:
            self.pnl_data[reqId] = {
                "daily_pnl": float(dailyPnL) if dailyPnL is not None else None,
                "unrealized_pnl": float(unrealizedPnL) if unrealizedPnL is not None else None,
                "realized_pnl": float(realizedPnL) if realizedPnL is not None else None,
            }
        evt = self.pnl_events.get(reqId)
        if evt is not None:
            evt.set()

    def pnlSingle(
        self,
        reqId: int,
        pos,
        dailyPnL: float,
        unrealizedPnL: float,
        realizedPnL: float,
        value: float,
    ) -> None:
        with self._lock:
            self.pnl_single_data[reqId] = {
                "pos": float(pos) if pos is not None else None,
                "daily_pnl": float(dailyPnL) if dailyPnL is not None else None,
                "unrealized_pnl": float(unrealizedPnL) if unrealizedPnL is not None else None,
                "realized_pnl": float(realizedPnL) if realizedPnL is not None else None,
                "value": float(value) if value is not None else None,
            }
        evt = self.pnl_single_events.get(reqId)
        if evt is not None:
            evt.set()

    def error(
        self,
        reqId: int,
        errorCode: int,
        errorString: str,
        advancedOrderRejectJson: str = "",
    ) -> None:
        msg = f"[{errorCode}] {errorString}"
        # Codes >= 2000 are informational warnings from IB (not hard rejections).
        # Only store genuine errors (< 2000) in request_errors so they can
        # surface to callers.  Still log all non-noise codes for visibility.
        _noise_codes = {2104, 2106, 2158}
        if errorCode not in _noise_codes:
            logger.warning("IB error reqId=%s: %s", reqId, msg)
        if errorCode < 2000:
            with self._lock:
                self.request_errors.setdefault(int(reqId), []).append(msg)

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
                    "con_id": getattr(contract, "conId", None),
                    "quantity": pos,
                    "avg_cost": round(avgCost, 4),
                    "market_price": None,
                    "last_price": None,
                    "market_value": None,
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
            # Delayed quote feed equivalents (IB tick IDs 66/67/68).
            elif tickType == 66 and "bid" not in data:
                data["bid"] = price
            elif tickType == 67 and "ask" not in data:
                data["ask"] = price
            elif tickType == 68 and "last" not in data:
                data["last"] = price

    def tickSize(self, reqId: TickerId, tickType: int, size: int) -> None:
        with self._lock:
            data = self.market_data.setdefault(int(reqId), {})
            if tickType == 0:
                data["bid_size"] = size
            elif tickType == 3:
                data["ask_size"] = size
            elif tickType == 8:
                data["volume"] = size
            elif tickType == 69 and "bid_size" not in data:
                data["bid_size"] = size
            elif tickType == 70 and "ask_size" not in data:
                data["ask_size"] = size

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
            if float(avgFillPrice or 0.0) > 0:
                self.order_avg_fill_price[int(orderId)] = float(avgFillPrice)
            if int(orderId) in self.open_orders:
                self.open_orders[int(orderId)]["status"] = status
                self.open_orders[int(orderId)]["filled"] = float(filled)
                self.open_orders[int(orderId)]["remaining"] = float(remaining)
                self.open_orders[int(orderId)]["avg_fill_price"] = float(avgFillPrice)

    def execDetails(self, reqId: int, contract: Any, execution: Any) -> None:
        try:
            row = {
                "exec_id": str(getattr(execution, "execId", "") or ""),
                "symbol": str(getattr(contract, "symbol", "") or "").upper(),
                "side": str(getattr(execution, "side", "") or "").upper(),  # BOT / SLD
                "shares": float(getattr(execution, "shares", 0.0) or 0.0),
                "price": float(getattr(execution, "price", 0.0) or 0.0),
                "perm_id": int(getattr(execution, "permId", 0) or 0),
                "order_id": int(getattr(execution, "orderId", 0) or 0),
                "time": str(getattr(execution, "time", "") or ""),
                "realized_pnl": None,
                "commission": None,
            }
        except Exception:
            return
        with self._lock:
            self.executions.setdefault(int(reqId), []).append(row)

    def execDetailsEnd(self, reqId: int) -> None:
        evt = self.executions_event.get(int(reqId))
        if evt is not None:
            evt.set()

    def commissionReport(self, commissionReport: Any) -> None:
        try:
            exec_id = str(getattr(commissionReport, "execId", "") or "")
            if not exec_id:
                return
            realized = getattr(commissionReport, "realizedPNL", None)
            commission = getattr(commissionReport, "commission", None)
            # IB sends DBL_MAX (~1.79e308) for realizedPNL on opening trades.
            realized_val = (
                None
                if realized is None or abs(float(realized)) >= 1.0e307
                else float(realized)
            )
            commission_val = (
                None
                if commission is None or abs(float(commission)) >= 1.0e307
                else float(commission)
            )
        except Exception:
            return
        with self._lock:
            self.commission_reports[exec_id] = {
                "realized_pnl": realized_val,
                "commission": commission_val,
            }


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

    def _snap_stock_limit_price(self, raw_price: float, side: str) -> float:
        """Snap stock LMT prices to common IB-valid increments.

        For US equities routed via SMART this avoids IB error 110 by
        conforming to penny ticks (or sub-penny for sub-$1 names).
        """
        price = float(raw_price or 0.0)
        if price <= 0.0:
            return 0.0
        tick = 0.01 if price >= 1.0 else 0.0001
        scaled = price / tick
        side_u = str(side or "").upper()
        if side_u == "BUY":
            snapped_ticks = math.ceil(scaled - 1e-12)
        else:
            snapped_ticks = math.floor(scaled + 1e-12)
        snapped = max(tick, snapped_ticks * tick)
        decimals = 2 if tick >= 0.01 else 4
        return round(snapped, decimals)

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

    async def get_account_pnl(self) -> dict:
        """Return IB's authoritative account-level PnL via reqPnL.

        Mirrors the figures shown in TWS:
          - daily_pnl:      today's total P&L (realized + unrealized)
          - realized_pnl:   today's realized P&L
          - unrealized_pnl: current open-position P&L

        These are IB's own calculations (cost basis, marks, commissions) and are
        the only way to match what the user sees in their IB account window.
        """
        if not self.is_connected or not self._app:
            return {"error": "Not connected to IB."}

        with self._app._lock:
            accounts = list(self._app.managed_accounts)
        account = accounts[0] if accounts else None
        if not account:
            return {"error": "No managed IB account available for PnL request."}

        req_id = self._next_req_id()
        evt = threading.Event()
        with self._app._lock:
            self._app.pnl_data.pop(req_id, None)
            self._app.pnl_events[req_id] = evt

        try:
            self._app.reqPnL(req_id, account, "")
            done = await self._wait_event(evt, timeout=10)
            try:
                self._app.cancelPnL(req_id)
            except Exception:
                pass
            if not done:
                err = self._pop_req_error(req_id)
                return {"error": err or "Timed out while fetching account PnL."}
            with self._app._lock:
                result = dict(self._app.pnl_data.get(req_id, {}))
            if not result:
                return {"error": "No PnL data returned."}
            # IB sends DBL_MAX (~1.7976931348623157e+308) for fields that are not
            # yet computed; treat those as missing rather than passing the
            # sentinel through as a real (astronomically large) PnL value.
            _IB_UNSET = 1.0e307
            cleaned: dict = {}
            for key in ("daily_pnl", "unrealized_pnl", "realized_pnl"):
                val = result.get(key)
                cleaned[key] = None if (val is None or abs(float(val)) >= _IB_UNSET) else float(val)
            logger.info(
                "IB account PnL for %s: daily=%s realized=%s unrealized=%s",
                account, cleaned["daily_pnl"], cleaned["realized_pnl"], cleaned["unrealized_pnl"],
            )
            return cleaned
        except Exception as exc:
            logger.error("get_account_pnl error: %s", exc)
            return {"error": "Failed to retrieve account PnL."}
        finally:
            with self._app._lock:
                self._app.pnl_events.pop(req_id, None)
                self._app.pnl_data.pop(req_id, None)

    async def get_executions(self) -> list[dict]:
        """Return today's IB executions with IB's own realized PnL per fill.

        Uses ``reqExecutions`` + ``commissionReport`` so realized P&L matches the
        TWS account window exactly (IB cost basis, FIFO, commissions). IB only
        returns executions for the current trading day, so this is the
        authoritative source for *today's* realized gain and for backfilling the
        local trade ledger. Each row: symbol, side (BUY/SELL), shares, price,
        order_id, perm_id, time, realized_pnl (None for opening fills),
        commission.
        """
        if not self.is_connected or not self._app:
            return []

        req_id = self._next_req_id()
        evt = threading.Event()
        with self._app._lock:
            self._app.executions.pop(req_id, None)
            self._app.executions_event[req_id] = evt

        try:
            self._app.reqExecutions(req_id, ExecutionFilter())
            done = await self._wait_event(evt, timeout=10)
            if not done:
                return []
            # commissionReport callbacks may arrive immediately after
            # execDetailsEnd; give them a brief window to populate.
            await asyncio.sleep(0.3)
            with self._app._lock:
                rows = [dict(r) for r in self._app.executions.get(req_id, [])]
                reports = dict(self._app.commission_reports)

            for row in rows:
                rep = reports.get(row.get("exec_id", ""))
                if rep:
                    row["realized_pnl"] = rep.get("realized_pnl")
                    row["commission"] = rep.get("commission")
                # Normalize IB side codes (BOT/SLD) to BUY/SELL.
                side = str(row.get("side") or "").upper()
                row["side"] = "BUY" if side in {"BOT", "BUY"} else "SELL" if side in {"SLD", "SELL"} else side
            return rows
        except Exception as exc:
            logger.error("get_executions error: %s", exc)
            return []
        finally:
            with self._app._lock:
                self._app.executions_event.pop(req_id, None)
                self._app.executions.pop(req_id, None)

    async def get_positions_pnl(self) -> dict[str, dict]:
        """Return IB's authoritative per-position PnL via reqPnLSingle.

        ``pnlSingle`` reports each position's current market ``value`` and
        ``unrealizedPnL`` using IB's own marks and cost basis, so the per-symbol
        figures sum exactly to the account-level ``UnrealizedPnL`` (and
        ``GrossPositionValue``). This keeps the breakdown table rows and their
        footer total consistent with IB. Returns
        ``{symbol: {unrealized_pnl, market_value, market_price, quantity}}``.
        """
        if not self.is_connected or not self._app:
            return {}
        with self._app._lock:
            accounts = list(self._app.managed_accounts)
        account = accounts[0] if accounts else None
        if not account:
            return {}

        positions = await self.get_positions()
        out: dict[str, dict] = {}
        _IB_UNSET = 1.0e307
        for p in positions:
            con_id = p.get("con_id")
            symbol = str(p.get("symbol") or "").upper()
            qty = float(p.get("quantity") or 0.0)
            if not con_id or not symbol or qty == 0.0:
                continue
            req_id = self._next_req_id()
            evt = threading.Event()
            with self._app._lock:
                self._app.pnl_single_data.pop(req_id, None)
                self._app.pnl_single_events[req_id] = evt
            try:
                self._app.reqPnLSingle(req_id, account, "", int(con_id))
                done = await self._wait_event(evt, timeout=5)
                try:
                    self._app.cancelPnLSingle(req_id)
                except Exception:
                    pass
                if not done:
                    continue
                with self._app._lock:
                    data = dict(self._app.pnl_single_data.get(req_id, {}))
            except Exception as exc:
                logger.warning("get_positions_pnl error for %s: %s", symbol, exc)
                continue
            finally:
                with self._app._lock:
                    self._app.pnl_single_events.pop(req_id, None)
                    self._app.pnl_single_data.pop(req_id, None)

            unreal = data.get("unrealized_pnl")
            value = data.get("value")
            unreal = None if (unreal is None or abs(float(unreal)) >= _IB_UNSET) else float(unreal)
            value = None if (value is None or abs(float(value)) >= _IB_UNSET) else float(value)
            market_price = (value / qty) if (value is not None and qty != 0.0) else None
            out[symbol] = {
                "unrealized_pnl": unreal,
                "market_value": value,
                "market_price": market_price,
                "quantity": qty,
            }
        return out

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
                "bid_size": data.get("bid_size"),
                "ask_size": data.get("ask_size"),
                "last": data.get("last"),
                "close": data.get("close"),
                "volume": data.get("volume"),
                "market_data_type": settings.IB_MARKET_DATA_TYPE,
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
        timeout_s: float = 20.0,
    ) -> list[dict]:
        meta = await self.get_historical_bars_request_meta(
            symbol=symbol,
            end_datetime=end_datetime,
            duration=duration,
            bar_size=bar_size,
            what_to_show=what_to_show,
            use_rth=use_rth,
            timeout_s=timeout_s,
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
        timeout_s: float = 20.0,
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
            wait_timeout = max(1.0, float(timeout_s))
            done = await self._wait_event(evt, timeout=wait_timeout)
            self._app.cancelHistoricalData(req_id)
            if not done:
                logger.warning(
                    "Historical data request timed out for %s (duration=%s bar_size=%s timeout=%.1fs)",
                    symbol,
                    duration,
                    bar_size,
                    wait_timeout,
                )
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
            logger.info(
                "IB place_order request (symbol=%s side=%s qty=%.4f type=%s limit=%s mode=%s)",
                symbol.upper(),
                action,
                float(quantity),
                kind,
                (f"{float(limit_price):.4f}" if limit_price is not None else "-"),
                settings.TRADING_MODE,
            )
            if action not in {"BUY", "SELL"}:
                return {"error": "side must be BUY or SELL."}
            if kind == "LMT" and limit_price is None:
                return {"error": "limit_price is required for LMT orders."}

            # Disallow opening/increasing short positions: SELL requires owned long shares.
            if action == "SELL":
                try:
                    positions = await self.get_positions()
                    owned_qty = 0.0
                    target = symbol.upper()
                    for pos in positions:
                        if str(pos.get("symbol") or "").upper() != target:
                            continue
                        owned_qty = float(pos.get("quantity") or 0.0)
                        break

                    sell_qty = float(quantity)
                    if owned_qty <= 0 or sell_qty - owned_qty > 1e-9:
                        return {
                            "error": (
                                f"Short selling disabled: cannot SELL {sell_qty:.4f} {target} "
                                f"with owned quantity {max(owned_qty, 0.0):.4f}."
                            )
                        }
                except Exception as exc:
                    logger.warning("SELL ownership check failed for %s: %s", symbol.upper(), exc)
                    return {"error": "Unable to verify owned shares before SELL order."}

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
                requested_limit = float(limit_price)
                snapped_limit = self._snap_stock_limit_price(requested_limit, action)
                if snapped_limit <= 0.0:
                    return {"error": f"Invalid limit price for {symbol.upper()}: {requested_limit}"}
                if abs(snapped_limit - requested_limit) > 1e-9:
                    logger.info(
                        "IB LMT price snapped (symbol=%s side=%s requested=%.6f snapped=%.6f)",
                        symbol.upper(),
                        action,
                        requested_limit,
                        snapped_limit,
                    )
                limit_price = snapped_limit
                order.lmtPrice = snapped_limit

            with self._app._lock:
                if self._app.next_order_id is None:
                    return {"error": "IB did not provide next valid order id."}
                order_id = int(self._app.next_order_id)
                self._app.next_order_id += 1

            self._app.placeOrder(order_id, contract, order)
            logger.info("IB placeOrder submitted (ib_order_id=%s symbol=%s)", order_id, symbol.upper())

            status = "Submitted"
            for _ in range(15):
                await asyncio.sleep(0.2)
                err = self._pop_req_error(order_id)
                if err:
                    logger.warning("IB order rejected (ib_order_id=%s error=%s)", order_id, err)
                    return {"error": f"IB rejected order {order_id}: {err}"}
                with self._app._lock:
                    if order_id in self._app.order_status:
                        status = self._app.order_status[order_id]
                        break

            if status in {"Inactive", "Cancelled", "ApiCancelled"}:
                err = self._pop_req_error(order_id)
                if err:
                    logger.warning("IB order not active (ib_order_id=%s status=%s error=%s)", order_id, status, err)
                    return {"error": f"IB order {order_id} {status}: {err}"}
                logger.warning("IB order not active (ib_order_id=%s status=%s)", order_id, status)
                return {"error": f"IB order {order_id} {status}. Check TWS/Gateway logs for details."}

            logger.info("IB order status observed (ib_order_id=%s status=%s)", order_id, status)
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
            logger.info("IB cancel_order request (ib_order_id=%s)", order_id)
            # ibapi changed cancelOrder signatures across versions.
            # Try modern (orderId, manualCancelTime) first, then legacy (orderId).
            try:
                self._app.cancelOrder(order_id, "")
            except TypeError:
                self._app.cancelOrder(order_id)
            logger.info("IB cancel_order submitted (ib_order_id=%s)", order_id)
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

    def get_known_order_statuses(self) -> dict[int, str]:
        """Return latest order statuses observed from IB callbacks."""
        if not self._app:
            return {}
        with self._app._lock:
            return {
                int(order_id): str(status)
                for order_id, status in self._app.order_status.items()
            }

    def get_known_order_fill_prices(self) -> dict[int, float]:
        """Return latest average fill prices observed from IB callbacks."""
        if not self._app:
            return {}
        with self._app._lock:
            return {
                int(order_id): float(price)
                for order_id, price in self._app.order_avg_fill_price.items()
                if float(price or 0.0) > 0.0
            }


ib_service = IBService()
