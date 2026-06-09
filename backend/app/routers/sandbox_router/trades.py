"""Trade execution and analytics endpoints."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.models.sandbox import SandboxAccount, SandboxPosition, SandboxTrade, SandboxAllocationEvent
from app.models.trade import Trade, TradingMode
from app.routers.sandbox_router._helpers import (
    get_account,
    position_dict,
    compute_available_cash,
    ensure_sandbox_write_allowed,
    offload_simulated_state,
)
from app.services.ib_service import ib_service
from app.services.market_calendar import count_nyse_trading_days
from app.services.local_storage import (
    save_trade_logs_csv, save_trade_logs_json, list_trade_log_files,
    records_to_csv_bytes, records_to_json_bytes,
)

router = APIRouter()


def _position_committed_funds(pos: SandboxPosition) -> float:
    settled_cost = float(pos.shares or 0.0) * float(pos.avg_cost or 0.0)
    pending_cost = float(pos.pending_shares or 0.0) * float(pos.pending_avg_cost or 0.0)
    allocated = float(pos.allocated_funds or 0.0)
    return allocated + settled_cost + pending_cost


def _position_max_allocation(pos: SandboxPosition, account_total_funds: float) -> float:
    cap_val = float(getattr(pos, "max_allocation_value", 0.0) or 0.0)
    if cap_val <= 0:
        return float("inf")
    mode = getattr(pos, "max_allocation_mode", "dollar") or "dollar"
    if mode == "percent":
        base = max(0.0, float(account_total_funds or 0.0))
        return (base * cap_val) / 100.0
    return cap_val


class TradeRequest(BaseModel):
    symbol: str
    side: str = Field(..., pattern="^(BUY|SELL)$")
    quantity: float = Field(..., gt=0)
    price: float = Field(..., gt=0)
    strategy_name: Optional[str] = None
    reason: Optional[str] = None


@router.post("/trade")
async def place_trade(req: TradeRequest, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed()
    symbol = req.symbol.upper()
    side   = req.side.upper()
    total  = req.quantity * req.price

    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, f"Symbol {symbol} not in sandbox. Add it first.")

    pnl = None

    if side == "BUY":
        # How much extra cash must be pulled from the account's unallocated pool?
        shortfall = round(max(0.0, total - pos.allocated_funds), 4)
        account = await get_account(db)
        all_pos_res = await db.execute(select(SandboxPosition))
        all_positions = all_pos_res.scalars().all()
        account_available = await compute_available_cash(db, account, all_positions)
        if shortfall > account_available:
            raise HTTPException(
                400,
                f"Insufficient funds. Position: ${pos.allocated_funds:.2f}, "
                f"Account available: ${account_available:.2f}, Need: ${total:.2f}"
            )

        max_cap = _position_max_allocation(pos, float(account.total_funds or 0.0))
        committed = _position_committed_funds(pos)
        cap_room = max(0.0, max_cap - committed) if max_cap != float("inf") else float("inf")
        if shortfall > cap_room:
            raise HTTPException(
                400,
                (
                    "Buy exceeds allocation guardrail. "
                    f"Cap: ${max_cap:.2f}, Committed: ${committed:.2f}, "
                    f"Additional required: ${shortfall:.2f}, Remaining room: ${cap_room:.2f}"
                ),
            )

        if shortfall > 0:
            # Draw shortfall from the unallocated pool into this position
            pos.allocated_funds += shortfall
            db.add(SandboxAllocationEvent(
                event_type="deploy",
                from_symbol=None,
                to_symbol=symbol,
                amount=shortfall,
                note="Manual BUY: draw from unallocated pool",
            ))
        new_shares = pos.shares + req.quantity
        pos.avg_cost = (pos.avg_cost * pos.shares + total) / new_shares
        pos.shares = new_shares
        pos.allocated_funds -= total
        pos.total_invested += total
        # Note: total_funds is unchanged — cash is now equity (shares × avg_cost)
    elif side == "SELL":
        if pos.shares < req.quantity:
            raise HTTPException(400, f"Insufficient shares. Held: {pos.shares}, Sell: {req.quantity}")
        pnl = round((req.price - pos.avg_cost) * req.quantity, 4)
        pos.shares -= req.quantity
        pos.allocated_funds += total
        pos.realized_pnl += pnl
        if pos.shares == 0:
            pos.avg_cost = 0.0
        # Realized P/L changes total_funds: gains add to cash, losses reduce it.
        account = await get_account(db)
        account.total_funds += pnl

    trade = SandboxTrade(
        symbol=symbol,
        side=side,
        quantity=req.quantity,
        price=req.price,
        total=total,
        strategy_name=req.strategy_name or pos.strategy_name,
        reason=req.reason,
        pnl=pnl,
    )
    db.add(trade)
    await db.commit()
    await db.refresh(trade)
    await db.refresh(pos)
    await offload_simulated_state(db)

    return {
        "trade_id": trade.id,
        "symbol": symbol,
        "side": side,
        "quantity": req.quantity,
        "price": req.price,
        "total": total,
        "pnl": pnl,
        "position": position_dict(pos),
    }


@router.get("/trades")
async def get_trades(
    symbol: Optional[str] = None,
    limit: int = 200,
    profile: Optional[str] = Query(default=None, pattern=r"^(simulated|paper|live)$"),
    db: AsyncSession = Depends(get_db),
):
    requested_profile = (profile or ("paper" if ib_service.is_connected else "simulated") or "simulated").lower()
    if ib_service.is_connected and requested_profile != "simulated":
        return {"trades": [], "source": "ib"}

    q = select(SandboxTrade).order_by(SandboxTrade.created_at.desc())
    if int(limit or 0) > 0:
        q = q.limit(limit)
    if symbol:
        q = q.where(SandboxTrade.symbol == symbol.upper())
    result = await db.execute(q)
    trades = result.scalars().all()
    return {
        "trades": [
            {
                "id": t.id,
                "symbol": t.symbol,
                "side": t.side,
                "quantity": t.quantity,
                "price": t.price,
                "total": t.total,
                "strategy_name": t.strategy_name,
                "reason": t.reason,
                "pnl": t.pnl,
                "created_at": t.created_at.astimezone().isoformat() if t.created_at else None,
            }
            for t in trades
        ]
    }


@router.get("/analytics")
async def get_analytics(
    profile: Optional[str] = Query(default=None, pattern=r"^(simulated|paper|live)$"),
    db: AsyncSession = Depends(get_db),
):
    """Time-series analytics derived from trade history."""
    requested_profile = (profile or ("paper" if ib_service.is_connected else "simulated") or "simulated").lower()
    use_ib = requested_profile in {"paper", "live"}

    def _status_text(value) -> str:
        raw = getattr(value, "value", value)
        return str(raw or "").upper()

    def _normalize_realized_pnl_rows(rows, created_at_fn, side_fn, qty_fn, price_fn, pnl_fn, status_fn):
        """Return trade-id -> normalized realized pnl for FILLED SELL rows.

        Uses explicit pnl when available, but in IB flows explicit pnl can be 0.0
        despite a known realized outcome. In that case we derive from reconstructed
        average cost basis built from filled trade sequence.
        """
        state_by_symbol: dict[str, dict[str, float]] = {}
        by_id: dict[int, float | None] = {}

        for t in rows:
            tid = int(getattr(t, "id", 0) or 0)
            side = str(side_fn(t) or "").upper()
            qty = float(qty_fn(t) or 0.0)
            px = float(price_fn(t) or 0.0)
            sym = str(getattr(t, "symbol", "") or "").upper()
            status = str(status_fn(t) or "").upper()

            explicit_raw = pnl_fn(t)
            explicit = float(explicit_raw) if explicit_raw is not None else None

            if not sym or qty <= 0.0 or px <= 0.0 or status != "FILLED":
                by_id[tid] = None
                continue

            st = state_by_symbol.get(sym) or {"qty": 0.0, "avg": 0.0}
            derived: float | None = None

            if side == "BUY":
                if st["qty"] >= 0.0:
                    next_qty = st["qty"] + qty
                    st["avg"] = ((st["avg"] * st["qty"]) + (px * qty)) / next_qty if next_qty > 0 else 0.0
                    st["qty"] = next_qty
                else:
                    # Covering a short; if crossing to long, new long basis is this buy price.
                    if abs(st["qty"]) > qty:
                        st["qty"] += qty
                    elif abs(st["qty"]) == qty:
                        st["qty"] = 0.0
                        st["avg"] = 0.0
                    else:
                        rem = qty - abs(st["qty"])
                        st["qty"] = rem
                        st["avg"] = px
            elif side == "SELL":
                if st["qty"] > 0.0 and st["avg"] > 0.0:
                    close_qty = min(qty, st["qty"])
                    if close_qty > 0.0:
                        derived = round((px - st["avg"]) * close_qty, 4)
                    st["qty"] -= close_qty
                    if st["qty"] <= 0.0:
                        st["avg"] = 0.0
                else:
                    # Opening/adding short inventory (should be rare/disabled).
                    cur_short = abs(min(st["qty"], 0.0))
                    next_short = cur_short + qty
                    st["qty"] = -next_short
                    st["avg"] = ((st["avg"] * cur_short) + (px * qty)) / next_short if next_short > 0 else 0.0

            state_by_symbol[sym] = st

            normalized = None
            if explicit is not None:
                if derived is not None and abs(explicit) < 1e-9 and side == "SELL":
                    normalized = derived
                else:
                    normalized = explicit
            # For IB history rows where SELL pnl is missing, do not invent a
            # realized value from reconstructed basis. Replays can drift when
            # fills/cost bases are incomplete; keep metrics on explicit broker
            # pnl only so daily/weekly/monthly/total remain coherent.

            by_id[tid] = normalized

        return by_id

    if use_ib:
        mode = TradingMode.PAPER if requested_profile == "paper" else TradingMode.LIVE
        trades_res = await db.execute(
            select(Trade).where(Trade.mode == mode).order_by(Trade.created_at)
        )
        all_trades = trades_res.scalars().all()
        trades = [t for t in all_trades if _status_text(t.status) == "FILLED"]

        def _created_at(t: Trade):
            return t.created_at

        def _side(t: Trade) -> str:
            return t.side.value if t.side is not None else ""

        def _symbol(t: Trade) -> str:
            return t.symbol

        def _total(t: Trade) -> float:
            return float(t.quantity or 0.0) * float(t.price or 0.0)

        def _qty(t: Trade) -> float:
            return float(t.quantity or 0.0)

        def _price(t: Trade) -> float:
            return float(t.price or 0.0)

        def _status(t: Trade) -> str:
            return _status_text(t.status)

        def _pnl(t: Trade):
            return t.pnl

        normalized_pnl_by_id = _normalize_realized_pnl_rows(
            trades,
            created_at_fn=_created_at,
            side_fn=_side,
            qty_fn=_qty,
            price_fn=_price,
            pnl_fn=_pnl,
            status_fn=_status,
        )
    else:
        trades_res = await db.execute(select(SandboxTrade).order_by(SandboxTrade.created_at))
        trades = trades_res.scalars().all()

        def _created_at(t: SandboxTrade):
            return t.created_at

        def _side(t: SandboxTrade) -> str:
            return t.side

        def _symbol(t: SandboxTrade) -> str:
            return t.symbol

        def _total(t: SandboxTrade) -> float:
            return float(t.total or 0.0)

        def _pnl(t: SandboxTrade):
            return t.pnl

        normalized_pnl_by_id = {
            int(getattr(t, "id", 0) or 0): (float(_pnl(t)) if _pnl(t) is not None else None)
            for t in trades
        }

    # Cumulative realised P&L
    cumulative = []
    running = 0.0
    for t in trades:
        pnl_val = normalized_pnl_by_id.get(int(getattr(t, "id", 0) or 0))
        if pnl_val is not None:
            running += float(pnl_val)
        local_time = _created_at(t).astimezone() if _created_at(t) else None
        date_str = local_time.strftime("%Y-%m-%d %H:%M") if local_time else "unknown"
        cumulative.append({"date": date_str, "value": round(running, 2)})

    # Daily buy/sell volume
    daily: dict[str, dict] = {}
    for t in trades:
        local_time = _created_at(t).astimezone() if _created_at(t) else None
        day = local_time.strftime("%Y-%m-%d") if local_time else "unknown"
        if day not in daily:
            daily[day] = {"date": day, "buy": 0.0, "sell": 0.0}
        if _side(t) == "BUY":
            daily[day]["buy"] = round(daily[day]["buy"] + _total(t), 2)
        else:
            daily[day]["sell"] = round(daily[day]["sell"] + _total(t), 2)
    daily_volume = [{"date": d, "buy": v["buy"], "sell": v["sell"]}
                    for d, v in sorted(daily.items())]

    # Per-symbol realised P&L
    sym_map: dict[str, dict] = {}
    for t in trades:
        sym = _symbol(t)
        if sym not in sym_map:
            sym_map[sym] = {"symbol": sym, "realized_pnl": 0.0, "trade_count": 0}
        sym_map[sym]["trade_count"] += 1
        pnl_val = normalized_pnl_by_id.get(int(getattr(t, "id", 0) or 0))
        if pnl_val is not None:
            sym_map[sym]["realized_pnl"] = round(sym_map[sym]["realized_pnl"] + float(pnl_val), 2)
    symbol_pnl = sorted(sym_map.values(), key=lambda x: x["realized_pnl"], reverse=True)

    normalized_realized = [
        v for v in normalized_pnl_by_id.values()
        if v is not None
    ]
    wins      = sum(1 for v in normalized_realized if float(v) > 0)
    losses    = sum(1 for v in normalized_realized if float(v) < 0)
    breakeven = sum(1 for v in normalized_realized if float(v) == 0)

    return {
        "cumulative_pnl": cumulative,
        "daily_volume": daily_volume,
        "symbol_pnl": symbol_pnl,
        "win_loss": {"wins": wins, "losses": losses, "breakeven": breakeven},
        "total_trades": len(trades),
        "profile": requested_profile,
        "source": "ib" if use_ib else "simulated",
    }


@router.get("/realized-metrics")
async def get_realized_metrics(
    profile: Optional[str] = Query(default=None, pattern=r"^(simulated|paper|live)$"),
    db: AsyncSession = Depends(get_db),
):
    """Return realized-performance metrics for the requested profile."""
    requested_profile = (profile or ("paper" if ib_service.is_connected else "simulated") or "simulated").lower()
    use_ib = requested_profile in {"paper", "live"}

    def _status_text(value) -> str:
        raw = getattr(value, "value", value)
        return str(raw or "").upper()

    def _normalize_realized_pnl_rows(rows, side_fn, qty_fn, price_fn, pnl_fn, status_fn):
        state_by_symbol: dict[str, dict[str, float]] = {}
        by_id: dict[int, float | None] = {}

        for t in rows:
            tid = int(getattr(t, "id", 0) or 0)
            side = str(side_fn(t) or "").upper()
            qty = float(qty_fn(t) or 0.0)
            px = float(price_fn(t) or 0.0)
            sym = str(getattr(t, "symbol", "") or "").upper()
            status = str(status_fn(t) or "").upper()

            explicit_raw = pnl_fn(t)
            explicit = float(explicit_raw) if explicit_raw is not None else None

            if not sym or qty <= 0.0 or px <= 0.0 or status != "FILLED":
                by_id[tid] = None
                continue

            st = state_by_symbol.get(sym) or {"qty": 0.0, "avg": 0.0}
            derived: float | None = None

            if side == "BUY":
                if st["qty"] >= 0.0:
                    next_qty = st["qty"] + qty
                    st["avg"] = ((st["avg"] * st["qty"]) + (px * qty)) / next_qty if next_qty > 0 else 0.0
                    st["qty"] = next_qty
                else:
                    if abs(st["qty"]) > qty:
                        st["qty"] += qty
                    elif abs(st["qty"]) == qty:
                        st["qty"] = 0.0
                        st["avg"] = 0.0
                    else:
                        rem = qty - abs(st["qty"])
                        st["qty"] = rem
                        st["avg"] = px
            elif side == "SELL":
                if st["qty"] > 0.0 and st["avg"] > 0.0:
                    close_qty = min(qty, st["qty"])
                    if close_qty > 0.0:
                        derived = round((px - st["avg"]) * close_qty, 4)
                    st["qty"] -= close_qty
                    if st["qty"] <= 0.0:
                        st["avg"] = 0.0
                else:
                    cur_short = abs(min(st["qty"], 0.0))
                    next_short = cur_short + qty
                    st["qty"] = -next_short
                    st["avg"] = ((st["avg"] * cur_short) + (px * qty)) / next_short if next_short > 0 else 0.0

            state_by_symbol[sym] = st

            normalized = None
            if explicit is not None:
                if derived is not None and abs(explicit) < 1e-9 and side == "SELL":
                    normalized = derived
                else:
                    normalized = explicit
            elif derived is not None and side == "SELL":
                normalized = derived

            by_id[tid] = normalized

        return by_id

    if use_ib:
        mode = TradingMode.PAPER if requested_profile == "paper" else TradingMode.LIVE
        trades_res = await db.execute(
            select(Trade)
            .where(Trade.mode == mode)
            .order_by(Trade.created_at)
        )
        trades = [t for t in trades_res.scalars().all() if _status_text(t.status) == "FILLED"]
        total_deposited = 0.0

        def _created_at(t: Trade):
            return t.filled_at or t.created_at

        def _pnl(t: Trade) -> float:
            return float(t.pnl or 0.0)

        def _side(t: Trade) -> str:
            return t.side.value if t.side is not None else ""

        def _qty(t: Trade) -> float:
            return float(t.quantity or 0.0)

        def _price(t: Trade) -> float:
            return float(t.price or 0.0)

        def _status(t: Trade) -> str:
            return _status_text(t.status)

        normalized_pnl_by_id = _normalize_realized_pnl_rows(
            trades,
            side_fn=_side,
            qty_fn=_qty,
            price_fn=_price,
            pnl_fn=lambda t: t.pnl,
            status_fn=_status,
        )
        realized_trades = [
            t for t in trades
            if normalized_pnl_by_id.get(int(getattr(t, "id", 0) or 0)) is not None
        ]
    else:
        trades_res = await db.execute(
            select(SandboxTrade)
            .where(SandboxTrade.pnl.isnot(None))
            .order_by(SandboxTrade.created_at)
        )
        realized_trades = trades_res.scalars().all()
        account = await get_account(db)
        total_deposited = float(account.total_deposited or 0.0)

        def _created_at(t: SandboxTrade):
            return t.created_at

        def _pnl(t: SandboxTrade) -> float:
            return float(t.pnl or 0.0)

        normalized_pnl_by_id = {
            int(getattr(t, "id", 0) or 0): float(t.pnl)
            for t in realized_trades
            if t.pnl is not None
        }

    def _to_utc(dt: datetime | None) -> datetime | None:
        if dt is None:
            return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    realized_points = [
        (_to_utc(_created_at(t)), float(normalized_pnl_by_id.get(int(getattr(t, "id", 0) or 0)) or 0.0))
        for t in realized_trades
        if _to_utc(_created_at(t)) is not None and normalized_pnl_by_id.get(int(getattr(t, "id", 0) or 0)) is not None
    ]

    realized_pnl_sum = float(sum(pnl for _, pnl in realized_points))

    first_realized_at = None
    elapsed_calendar_days = None
    elapsed_trading_days = None
    if realized_points:
        first_realized_at = realized_points[0][0]
        now_utc = datetime.now(timezone.utc)
        elapsed_calendar_days = max(1, (now_utc - first_realized_at).days)
        elapsed_trading_days = max(1, count_nyse_trading_days(first_realized_at, now_utc))

    trade_days = {dt.date().isoformat() for dt, _ in realized_points}
    realized_trade_days = len(trade_days)

    now_utc = datetime.now(timezone.utc)
    today_start_utc = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start_utc = today_start_utc - timedelta(days=today_start_utc.weekday())
    month_start_utc = today_start_utc.replace(day=1)

    daily_realized_pnl = sum(pnl for dt, pnl in realized_points if dt >= today_start_utc)
    weekly_realized_pnl = sum(pnl for dt, pnl in realized_points if dt >= week_start_utc)
    monthly_realized_pnl = sum(pnl for dt, pnl in realized_points if dt >= month_start_utc)

    daily_realized_pnl_pct = (daily_realized_pnl / total_deposited) * 100 if total_deposited > 0 else None
    weekly_realized_pnl_pct = (weekly_realized_pnl / total_deposited) * 100 if total_deposited > 0 else None
    monthly_realized_pnl_pct = (monthly_realized_pnl / total_deposited) * 100 if total_deposited > 0 else None

    avg_daily_realized_pnl = (
        round(realized_pnl_sum / realized_trade_days, 4)
        if realized_trade_days > 0
        else None
    )

    annualized_return_pct = None
    if elapsed_trading_days is not None and total_deposited > 0:
        realized_return_decimal = realized_pnl_sum / total_deposited
        if realized_return_decimal > -1:
            annualized_return_pct = (math.pow(1 + realized_return_decimal, 252 / elapsed_trading_days) - 1) * 100
            annualized_return_pct = round(annualized_return_pct, 4)

    return {
        "realized_pnl_sum": round(realized_pnl_sum, 4),
        "total_deposited": round(total_deposited, 4),
        "first_realized_at": first_realized_at.isoformat() if first_realized_at else None,
        "elapsed_days": elapsed_trading_days,
        "elapsed_trading_days": elapsed_trading_days,
        "elapsed_calendar_days": elapsed_calendar_days,
        "realized_trade_days": realized_trade_days,
        "daily_realized_pnl": round(daily_realized_pnl, 4),
        "weekly_realized_pnl": round(weekly_realized_pnl, 4),
        "monthly_realized_pnl": round(monthly_realized_pnl, 4),
        "daily_realized_pnl_pct": round(daily_realized_pnl_pct, 4) if daily_realized_pnl_pct is not None else None,
        "weekly_realized_pnl_pct": round(weekly_realized_pnl_pct, 4) if weekly_realized_pnl_pct is not None else None,
        "monthly_realized_pnl_pct": round(monthly_realized_pnl_pct, 4) if monthly_realized_pnl_pct is not None else None,
        "avg_daily_realized_pnl": avg_daily_realized_pnl,
        "annualized_return_pct": annualized_return_pct,
        "profile": requested_profile,
        "source": "ib" if use_ib else "simulated",
    }


def _trade_dicts(trades) -> list[dict]:
    return [
        {
            "id": t.id,
            "symbol": t.symbol,
            "side": t.side,
            "quantity": t.quantity,
            "price": t.price,
            "total": t.total,
            "strategy_name": t.strategy_name,
            "reason": t.reason,
            "pnl": t.pnl,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in trades
    ]


@router.get("/trades/export")
async def export_trades(
    fmt: str = "csv",
    symbol: Optional[str] = None,
    save: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Download sandbox trade logs as CSV or JSON.

    - ``fmt``    – ``csv`` (default) or ``json``
    - ``symbol`` – optional filter by ticker symbol
    - ``save``   – if ``true``, also persist a copy to local PC storage
    """
    q = select(SandboxTrade).order_by(SandboxTrade.created_at.desc())
    if symbol:
        q = q.where(SandboxTrade.symbol == symbol.upper())
    result = await db.execute(q)
    trades = result.scalars().all()
    records = _trade_dicts(trades)

    if save:
        prefix = f"sandbox_trades_{symbol.upper()}" if symbol else "sandbox_trades"
        if fmt == "json":
            save_trade_logs_json(records, filename_prefix=prefix)
        else:
            save_trade_logs_csv(records, filename_prefix=prefix)

    if fmt == "json":
        content = records_to_json_bytes(records)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="sandbox_trades.json"'},
        )

    content = records_to_csv_bytes(records)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="sandbox_trades.csv"'},
    )


@router.get("/trades/local-storage/files")
async def list_trade_log_files():
    """List all trade log files saved to local PC storage."""
    return {"files": list_trade_log_files()}
