"""Sandbox automated trading engine.

Runs every minute for each active sandbox position that has a strategy
assigned and ``strategy_enabled = True``.  It fetches the most recent
intraday OHLCV bars, runs the strategy's ``generate_signals``, and
executes simulated BUY/SELL trades against the sandbox positions table.

Architecture
------------
* A single asyncio task is started at application startup.
* The task wakes up every ``TICK_SECONDS`` (default 60) and processes all
  active symbols in parallel.
* Heavy computation (strategy signal generation) is offloaded to a thread
  pool executor so the event loop is not blocked.
* All DB mutations use their own short-lived sessions so they do not
  interfere with request-scoped sessions.
"""
from __future__ import annotations

# Trade activity log and logger function (must be defined before use)
_trade_activity_log = []  # in-memory log of recent trades (max 20)
def _log_trade_activity(symbol: str, side: str, shares: float, price: float, reason: str):
    from datetime import datetime, timezone
    entry = {
        "at": datetime.now(timezone.utc).isoformat(),
        "symbol": symbol,
        "side": side,
        "shares": round(shares, 4),
        "price": round(price, 4),
        "reason": reason,
    }
    _trade_activity_log.insert(0, entry)
    del _trade_activity_log[20:]
    logger.info(f"Trade: {side} {symbol} x{shares:.4f} @ ${price:.2f} | {reason}")


import asyncio
import logging
import math
import random
from datetime import datetime, timezone, timedelta, time as dt_time
from typing import Any
import zoneinfo

import pandas as pd
import numpy as np

from app.database import AsyncSessionLocal
from app.models.sandbox import SandboxPosition, SandboxTrade
from app.services.strategies import get_strategy, STRATEGY_MAP
from app.services.script_executor import execute_script

logger = logging.getLogger(__name__)

TICK_SECONDS  = 60          # how often the engine wakes up
MIN_BARS      = 30          # minimum history bars required before signalling
LOOKBACK_DAYS = 5           # days of 1-minute bars to fetch from Yahoo

_ET = zoneinfo.ZoneInfo("America/New_York")
_MARKET_OPEN      = dt_time(9, 30)   # regular session open
_PRE_OPEN_OFFSET  = dt_time(9, 20)   # 10 min before open (preparation window)
_MARKET_CLOSE     = dt_time(16, 0)   # regular session close


def _minutes_to_time(total_minutes: int) -> dt_time:
    hours = total_minutes // 60
    minutes = total_minutes % 60
    return dt_time(hours, minutes)


def _get_eod_window_starts(
    eod_sell_window_minutes: int,
    eod_engine_shutoff_minutes_before_sell: int,
) -> tuple[dt_time, dt_time]:
    """Return (engine_shutoff_start, final_sell_start) in ET clock time."""
    close_minutes = _MARKET_CLOSE.hour * 60 + _MARKET_CLOSE.minute
    sell_window_mins = max(1, int(eod_sell_window_minutes or 30))
    shutoff_mins = max(1, int(eod_engine_shutoff_minutes_before_sell or 120))

    final_sell_start_m = max(0, close_minutes - sell_window_mins)
    engine_shutoff_start_m = max(0, final_sell_start_m - shutoff_mins)
    return _minutes_to_time(engine_shutoff_start_m), _minutes_to_time(final_sell_start_m)


def _market_is_active() -> bool:
    """Return True when the engine should tick.

    Ticks are allowed:
    * Monday–Friday only (weekday() 0–4)
    * Between 09:20 and 16:00 US/Eastern (10 min before open through close)
    """
    now_et = datetime.now(tz=_ET)
    if now_et.weekday() >= 5:          # Saturday=5, Sunday=6
        return False
    t = now_et.time()
    return _PRE_OPEN_OFFSET <= t < _MARKET_CLOSE


def _regular_session_is_open() -> bool:
    """Return True only during regular market hours (09:30–16:00 ET, Mon–Fri).

    Used to gate trade execution — warm-up ticks (09:20–09:30) should process
    data but must not trigger BUY/SELL orders.
    """
    now_et = datetime.now(tz=_ET)
    if now_et.weekday() >= 5:
        return False
    t = now_et.time()
    return _MARKET_OPEN <= t < _MARKET_CLOSE


