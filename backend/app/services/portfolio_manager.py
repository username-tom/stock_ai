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
import json
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
        "neutral": "bollinger_bands",
        "bullish": "sma_crossover",
        "euphoric": "rsi",
    },
    "symbol_sentiment_strategies": {
        "crash": "rsi",
        "bearish": "macd",
        "neutral": "bollinger_bands",
        "bullish": "sma_crossover",
        "euphoric": "rsi",
    },
    "sentiment_strategy_enabled": True,   # auto-change strategy based on sentiment
    "ai_tag_strategy_enabled": False,      # auto-change strategy based on AI learner tag
    "ai_tag_strategies": {
        "STRONG LONG": "sma_crossover",
        "LONG": "sma_crossover",
        "NEUTRAL": "",           # empty = keep current strategy (no override)
        "SHORT": "rsi",
        "STRONG SHORT": "rsi",
    },
    "ai_tag_allow_overnight": True,        # LONG/STRONG LONG positions skip EOD liquidation
    "ai_tag_action_mode": "strategy_override",  # strategy_override | direct
    "ai_tag_long_engine_off": True,        # disable engine after buy for LONG/STRONG LONG (hold mode)
    "ai_tag_long_tp_pct": 0.0,            # take profit % for long-hold positions (0 = disabled)
    "ai_tag_long_sl_pct": 0.0,            # stop loss  % for long-hold positions (0 = disabled)
    "stop_loss_pct": 0.0,
    "take_profit_pct": 0.0,
    "hold_positions_overnight": True,     # whether to hold positions between days
    "eod_engine_shutoff_minutes_before_sell": 120,  # minutes before sell window to block new buys
    "eod_sell_window_minutes": 30,        # minutes before market close to start sell-only mode
    "sentiment_lookback_days": 5,         # days of historical data for sentiment calc
    "sentiment_data_points": 10,          # number of recent bars used for sentiment calc
    "sentiment_interval": "1m",           # interval: 1m, 5m, 15m, 1h, daily, etc.
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
    "last_engine_reenable_day": None,
    "ai_tags": {},   # { symbol: { learner_tag, learner_direction, learner_confidence } }
}

# Prevent repeated IB profit-take submissions every PM loop tick.
_ib_profit_take_last_attempt: dict[str, datetime] = {}


def get_manager_settings() -> dict:
    return dict(_settings)


def get_manager_state() -> dict:
    return {
        **_state,
        "last_transfer_at": _state["last_transfer_at"].isoformat() if _state["last_transfer_at"] else None,
        "last_score_at": _state["last_score_at"].isoformat() if _state["last_score_at"] else None,
        "market_classification": _state.get("market_classification"),
        "sentiment_groups": _state.get("sentiment_groups", {"market": [], "symbol": []}),
        "ai_tags": _state.get("ai_tags", {}),
        "settings": get_manager_settings(),
    }


# Legacy strategy name aliases – renamed in a previous refactor.
_LEGACY_STRATEGY_NAMES: dict[str, str] = {"bollinger": "bollinger_bands"}


