"""Portfolio Manager – automatic fund rebalancing between bearish and bullish positions.

The manager wakes up on a configurable interval, classifies each active sandbox
position as *bullish* or *bearish* using recent price-action indicators (RSI,
MACD, SMA trend), then moves a configurable percentage of available funds from
bearish positions to bullish ones, subject to per-position minimums.

Settings (persisted in-memory, reset on server restart unless saved to DB):
  enabled               – master on/off switch
  transfer_pct          – fraction of bearish available-cash to move per cycle  (0–1)
  transfer_interval_s   – seconds between rebalance cycles
  indicator_interval_s  – seconds between re-scoring each stock
  min_position_funds    – minimum $ that must remain allocated to any position
  deploy_available_funds – whether to deploy unallocated account cash each cycle
  deploy_target         – where to deploy: most_bearish | most_bullish | most_held | least_held | specific
  deploy_target_symbol  – symbol to target when deploy_target == 'specific'
"""
from __future__ import annotations

import asyncio
import logging
import math
from datetime import datetime, timezone
from typing import Any

import pandas as pd

from app.database import AsyncSessionLocal
from app.models.sandbox import SandboxPosition, SandboxTrade

logger = logging.getLogger(__name__)

# ── default settings ──────────────────────────────────────────────────────── #

_settings: dict[str, Any] = {
    "enabled": False,
    "transfer_pct": 0.50,            # move 50 % of bearish idle cash per cycle
    "transfer_interval_s": 300,      # rebalance every 5 minutes
    "indicator_interval_s": 120,     # refresh scores every 2 minutes
    "min_position_funds": 100.0,     # never leave less than $100 in any position
    "deploy_available_funds": True,   # allocate unassigned account cash each cycle
    "deploy_target": "most_bearish",   # most_bearish | most_bullish | most_held | least_held | specific
    "deploy_target_symbol": "",        # used when deploy_target == 'specific'
    "reallocation_enabled": True,      # enable bearish→bullish (or →available) rebalancing
    "reallocation_mode": "to_stock",   # to_stock | to_available
}

# ── runtime state ─────────────────────────────────────────────────────────── #

_state: dict[str, Any] = {
    "running": False,
    "last_transfer_at": None,
    "last_score_at": None,
    "scores": {},          # { symbol: { score, classification, updated_at } }
    "last_activity": [],   # list of recent log entries (max 20)
}


def get_manager_settings() -> dict:
    return dict(_settings)


def get_manager_state() -> dict:
    return {
        **_state,
        "last_transfer_at": _state["last_transfer_at"].isoformat() if _state["last_transfer_at"] else None,
        "last_score_at": _state["last_score_at"].isoformat() if _state["last_score_at"] else None,
        "settings": get_manager_settings(),
    }


async def _load_settings_from_db() -> None:
    """Overwrite in-memory _settings from the DB row on startup."""
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import PortfolioManagerSettings
        res = await db.execute(sa_select(PortfolioManagerSettings).where(PortfolioManagerSettings.id == 1))
        row = res.scalar_one_or_none()
        if row:
            _settings["enabled"] = bool(row.enabled)
            _settings["transfer_pct"] = row.transfer_pct
            _settings["transfer_interval_s"] = row.transfer_interval_s
            _settings["indicator_interval_s"] = row.indicator_interval_s
            _settings["min_position_funds"] = row.min_position_funds
            _settings["deploy_available_funds"] = bool(row.deploy_available_funds)
            _settings["deploy_target"] = row.deploy_target
            _settings["deploy_target_symbol"] = row.deploy_target_symbol or ""
            _settings["reallocation_enabled"] = bool(row.reallocation_enabled) if row.reallocation_enabled is not None else True
            _settings["reallocation_mode"] = row.reallocation_mode or "to_stock"


async def _save_settings_to_db() -> None:
    """Persist current in-memory _settings to the DB."""
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import PortfolioManagerSettings
        res = await db.execute(sa_select(PortfolioManagerSettings).where(PortfolioManagerSettings.id == 1))
        row = res.scalar_one_or_none()
        if not row:
            from app.models.sandbox import PortfolioManagerSettings as PMS
            row = PMS(id=1)
            db.add(row)
        row.enabled = _settings["enabled"]
        row.transfer_pct = _settings["transfer_pct"]
        row.transfer_interval_s = _settings["transfer_interval_s"]
        row.indicator_interval_s = _settings["indicator_interval_s"]
        row.min_position_funds = _settings["min_position_funds"]
        row.deploy_available_funds = _settings["deploy_available_funds"]
        row.deploy_target = _settings["deploy_target"]
        row.deploy_target_symbol = _settings["deploy_target_symbol"]
        row.reallocation_enabled = _settings["reallocation_enabled"]
        row.reallocation_mode = _settings["reallocation_mode"]
        await db.commit()


