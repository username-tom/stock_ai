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
    "min_position_funds_mode": "dollar",  # dollar | percent (of total funds)
    "min_position_funds_pct": 1.0,   # used when mode == percent
    "deploy_available_funds": True,   # allocate unassigned account cash each cycle
    "deploy_target": "most_bearish",   # most_bearish | most_bullish | most_held | least_held | specific
    "deploy_target_symbol": "",        # used when deploy_target == 'specific'
    "reallocation_enabled": True,      # enable bearish→bullish (or →available) rebalancing
    "reallocation_mode": "to_stock",   # to_stock | to_available
    "allow_buy_outside_allocation": False, # allow sandbox buy with funds outside allocation
    "market_sentiment_strategies": {
        "crash": "rsi",
        "bearish": "macd",
        "neutral": "bollinger",
        "bullish": "sma_crossover",
        "euphoric": "rsi",
    },
    "symbol_sentiment_strategies": {
        "crash": "rsi",
        "bearish": "macd",
        "neutral": "bollinger",
        "bullish": "sma_crossover",
        "euphoric": "rsi",
    },
    "sentiment_strategy_enabled": True,   # auto-change strategy based on sentiment
    "stop_loss_pct": 0.0,
    "take_profit_pct": 0.0,
}

# ── runtime state ─────────────────────────────────────────────────────────── #

_state: dict[str, Any] = {
    "running": False,
    "last_transfer_at": None,
    "last_score_at": None,
    "scores": {},          # { symbol: { score, classification, updated_at } }
    "last_activity": [],   # list of recent log entries (max 20)
    "market_classification": {
        "score": 0.0, "classification": "neutral", "bucket": "neutral", "updated_at": None,
    },
    "sentiment_groups": {"market": [], "symbol": []},  # symbols by sentiment mode
}


def get_manager_settings() -> dict:
    return dict(_settings)