def _load_strategy_map(raw_value: Any, fallback: dict[str, str]) -> dict[str, str]:
    """Return a safe strategy-map dict from DB text, dict, or fallback defaults.

    Automatically migrates legacy strategy names (e.g. ``bollinger`` →
    ``bollinger_bands``) so that old persisted settings keep working.
    """
    if isinstance(raw_value, dict):
        merged = {**fallback, **raw_value}
    elif isinstance(raw_value, str) and raw_value.strip():
        try:
            parsed = json.loads(raw_value)
            if isinstance(parsed, dict):
                merged = {**fallback, **parsed}
            else:
                merged = dict(fallback)
        except Exception:
            merged = dict(fallback)
    else:
        merged = dict(fallback)
    # Migrate any legacy names stored in the DB.
    return {k: _LEGACY_STRATEGY_NAMES.get(v, v) for k, v in merged.items()}


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
            _settings["market_sentiment_strategies"] = _load_strategy_map(
                getattr(row, "market_sentiment_strategies", None),
                _settings["market_sentiment_strategies"],
            )
            _settings["symbol_sentiment_strategies"] = _load_strategy_map(
                getattr(row, "symbol_sentiment_strategies", None),
                _settings["symbol_sentiment_strategies"],
            )
            _settings["sentiment_strategy_enabled"] = bool(getattr(row, "sentiment_strategy_enabled", True))
            _settings["stop_loss_pct"] = float(getattr(row, "stop_loss_pct", 0.0) or 0.0)
            _settings["take_profit_pct"] = float(getattr(row, "take_profit_pct", 0.0) or 0.0)
            _settings["hold_positions_overnight"] = bool(getattr(row, "hold_positions_overnight", True))
            _settings["eod_engine_shutoff_minutes_before_sell"] = int(getattr(row, "eod_engine_shutoff_minutes_before_sell", 120) or 120)
            _settings["eod_sell_window_minutes"] = int(getattr(row, "eod_sell_window_minutes", 30) or 30)
            _settings["sentiment_lookback_days"] = int(getattr(row, "sentiment_lookback_days", 5) or 5)
            _settings["sentiment_data_points"] = int(getattr(row, "sentiment_data_points", 10) or 10)
            _settings["sentiment_interval"] = getattr(row, "sentiment_interval", "1m") or "1m"
            _settings["ai_tag_strategy_enabled"] = bool(getattr(row, "ai_tag_strategy_enabled", False))
            _settings["ai_tag_strategies"] = _load_strategy_map(
                getattr(row, "ai_tag_strategies", None),
                _settings["ai_tag_strategies"],
            )
            _settings["ai_tag_allow_overnight"] = bool(getattr(row, "ai_tag_allow_overnight", True))
            _settings["ai_tag_action_mode"] = getattr(row, "ai_tag_action_mode", "strategy_override") or "strategy_override"
            _settings["ai_tag_long_engine_off"] = bool(getattr(row, "ai_tag_long_engine_off", True))
            _settings["ai_tag_long_tp_pct"] = float(getattr(row, "ai_tag_long_tp_pct", 0.0) or 0.0)
            _settings["ai_tag_long_sl_pct"] = float(getattr(row, "ai_tag_long_sl_pct", 0.0) or 0.0)


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
        row.market_sentiment_strategies = json.dumps(_settings.get("market_sentiment_strategies", {}), sort_keys=True)
        row.symbol_sentiment_strategies = json.dumps(_settings.get("symbol_sentiment_strategies", {}), sort_keys=True)
        row.sentiment_strategy_enabled = _settings.get("sentiment_strategy_enabled", True)
        row.stop_loss_pct = float(_settings.get("stop_loss_pct", 0.0) or 0.0)
        row.take_profit_pct = float(_settings.get("take_profit_pct", 0.0) or 0.0)
        row.hold_positions_overnight = _settings.get("hold_positions_overnight", True)
        row.eod_engine_shutoff_minutes_before_sell = int(_settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120)
        row.eod_sell_window_minutes = int(_settings.get("eod_sell_window_minutes", 30) or 30)
        row.sentiment_lookback_days = int(_settings.get("sentiment_lookback_days", 5) or 5)
        row.sentiment_data_points = int(_settings.get("sentiment_data_points", 10) or 10)
        row.sentiment_interval = _settings.get("sentiment_interval", "1m") or "1m"
        row.ai_tag_strategy_enabled = bool(_settings.get("ai_tag_strategy_enabled", False))
        row.ai_tag_strategies = json.dumps(_settings.get("ai_tag_strategies", {}), sort_keys=True)
        row.ai_tag_allow_overnight = bool(_settings.get("ai_tag_allow_overnight", True))
        row.ai_tag_action_mode = _settings.get("ai_tag_action_mode", "strategy_override") or "strategy_override"
        row.ai_tag_long_engine_off = bool(_settings.get("ai_tag_long_engine_off", True))
        row.ai_tag_long_tp_pct = float(_settings.get("ai_tag_long_tp_pct", 0.0) or 0.0)
        row.ai_tag_long_sl_pct = float(_settings.get("ai_tag_long_sl_pct", 0.0) or 0.0)
        await db.commit()


