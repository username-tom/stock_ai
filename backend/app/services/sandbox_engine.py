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
from app.services.pending_fill import assess_pending_fill
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
    sell_window_mins = max(0, int(eod_sell_window_minutes or 30))
    shutoff_mins = max(0, int(eod_engine_shutoff_minutes_before_sell or 120))

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


def _current_market_phase(
    *,
    hold_overnight: bool,
    eod_sell_window_minutes: int,
    eod_engine_shutoff_minutes_before_sell: int,
) -> dict[str, str]:
    """Return current trading phase metadata for UI and status APIs."""
    if not _regular_session_is_open():
        return {"code": "closed", "label": "CLOSED"}

    now_et = datetime.now(tz=_ET)
    minutes_now = now_et.hour * 60 + now_et.minute
    market_open_m = _MARKET_OPEN.hour * 60 + _MARKET_OPEN.minute
    market_close_m = _MARKET_CLOSE.hour * 60 + _MARKET_CLOSE.minute

    frenzy_minutes = 180   # first few hours after open
    settling_minutes = 60  # final hour before shutdown boundary

    _, final_sell_start = _get_eod_window_starts(
        eod_sell_window_minutes,
        eod_engine_shutoff_minutes_before_sell,
    )
    final_sell_start_m = final_sell_start.hour * 60 + final_sell_start.minute
    shutoff_start_m = max(
        0,
        final_sell_start_m - max(1, int(eod_engine_shutoff_minutes_before_sell or 120)),
    )

    if not hold_overnight:
        if minutes_now >= final_sell_start_m:
            return {"code": "sell_period", "label": "SELL PERIOD"}
        if minutes_now >= shutoff_start_m:
            return {"code": "shut_off", "label": "SHUT OFF"}
        normal_end = shutoff_start_m
    else:
        normal_end = market_close_m

    frenzy_end = min(normal_end, market_open_m + frenzy_minutes)
    settling_start = max(frenzy_end, normal_end - settling_minutes)

    if minutes_now < frenzy_end:
        return {"code": "frenzy", "label": "FRENZY"}
    if minutes_now < settling_start:
        return {"code": "follow_up", "label": "FOLLOW UP"}
    return {"code": "settling", "label": "SETTLING"}


def should_force_engine_off_without_position(
    *,
    shares: float,
    pending_shares: float,
    hold_overnight: bool,
    eod_sell_window_minutes: int,
    eod_engine_shutoff_minutes_before_sell: int,
) -> bool:
    """Return True when a flat engine must stay off during the EOD shutoff flow."""
    if hold_overnight:
        return False
    if float(shares or 0.0) > 0 or float(pending_shares or 0.0) > 0:
        return False
    return (
        _is_in_pre_sell_engine_shutoff_window(
            eod_sell_window_minutes,
            eod_engine_shutoff_minutes_before_sell,
        )
        or _is_in_eod_sell_window(eod_sell_window_minutes)
    )


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
_signal_handoff_state: dict[str, dict[str, Any]] = {}  # {symbol: {strategy, switched_at_idx}}
_buy_lock: asyncio.Lock | None = None  # serialises concurrent BUY fund allocation
_pending_sell_orders: dict[int, dict[str, Any]] = {}


def _mark_pending_reroll_state(
    symbol: str,
    *,
    side: str | None = None,
    active: bool | None = None,
    in_range: bool | None = None,
    result: str | None = None,
    increment_attempt: bool = False,
    reset_attempts: bool = False,
) -> None:
    if not symbol:
        return

    status = dict(_symbol_status.get(symbol) or {})
    attempts = int(status.get("pending_reroll_attempts") or 0)

    if reset_attempts:
        attempts = 0
    if increment_attempt:
        attempts += 1

    status["pending_reroll_attempts"] = attempts
    if side is not None:
        status["pending_reroll_side"] = side
    if active is not None:
        status["pending_reroll_active"] = bool(active)
    if in_range is not None:
        status["pending_reroll_in_range"] = bool(in_range)
    if result is not None:
        status["pending_reroll_last_result"] = str(result)
    status["pending_reroll_last_at"] = datetime.now(timezone.utc).isoformat()

    _symbol_status[symbol] = status


