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

import asyncio
import logging
import math
from datetime import datetime, timezone, time as dt_time
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

# ── shared state ──────────────────────────────────────────────────────────── #
_running = False
_last_tick: datetime | None = None
_symbol_status: dict[str, dict] = {}   # { symbol: { last_signal, last_run_at, error } }


def get_engine_state() -> dict:
    return {
        "running": _running,
        "last_tick": _last_tick.isoformat() if _last_tick else None,
        "market_active": _market_is_active(),
        "symbols": dict(_symbol_status),
    }


# ── data fetching ─────────────────────────────────────────────────────────── #

async def _fetch_intraday_df(symbol: str) -> pd.DataFrame:
    """Return a DataFrame of recent intraday OHLCV bars for *symbol*."""
    from app.services.market_service import _yf_chart, _fmt_ts

    chart = await _yf_chart(symbol, range_="5d", interval="1m", include_pre_post=False)
    timestamps = chart.get("timestamp", [])
    quotes     = chart.get("indicators", {}).get("quote", [{}])[0]

    opens   = quotes.get("open",   [])
    highs   = quotes.get("high",   [])
    lows    = quotes.get("low",    [])
    closes  = quotes.get("close",  [])
    volumes = quotes.get("volume", [])

    rows = []
    for i, ts in enumerate(timestamps):
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        rows.append({
            "Open":   float(opens[i])   if i < len(opens)   and opens[i]   is not None else float(c),
            "High":   float(highs[i])   if i < len(highs)   and highs[i]   is not None else float(c),
            "Low":    float(lows[i])    if i < len(lows)    and lows[i]    is not None else float(c),
            "Close":  float(c),
            "Volume": int(volumes[i])   if i < len(volumes) and volumes[i] is not None else 0,
        })

    if not rows:
        raise ValueError(f"No intraday data returned for {symbol}")

    df = pd.DataFrame(rows)
    df.index = pd.RangeIndex(len(df))
    return df


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
        signal = int(last_row.get("signal", 0))
        position_change = int(df_sig["signal"].diff().iloc[-1] or 0) if len(df_sig) > 1 else signal

        status["last_signal"] = signal
        current_price = float(last_row["Close"])

        # Determine what action to take
        action = None
        reason = None

        if position_change > 0 and pos.shares == 0:
            # Buy signal – enter position
            action = "BUY"
            reason = f"Strategy {strategy_name.split(':')[0]} buy signal at ${current_price:.2f}"

        elif position_change < 0 and pos.shares > 0:
            # Sell signal – exit position
            action = "SELL"
            reason = f"Strategy {strategy_name.split(':')[0]} sell signal at ${current_price:.2f}"

        if action:
            await _execute_trade(pos, action, current_price, reason)

        # Write engine status back to the position row
        await _update_position_status(pos.id, signal, None, datetime.now(timezone.utc))

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
) -> None:
    """Open a fresh DB session and execute the simulated trade."""
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        result = await db.execute(
            sa_select(SandboxPosition).where(SandboxPosition.id == pos.id)
        )
        position = result.scalar_one_or_none()
        if not position:
            return

        pnl = None

        if side == "BUY":
            # Use available allocated funds to buy as many whole shares as possible
            available = position.allocated_funds
            if available < price:
                logger.debug("Engine BUY skipped for %s — insufficient funds ($%.2f)", pos.symbol, available)
                return
            quantity = math.floor(available / price)
            if quantity <= 0:
                return
            total = quantity * price
            new_shares = position.shares + quantity
            position.avg_cost = (position.avg_cost * position.shares + total) / new_shares
            position.shares = new_shares
            position.allocated_funds -= total

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
        logger.info("Engine %s %s x%.4f @ $%.2f (PnL: %s)", side, pos.symbol, quantity, price, pnl)


# ── main loop ─────────────────────────────────────────────────────────────── #

async def _tick(loop: asyncio.AbstractEventLoop) -> None:
    """One engine tick — load all enabled positions and process them."""
    global _last_tick

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