def update_manager_settings(new: dict) -> dict:
    allowed = {"transfer_pct", "transfer_interval_s", "indicator_interval_s", "min_position_funds",
               "min_position_funds_mode", "min_position_funds_pct",
               "enabled", "deploy_available_funds", "deploy_target", "deploy_target_symbol",
               "reallocation_enabled", "reallocation_mode", "allow_buy_outside_allocation",
               "market_sentiment_strategies", "symbol_sentiment_strategies",
              "sentiment_strategy_enabled", "sentiment_lookback_days", "sentiment_data_points", "sentiment_interval",
              "stop_loss_pct", "take_profit_pct",
              "hold_positions_overnight", "eod_engine_shutoff_minutes_before_sell", "eod_sell_window_minutes",
              "ai_tag_strategy_enabled", "ai_tag_strategies", "ai_tag_allow_overnight",
              "ai_tag_action_mode",
              "ai_tag_long_engine_off", "ai_tag_long_tp_pct", "ai_tag_long_sl_pct"}
    for k, v in new.items():
        if k in allowed:
            _settings[k] = v

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(_save_settings_to_db())
        if any(key in new for key in ("market_sentiment_strategies", "symbol_sentiment_strategies", "sentiment_strategy_enabled", "sentiment_lookback_days", "sentiment_data_points", "sentiment_interval")):
            async def _refresh_and_apply() -> None:
                # Refresh scores for every position that is in sentiment-routing
                # mode so that the strategy update uses current data, not stale
                # or empty scores (the latter would silently skip the update).
                async with AsyncSessionLocal() as _db:
                    from sqlalchemy import select as _sa_select
                    _res = await _db.execute(
                        _sa_select(SandboxPosition).where(SandboxPosition.sentiment_mode.isnot(None))
                    )
                    syms = list({p.symbol for p in _res.scalars().all()})
                if syms:
                    await _refresh_scores(syms)
                await _apply_sentiment_strategies()
            loop.create_task(_refresh_and_apply())
        if any(key in new for key in ("ai_tag_strategy_enabled", "ai_tag_strategies")):
            loop.create_task(_apply_ai_tag_strategies())
    return get_manager_settings()


# ── scoring ───────────────────────────────────────────────────────────────── #

async def _fetch_bars(symbol: str) -> pd.DataFrame:
    """Fetch recent intraday bars for scoring (re-uses the shared market_service helper)."""
    from app.services.market_service import get_intraday_df
    lookback_days = _settings.get("sentiment_lookback_days", 5)
    data_points = max(1, int(_settings.get("sentiment_data_points", 10) or 10))
    interval = _settings.get("sentiment_interval", "1m")
    range_str = f"{lookback_days}d"
    # Force YF for sentiment scoring – IB pacing is preserved for trading
    # signals and scoring doesn't need tick-level data accuracy.
    df = await get_intraday_df(symbol, range_=range_str, interval=interval, include_pre_post=False, force_yf=True)
    bars = df[["Close", "Volume"]]
    return bars.tail(data_points)