def _is_in_eod_sell_window(eod_sell_window_minutes: int) -> bool:
    """Return True if currently within the end-of-day sell window.

    The sell window runs from (16:00 - window_duration) to 16:00 ET.
    """
    now_et = datetime.now(tz=_ET)
    if now_et.weekday() >= 5:
        return False

    _, final_sell_start = _get_eod_window_starts(eod_sell_window_minutes, 120)
    t = now_et.time()
    return final_sell_start <= t < _MARKET_CLOSE


def _is_in_pre_sell_engine_shutoff_window(
    eod_sell_window_minutes: int,
    eod_engine_shutoff_minutes_before_sell: int,
) -> bool:
    """Return True during the pre-sell period where new BUYs are blocked."""
    now_et = datetime.now(tz=_ET)
    if now_et.weekday() >= 5:
        return False

    engine_shutoff_start, final_sell_start = _get_eod_window_starts(
        eod_sell_window_minutes,
        eod_engine_shutoff_minutes_before_sell,
    )
    t = now_et.time()
    return engine_shutoff_start <= t < final_sell_start


_final_sell_window_seen: set[str] = set()


def _mark_first_entry_into_final_sell_window(symbol: str, eod_sell_window_minutes: int) -> bool:
    """Return True once per symbol/day on first tick inside the final sell window."""
    now_et = datetime.now(tz=_ET)
    if now_et.weekday() >= 5:
        return False
    if not _is_in_eod_sell_window(eod_sell_window_minutes):
        return False

    key = f"{symbol}:{now_et.date().isoformat()}"
    if key in _final_sell_window_seen:
        return False

    _final_sell_window_seen.add(key)
    return True


def _notify_manager_activity(msg: str) -> None:
    """Best-effort write to portfolio-manager activity feed."""
    try:
        from app.services.portfolio_manager import _log_activity
        _log_activity(msg)
    except Exception:
        logger.info(msg)


async def _notify_unrealized_loss(_position_id: int, symbol: str, unrealized_pnl: float) -> None:
    """Publish a per-symbol unrealized-loss notice to manager activity feed."""
    msg = (
        f"EOD final-sell start: {symbol} unrealized loss ${abs(unrealized_pnl):.2f}; "
        "position requires manual exit or later liquidation"
    )
    _notify_manager_activity(msg)

# ── shared state ──────────────────────────────────────────────────────────── #
_running = False
_last_tick: datetime | None = None
_symbol_status: dict[str, dict] = {}   # { symbol: { last_signal, last_run_at, error } }
_buy_lock: asyncio.Lock | None = None  # serialises concurrent BUY fund allocation


def _get_buy_lock() -> asyncio.Lock:
    """Return the module-level BUY lock, creating it lazily on first call."""
    global _buy_lock
    if _buy_lock is None:
        _buy_lock = asyncio.Lock()
    return _buy_lock


def get_engine_state() -> dict:
    return {
        "running": _running,
        "last_tick": _last_tick.isoformat() if _last_tick else None,
        "market_active": _market_is_active(),
        "trading_open": _regular_session_is_open(),
        "symbols": dict(_symbol_status),
    }


# ── data fetching ─────────────────────────────────────────────────────────── #

async def _fetch_intraday_df(symbol: str) -> pd.DataFrame:
    """Return a DataFrame of recent intraday OHLCV bars for *symbol*."""
    from app.services.market_service import get_intraday_df
    return await get_intraday_df(symbol, range_="5d", interval="1m", include_pre_post=False)


# ── signal generation ─────────────────────────────────────────────────────── #