def get_manager_state() -> dict:
    return {
        **_state,
        "last_transfer_at": _state["last_transfer_at"].isoformat() if _state["last_transfer_at"] else None,
        "last_score_at": _state["last_score_at"].isoformat() if _state["last_score_at"] else None,
        "market_classification": _state.get("market_classification"),
        "sentiment_groups": _state.get("sentiment_groups", {"market": [], "symbol": []}),
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
            _settings["min_position_funds_mode"] = getattr(row, "min_position_funds_mode", "dollar") or "dollar"
            _settings["min_position_funds_pct"] = float(getattr(row, "min_position_funds_pct", 1.0) or 1.0)
            _settings["deploy_available_funds"] = bool(row.deploy_available_funds)
            _settings["deploy_target"] = row.deploy_target
            _settings["deploy_target_symbol"] = row.deploy_target_symbol or ""
            _settings["reallocation_enabled"] = bool(row.reallocation_enabled) if row.reallocation_enabled is not None else True
            _settings["reallocation_mode"] = row.reallocation_mode or "to_stock"
            _settings["allow_buy_outside_allocation"] = bool(getattr(row, "allow_buy_outside_allocation", False))
            _settings["sentiment_strategy_enabled"] = bool(getattr(row, "sentiment_strategy_enabled", True))
            _settings["stop_loss_pct"] = float(getattr(row, "stop_loss_pct", 0.0) or 0.0)
            _settings["take_profit_pct"] = float(getattr(row, "take_profit_pct", 0.0) or 0.0)


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
        row.min_position_funds_mode = _settings.get("min_position_funds_mode", "dollar")
        row.min_position_funds_pct = float(_settings.get("min_position_funds_pct", 1.0))
        row.deploy_available_funds = _settings["deploy_available_funds"]
        row.deploy_target = _settings["deploy_target"]
        row.deploy_target_symbol = _settings["deploy_target_symbol"]
        row.reallocation_enabled = _settings["reallocation_enabled"]
        row.reallocation_mode = _settings["reallocation_mode"]
        row.allow_buy_outside_allocation = _settings["allow_buy_outside_allocation"]
        row.sentiment_strategy_enabled = _settings.get("sentiment_strategy_enabled", True)
        row.stop_loss_pct = float(_settings.get("stop_loss_pct", 0.0) or 0.0)
        row.take_profit_pct = float(_settings.get("take_profit_pct", 0.0) or 0.0)
        await db.commit()


def update_manager_settings(new: dict) -> dict:
    allowed = {"transfer_pct", "transfer_interval_s", "indicator_interval_s", "min_position_funds",
               "min_position_funds_mode", "min_position_funds_pct",
               "enabled", "deploy_available_funds", "deploy_target", "deploy_target_symbol",
               "reallocation_enabled", "reallocation_mode", "allow_buy_outside_allocation",
               "market_sentiment_strategies", "symbol_sentiment_strategies",
               "sentiment_strategy_enabled", "stop_loss_pct", "take_profit_pct"}
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


# ── sentiment strategy helpers ────────────────────────────────────────────── #

def _score_to_bucket(score: float) -> str:
    """Map a -1..1 composite score to a 5-label sentiment bucket."""
    if score >= 0.5:
        return "euphoric"
    if score >= 0.1:
        return "bullish"
    if score > -0.1:
        return "neutral"
    if score > -0.5:
        return "bearish"
    return "crash"


def _compute_market_classification() -> dict:
    """Derive overall market sentiment by averaging all tracked symbol scores."""
    scores = _state.get("scores", {})
    if not scores:
        return {"score": 0.0, "classification": "neutral", "bucket": "neutral"}
    avg_score = sum(v["score"] for v in scores.values()) / len(scores)
    bucket = _score_to_bucket(avg_score)
    classification = "bullish" if avg_score > 0.1 else ("bearish" if avg_score < -0.1 else "neutral")
    return {"score": round(avg_score, 3), "classification": classification, "bucket": bucket}


async def _apply_sentiment_strategies() -> None:
    """For positions with sentiment_mode set, update strategy_name based on current sentiment scores."""
    if not _settings.get("sentiment_strategy_enabled", True):
        return

    market = _compute_market_classification()
    _state["market_classification"] = {
        **market,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    market_bucket = market["bucket"]
    market_strats = _settings.get("market_sentiment_strategies", {})
    symbol_strats = _settings.get("symbol_sentiment_strategies", {})

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        res = await db.execute(
            sa_select(SandboxPosition).where(
                SandboxPosition.sentiment_mode.isnot(None),
                SandboxPosition.strategy_enabled == True,  # noqa: E712
            )
        )
        positions: list[SandboxPosition] = res.scalars().all()

        changed = []
        market_syms = []
        symbol_syms = []
        for pos in positions:
            mode = pos.sentiment_mode
            if mode == "market":
                market_syms.append(pos.symbol)
                target_strategy = market_strats.get(market_bucket)
            elif mode == "symbol":
                symbol_syms.append(pos.symbol)
                sym_score = _state["scores"].get(pos.symbol, {})
                sym_bucket = _score_to_bucket(float(sym_score.get("score", 0.0)))
                target_strategy = symbol_strats.get(sym_bucket)
            else:
                continue

            if target_strategy and pos.strategy_name != target_strategy:
                old = pos.strategy_name or "none"
                pos.strategy_name = target_strategy
                changed.append(f"{pos.symbol}: {old}→{target_strategy}")

        _state["sentiment_groups"] = {"market": market_syms, "symbol": symbol_syms}

        if changed:
            await db.commit()
            _log_activity(f"Sentiment strategy update: {', '.join(changed)}")


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


def _min_funds_floor(account_total_funds: float | None) -> float:
    mode = _settings.get("min_position_funds_mode", "dollar")
    if mode == "percent":
        pct = max(0.0, float(_settings.get("min_position_funds_pct", 1.0) or 0.0))
        base = max(0.0, float(account_total_funds or 0.0))
        return (base * pct) / 100.0
    return max(0.0, float(_settings.get("min_position_funds", 0.0) or 0.0))


def _position_max_allocation(position: SandboxPosition, account_total_funds: float | None) -> float:
    cap_val = float(getattr(position, "max_allocation_value", 0.0) or 0.0)
    if cap_val <= 0:
        return float("inf")
    mode = getattr(position, "max_allocation_mode", "dollar") or "dollar"
    if mode == "percent":
        base = max(0.0, float(account_total_funds or 0.0))
        return (base * cap_val) / 100.0
    return cap_val


async def _do_transfer() -> None:
    """Move funds from bearish positions to bullish positions, and optionally
    deploy unallocated account cash to the most bearish position."""
    transfer_pct = _settings["transfer_pct"]

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import SandboxAccount
        result = await db.execute(sa_select(SandboxPosition))
        positions: list[SandboxPosition] = result.scalars().all()
        acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
        account = acct_res.scalar_one_or_none()

    min_funds = _min_funds_floor(account.total_funds if account else 0.0)

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
    if _settings.get("deploy_available_funds") and account and _settings.get("reallocation_mode", "to_stock") != "to_available":
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
                        max_cap = _position_max_allocation(pos, acct2.total_funds)
                        room = max(0.0, max_cap - pos.allocated_funds) if max_cap != float("inf") else deployable
                        deploy_amount = min(deployable, room)
                        deploy_amount = math.floor(deploy_amount * 100) / 100
                        if deploy_amount <= 0:
                            deploy_amount = 0.0
                        else:
                            pos.allocated_funds += deploy_amount
                        # Do NOT touch total_funds — deploying to a position just
                        # moves cash from the unallocated pool to the position.
                        # Capital is preserved; available = total_funds - allocated - equity.
                        from app.models.sandbox import SandboxAllocationEvent
                        if deploy_amount > 0:
                            db.add(SandboxAllocationEvent(
                                event_type="deploy",
                                from_symbol=None,
                                to_symbol=target.symbol,
                                amount=round(deploy_amount, 4),
                                note=f"PM deploy [{_settings['deploy_target']}]",
                            ))
                            await db.commit()
                            _state["last_transfer_at"] = datetime.now(timezone.utc)
                            sc = scores.get(target.symbol, {})
                            score_str = f" (score {sc['score']:+.3f})" if sc.get("score") is not None else ""
                            _log_activity(f"Deployed ${deploy_amount:.2f} available funds → {target.symbol}{score_str} [{_settings['deploy_target']}]")

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

        async with AsyncSessionLocal() as db:
            from sqlalchemy import select as sa_select
            from app.models.sandbox import SandboxAllocationEvent

            acct_res2 = await db.execute(sa_select(SandboxAccount).limit(1))
            account2 = acct_res2.scalar_one_or_none()

            dest_rows: list[SandboxPosition] = []
            rooms: dict[int, float] = {}
            for dst_pos in bullish_pos:
                res = await db.execute(sa_select(SandboxPosition).where(SandboxPosition.id == dst_pos.id))
                pos = res.scalar_one_or_none()
                if not pos:
                    continue
                cap = _position_max_allocation(pos, account2.total_funds if account2 else 0.0)
                room = max(0.0, cap - pos.allocated_funds) if cap != float("inf") else total_to_move
                room = math.floor(room * 100) / 100
                if room > 0:
                    dest_rows.append(pos)
                    rooms[pos.id] = room

            if not dest_rows:
                return

            total_room = sum(rooms.values())
            actual_to_move = min(total_to_move, total_room)
            actual_to_move = math.floor(actual_to_move * 100) / 100
            if actual_to_move <= 0:
                return

            source_scale = actual_to_move / total_to_move if total_to_move > 0 else 0.0
            effective_from: list[tuple[SandboxPosition, float]] = []
            running_from = 0.0
            for idx, (src_pos, amount) in enumerate(transfers_from):
                src_amt = math.floor((amount * source_scale) * 100) / 100
                if idx == len(transfers_from) - 1:
                    src_amt = round(max(0.0, actual_to_move - running_from), 2)
                running_from += src_amt
                if src_amt > 0:
                    effective_from.append((src_pos, src_amt))

            to_amounts: dict[int, float] = {}
            running_to = 0.0
            for idx, dst in enumerate(dest_rows):
                room = rooms[dst.id]
                alloc = math.floor((actual_to_move * (room / total_room)) * 100) / 100 if total_room > 0 else 0.0
                alloc = min(alloc, room)
                if idx == len(dest_rows) - 1:
                    alloc = round(min(room, max(0.0, actual_to_move - running_to)), 2)
                to_amounts[dst.id] = alloc
                running_to += alloc

            remainder = round(actual_to_move - running_to, 2)
            if remainder > 0:
                for dst in dest_rows:
                    room_left = round(rooms[dst.id] - to_amounts[dst.id], 2)
                    if room_left <= 0:
                        continue
                    add = min(room_left, remainder)
                    to_amounts[dst.id] = round(to_amounts[dst.id] + add, 2)
                    remainder = round(remainder - add, 2)
                    if remainder <= 0:
                        break

            for src_pos, amount in effective_from:
                res = await db.execute(sa_select(SandboxPosition).where(SandboxPosition.id == src_pos.id))
                pos = res.scalar_one_or_none()
                if pos:
                    pos.allocated_funds = max(0.0, pos.allocated_funds - amount)

            id_to_dest = {d.id: d for d in dest_rows}
            for dst_id, amount in to_amounts.items():
                if amount <= 0:
                    continue
                id_to_dest[dst_id].allocated_funds += amount

            # Log a single reallocate event per (source → destination) pair
            total_to_amounts = sum(to_amounts.values())
            for src_pos, amount in effective_from:
                for dst_id, dst_amount in to_amounts.items():
                    share = math.floor((amount * (dst_amount / total_to_amounts)) * 100) / 100 if total_to_amounts > 0 else 0
                    if share > 0:
                        dst_pos = id_to_dest[dst_id]
                        db.add(SandboxAllocationEvent(
                            event_type="reallocate",
                            from_symbol=src_pos.symbol,
                            to_symbol=dst_pos.symbol,
                            amount=round(share, 4),
                            note="PM: bearish→bullish rebalance",
                        ))

            await db.commit()

        _state["last_transfer_at"] = datetime.now(timezone.utc)

        from_desc = ", ".join(f"{p.symbol} (−${a:.2f})" for p, a in effective_from)
        to_desc = ", ".join(
            f"{p.symbol} (+${to_amounts.get(p.id, 0):.2f})"
            for p in bullish_pos
            if to_amounts.get(p.id, 0) > 0
        )
        _log_activity(f"Transferred ${actual_to_move:.2f} | from: {from_desc} | to: {to_desc}")


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
                    await _apply_sentiment_strategies()
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