def get_symbol_runtime_status(symbol: str) -> dict[str, Any]:
    status = dict(_symbol_status.get(symbol) or {})
    return {
        "pending_reroll_active": bool(status.get("pending_reroll_active", False)),
        "pending_reroll_side": status.get("pending_reroll_side"),
        "pending_reroll_attempts": int(status.get("pending_reroll_attempts") or 0),
        "pending_reroll_in_range": status.get("pending_reroll_in_range"),
        "pending_reroll_last_result": status.get("pending_reroll_last_result"),
        "pending_reroll_last_at": status.get("pending_reroll_last_at"),
    }


def _get_buy_lock() -> asyncio.Lock:
    """Return the module-level BUY lock, creating it lazily on first call."""
    global _buy_lock
    if _buy_lock is None:
        _buy_lock = asyncio.Lock()
    return _buy_lock


def _queue_pending_sell(
    position_id: int,
    *,
    symbol: str,
    quantity: float,
    requested_price: float,
    reason: str,
    disable_engine_after_sell: bool,
) -> None:
    _pending_sell_orders[position_id] = {
        "symbol": symbol,
        "quantity": float(quantity),
        "requested_price": float(requested_price),
        "reason": reason,
        "disable_engine_after_sell": bool(disable_engine_after_sell),
        "created_at": datetime.now(timezone.utc),
    }


def _pop_pending_sell(position_id: int) -> dict[str, Any] | None:
    return _pending_sell_orders.pop(position_id, None)


def _has_pending_sell(position_id: int) -> bool:
    return position_id in _pending_sell_orders


def _position_committed_funds(pos: SandboxPosition) -> float:
    settled_cost = float(pos.shares or 0.0) * float(pos.avg_cost or 0.0)
    allocated = float(pos.allocated_funds or 0.0)
    # pending BUY cost is already debited from allocated_funds at order placement.
    return allocated + settled_cost


def _position_max_allocation(pos: SandboxPosition, account_total_funds: float) -> float:
    cap_val = float(getattr(pos, "max_allocation_value", 0.0) or 0.0)
    if cap_val <= 0:
        return float("inf")
    mode = getattr(pos, "max_allocation_mode", "dollar") or "dollar"
    if mode == "percent":
        base = max(0.0, float(account_total_funds or 0.0))
        return (base * cap_val) / 100.0
    return cap_val


def get_engine_state() -> dict:
    from app.services.portfolio_manager import get_manager_settings

    manager_settings = get_manager_settings()
    hold_overnight = bool(manager_settings.get("hold_positions_overnight", True))
    eod_window_mins = int(manager_settings.get("eod_sell_window_minutes", 30) or 30)
    pre_sell_shutoff_mins = int(
        manager_settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120
    )

    return {
        "running": _running,
        "last_tick": _last_tick.isoformat() if _last_tick else None,
        "market_active": _market_is_active(),
        "trading_open": _regular_session_is_open(),
        "market_phase": _current_market_phase(
            hold_overnight=hold_overnight,
            eod_sell_window_minutes=eod_window_mins,
            eod_engine_shutoff_minutes_before_sell=pre_sell_shutoff_mins,
        ),
        "symbols": dict(_symbol_status),
    }


# ── data fetching ─────────────────────────────────────────────────────────── #

async def _fetch_intraday_df(symbol: str) -> pd.DataFrame:
    """Return a DataFrame of recent intraday OHLCV bars for *symbol*."""
    from app.services.market_service import get_intraday_df
    return await get_intraday_df(symbol, range_="5d", interval="1m", include_pre_post=False)


# ── signal generation ─────────────────────────────────────────────────────── #