def _run_strategy_sync(strategy_name: str, df: pd.DataFrame, scripts: dict[int, str]) -> pd.DataFrame:
    """Run strategy in a thread (CPU-bound).  Returns df with 'signal' column."""
    if strategy_name.startswith("custom:"):
        script_id_str = strategy_name[7:]
        try:
            script_id = int(script_id_str)
        except ValueError:
            raise ValueError(f"Invalid custom script id: {script_id_str}")
        code = scripts.get(script_id)
        if not code:
            raise ValueError(f"Script {script_id} not found.")
        return execute_script(code, df)

    if strategy_name.startswith("template:"):
        filename = strategy_name[9:]
        # Reject any path traversal attempts
        if "/" in filename or "\\" in filename or ".." in filename:
            raise ValueError(f"Invalid template filename: {filename}")
        from pathlib import Path
        tmpl_path = Path(__file__).resolve().parents[1] / "templates" / filename
        if not tmpl_path.exists():
            raise ValueError(f"Template file not found: {filename}")
        code = tmpl_path.read_text(encoding="utf-8")
        return execute_script(code, df)

    # Built-in strategy — parse type and params
    colon = strategy_name.find(":")
    if colon == -1:
        stype, params = strategy_name, {}
    else:
        import json
        stype = strategy_name[:colon]
        try:
            params = json.loads(strategy_name[colon + 1:])
        except Exception:
            params = {}

    strategy = get_strategy(stype, **params)
    return strategy.generate_signals(df)