def _score_symbol(df: pd.DataFrame) -> tuple[float, str]:
    """
    Return (score, classification) where score is −1..+1 and classification
    is one of 'crash', 'bearish', 'neutral', 'bullish', 'euphoric'.

    Composite of three sub-signals, each contributing ±1/3:
      1. RSI  – < 30 crash, < 40 bearish, > 70 euphoric, > 60 bullish
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
        if rsi < 30:
            score -= 2 / 3
        elif rsi < 40:
            score -= 1 / 3
        elif rsi > 70:
            score += 2 / 3
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
    if score >= 0.5:
        classification = "euphoric"
    elif score >= 0.1:
        classification = "bullish"
    elif score > -0.1:
        classification = "neutral"
    elif score > -0.5:
        classification = "bearish"
    else:
        classification = "crash"

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
    classification = bucket
    return {"score": round(avg_score, 3), "classification": classification, "bucket": bucket}


async def _apply_sentiment_strategies() -> None:
    """For positions with sentiment_mode set, update strategy_name based on current sentiment scores."""
    if not _settings.get("sentiment_strategy_enabled", True):
        return
    if not _state.get("scores"):
        # Scores have not been loaded yet (e.g. PM never ran or server just
        # restarted).  Applying strategies now would classify every position as
        # "neutral" and set an incorrect default.  Wait until the normal PM
        # loop has populated scores via _refresh_scores().
        logger.debug("Skipping sentiment strategy update – no scores available yet.")
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


async def _apply_ai_tag_strategies() -> None:
    """Apply strategy overrides / direct trades based on the AI learner tag.

    Mode: strategy_override (default)
    ----------------------------------
    - WATCH → keep default engine strategy unchanged.
    - Other tags → apply the configured strategy name from ai_tag_strategies.
    - With ai_tag_long_engine_off: disable engine after BUY for LONG/STRONG LONG,
      re-enable on TP/SL hit or tag change.

    Mode: direct
    ------------
    - LONG/STRONG LONG: PM manages all trading directly; engine stays off.
      · No position → direct BUY (bypasses engine shutoff window; respects market open
        and final EOD sell window when hold_positions_overnight is disabled).
      · Has position → monitor TP/SL; direct SELL when hit.
      · Tag change LONG/STRONG LONG → other → direct SELL; re-enable engine.
    - Other tags still receive strategy name overrides (same as strategy_override mode).
    """
    if not _settings.get("ai_tag_strategy_enabled", False):
        return

    tag_strategies = _settings.get("ai_tag_strategies", {})
    action_mode = _settings.get("ai_tag_action_mode", "strategy_override")
    engine_off_mode = bool(_settings.get("ai_tag_long_engine_off", True))
    long_tp = float(_settings.get("ai_tag_long_tp_pct", 0.0) or 0.0)
    long_sl = float(_settings.get("ai_tag_long_sl_pct", 0.0) or 0.0)

    # Record existing tags before overwrite for change-detection.
    old_tags: dict[str, str] = {
        sym: (info.get("learner_tag") or "WATCH").upper()
        for sym, info in _state.get("ai_tags", {}).items()
    }

    # ── 1. Fetch all positions ─────────────────────────────────────────── #
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        res = await db.execute(sa_select(SandboxPosition))
        snap: list[SandboxPosition] = res.scalars().all()
        if not snap:
            return
        symbols = [p.symbol for p in snap]

    # ── 2. Classify symbols ───────────────────────────────────────────── #
    try:
        from app.services.stock_learner import classify_symbols
        insights = await classify_symbols(symbols)
    except Exception as exc:
        logger.warning("AI tag classification failed: %s", exc)
        return

    # Persist current tags in state for engine overnight-override lookups.
    _state["ai_tags"] = {
        sym: {
            "learner_tag": info.get("learner_tag", "WATCH"),
            "learner_direction": info.get("learner_direction", "neutral"),
            "learner_confidence": info.get("learner_confidence", 0.0),
        }
        for sym, info in insights.items()
    }

    # ── 3. Determine which symbols need current prices ─────────────────── #
    if action_mode == "direct":
        # Need prices for all LONG/STRONG LONG positions (buy + TP/SL) and
        # positions that just had a tag change away from LONG (tag-change sell).
        needs_price_set: set[str] = set()
        for p in snap:
            new_tag = (insights.get(p.symbol, {}).get("learner_tag") or "WATCH").upper()
            old_tag = old_tags.get(p.symbol, "WATCH").upper()
            is_long = new_tag in ("LONG", "STRONG LONG")
            was_long = old_tag in ("LONG", "STRONG LONG")
            if is_long or (was_long and p.shares > 0):
                needs_price_set.add(p.symbol)
        needs_price = list(needs_price_set)
    else:
        # strategy_override: only held long positions in engine-off mode with TP/SL set
        needs_price = [
            p.symbol for p in snap
            if engine_off_mode
            and p.shares > 0
            and not p.strategy_enabled
            and (insights.get(p.symbol, {}).get("learner_tag") or "WATCH").upper() in ("LONG", "STRONG LONG")
            and (long_tp > 0 or long_sl > 0)
        ]

    price_map: dict[str, float] = {}
    if needs_price:
        try:
            from app.services.market_service import get_bulk_quotes
            quotes = await get_bulk_quotes(needs_price)
            price_map = {
                sym: float(q["last_price"])
                for sym, q in quotes.items()
                if q and q.get("last_price")
            }
        except Exception as exc:
            logger.warning("AI tag price fetch failed: %s", exc)

    # ── 4. Apply all changes in a single session ──────────────────────── #
    strategy_changes: list[str] = []
    engine_changes: list[str] = []
    hold_modes: dict[str, bool] = {}

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import SandboxAccount
        from app.models.sandbox import SandboxTrade as _ST
        res = await db.execute(sa_select(SandboxPosition))
        positions: list[SandboxPosition] = res.scalars().all()

        for pos in positions:
            info = insights.get(pos.symbol, {})
            new_tag = (info.get("learner_tag") or "WATCH").upper()
            old_tag = old_tags.get(pos.symbol, "WATCH").upper()
            is_long = new_tag in ("LONG", "STRONG LONG")
            was_long = old_tag in ("LONG", "STRONG LONG")

            # ── Strategy name override ────────────────────────────────────
            # direct mode: only apply for non-LONG tags (LONG positions managed by PM).
            # strategy_override mode: apply for all non-WATCH tags.
            if new_tag != "WATCH" and (action_mode == "strategy_override" or not is_long):
                target = tag_strategies.get(new_tag, "")
                if target and pos.strategy_name != target:
                    old_strat = pos.strategy_name or "none"
                    pos.strategy_name = target
                    if pos.strategy_enabled:
                        strategy_changes.append(f"{pos.symbol}[AI:{new_tag}]: {old_strat}→{target}")

            # ── Direct mode: PM controls LONG/STRONG LONG positions ────────
            if action_mode == "direct":
                if is_long:
                    # Engine always off in direct mode for LONG positions.
                    if pos.strategy_enabled:
                        pos.strategy_enabled = False
                        engine_changes.append(f"{pos.symbol}: engine off (direct, {new_tag})")

                    cp = price_map.get(pos.symbol, 0.0)

                    if pos.shares == 0 and pos.pending_shares == 0:
                        # Buy candidate: check market open and not in final sell window.
                        if cp >= 1.0 and pos.allocated_funds >= cp:
                            from app.services.sandbox_engine import (
                                _regular_session_is_open,
                                _is_in_eod_sell_window,
                            )
                            hold_overnight = bool(_settings.get("hold_positions_overnight", True))
                            eod_mins = int(_settings.get("eod_sell_window_minutes", 30) or 30)
                            if _regular_session_is_open() and (
                                hold_overnight or not _is_in_eod_sell_window(eod_mins)
                            ):
                                qty = math.floor(pos.allocated_funds / cp)
                                if qty > 0:
                                    total = qty * cp
                                    pos.shares = qty
                                    pos.avg_cost = cp
                                    pos.allocated_funds -= total
                                    pos.total_invested = (pos.total_invested or 0.0) + total
                                    pos.pm_managed = True   # PM owns this; skip day-start re-enable
                                    hold_modes[pos.symbol] = True
                                    db.add(_ST(
                                        symbol=pos.symbol,
                                        side="BUY",
                                        quantity=qty,
                                        price=cp,
                                        total=round(total, 4),
                                        strategy_name=pos.strategy_name,
                                        reason=f"ai_direct_buy ({new_tag})",
                                        pnl=None,
                                    ))
                                    engine_changes.append(
                                        f"{pos.symbol}: direct BUY {qty}@${cp:.2f} ({new_tag})"
                                    )
                    elif pos.shares > 0:
                        # Position already held — ensure pm_managed is set (survive restarts).
                        if not pos.pm_managed:
                            pos.pm_managed = True

                        if cp > 0 and pos.avg_cost > 0:
                            # TP/SL check for held position.
                            hit_sl = long_sl > 0 and cp <= pos.avg_cost * (1.0 - long_sl / 100.0)
                            hit_tp = long_tp > 0 and cp >= pos.avg_cost * (1.0 + long_tp / 100.0)
                            if hit_sl or hit_tp:
                                reason = (
                                    f"ai_long_sl ({long_sl:.2f}% @ ${cp:.2f})"
                                    if hit_sl
                                    else f"ai_long_tp ({long_tp:.2f}% @ ${cp:.2f})"
                                )
                                qty = pos.shares
                                total = qty * cp
                                pnl = round((cp - pos.avg_cost) * qty, 4)
                                pos.shares = 0.0
                                pos.allocated_funds += total
                                pos.realized_pnl += pnl
                                pos.avg_cost = 0.0
                                pos.pm_managed = False  # PM releasing control
                                hold_modes[pos.symbol] = False
                                acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
                                acct = acct_res.scalar_one_or_none()
                                if acct:
                                    acct.total_funds += pnl
                                db.add(_ST(
                                    symbol=pos.symbol,
                                    side="SELL",
                                    quantity=qty,
                                    price=cp,
                                    total=round(total, 4),
                                    strategy_name=pos.strategy_name,
                                    reason=reason,
                                    pnl=pnl,
                                ))
                                engine_changes.append(
                                    f"{pos.symbol}: {reason.split('(')[0].strip()} PnL ${pnl:+.2f}"
                                )
                            else:
                                hold_modes[pos.symbol] = True  # still holding

                elif was_long and pos.shares > 0:
                    # Tag changed from LONG/STRONG LONG → other: sell directly.
                    cp = price_map.get(pos.symbol, 0.0)
                    if cp > 0:
                        qty = pos.shares
                        total = qty * cp
                        pnl = round((cp - pos.avg_cost) * qty, 4)
                        pos.shares = 0.0
                        pos.allocated_funds += total
                        pos.realized_pnl += pnl
                        pos.avg_cost = 0.0
                        pos.pm_managed = False  # PM releasing control
                        hold_modes[pos.symbol] = False
                        acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
                        acct = acct_res.scalar_one_or_none()
                        if acct:
                            acct.total_funds += pnl
                        db.add(_ST(
                            symbol=pos.symbol,
                            side="SELL",
                            quantity=qty,
                            price=cp,
                            total=round(total, 4),
                            strategy_name=pos.strategy_name,
                            reason=f"ai_tag_change ({old_tag}→{new_tag})",
                            pnl=pnl,
                        ))
                        engine_changes.append(
                            f"{pos.symbol}: sold on tag change ({old_tag}→{new_tag}) PnL ${pnl:+.2f}"
                        )
                    # Re-enable engine so the new tag's strategy can run.
                    if not pos.strategy_enabled:
                        pos.strategy_enabled = True
                        engine_changes.append(f"{pos.symbol}: engine re-enabled ({new_tag})")

            # ── Strategy override mode: long-hold engine control ───────────
            elif engine_off_mode:
                has_open = pos.shares > 0 or pos.pending_shares > 0

                if is_long and has_open and pos.strategy_enabled:
                    pos.strategy_enabled = False
                    pos.pm_managed = True   # PM holds; skip day-start re-enable
                    hold_modes[pos.symbol] = True
                    engine_changes.append(f"{pos.symbol}: engine off (long hold, {new_tag})")

                elif is_long and pos.shares > 0 and not pos.strategy_enabled:
                    # Ensure pm_managed survives a backend restart.
                    if not pos.pm_managed:
                        pos.pm_managed = True
                    cp = price_map.get(pos.symbol, 0.0)
                    if cp > 0 and pos.avg_cost > 0:
                        hit_sl = long_sl > 0 and cp <= pos.avg_cost * (1.0 - long_sl / 100.0)
                        hit_tp = long_tp > 0 and cp >= pos.avg_cost * (1.0 + long_tp / 100.0)
                        if hit_sl or hit_tp:
                            reason = (
                                f"ai_long_sl ({long_sl:.2f}% @ ${cp:.2f})"
                                if hit_sl
                                else f"ai_long_tp ({long_tp:.2f}% @ ${cp:.2f})"
                            )
                            qty = pos.shares
                            total = qty * cp
                            pnl = round((cp - pos.avg_cost) * qty, 4)
                            pos.shares = 0.0
                            pos.allocated_funds += total
                            pos.realized_pnl += pnl
                            pos.avg_cost = 0.0
                            pos.strategy_enabled = True
                            pos.pm_managed = False  # PM releasing control
                            hold_modes[pos.symbol] = False
                            acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
                            acct = acct_res.scalar_one_or_none()
                            if acct:
                                acct.total_funds += pnl
                            db.add(_ST(
                                symbol=pos.symbol,
                                side="SELL",
                                quantity=qty,
                                price=cp,
                                total=round(total, 4),
                                strategy_name=pos.strategy_name,
                                reason=reason,
                                pnl=pnl,
                            ))
                            engine_changes.append(
                                f"{pos.symbol}: {reason.split('(')[0].strip()} PnL ${pnl:+.2f}"
                            )
                        else:
                            hold_modes[pos.symbol] = True

                elif not is_long and was_long and not pos.strategy_enabled:
                    pos.strategy_enabled = True
                    pos.pm_managed = False  # PM releasing control
                    hold_modes[pos.symbol] = False
                    engine_changes.append(f"{pos.symbol}: engine re-enabled ({old_tag}→{new_tag})")

        if strategy_changes or engine_changes:
            await db.commit()
            if strategy_changes:
                _log_activity(f"AI tag strategy: {', '.join(strategy_changes)}")
            if engine_changes:
                _log_activity(f"AI tag engine: {', '.join(engine_changes)}")

    # Propagate hold_mode flags into the live state so the frontend can display them.
    for sym, info in _state["ai_tags"].items():
        info["hold_mode"] = hold_modes.get(sym, False)


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


def _position_committed_funds(position: SandboxPosition) -> float:
    settled_cost = float(position.shares or 0.0) * float(position.avg_cost or 0.0)
    pending_cost = float(position.pending_shares or 0.0) * float(position.pending_avg_cost or 0.0)
    allocated = float(position.allocated_funds or 0.0)
    return allocated + settled_cost + pending_cost


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
        if cls in {"bearish", "crash"} and idle_cash > min_funds and not has_pending:
            bearish_pos.append((p, idle_cash))
        elif cls in {"bullish", "euphoric"}:
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
                        committed = _position_committed_funds(pos)
                        room = max(0.0, max_cap - committed) if max_cap != float("inf") else deployable
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
                committed = _position_committed_funds(pos)
                room = max(0.0, cap - committed) if cap != float("inf") else total_to_move
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


async def _attempt_ib_profit_take_for_unwatched_owned() -> None:
    """Best-effort IB profit-taking for owned symbols not on sidebar watchlist.

    When PM is enabled in IB mode, place a DAY limit SELL at current market
    for owned long positions that are currently profitable and not watchlisted.
    """
    from app.services.ib_service import ib_service

    if not ib_service.is_connected:
        return

    ib_positions = await ib_service.get_positions()
    owned = [p for p in ib_positions if float(p.get("quantity") or 0.0) > 0]
    if not owned:
        return

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        res = await db.execute(sa_select(SandboxPosition))
        local_positions: list[SandboxPosition] = res.scalars().all()
    watchlist_symbols = {
        p.symbol for p in local_positions if p.symbol and bool(getattr(p, "is_on_watchlist", True))
    }

    open_orders = await ib_service.get_open_orders()
    active_status = {"PendingSubmit", "ApiPending", "PreSubmitted", "Submitted"}
    open_sell_symbols = {
        str(o.get("symbol") or "").upper()
        for o in open_orders
        if str(o.get("side") or "").upper() == "SELL"
        and float(o.get("remaining") or 0.0) > 0
        and str(o.get("status") or "") in active_status
    }

    now = datetime.now(timezone.utc)
    cooldown_s = max(30, int(_settings.get("transfer_interval_s", 300) or 300))

    for row in owned:
        symbol = str(row.get("symbol") or "").upper()
        if not symbol or symbol in watchlist_symbols or symbol in open_sell_symbols:
            continue

        last_try = _ib_profit_take_last_attempt.get(symbol)
        if last_try and (now - last_try).total_seconds() < cooldown_s:
            continue

        qty = float(row.get("quantity") or 0.0)
        avg_cost = float(row.get("avg_cost") or 0.0)
        if qty <= 0 or avg_cost <= 0:
            continue

        quote = await ib_service.get_market_data(symbol)
        market_px = float((quote or {}).get("last") or (quote or {}).get("close") or 0.0)
        if market_px <= avg_cost:
            continue

        result = await ib_service.place_order(
            symbol=symbol,
            side="SELL",
            quantity=qty,
            order_type="LMT",
            limit_price=round(market_px, 2),
        )
        _ib_profit_take_last_attempt[symbol] = now

        if result.get("error"):
            _log_activity(
                f"IB PM profit-take attempt failed for unwatched {symbol}: {result['error']}"
            )
        else:
            _log_activity(
                f"IB PM submitted profit-take SELL for unwatched {symbol} "
                f"x{qty:.4f} @ ${market_px:.2f}"
            )


async def _cancel_bearish_pending_orders() -> None:
    """Cancel unsettled pending BUY orders when any of the following is true:

    1. Sentiment score (symbol or market) is bearish/crash (< -0.2).
    2. Current price has dropped below the pending order's fill price
       (already underwater before the order even settles).
    3. AI learner tag for the symbol is SHORT or STRONG SHORT.
    4. We are in the EOD sell window and overnight holding is disabled.

    Cancelled funds are returned to the position's allocated_funds pool.
    """
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import SandboxTrade as _ST

        res = await db.execute(
            sa_select(SandboxPosition).where(SandboxPosition.pending_shares > 0)
        )
        positions: list[SandboxPosition] = res.scalars().all()
        if not positions:
            return

        from app.services.sandbox_engine import _is_in_eod_sell_window
        hold_overnight = bool(_settings.get("hold_positions_overnight", True))
        eod_mins = int(_settings.get("eod_sell_window_minutes", 30) or 30)
        in_eod_window = not hold_overnight and _is_in_eod_sell_window(eod_mins)

        market_score = float(_compute_market_classification().get("score", 0.0))

        # Fetch current prices for all pending symbols (to check price vs fill price).
        symbols = [p.symbol for p in positions]
        price_map: dict[str, float] = {}
        try:
            from app.services.market_service import get_bulk_quotes
            quotes = await get_bulk_quotes(symbols)
            price_map = {
                sym: float(q["last_price"])
                for sym, q in quotes.items()
                if q and q.get("last_price")
            }
        except Exception as exc:
            logger.warning("PM pending cancel price fetch failed: %s", exc)

        cancelled: list[str] = []
        for pos in positions:
            # ── 1. Sentiment score ────────────────────────────────────────
            sym_info = _state.get("scores", {}).get(pos.symbol, {})
            score = float(sym_info.get("score", market_score)) if sym_info else market_score
            bearish_sentiment = score < -0.2

            # ── 2. Price already below pending fill price (pre-loss) ──────
            cp = price_map.get(pos.symbol, 0.0)
            fill_price = float(pos.pending_avg_cost or 0.0)
            price_dropped = cp > 0 and fill_price > 0 and cp < fill_price

            # ── 3. AI tag is SHORT or STRONG SHORT ────────────────────────
            ai_tag = (
                _state.get("ai_tags", {}).get(pos.symbol, {}).get("learner_tag") or ""
            ).upper()
            ai_short = ai_tag in ("SHORT", "STRONG SHORT")

            if not bearish_sentiment and not price_dropped and not ai_short and not (in_eod_window and not pos.pm_managed):
                continue

            # ── Build cancel reason ───────────────────────────────────────
            reasons: list[str] = []
            if bearish_sentiment:
                reasons.append(f"sentiment {score:+.3f}")
            if price_dropped:
                reasons.append(f"price ${cp:.2f}<fill ${fill_price:.2f}")
            if ai_short:
                reasons.append(f"ai_tag {ai_tag}")
            if in_eod_window and not pos.pm_managed:
                reasons.append("eod_window")
            reason = "pm_cancel: " + ", ".join(reasons)

            returned = float(pos.pending_shares or 0.0) * fill_price
            db.add(_ST(
                symbol=pos.symbol,
                side="CANCEL",
                quantity=pos.pending_shares,
                price=fill_price,
                total=round(returned, 4),
                strategy_name=pos.strategy_name,
                reason=reason,
                pnl=None,
            ))
            pos.allocated_funds += returned
            pos.pending_shares = 0.0
            pos.pending_avg_cost = 0.0
            pos.pending_since = None
            cancelled.append(f"{pos.symbol} ({reason})")

        if cancelled:
            await db.commit()
            _log_activity(
                f"PM cancelled {len(cancelled)} pending order(s): {', '.join(cancelled)}"
            )


async def _reenable_all_engines_for_trading_day_start() -> int:
    """Turn every strategy engine back on at the start of each trading day.

    Positions with ``pm_managed=True`` are skipped — the Portfolio Manager is
    holding those through its own AI-tag logic (direct buy or long-hold mode)
    and will handle the exit itself via TP/SL or tag change.
    """
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select

        res = await db.execute(
            sa_select(SandboxPosition).where(
                SandboxPosition.strategy_name.isnot(None),
                SandboxPosition.strategy_enabled == False,  # noqa: E712
                SandboxPosition.pm_managed == False,        # noqa: E712  # skip PM-held positions
            )
        )
        positions: list[SandboxPosition] = res.scalars().all()
        if not positions:
            return 0

        for pos in positions:
            pos.strategy_enabled = True
            pos.engine_error = None
        await db.commit()
        return len(positions)


# ── main loop ─────────────────────────────────────────────────────────────── #

async def refresh_sentiment_routing() -> None:
    """Refresh sentiment_groups from current position routing data and apply strategies if scores exist."""
    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        res = await db.execute(sa_select(SandboxPosition).where(SandboxPosition.sentiment_mode.isnot(None)))
        positions: list[SandboxPosition] = res.scalars().all()
        market_syms = [p.symbol for p in positions if p.sentiment_mode == "market"]
        symbol_syms = [p.symbol for p in positions if p.sentiment_mode == "symbol"]
        _state["sentiment_groups"] = {"market": market_syms, "symbol": symbol_syms}
    # If scores are already populated, apply strategies immediately so a
    # routing-mode change takes effect without waiting for the next PM tick.
    if _state.get("scores"):
        await _apply_sentiment_strategies()


async def run_portfolio_manager() -> None:
    """Long-running coroutine – start as an asyncio task from app lifespan."""
    _state["running"] = True
    await _load_settings_from_db()
    await refresh_sentiment_routing()
    logger.info("Portfolio Manager task started (enabled=%s).", _settings["enabled"])

    last_transfer = 0.0
    last_score = 0.0

    while True:
        await asyncio.sleep(10)

        if not _settings["enabled"]:
            continue

        from app.services.sandbox_engine import _ET, _market_is_active, _regular_session_is_open
        if not _market_is_active():
            continue

        # Start-of-day reset: when PM is ON, re-enable all symbol engines once
        # per market day so symbols auto-resume after prior EOD shutoff/sell.
        if _regular_session_is_open():
            day_key = datetime.now(tz=_ET).date().isoformat()
            if _state.get("last_engine_reenable_day") != day_key:
                try:
                    reenabled = await _reenable_all_engines_for_trading_day_start()
                    if reenabled > 0:
                        _log_activity(
                            f"Trading-day start: re-enabled {reenabled} engine(s)"
                        )
                except Exception as exc:
                    logger.warning("PM day-start engine re-enable error: %s", exc)
                _state["last_engine_reenable_day"] = day_key

        now = asyncio.get_event_loop().time()

        # Cancel pending orders when sentiment worsens or entering EOD sell window
        try:
            await _cancel_bearish_pending_orders()
        except Exception as exc:
            logger.warning("PM pending cancel check error: %s", exc)

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
                    await _apply_ai_tag_strategies()
            except Exception as exc:
                logger.warning("PM score refresh error: %s", exc)
            last_score = now

        # Transfer on interval
        if now - last_transfer >= _settings["transfer_interval_s"]:
            try:
                await _attempt_ib_profit_take_for_unwatched_owned()
                await _do_transfer()
            except Exception as exc:
                logger.warning("PM transfer error: %s", exc)
                _log_activity(f"Transfer error: {exc}")
            last_transfer = now