def _run_strategy_sync(
    strategy_name: str,
    df: pd.DataFrame,
    scripts: dict[int, str],
    template_params: dict[str, Any] | None = None,
) -> pd.DataFrame:
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
        params = template_params if isinstance(template_params, dict) else {}
        return execute_script(code, df, **params)

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
    prev_status = _symbol_status.get(symbol) or {}
    status: dict[str, Any] = {
        "last_run_at": datetime.now(timezone.utc).isoformat(),
        "last_signal": None,
        "error": None,
        "pending_reroll_active": bool(prev_status.get("pending_reroll_active", False)),
        "pending_reroll_side": prev_status.get("pending_reroll_side"),
        "pending_reroll_attempts": int(prev_status.get("pending_reroll_attempts") or 0),
        "pending_reroll_in_range": prev_status.get("pending_reroll_in_range"),
        "pending_reroll_last_result": prev_status.get("pending_reroll_last_result"),
        "pending_reroll_last_at": prev_status.get("pending_reroll_last_at"),
    }

    try:
        from app.services.portfolio_manager import get_manager_settings

        manager_settings = get_manager_settings()
        symbol_overrides = manager_settings.get("position_overrides") if isinstance(manager_settings.get("position_overrides"), dict) else {}
        sym_override = symbol_overrides.get(symbol.upper(), {}) if isinstance(symbol_overrides, dict) else {}
        override_strategy = str(sym_override.get("strategy_name") or "").strip() if isinstance(sym_override, dict) else ""
        default_strategy = str(manager_settings.get("default_strategy_name") or "").strip()
        effective_strategy_name = override_strategy or strategy_name or default_strategy
        if not effective_strategy_name:
            effective_strategy_name = "sma_crossover"

        df = await _fetch_intraday_df(symbol)

        if len(df) < MIN_BARS:
            status["error"] = f"Not enough bars ({len(df)} < {MIN_BARS})"
            _symbol_status[symbol] = status
            return

        # Run signal generation off the event loop
        df_sig = await loop.run_in_executor(
            None,
            _run_strategy_sync,
            effective_strategy_name,
            df,
            scripts,
            manager_settings.get("intraday_1m_template_params") if effective_strategy_name == "template:intraday_1m_regime_template.py" else None,
        )

        # The last bar is the current minute
        last_row = df_sig.iloc[-1]
        current_price = float(last_row["Close"])

        # Global risk exits from portfolio-manager settings (0 = disabled).
        stop_loss_pct = float(manager_settings.get("stop_loss_pct", 0.0) or 0.0)
        take_profit_pct = float(manager_settings.get("take_profit_pct", 0.0) or 0.0)
        stop_loss_value = float(manager_settings.get("stop_loss_value", 0.0) or 0.0)
        take_profit_value = float(manager_settings.get("take_profit_value", 0.0) or 0.0)
        if isinstance(sym_override, dict):
            stop_loss_pct = float(sym_override.get("stop_loss_pct", stop_loss_pct) or 0.0)
            take_profit_pct = float(sym_override.get("take_profit_pct", take_profit_pct) or 0.0)
            stop_loss_value = float(sym_override.get("stop_loss_value", stop_loss_value) or 0.0)
            take_profit_value = float(sym_override.get("take_profit_value", take_profit_value) or 0.0)
        hold_overnight = bool(manager_settings.get("hold_positions_overnight", True))

        # Per-symbol AI-tag overnight exemption: if the symbol has a LONG or STRONG LONG
        # learner tag and ai_tag_allow_overnight is enabled, treat this symbol as
        # hold_overnight=True regardless of the global setting.
        if not hold_overnight and manager_settings.get("ai_tag_allow_overnight", True):
            from app.services.portfolio_manager import get_manager_state as _get_pm_state
            ai_tags = _get_pm_state().get("ai_tags", {})
            sym_tag = (ai_tags.get(pos.symbol, {}).get("learner_tag") or "").upper()
            if sym_tag in ("LONG", "STRONG LONG"):
                hold_overnight = True

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

        # Strategy handoff state: when PM changes strategy while a position is
        # open, ignore stale historical sell events from the new strategy until
        # a fresh post-switch event arrives.
        switch_state = _signal_handoff_state.get(symbol)
        switched_at_idx = None
        if switch_state is None or switch_state.get("strategy") != effective_strategy_name:
            switched_at_idx = df_sig.index[-1]
            _signal_handoff_state[symbol] = {
                "strategy": effective_strategy_name,
                "switched_at_idx": switched_at_idx,
            }
        else:
            switched_at_idx = switch_state.get("switched_at_idx")

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

        def _idx_after_switch(a, switch_idx):
            if switch_idx is None:
                return a is not None
            return a is not None and a > switch_idx

        if pos.shares > 0:
            # Exit only on a fresh post-switch sell event (or explicit current -1).
            has_fresh_sell_event = _idx_after(last_sell_idx, last_buy_idx) and _idx_after_switch(last_sell_idx, switched_at_idx)
            trade_signal = -1 if (current_signal < 0 or has_fresh_sell_event) else 0
            ref_idx = last_sell_idx if has_fresh_sell_event else None
        else:
            # Entry only on a fresh post-switch buy event (or explicit current +1).
            has_fresh_buy_event = _idx_after(last_buy_idx, last_sell_idx) and _idx_after_switch(last_buy_idx, switched_at_idx)
            trade_signal = 1 if (current_signal > 0 or has_fresh_buy_event) else 0
            ref_idx = last_buy_idx if has_fresh_buy_event else None

        # Grab the signal_source from the relevant bar (if available)
        signal_source = ""
        if ref_idx is not None and "signal_source" in df_sig.columns:
            signal_source = str(df_sig.loc[ref_idx, "signal_source"]).strip()

        from app.services.ib_service import ib_service

        # In IB mode, PM consumes SandboxPosition.last_signal. Persist the
        # actionable signal so event-based strategies (where last bar signal
        # is often 0) still produce IB orders.
        signal_for_pm = trade_signal if ib_service.is_connected else current_signal
        status["last_signal"] = signal_for_pm

        # Determine what action to take
        action = None
        reason = None
        disable_engine_after_sell = False
        has_pending_sell = _has_pending_sell(pos.id)

        strat_label = effective_strategy_name.split(':')[0]

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
            sl_targets: list[float] = []
            tp_targets: list[float] = []
            if stop_loss_pct > 0:
                sl_targets.append(pos.avg_cost * (1.0 - stop_loss_pct / 100.0))
            if stop_loss_value > 0:
                sl_targets.append(pos.avg_cost - stop_loss_value)
            if take_profit_pct > 0:
                tp_targets.append(pos.avg_cost * (1.0 + take_profit_pct / 100.0))
            if take_profit_value > 0:
                tp_targets.append(pos.avg_cost + take_profit_value)

            stop_price = max(sl_targets) if sl_targets else None
            tp_price = min(tp_targets) if tp_targets else None

            if stop_price is not None and current_price <= stop_price:
                action = "SELL"
                reason = f"stop_loss (@ ${stop_price:.2f})"
            if action is None and tp_price is not None and current_price >= tp_price:
                action = "SELL"
                reason = f"take_profit (@ ${tp_price:.2f})"

        disable_engine_without_position = should_force_engine_off_without_position(
            shares=pos.shares,
            pending_shares=pos.pending_shares,
            hold_overnight=hold_overnight,
            eod_sell_window_minutes=eod_window_mins,
            eod_engine_shutoff_minutes_before_sell=pre_sell_shutoff_mins,
        )
        if action is None and trade_signal > 0 and pos.shares == 0 and pos.pending_shares == 0 and not has_pending_sell:
            # During pre-sell shutdown and final sell windows, suppress new entries.
            if in_pre_sell_shutoff_window or in_final_sell_window:
                logger.debug(
                    "Engine BUY suppressed for %s during EOD shutdown/final-sell window",
                    symbol,
                )
            else:
                action = "BUY"
                reason = signal_source if signal_source else f"{strat_label} buy @ ${current_price:.2f}"

        elif action is None and trade_signal < 0 and pos.shares > 0 and not has_pending_sell:
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
        await _update_position_status(
            pos.id,
            signal_for_pm,
            None,
            datetime.now(timezone.utc),
            disable_engine=disable_engine_without_position,
        )

    except Exception as exc:
        logger.warning("Engine error for %s: %s", symbol, exc)
        status["error"] = str(exc)
        await _update_position_status(pos.id, None, str(exc), datetime.now(timezone.utc))

    latest_pending = _symbol_status.get(symbol) or {}
    for key in (
        "pending_reroll_active",
        "pending_reroll_side",
        "pending_reroll_attempts",
        "pending_reroll_in_range",
        "pending_reroll_last_result",
        "pending_reroll_last_at",
    ):
        if key in latest_pending:
            status[key] = latest_pending.get(key)

    _symbol_status[symbol] = status