def update_manager_settings(new: dict) -> dict:
    allowed = {"transfer_pct", "transfer_interval_s", "indicator_interval_s", "min_position_funds",
               "enabled", "deploy_available_funds", "deploy_target", "deploy_target_symbol",
               "reallocation_enabled", "reallocation_mode"}
    for k, v in new.items():
        if k in allowed:
            _settings[k] = v
    asyncio.get_event_loop().create_task(_save_settings_to_db())
    return get_manager_settings()


# ── scoring ───────────────────────────────────────────────────────────────── #

async def _fetch_bars(symbol: str) -> pd.DataFrame:
    """Fetch recent intraday bars for scoring (re-uses the shared market_service helper)."""
    from app.services.market_service import get_intraday_df
    df = await get_intraday_df(symbol, range_="5d", interval="1m", include_pre_post=False)
    return df[["Close", "Volume"]]


def _score_symbol(df: pd.DataFrame) -> tuple[float, str]:
    """
    Return (score, classification) where score is −1..+1 and classification
    is one of 'bullish', 'neutral', 'bearish'.

    Composite of three sub-signals, each contributing ±1/3:
      1. RSI  – < 40 bearish, > 60 bullish
      2. MACD histogram sign (12/26/9 EMA)
      3. Close vs 20-bar SMA trend
    """
    closes = df["Close"]
    score = 0.0

    # RSI
    if len(closes) >= 15:
        delta = closes.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        last_loss = loss.iloc[-1]
        rs = gain.iloc[-1] / last_loss if last_loss and last_loss != 0 else float("inf")
        rsi = 100 - 100 / (1 + rs)
        if rsi < 40:
            score -= 1 / 3
        elif rsi > 60:
            score += 1 / 3

    # MACD histogram
    if len(closes) >= 35:
        ema12 = closes.ewm(span=12, adjust=False).mean()
        ema26 = closes.ewm(span=26, adjust=False).mean()
        macd_line = ema12 - ema26
        signal_line = macd_line.ewm(span=9, adjust=False).mean()
        hist = macd_line - signal_line
        if hist.iloc[-1] > 0:
            score += 1 / 3
        elif hist.iloc[-1] < 0:
            score -= 1 / 3

    # SMA trend (close vs 20-bar SMA)
    if len(closes) >= 20:
        sma20 = closes.rolling(20).mean()
        if closes.iloc[-1] > sma20.iloc[-1]:
            score += 1 / 3
        elif closes.iloc[-1] < sma20.iloc[-1]:
            score -= 1 / 3

    score = max(-1.0, min(1.0, score))
    if score > 0.1:
        classification = "bullish"
    elif score < -0.1:
        classification = "bearish"
    else:
        classification = "neutral"

    return round(score, 3), classification