async def _process_symbol(
    pos: SandboxPosition,
    scripts: dict[int, str],
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Evaluate strategy for one symbol and execute a trade if signalled."""
    global _symbol_status

    symbol = pos.symbol
    strategy_name = pos.strategy_name or ""
    status: dict[str, Any] = {
        "last_run_at": datetime.now(timezone.utc).isoformat(),
        "last_signal": None,
        "error": None,
    }

    try:
        df = await _fetch_intraday_df(symbol)

        if len(df) < MIN_BARS:
            status["error"] = f"Not enough bars ({len(df)} < {MIN_BARS})"
            _symbol_status[symbol] = status
            return

        # Run signal generation off the event loop
        df_sig = await loop.run_in_executor(
            None, _run_strategy_sync, strategy_name, df, scripts
        )

        # The last bar is the current minute
        last_row = df_sig.iloc[-1]
        current_price = float(last_row["Close"])

        # Global risk exits from portfolio-manager settings (0 = disabled).
        from app.services.portfolio_manager import get_manager_settings
        manager_settings = get_manager_settings()
        stop_loss_pct = float(manager_settings.get("stop_loss_pct", 0.0) or 0.0)
        take_profit_pct = float(manager_settings.get("take_profit_pct", 0.0) or 0.0)
        hold_overnight = bool(manager_settings.get("hold_positions_overnight", True))
        eod_window_mins = int(manager_settings.get("eod_sell_window_minutes", 30) or 30)
        pre_sell_shutoff_mins = int(
            manager_settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120
        )
        in_pre_sell_shutoff_window = (
            not hold_overnight
            and _is_in_pre_sell_engine_shutoff_window(eod_window_mins, pre_sell_shutoff_mins)
        )
        in_final_sell_window = (
            not hold_overnight
            and _is_in_eod_sell_window(eod_window_mins)
        )

        # The raw last-bar signal is used for display (last_signal in DB).
        current_signal = int(last_row.get("signal", 0))

        # Custom scripts emit event-based signals (+1/-1 only on the crossover
        # bar, then 0).  Built-in strategies keep signal = +1/-1 while the
        # condition holds.  Using the last *non-zero* value handles both: for
        # state-based strategies it is still the last bar; for event-based
        # scripts it is the most recent buy or sell event.
        sig_series = df_sig["signal"]
        buy_bars  = sig_series[sig_series == 1]
        sell_bars = sig_series[sig_series == -1]
        last_buy_idx  = buy_bars.index[-1]  if len(buy_bars)  > 0 else None
        last_sell_idx = sell_bars.index[-1] if len(sell_bars) > 0 else None

        # Determine the relevant signal index for signal_source lookup.
        # When holding shares: the exit (SELL) signal is relevant.
        # When flat:           the entry (BUY) signal is relevant.
        def _idx_after(a, b):
            """Return True if index a comes strictly after index b (or b is None)."""
            return b is None or (a is not None and a > b)

        if pos.shares > 0:
            # TP / SL / exit: a SELL that fired AFTER the last BUY
            trade_signal = -1 if _idx_after(last_sell_idx, last_buy_idx) else 0
            ref_idx = last_sell_idx
        else:
            # Entry: a BUY that fired AFTER the last SELL
            trade_signal = 1 if _idx_after(last_buy_idx, last_sell_idx) else 0
            ref_idx = last_buy_idx

        # Grab the signal_source from the relevant bar (if available)
        signal_source = ""
        if ref_idx is not None and "signal_source" in df_sig.columns:
            signal_source = str(df_sig.loc[ref_idx, "signal_source"]).strip()

        status["last_signal"] = current_signal

        # Determine what action to take
        action = None
        reason = None
        disable_engine_after_sell = False

        strat_label = strategy_name.split(':')[0]

        # At the first tick of the final sell window (per symbol/day),
        # immediately lock in winners and notify unrealized losers.
        if (
            pos.shares > 0
            and pos.avg_cost > 0
            and in_final_sell_window
            and _mark_first_entry_into_final_sell_window(symbol, eod_window_mins)
        ):
            unrealized_pnl = (current_price - pos.avg_cost) * pos.shares
            if unrealized_pnl > 0:
                action = "SELL"
                disable_engine_after_sell = True
                reason = (
                    f"final_sell_window_profit_lock (${unrealized_pnl:.2f}, "
                    f"window: {eod_window_mins}min)"
                )
            else:
                await _notify_unrealized_loss(pos.id, symbol, unrealized_pnl)

        # End-of-day sell override: force liquidation if EOD window is active
        # and hold_positions_overnight is disabled.
        if action is None and pos.shares > 0 and pos.avg_cost > 0 and in_final_sell_window:
            action = "SELL"
            disable_engine_after_sell = True
            reason = f"end_of_day_liquidation (window: {eod_window_mins}min)"

        # Standard risk exits: stop loss and take profit
        if action is None and pos.shares > 0 and pos.avg_cost > 0:
            if stop_loss_pct > 0:
                stop_price = pos.avg_cost * (1.0 - stop_loss_pct / 100.0)
                if current_price <= stop_price:
                    action = "SELL"
                    reason = f"stop_loss ({stop_loss_pct:.2f}% @ ${stop_price:.2f})"
            if action is None and take_profit_pct > 0:
                tp_price = pos.avg_cost * (1.0 + take_profit_pct / 100.0)
                if current_price >= tp_price:
                    action = "SELL"
                    reason = f"take_profit ({take_profit_pct:.2f}% @ ${tp_price:.2f})"

        if action is None and trade_signal > 0 and pos.shares == 0 and pos.pending_shares == 0:
            # During pre-sell shutdown and final sell windows, suppress new entries.
            if in_pre_sell_shutoff_window or in_final_sell_window:
                logger.debug(
                    "Engine BUY suppressed for %s during EOD shutdown/final-sell window",
                    symbol,
                )
            else:
                action = "BUY"
                reason = signal_source if signal_source else f"{strat_label} buy @ ${current_price:.2f}"

        elif action is None and trade_signal < 0 and pos.shares > 0:
            action = "SELL"
            reason = signal_source if signal_source else f"{strat_label} sell @ ${current_price:.2f}"

        if action:
            if _regular_session_is_open():
                await _execute_trade(
                    pos,
                    action,
                    current_price,
                    reason,
                    disable_engine_after_sell=disable_engine_after_sell,
                )
            else:
                logger.debug(
                    "Engine skipping %s %s — pre-market warm-up (not yet 09:30 ET)",
                    action, symbol,
                )

        # Write engine status back to the position row (current bar signal for display)
        await _update_position_status(pos.id, current_signal, None, datetime.now(timezone.utc))

    except Exception as exc:
        logger.warning("Engine error for %s: %s", symbol, exc)
        status["error"] = str(exc)
        await _update_position_status(pos.id, None, str(exc), datetime.now(timezone.utc))

    _symbol_status[symbol] = status


async def _update_position_status(
    position_id: int,
    last_signal: int | None,
    engine_error: str | None,
    last_run_at: datetime,
) -> None:
    """Write last_signal / last_run_at / engine_error back to the DB."""
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        result = await db.execute(
            sa_select(SandboxPosition).where(SandboxPosition.id == position_id)
        )
        pos = result.scalar_one_or_none()
        if pos:
            if last_signal is not None:
                pos.last_signal = last_signal
            pos.last_run_at = last_run_at
            pos.engine_error = engine_error
            await db.commit()


async def _execute_trade(
    pos: SandboxPosition,
    side: str,
    price: float,
    reason: str,
    disable_engine_after_sell: bool = False,
) -> None:
    """Open a fresh DB session and execute the simulated trade."""
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import SandboxAccount
        result = await db.execute(
            sa_select(SandboxPosition).where(SandboxPosition.id == pos.id)
        )
        position = result.scalar_one_or_none()
        if not position:
            return

        pnl = None

        if side == "BUY":
            # Acquire the buy lock so that concurrent ticks cannot both see
            # the same available funds and each place a full-size order.
            async with _get_buy_lock():
                # Re-fetch the position inside the lock to get the latest state
                result2 = await db.execute(
                    sa_select(SandboxPosition).where(SandboxPosition.id == pos.id)
                )
                position = result2.scalar_one_or_none()
                if not position:
                    return

                # Use allocated funds + any unallocated account balance
                acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
                account = acct_res.scalar_one_or_none()
                if account:
                    from app.routers.sandbox_router._helpers import compute_available_cash
                    all_pos_res = await db.execute(sa_select(SandboxPosition))
                    all_positions = all_pos_res.scalars().all()
                    account_available = await compute_available_cash(db, account, all_positions)
                else:
                    account_available = 0.0

                available = position.allocated_funds + account_available
                if available < price:
                    logger.debug("Engine BUY skipped for %s — insufficient funds ($%.2f)", pos.symbol, available)
                    return
                quantity = math.floor(available / price)
                if quantity <= 0:
                    return
                total = quantity * price
                # Draw any shortfall from the unallocated pool into this position
                extra_needed = max(0.0, total - position.allocated_funds)
                if extra_needed > 0 and account:
                    # Draw from the unallocated pool into this position's allocation.
                    # Log it so repair can replay it correctly.
                    position.allocated_funds += extra_needed
                    from app.models.sandbox import SandboxAllocationEvent
                    db.add(SandboxAllocationEvent(
                        event_type="deploy",
                        from_symbol=None,
                        to_symbol=position.symbol,
                        amount=round(extra_needed, 4),
                        note="Engine: draw from unallocated pool for BUY",
                    ))
                # Place shares into the pending (open order) state.
                # A background settler will convert them to real shares after
                # a random 5–10 second delay, simulating order fill latency.
                new_pending = position.pending_shares + quantity
                position.pending_avg_cost = (
                    (position.pending_avg_cost * position.pending_shares + total) / new_pending
                )
                position.pending_shares = new_pending
                position.pending_since = datetime.now(timezone.utc)
                position.allocated_funds -= total
                trade = SandboxTrade(
                    symbol=position.symbol,
                    side="BUY",
                    quantity=quantity,
                    price=price,
                    total=round(total, 4),
                    strategy_name=position.strategy_name,
                    reason=reason,
                    pnl=None,
                )
                db.add(trade)
                await db.commit()
                _log_trade_activity(pos.symbol, "BUY", quantity, price, reason)
            return

        elif side == "SELL":
            quantity = position.shares
            if quantity <= 0:
                return
            total = quantity * price
            pnl = round((price - position.avg_cost) * quantity, 4)
            position.shares = 0.0
            position.allocated_funds += total
            position.realized_pnl += pnl
            position.avg_cost = 0.0
            # Realized P/L adjusts total_funds: gains add to cash, losses reduce it.
            acct_res2 = await db.execute(sa_select(SandboxAccount).limit(1))
            acct2 = acct_res2.scalar_one_or_none()
            if acct2:
                acct2.total_funds += pnl
            if disable_engine_after_sell:
                position.strategy_enabled = False
                position.engine_error = None
                logger.info("Engine auto-disabled for %s after EOD liquidation SELL", position.symbol)
        else:
            return

        trade = SandboxTrade(
            symbol=position.symbol,
            side=side,
            quantity=quantity,
            price=price,
            total=round(quantity * price, 4),
            strategy_name=position.strategy_name,
            reason=reason,
            pnl=pnl,
        )
        db.add(trade)
        await db.commit()
        if side != "BUY":
            _log_trade_activity(pos.symbol, side, quantity, price, reason)


# ── pending-order settlement ─────────────────────────────────────────────── #

PENDING_SETTLE_MIN_S = 5   # minimum seconds before a pending order settles
PENDING_SETTLE_MAX_S = 10  # maximum seconds before a pending order settles


async def _settle_pending_shares() -> None:
    """Convert any pending (open-order) shares to settled shares when their
    random settlement delay has elapsed (5–10 seconds after the BUY order)."""
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select

        result = await db.execute(
            sa_select(SandboxPosition).where(SandboxPosition.pending_shares > 0)
        )
        positions = result.scalars().all()

        for position in positions:
            if position.pending_since is None:
                continue

            # Ensure pending_since is timezone-aware for comparison
            ps = position.pending_since
            if ps.tzinfo is None:
                ps = ps.replace(tzinfo=timezone.utc)

            # Each position gets its own deterministic-but-random delay derived
            # from its id so that different symbols settle at different times.
            rng = random.Random(position.id ^ int(ps.timestamp()))
            delay_s = rng.randint(PENDING_SETTLE_MIN_S, PENDING_SETTLE_MAX_S)

            if (now - ps) < timedelta(seconds=delay_s):
                continue  # not yet time to settle

            # Settle: merge pending into real shares
            pending_qty = position.pending_shares
            pending_cost = position.pending_avg_cost

            new_total_shares = position.shares + pending_qty
            if new_total_shares > 0:
                position.avg_cost = (
                    (position.avg_cost * position.shares + pending_cost * pending_qty)
                    / new_total_shares
                )
            position.shares = new_total_shares
            position.total_invested += pending_cost * pending_qty

            # Clear pending state
            position.pending_shares = 0.0
            position.pending_avg_cost = 0.0
            position.pending_since = None

            logger.info(
                "Engine settled pending BUY %s x%.4f @ avg $%.2f -> shares=%.4f",
                position.symbol, pending_qty, pending_cost, position.shares,
            )

        await db.commit()


# ── main loop ─────────────────────────────────────────────────────────────── #

async def _tick(loop: asyncio.AbstractEventLoop) -> None:
    """One engine tick — load all enabled positions and process them."""
    global _last_tick

    # Settle any pending (open-order) shares whose delay has elapsed
    await _settle_pending_shares()

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.custom_script import CustomScript

        pos_res = await db.execute(
            sa_select(SandboxPosition).where(
                SandboxPosition.strategy_enabled == True,  # noqa: E712
                SandboxPosition.strategy_name.isnot(None),
            )
        )
        positions = pos_res.scalars().all()

        # Pre-load all custom scripts used by any active position
        script_ids = set()
        for p in positions:
            if p.strategy_name and p.strategy_name.startswith("custom:"):
                try:
                    script_ids.add(int(p.strategy_name[7:]))
                except ValueError:
                    pass

        scripts: dict[int, str] = {}
        if script_ids:
            sc_res = await db.execute(
                sa_select(CustomScript).where(CustomScript.id.in_(script_ids))
            )
            for sc in sc_res.scalars().all():
                scripts[sc.id] = sc.script_code

    if not positions:
        _last_tick = datetime.now(timezone.utc)
        return

    await asyncio.gather(
        *[_process_symbol(p, scripts, loop) for p in positions],
        return_exceptions=True,
    )
    _last_tick = datetime.now(timezone.utc)


async def run_engine() -> None:
    """Long-running coroutine — call from app lifespan as an asyncio task."""
    global _running
    _running = True
    loop = asyncio.get_event_loop()
    logger.info("Sandbox trading engine started (tick interval: %ds)", TICK_SECONDS)
    while True:
        if _market_is_active():
            try:
                await _tick(loop)
            except Exception as exc:
                logger.error("Engine tick unhandled error: %s", exc)
        else:
            logger.debug("Engine idle — market closed")
        await asyncio.sleep(TICK_SECONDS)