async def _update_position_status(
    position_id: int,
    last_signal: int | None,
    engine_error: str | None,
    last_run_at: datetime,
    disable_engine: bool = False,
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
            if disable_engine:
                pos.strategy_enabled = False
            await db.commit()


async def _execute_trade(
    pos: SandboxPosition,
    side: str,
    price: float,
    reason: str,
    disable_engine_after_sell: bool = False,
) -> None:
    """Open a fresh DB session and execute the simulated trade."""
    from app.services.ib_service import ib_service

    if ib_service.is_connected:
        logger.info(
            "Sandbox engine trade blocked while IB is connected (symbol=%s side=%s reason=%s)",
            pos.symbol,
            side,
            reason,
        )
        return

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

                max_cap = _position_max_allocation(position, float(account.total_funds or 0.0) if account else 0.0)
                committed = _position_committed_funds(position)
                cap_room = max(0.0, max_cap - committed) if max_cap != float("inf") else float("inf")
                max_extra_from_account = min(account_available, cap_room)
                available = position.allocated_funds + max_extra_from_account
                if available < price:
                    logger.debug(
                        "Engine BUY skipped for %s — insufficient funds/cap room ($%.2f, room=$%.2f)",
                        pos.symbol,
                        available,
                        cap_room if cap_room != float("inf") else -1.0,
                    )
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
                # A background settler will evaluate fills after an
                # IB-aligned pending delay and reroll per bar.
                new_pending = position.pending_shares + quantity
                position.pending_avg_cost = (
                    (position.pending_avg_cost * position.pending_shares + total) / new_pending
                )
                position.pending_shares = new_pending
                position.pending_since = datetime.now(timezone.utc)
                position.allocated_funds -= total
                _mark_pending_reroll_state(
                    position.symbol,
                    side="BUY",
                    active=True,
                    result="queued",
                    reset_attempts=True,
                )
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
                if ib_service.is_connected:
                    ib_result = await ib_service.place_order(
                        symbol=position.symbol,
                        side="BUY",
                        quantity=quantity,
                        order_type="MKT",
                    )
                    if ib_result.get("error"):
                        logger.error(
                            "Engine IB BUY failed for %s: %s",
                            position.symbol,
                            ib_result.get("error"),
                        )
                        _notify_manager_activity(
                            f"Engine IB BUY failed for {position.symbol}: {ib_result.get('error')}"
                        )
                    else:
                        _notify_manager_activity(
                            f"Engine IB BUY submitted for {position.symbol} x{float(quantity):.4f}"
                        )
            return

        elif side == "SELL":
            quantity = position.shares
            if quantity <= 0:
                return
            _queue_pending_sell(
                position.id,
                symbol=position.symbol,
                quantity=quantity,
                requested_price=price,
                reason=reason,
                disable_engine_after_sell=disable_engine_after_sell,
            )
            _mark_pending_reroll_state(
                position.symbol,
                side="SELL",
                active=True,
                result="queued",
                reset_attempts=True,
            )
            await db.commit()
            logger.info(
                "Engine queued pending SELL %s x%.4f @ $%.2f (%s)",
                position.symbol,
                quantity,
                price,
                reason,
            )
            return
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
        if ib_service.is_connected:
            ib_result = await ib_service.place_order(
                symbol=position.symbol,
                side=side,
                quantity=quantity,
                order_type="MKT",
            )
            if ib_result.get("error"):
                logger.error(
                    "Engine IB %s failed for %s: %s",
                    side,
                    position.symbol,
                    ib_result.get("error"),
                )
                _notify_manager_activity(
                    f"Engine IB {side} failed for {position.symbol}: {ib_result.get('error')}"
                )
            else:
                _notify_manager_activity(
                    f"Engine IB {side} submitted for {position.symbol} x{float(quantity):.4f}"
                )


# ── pending-order settlement ─────────────────────────────────────────────── #

PENDING_SETTLE_SECONDS = 3  # align simulated pending delay with IB order-status observation window


async def _settle_pending_shares() -> None:
    """Settle pending simulated orders with per-bar rerolls.

    BUY and SELL pending orders are only eligible to fill when market price is
    still within the configured drift range from the pending reference price.
    On each eligible bar, a random roll is applied against side-specific fill
    rate multipliers (0-100%). Unfilled orders remain pending for the next bar.
    """
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import SandboxAccount
        from app.services.market_service import get_bulk_quotes
        from app.services.portfolio_manager import get_manager_settings

        manager_settings = get_manager_settings()
        buy_fill_rate = max(0.0, min(100.0, float(manager_settings.get("sim_buy_fill_rate_pct", 60.0) or 0.0)))
        sell_fill_rate = max(0.0, min(100.0, float(manager_settings.get("sim_sell_fill_rate_pct", 70.0) or 0.0)))
        drift_threshold_pct = max(0.0, float(manager_settings.get("pending_price_drift_cancel_pct", 0.75) or 0.0))

        def _is_within_range(current_price: float, pending_price: float) -> bool:
            if pending_price <= 0 or current_price <= 0:
                return False
            drift_pct = abs(current_price - pending_price) / pending_price * 100.0
            return drift_pct <= drift_threshold_pct

        result = await db.execute(
            sa_select(SandboxPosition).where(SandboxPosition.pending_shares > 0)
        )
        buy_positions: list[SandboxPosition] = result.scalars().all()
        sell_orders = dict(_pending_sell_orders)

        symbols = {p.symbol for p in buy_positions}
        symbols.update(str(v.get("symbol") or "") for v in sell_orders.values())
        symbols = {s for s in symbols if s}

        quote_map: dict[str, dict[str, Any]] = {}
        if symbols:
            try:
                quotes = await get_bulk_quotes(sorted(symbols))
                quote_map = {
                    sym: dict(q)
                    for sym, q in quotes.items()
                    if isinstance(q, dict)
                }
            except Exception as exc:
                logger.warning("Engine pending settlement quote fetch failed: %s", exc)

        changed = False
        acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
        account = acct_res.scalar_one_or_none()

        for position in buy_positions:
            if position.pending_since is None:
                continue

            # Ensure pending_since is timezone-aware for comparison
            ps = position.pending_since
            if ps.tzinfo is None:
                ps = ps.replace(tzinfo=timezone.utc)

            if (now - ps) < timedelta(seconds=PENDING_SETTLE_SECONDS):
                _mark_pending_reroll_state(
                    position.symbol,
                    side="BUY",
                    active=True,
                    result="waiting_delay",
                )
                continue  # not yet time to settle

            quote = quote_map.get(position.symbol, {})
            current_price = float(quote.get("last_price") or 0.0)
            pending_price = float(position.pending_avg_cost or 0.0)
            range_check = assess_pending_fill(
                reference_price=pending_price,
                quantity=position.pending_shares,
                low=quote.get("day_low"),
                high=quote.get("day_high"),
                volume=quote.get("volume"),
                drift_threshold_pct=drift_threshold_pct,
            )
            if not range_check["within_drift_range"]:
                _mark_pending_reroll_state(
                    position.symbol,
                    side="BUY",
                    active=True,
                    in_range=False,
                    result="out_of_range",
                )
                continue

            if not range_check["eligible_to_attempt"]:
                _mark_pending_reroll_state(
                    position.symbol,
                    side="BUY",
                    active=True,
                    in_range=bool(range_check["within_fill_range"]),
                    result="waiting_range_or_volume",
                )
                continue

            if random.random() > (buy_fill_rate / 100.0):
                _mark_pending_reroll_state(
                    position.symbol,
                    side="BUY",
                    active=True,
                    in_range=True,
                    result="miss",
                    increment_attempt=True,
                )
                logger.debug(
                    "Engine pending BUY reroll miss %s (rate=%.2f%%)",
                    position.symbol,
                    buy_fill_rate,
                )
                continue

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
            _mark_pending_reroll_state(
                position.symbol,
                side="BUY",
                active=False,
                in_range=True,
                result="filled",
                increment_attempt=True,
            )
            changed = True

            logger.info(
                "Engine settled pending BUY %s x%.4f @ avg $%.2f -> shares=%.4f",
                position.symbol, pending_qty, pending_cost, position.shares,
            )

        for position_id, order in sell_orders.items():
            created_at = order.get("created_at")
            symbol = str(order.get("symbol") or "")
            if not isinstance(created_at, datetime):
                _pop_pending_sell(position_id)
                continue
            created_at_utc = created_at if created_at.tzinfo is not None else created_at.replace(tzinfo=timezone.utc)
            if (now - created_at_utc) < timedelta(seconds=PENDING_SETTLE_SECONDS):
                _mark_pending_reroll_state(
                    symbol,
                    side="SELL",
                    active=True,
                    result="waiting_delay",
                )
                continue

            quote = quote_map.get(symbol, {})
            current_price = float(quote.get("last_price") or 0.0)
            pending_price = float(order.get("requested_price") or 0.0)
            range_check = assess_pending_fill(
                reference_price=pending_price,
                quantity=order.get("quantity"),
                low=quote.get("day_low"),
                high=quote.get("day_high"),
                volume=quote.get("volume"),
                drift_threshold_pct=drift_threshold_pct,
            )
            if not range_check["within_drift_range"]:
                _mark_pending_reroll_state(
                    symbol,
                    side="SELL",
                    active=True,
                    in_range=False,
                    result="out_of_range",
                )
                continue

            if not range_check["eligible_to_attempt"]:
                _mark_pending_reroll_state(
                    symbol,
                    side="SELL",
                    active=True,
                    in_range=bool(range_check["within_fill_range"]),
                    result="waiting_range_or_volume",
                )
                continue

            if random.random() > (sell_fill_rate / 100.0):
                _mark_pending_reroll_state(
                    symbol,
                    side="SELL",
                    active=True,
                    in_range=True,
                    result="miss",
                    increment_attempt=True,
                )
                logger.debug(
                    "Engine pending SELL reroll miss %s (rate=%.2f%%)",
                    symbol,
                    sell_fill_rate,
                )
                continue

            pos_res = await db.execute(
                sa_select(SandboxPosition).where(SandboxPosition.id == position_id)
            )
            position = pos_res.scalar_one_or_none()
            if not position:
                _pop_pending_sell(position_id)
                continue

            quantity = min(float(order.get("quantity") or 0.0), float(position.shares or 0.0))
            if quantity <= 0:
                _pop_pending_sell(position_id)
                continue

            total = quantity * current_price
            pnl = round((current_price - float(position.avg_cost or 0.0)) * quantity, 4)
            position.shares = max(0.0, float(position.shares or 0.0) - quantity)
            if position.shares <= 0:
                position.shares = 0.0
                position.avg_cost = 0.0
            position.allocated_funds += total
            position.realized_pnl += pnl
            if account:
                account.total_funds += pnl

            if bool(order.get("disable_engine_after_sell", False)) and position.shares <= 0:
                position.strategy_enabled = False
                position.engine_error = None

            trade = SandboxTrade(
                symbol=position.symbol,
                side="SELL",
                quantity=quantity,
                price=current_price,
                total=round(total, 4),
                strategy_name=position.strategy_name,
                reason=f"{order.get('reason') or 'pending_sell'} | pending_fill",
                pnl=pnl,
            )
            db.add(trade)
            _pop_pending_sell(position_id)
            _mark_pending_reroll_state(
                position.symbol,
                side="SELL",
                active=False,
                in_range=True,
                result="filled",
                increment_attempt=True,
            )
            changed = True

            _log_trade_activity(
                position.symbol,
                "SELL",
                quantity,
                current_price,
                str(order.get("reason") or "pending_sell"),
            )
            logger.info(
                "Engine settled pending SELL %s x%.4f @ $%.2f",
                position.symbol,
                quantity,
                current_price,
            )

        active_pending_symbols = {
            p.symbol
            for p in buy_positions
            if float(p.pending_shares or 0.0) > 0.0
        }
        active_pending_symbols.update(
            str(v.get("symbol") or "")
            for v in _pending_sell_orders.values()
            if str(v.get("symbol") or "")
        )
        for symbol, state in list(_symbol_status.items()):
            if bool(state.get("pending_reroll_active")) and symbol not in active_pending_symbols:
                _mark_pending_reroll_state(symbol, active=False, result="cleared")

        if changed:
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