async def _refresh_scores(symbols: list[str]) -> None:
    """Fetch bars and score all symbols concurrently."""
    async def _score_one(sym: str):
        try:
            df = await _fetch_bars(sym)
            score, cls = _score_symbol(df)
            _state["scores"][sym] = {
                "score": score,
                "classification": cls,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as exc:
            logger.warning("PM score error for %s: %s", sym, exc)
            _state["scores"].setdefault(sym, {
                "score": 0.0,
                "classification": "neutral",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })

    await asyncio.gather(*[_score_one(s) for s in symbols], return_exceptions=True)
    _state["last_score_at"] = datetime.now(timezone.utc)


# ── transfer logic ────────────────────────────────────────────────────────── #

def _log_activity(msg: str) -> None:
    entry = {"at": datetime.now(timezone.utc).isoformat(), "msg": msg}
    _state["last_activity"].insert(0, entry)
    _state["last_activity"] = _state["last_activity"][:20]
    logger.info("PortfolioManager: %s", msg)


def _pick_deploy_target(
    positions: list[SandboxPosition],
    scores: dict,
) -> SandboxPosition | None:
    """Return the position that should receive deployed available funds."""
    if not positions:
        return None

    deploy_target = _settings.get("deploy_target", "most_bearish")

    if deploy_target == "specific":
        sym = (_settings.get("deploy_target_symbol") or "").upper()
        return next((p for p in positions if p.symbol == sym), None)

    if deploy_target == "most_bearish":
        scored = [(p, scores[p.symbol]["score"]) for p in positions if p.symbol in scores]
        return min(scored, key=lambda x: x[1])[0] if scored else None

    if deploy_target == "most_bullish":
        scored = [(p, scores[p.symbol]["score"]) for p in positions if p.symbol in scores]
        return max(scored, key=lambda x: x[1])[0] if scored else None

    if deploy_target == "most_held":
        return max(positions, key=lambda p: (p.shares * (p.avg_cost or 0)) + (p.pending_shares * (p.pending_avg_cost or 0)))

    if deploy_target == "least_held":
        return min(positions, key=lambda p: (p.shares * (p.avg_cost or 0)) + (p.pending_shares * (p.pending_avg_cost or 0)))

    return None


async def _do_transfer() -> None:
    """Move funds from bearish positions to bullish positions, and optionally
    deploy unallocated account cash to the most bearish position."""
    min_funds = _settings["min_position_funds"]
    transfer_pct = _settings["transfer_pct"]

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import SandboxAccount
        result = await db.execute(sa_select(SandboxPosition))
        positions: list[SandboxPosition] = result.scalars().all()
        acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
        account = acct_res.scalar_one_or_none()

    if not positions:
        return

    scores = _state["scores"]

    bearish_pos = []
    bullish_pos = []

    for p in positions:
        sc = scores.get(p.symbol, {})
        cls = sc.get("classification", "neutral")
        # allocated_funds is already reduced by the cost of any pending order
        # (the engine debits it at order placement).  Subtract settled shares
        # cost basis to get truly idle cash.  Positions with an active pending
        # order should not be drained — their funds are already committed.
        settled_cost = p.avg_cost * p.shares
        pending_cost = p.pending_avg_cost * p.pending_shares
        idle_cash = p.allocated_funds - settled_cost
        has_pending = p.pending_shares > 0
        if cls == "bearish" and idle_cash > min_funds and not has_pending:
            bearish_pos.append((p, idle_cash))
        elif cls == "bullish":
            bullish_pos.append(p)

    # ── deploy unallocated account funds to target position ─────── #
    if _settings.get("deploy_available_funds") and account:
        from app.routers.sandbox_router._helpers import compute_available_cash
        available = await compute_available_cash(None, account, positions)  # type: ignore[arg-type]
        deployable = math.floor(available * transfer_pct * 100) / 100
        if deployable > 0:
            target = _pick_deploy_target(positions, scores)
            if target:
                async with AsyncSessionLocal() as db:
                    from sqlalchemy import select as sa_select
                    from app.models.sandbox import SandboxAccount as _SandboxAccount
                    res = await db.execute(sa_select(SandboxPosition).where(SandboxPosition.id == target.id))
                    pos = res.scalar_one_or_none()
                    acct_res2 = await db.execute(sa_select(_SandboxAccount).limit(1))
                    acct2 = acct_res2.scalar_one_or_none()
                    if pos and acct2:
                        pos.allocated_funds += deployable
                        # Do NOT touch total_funds — deploying to a position just
                        # moves cash from the unallocated pool to the position.
                        # Capital is preserved; available = total_funds - allocated - equity.
                        from app.models.sandbox import SandboxAllocationEvent
                        db.add(SandboxAllocationEvent(
                            event_type="deploy",
                            from_symbol=None,
                            to_symbol=target.symbol,
                            amount=round(deployable, 4),
                            note=f"PM deploy [{_settings['deploy_target']}]",
                        ))
                        await db.commit()
                        _state["last_transfer_at"] = datetime.now(timezone.utc)
                        sc = scores.get(target.symbol, {})
                        score_str = f" (score {sc['score']:+.3f})" if sc.get("score") is not None else ""
                        _log_activity(f"Deployed ${deployable:.2f} available funds → {target.symbol}{score_str} [{_settings['deploy_target']}]")

    # ── fund reallocation ─────────────────────────────────────────── #
    if not _settings.get("reallocation_enabled", True):
        return

    reallocation_mode = _settings.get("reallocation_mode", "to_stock")

    if reallocation_mode == "to_available":
        # Move idle cash from every position back to account.total_funds,
        # leaving only min_position_funds (or the cost basis) in each slot.
        # This frees up available funds for strategies to spend directly.
        total_freed = 0.0
        async with AsyncSessionLocal() as db:
            from sqlalchemy import select as sa_select
            from app.models.sandbox import SandboxAccount
            res = await db.execute(sa_select(SandboxPosition))
            fresh_positions: list[SandboxPosition] = res.scalars().all()
            acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
            account = acct_res.scalar_one_or_none()
            if account:
                for pos in fresh_positions:
                    # Skip positions with an active pending order — their
                    # funds are already committed and should not be moved.
                    if pos.pending_shares > 0:
                        continue
                    # idle cash = allocated minus what's locked in settled shares
                    cost_basis = pos.avg_cost * pos.shares
                    idle = pos.allocated_funds - cost_basis
                    # how much we can safely pull out
                    movable = max(0.0, idle - min_funds)
                    movable = math.floor(movable * transfer_pct * 100) / 100
                    if movable > 0:
                        pos.allocated_funds -= movable
                        total_freed += movable
                        from app.models.sandbox import SandboxAllocationEvent
                        db.add(SandboxAllocationEvent(
                            event_type="deallocate",
                            from_symbol=pos.symbol,
                            to_symbol=None,
                            amount=round(movable, 4),
                            note="PM: return idle cash to available pool",
                        ))
                await db.commit()
        if total_freed > 0:
            _state["last_transfer_at"] = datetime.now(timezone.utc)
            _log_activity(f"Freed ${total_freed:.2f} idle cash from positions → available funds")
        return
    else:
        # ── to_stock: bearish → bullish rebalance ─────────────────────── #
        if not bearish_pos or not bullish_pos:
            return

        total_to_move = 0.0
        transfers_from: list[tuple[SandboxPosition, float]] = []
        for p, idle in bearish_pos:
            movable = max(0.0, (idle - min_funds) * transfer_pct)
            movable = math.floor(movable * 100) / 100
            if movable > 0:
                transfers_from.append((p, movable))
                total_to_move += movable

        if total_to_move <= 0:
            return

        per_bullish = math.floor((total_to_move / len(bullish_pos)) * 100) / 100

        async with AsyncSessionLocal() as db:
            from sqlalchemy import select as sa_select
            from app.models.sandbox import SandboxAllocationEvent

            for src_pos, amount in transfers_from:
                res = await db.execute(sa_select(SandboxPosition).where(SandboxPosition.id == src_pos.id))
                pos = res.scalar_one_or_none()
                if pos:
                    pos.allocated_funds = max(0.0, pos.allocated_funds - amount)

            for dst_pos in bullish_pos:
                res = await db.execute(sa_select(SandboxPosition).where(SandboxPosition.id == dst_pos.id))
                pos = res.scalar_one_or_none()
                if pos:
                    pos.allocated_funds += per_bullish

            # Log a single reallocate event per (source → destination) pair
            for src_pos, amount in transfers_from:
                for dst_pos in bullish_pos:
                    share = math.floor((amount / len(bullish_pos)) * 100) / 100
                    if share > 0:
                        db.add(SandboxAllocationEvent(
                            event_type="reallocate",
                            from_symbol=src_pos.symbol,
                            to_symbol=dst_pos.symbol,
                            amount=round(share, 4),
                            note="PM: bearish→bullish rebalance",
                        ))

            await db.commit()

        _state["last_transfer_at"] = datetime.now(timezone.utc)

        from_desc = ", ".join(f"{p.symbol} (−${a:.2f})" for p, a in transfers_from)
        to_desc = ", ".join(f"{p.symbol} (+${per_bullish:.2f})" for p in bullish_pos)
        _log_activity(f"Transferred ${total_to_move:.2f} | from: {from_desc} | to: {to_desc}")


# ── main loop ─────────────────────────────────────────────────────────────── #

async def run_portfolio_manager() -> None:
    """Long-running coroutine – start as an asyncio task from app lifespan."""
    _state["running"] = True
    await _load_settings_from_db()
    logger.info("Portfolio Manager task started (enabled=%s).", _settings["enabled"])

    last_transfer = 0.0
    last_score = 0.0

    while True:
        await asyncio.sleep(10)

        if not _settings["enabled"]:
            continue

        from app.services.sandbox_engine import _market_is_active
        if not _market_is_active():
            continue

        now = asyncio.get_event_loop().time()

        # Refresh scores on interval
        if now - last_score >= _settings["indicator_interval_s"]:
            try:
                async with AsyncSessionLocal() as db:
                    from sqlalchemy import select as sa_select
                    res = await db.execute(sa_select(SandboxPosition))
                    syms = [p.symbol for p in res.scalars().all()]
                if syms:
                    await _refresh_scores(syms)
            except Exception as exc:
                logger.warning("PM score refresh error: %s", exc)
            last_score = now

        # Transfer on interval
        if now - last_transfer >= _settings["transfer_interval_s"]:
            try:
                await _do_transfer()
            except Exception as exc:
                logger.warning("PM transfer error: %s", exc)
                _log_activity(f"Transfer error: {exc}")
            last_transfer = now
