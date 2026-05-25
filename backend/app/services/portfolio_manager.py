"""Portfolio Manager – automatic fund rebalancing between bearish and bullish positions.

The manager wakes up on a configurable interval, classifies each active sandbox
position as *bullish* or *bearish* using low-lag price/volume state (VWAP,
ROC velocity, volume impulse), then moves a configurable percentage of available funds from
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
from sqlalchemy.exc import OperationalError

from app.database import AsyncSessionLocal
from app.models.sandbox import SandboxPosition, SandboxTrade

logger = logging.getLogger(__name__)

_MIN_SENTIMENT_DATA_POINTS = 35
_INTRADAY_1M_TEMPLATE = "template:intraday_1m_regime_template.py"

# ── default 5×5 sentiment matrices ───────────────────────────────────────── #
# These mirror the curated defaults rendered by the PM panel
# (frontend/src/components/sandbox/PortfolioManagerPanel.jsx). Keeping them
# in sync ensures the matrix the user sees in the UI is the matrix actually
# used by the engine, even before the user clicks Save.
_DEFAULT_SENTIMENT_MATRIX_STRATEGIES: dict[str, dict[str, str]] = {
    "crash": {
        "STRONG LONG": _INTRADAY_1M_TEMPLATE,
        "LONG": _INTRADAY_1M_TEMPLATE,
        "NEUTRAL": _INTRADAY_1M_TEMPLATE,
        "SHORT": _INTRADAY_1M_TEMPLATE,
        "STRONG SHORT": _INTRADAY_1M_TEMPLATE,
    },
    "bearish": {
        "STRONG LONG": _INTRADAY_1M_TEMPLATE,
        "LONG": _INTRADAY_1M_TEMPLATE,
        "NEUTRAL": _INTRADAY_1M_TEMPLATE,
        "SHORT": _INTRADAY_1M_TEMPLATE,
        "STRONG SHORT": _INTRADAY_1M_TEMPLATE,
    },
    "neutral": {
        "STRONG LONG": _INTRADAY_1M_TEMPLATE,
        "LONG": _INTRADAY_1M_TEMPLATE,
        "NEUTRAL": _INTRADAY_1M_TEMPLATE,
        "SHORT": _INTRADAY_1M_TEMPLATE,
        "STRONG SHORT": _INTRADAY_1M_TEMPLATE,
    },
    "bullish": {
        "STRONG LONG": _INTRADAY_1M_TEMPLATE,
        "LONG": _INTRADAY_1M_TEMPLATE,
        "NEUTRAL": _INTRADAY_1M_TEMPLATE,
        "SHORT": _INTRADAY_1M_TEMPLATE,
        "STRONG SHORT": _INTRADAY_1M_TEMPLATE,
    },
    "euphoric": {
        "STRONG LONG": _INTRADAY_1M_TEMPLATE,
        "LONG": _INTRADAY_1M_TEMPLATE,
        "NEUTRAL": _INTRADAY_1M_TEMPLATE,
        "SHORT": _INTRADAY_1M_TEMPLATE,
        "STRONG SHORT": _INTRADAY_1M_TEMPLATE,
    },
}

_DEFAULT_SENTIMENT_MATRIX_ACTIONS: dict[str, dict[str, str]] = {
    "crash":    {"STRONG LONG": "trade",    "LONG": "trade", "NEUTRAL": "trade",    "SHORT": "engine_off", "STRONG SHORT": "engine_off"},
    "bearish":  {"STRONG LONG": "no_trade", "LONG": "no_trade", "NEUTRAL": "no_trade", "SHORT": "engine_off", "STRONG SHORT": "engine_off"},
    "neutral":  {"STRONG LONG": "trade",    "LONG": "trade", "NEUTRAL": "trade",    "SHORT": "trade",      "STRONG SHORT": "trade"},
    "bullish":  {"STRONG LONG": "hold",     "LONG": "trade", "NEUTRAL": "trade",    "SHORT": "trade",      "STRONG SHORT": "force_sell"},
    "euphoric": {"STRONG LONG": "hold",     "LONG": "hold",  "NEUTRAL": "trade",    "SHORT": "trade",      "STRONG SHORT": "force_sell"},
}


def _clone_matrix(m: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    return {row: dict(cols) for row, cols in m.items()}


def _merge_matrix_with_defaults(
    raw: Any, defaults: dict[str, dict[str, str]]
) -> dict[str, dict[str, str]]:
    """Return a complete 5×5 matrix by overlaying ``raw`` on top of ``defaults``.

    Empty / missing cells fall back to the curated default so the engine
    always has a value to act on (matches frontend behavior).
    """
    merged = _clone_matrix(defaults)
    if isinstance(raw, str) and raw.strip():
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    if isinstance(raw, dict):
        for row, cols in raw.items():
            if not isinstance(cols, dict):
                continue
            target = merged.setdefault(row, {})
            for col, val in cols.items():
                if isinstance(val, str) and val.strip():
                    target[col] = val
    return merged


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
        "crash": _INTRADAY_1M_TEMPLATE,
        "bearish": _INTRADAY_1M_TEMPLATE,
        "neutral": _INTRADAY_1M_TEMPLATE,
        "bullish": _INTRADAY_1M_TEMPLATE,
        "euphoric": _INTRADAY_1M_TEMPLATE,
    },
    "symbol_sentiment_strategies": {
        "crash": _INTRADAY_1M_TEMPLATE,
        "bearish": _INTRADAY_1M_TEMPLATE,
        "neutral": _INTRADAY_1M_TEMPLATE,
        "bullish": _INTRADAY_1M_TEMPLATE,
        "euphoric": _INTRADAY_1M_TEMPLATE,
    },
    "sentiment_strategy_enabled": True,   # auto-change strategy based on sentiment
    "default_strategy_name": _INTRADAY_1M_TEMPLATE,
    "ai_tag_strategy_enabled": False,      # auto-change strategy based on AI learner tag
    "ai_sentiment_change_enabled": True,   # master switch for AI sentiment-driven strategy/trade changes
    "ai_tag_strategies": {
        "STRONG LONG": _INTRADAY_1M_TEMPLATE,
        "LONG": _INTRADAY_1M_TEMPLATE,
        "NEUTRAL": "",           # empty = keep current strategy (no override)
        "SHORT": _INTRADAY_1M_TEMPLATE,
        "STRONG SHORT": _INTRADAY_1M_TEMPLATE,
    },
    "ai_tag_allow_overnight": True,        # LONG/STRONG LONG positions skip EOD liquidation
    "ai_tag_action_mode": "strategy_override",  # strategy_override | direct
    "ai_external_sentiment_weight": 0.35,  # 0..1 weight blending external news/social sentiment into AI learner score
    "ai_tag_long_engine_off": True,        # disable engine after buy for LONG/STRONG LONG (hold mode)
    "ai_tag_long_tp_pct": 0.0,            # take profit % for long-hold positions (0 = disabled)
    "ai_tag_long_sl_pct": 0.0,            # stop loss  % for long-hold positions (0 = disabled)
    "ai_tag_long_tp_value": 0.0,          # take profit $ for long-hold positions (0 = disabled)
    "ai_tag_long_sl_value": 0.0,          # stop loss  $ for long-hold positions (0 = disabled)
    "ai_tag_no_loss_sell": True,          # block AI-driven sells that would realize a loss
    "pending_price_drift_cancel_pct": 0.25,  # cancel pending BUY when market drifts >= this % from pending fill/limit
    "pending_cancel_after_bars": 3,       # cancel pending orders after N sentiment bars even without price drift
    "sim_buy_fill_rate_pct": 100.0,       # simulated BUY pending-fill probability (%), evaluated each bar when in price range
    "sim_sell_fill_rate_pct": 100.0,      # simulated SELL pending-fill probability (%), evaluated each bar when in price range
    "auto_trade_buy_price_offset_pct": 0.01,    # BUY price = prev OHLC midpoint + this % (IB automated orders)
    "auto_trade_sell_price_offset_pct": 0.01,   # SELL price = prev OHLC midpoint - this % (IB automated orders)
    "intraday_1m_template_params": {},
    "position_overrides": {},
    # 5×5 matrix: keys are PM sentiment bucket → AI tag → strategy name
    "sentiment_matrix_strategies": _clone_matrix(_DEFAULT_SENTIMENT_MATRIX_STRATEGIES),
    # 5×5 matrix: keys are PM sentiment bucket → AI tag → action
    # actions: trade | hold | engine_off | force_sell | no_trade
    "sentiment_matrix_actions": _clone_matrix(_DEFAULT_SENTIMENT_MATRIX_ACTIONS),
    # Max number of days a PM buy-and-hold position can be held before auto-release (0 = no limit).
    # Default 1 day suits day-trading workflows; sentiment-driven exits also trigger inside this window.
    "pm_hold_duration_days": 1,
    # Buy & Hold cap in bars (0 = no time cap). This is preferred over day-based duration.
    "pm_hold_duration_bars": 20,
    # Advanced Hold tuning
    "pm_hold_extended_multiplier": 2.0,  # used by `advanced_hold:extended` cells (typically STRONG LONG)
    "pm_hold_trailing_pct": 3.0,         # trailing stop % for `advanced_hold:trailing` cells
    "stop_loss_pct": 0.5,
    "take_profit_pct": 1.25,
    "stop_loss_value": 0.0,
    "take_profit_value": 0.0,
    "hold_positions_overnight": False,    # strict day-trade default: flatten before close
    "eod_engine_shutoff_minutes_before_sell": 120,  # minutes before sell window to block new buys
    "eod_sell_window_minutes": 5,         # minutes before market close to start sell-only mode
    "sentiment_lookback_days": 5,         # days of historical data for sentiment calc
    "sentiment_data_points": _MIN_SENTIMENT_DATA_POINTS,  # number of recent bars used for sentiment calc
    "sentiment_interval": "1m",           # interval: 1m, 5m, 15m, 1h, daily, etc.
    "sentiment_bucket_persistence": 3,     # bars required before bucket flip is applied
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
    # Per-key hysteresis state to avoid one-bar sentiment flapping.
    "bucket_debounce": {},  # { key: {active, candidate, count} }
}


def _interval_to_minutes(interval: str) -> float:
    """Map PM sentiment interval strings to approximate bar duration in minutes."""
    value = (interval or "1m").strip().lower()
    mapping: dict[str, float] = {
        "5s": 5.0 / 60.0,
        "1m": 1.0,
        "5m": 5.0,
        "15m": 15.0,
        "30m": 30.0,
        "1h": 60.0,
        "daily": 390.0,
    }
    return float(mapping.get(value, 1.0))

# Prevent repeated IB profit-take submissions every PM loop tick.
_ib_profit_take_last_attempt: dict[str, datetime] = {}
_ib_eod_liq_last_attempt: dict[str, datetime] = {}
_ib_signal_last_processed_at: dict[str, str] = {}


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
_LEGACY_STRATEGY_NAMES: dict[str, str] = {
    "bollinger": "bollinger_bands",
    "intraday_1m": _INTRADAY_1M_TEMPLATE,
}


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


def _load_json_dict(raw_value: Any, fallback: dict) -> dict:
    """Safely decode a JSON blob from DB into a plain dict, falling back on error."""
    if isinstance(raw_value, dict):
        return raw_value
    if isinstance(raw_value, str) and raw_value.strip():
        try:
            parsed = json.loads(raw_value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return dict(fallback)


def _is_dynamic_strategy_name(value: str) -> bool:
    raw = (value or "").strip().lower()
    return raw.startswith("template:") or raw.startswith("custom:")


def _auto_upgrade_intraday_strategy_defaults() -> bool:
    """Upgrade legacy built-in PM strategy maps to intraday 1m defaults.

    This runs on startup after DB settings are loaded so older persisted maps
    (e.g. macd/williams_r mixes) don't silently override the current intraday
    template-first product defaults.
    """
    strategy_values: list[str] = []

    for key in ("market_sentiment_strategies", "symbol_sentiment_strategies", "ai_tag_strategies"):
        d = _settings.get(key)
        if isinstance(d, dict):
            strategy_values.extend(str(v) for v in d.values() if isinstance(v, str) and v.strip())

    matrix = _settings.get("sentiment_matrix_strategies")
    if isinstance(matrix, dict):
        for row in matrix.values():
            if isinstance(row, dict):
                strategy_values.extend(str(v) for v in row.values() if isinstance(v, str) and v.strip())

    if not strategy_values:
        return False

    has_intraday = any((v or "").strip() == _INTRADAY_1M_TEMPLATE for v in strategy_values)
    has_dynamic = any(_is_dynamic_strategy_name(v) for v in strategy_values)
    if has_intraday or has_dynamic:
        return False

    # Legacy-only config detected -> upgrade to current intraday defaults.
    intraday_bucket_map = {
        "crash": _INTRADAY_1M_TEMPLATE,
        "bearish": _INTRADAY_1M_TEMPLATE,
        "neutral": _INTRADAY_1M_TEMPLATE,
        "bullish": _INTRADAY_1M_TEMPLATE,
        "euphoric": _INTRADAY_1M_TEMPLATE,
    }
    _settings["market_sentiment_strategies"] = dict(intraday_bucket_map)
    _settings["symbol_sentiment_strategies"] = dict(intraday_bucket_map)
    _settings["sentiment_matrix_strategies"] = _clone_matrix(_DEFAULT_SENTIMENT_MATRIX_STRATEGIES)

    ai_map = dict(_settings.get("ai_tag_strategies") or {})
    for tag in ("STRONG LONG", "LONG", "SHORT", "STRONG SHORT"):
        ai_map[tag] = _INTRADAY_1M_TEMPLATE
    if "NEUTRAL" not in ai_map:
        ai_map["NEUTRAL"] = ""
    _settings["ai_tag_strategies"] = ai_map

    logger.info("PM settings auto-upgraded to intraday 1m strategy defaults from legacy built-in maps")
    return True


async def _load_settings_from_db() -> None:
    """Overwrite in-memory _settings from the DB row on startup."""
    upgraded_legacy_maps = False
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
            _row_stop_loss_pct = getattr(row, "stop_loss_pct", None)
            _row_take_profit_pct = getattr(row, "take_profit_pct", None)
            _settings["stop_loss_pct"] = 0.5 if _row_stop_loss_pct is None else float(_row_stop_loss_pct)
            _settings["take_profit_pct"] = 1.25 if _row_take_profit_pct is None else float(_row_take_profit_pct)
            _settings["stop_loss_value"] = float(getattr(row, "stop_loss_value", 0.0) or 0.0)
            _settings["take_profit_value"] = float(getattr(row, "take_profit_value", 0.0) or 0.0)
            _settings["hold_positions_overnight"] = bool(getattr(row, "hold_positions_overnight", False))
            _settings["eod_engine_shutoff_minutes_before_sell"] = int(getattr(row, "eod_engine_shutoff_minutes_before_sell", 120) or 120)
            _settings["eod_sell_window_minutes"] = int(getattr(row, "eod_sell_window_minutes", 5) or 5)
            _settings["sentiment_lookback_days"] = int(getattr(row, "sentiment_lookback_days", 5) or 5)
            _settings["sentiment_data_points"] = max(
                _MIN_SENTIMENT_DATA_POINTS,
                int(getattr(row, "sentiment_data_points", _MIN_SENTIMENT_DATA_POINTS) or _MIN_SENTIMENT_DATA_POINTS),
            )
            _settings["sentiment_interval"] = getattr(row, "sentiment_interval", "1m") or "1m"
            _settings["sentiment_bucket_persistence"] = max(
                1,
                min(20, int(getattr(row, "sentiment_bucket_persistence", 3) or 3)),
            )
            _settings["ai_tag_strategy_enabled"] = bool(getattr(row, "ai_tag_strategy_enabled", False))
            _settings["ai_sentiment_change_enabled"] = bool(getattr(row, "ai_sentiment_change_enabled", True))
            _settings["ai_tag_strategies"] = _load_strategy_map(
                getattr(row, "ai_tag_strategies", None),
                _settings["ai_tag_strategies"],
            )
            _settings["ai_tag_allow_overnight"] = bool(getattr(row, "ai_tag_allow_overnight", True))
            _settings["ai_tag_action_mode"] = getattr(row, "ai_tag_action_mode", "strategy_override") or "strategy_override"
            _ext_w = getattr(row, "ai_external_sentiment_weight", 0.0)
            _settings["ai_external_sentiment_weight"] = max(0.0, min(1.0, float(_ext_w or 0.0)))
            _settings["ai_tag_long_engine_off"] = bool(getattr(row, "ai_tag_long_engine_off", True))
            _settings["ai_tag_long_tp_pct"] = float(getattr(row, "ai_tag_long_tp_pct", 0.0) or 0.0)
            _settings["ai_tag_long_sl_pct"] = float(getattr(row, "ai_tag_long_sl_pct", 0.0) or 0.0)
            _settings["ai_tag_long_tp_value"] = float(getattr(row, "ai_tag_long_tp_value", 0.0) or 0.0)
            _settings["ai_tag_long_sl_value"] = float(getattr(row, "ai_tag_long_sl_value", 0.0) or 0.0)
            _settings["ai_tag_no_loss_sell"] = bool(getattr(row, "ai_tag_no_loss_sell", True))
            _settings["pending_price_drift_cancel_pct"] = float(getattr(row, "pending_price_drift_cancel_pct", 0.25) or 0.25)
            _settings["pending_cancel_after_bars"] = int(max(0, getattr(row, "pending_cancel_after_bars", 3) or 3))
            _settings["sim_buy_fill_rate_pct"] = max(0.0, min(100.0, float(getattr(row, "sim_buy_fill_rate_pct", 100.0) or 0.0)))
            _settings["sim_sell_fill_rate_pct"] = max(0.0, min(100.0, float(getattr(row, "sim_sell_fill_rate_pct", 100.0) or 0.0)))
            _buy_offset = getattr(row, "auto_trade_buy_price_offset_pct", None)
            _sell_offset = getattr(row, "auto_trade_sell_price_offset_pct", None)
            _settings["auto_trade_buy_price_offset_pct"] = 0.145 if _buy_offset is None else float(_buy_offset)
            _settings["auto_trade_sell_price_offset_pct"] = 0.185 if _sell_offset is None else float(_sell_offset)
            _settings["default_strategy_name"] = str(getattr(row, "default_strategy_name", _INTRADAY_1M_TEMPLATE) or _INTRADAY_1M_TEMPLATE)
            _settings["intraday_1m_template_params"] = _load_json_dict(
                getattr(row, "intraday_1m_template_params", None),
                {},
            )
            _settings["position_overrides"] = _load_json_dict(
                getattr(row, "position_overrides", None),
                {},
            )
            # 5×5 matrices – overlay any stored cells on top of the curated
            # defaults so an empty DB row still produces the same matrix the
            # PM UI displays out-of-the-box.
            _settings["sentiment_matrix_strategies"] = _merge_matrix_with_defaults(
                getattr(row, "sentiment_matrix_strategies", None),
                _DEFAULT_SENTIMENT_MATRIX_STRATEGIES,
            )
            _settings["sentiment_matrix_actions"] = _merge_matrix_with_defaults(
                getattr(row, "sentiment_matrix_actions", None),
                _DEFAULT_SENTIMENT_MATRIX_ACTIONS,
            )
            _settings["pm_hold_duration_days"] = int(getattr(row, "pm_hold_duration_days", 1) or 0)
            bars_loaded = int(getattr(row, "pm_hold_duration_bars", 0) or 0)
            if bars_loaded > 0:
                _settings["pm_hold_duration_bars"] = bars_loaded
            else:
                # Backward compatibility with day-based cap.
                bar_minutes = max(1e-9, _interval_to_minutes(_settings.get("sentiment_interval", "1m")))
                bars_per_day = max(1, int(round(390.0 / bar_minutes)))
                _settings["pm_hold_duration_bars"] = max(0, int(_settings["pm_hold_duration_days"]) * bars_per_day)
            _settings["pm_hold_extended_multiplier"] = float(getattr(row, "pm_hold_extended_multiplier", 2.0) or 0.0)
            _settings["pm_hold_trailing_pct"] = float(getattr(row, "pm_hold_trailing_pct", 3.0) or 0.0)
            # Restore cached scores so the UI shows previous values immediately.
            try:
                raw = getattr(row, "cached_scores", None)
                if raw:
                    loaded = json.loads(raw)
                    if isinstance(loaded, dict) and loaded:
                        _state["scores"] = loaded
            except Exception:
                pass

            upgraded_legacy_maps = _auto_upgrade_intraday_strategy_defaults()

    if upgraded_legacy_maps:
        await _save_settings_to_db()


async def _save_scores_to_db() -> None:
    """Persist current in-memory scores to the DB cache column."""
    try:
        async with AsyncSessionLocal() as db:
            from sqlalchemy import select as sa_select
            from app.models.sandbox import PortfolioManagerSettings
            res = await db.execute(sa_select(PortfolioManagerSettings).where(PortfolioManagerSettings.id == 1))
            row = res.scalar_one_or_none()
            if row:
                row.cached_scores = json.dumps(_state["scores"])
                await db.commit()
    except Exception as exc:
        logger.debug("PM score cache write error: %s", exc)


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
        _stop_loss_pct = _settings.get("stop_loss_pct", 0.5)
        _take_profit_pct = _settings.get("take_profit_pct", 1.25)
        row.stop_loss_pct = float(0.5 if _stop_loss_pct is None else _stop_loss_pct)
        row.take_profit_pct = float(1.25 if _take_profit_pct is None else _take_profit_pct)
        row.stop_loss_value = float(_settings.get("stop_loss_value", 0.0) or 0.0)
        row.take_profit_value = float(_settings.get("take_profit_value", 0.0) or 0.0)
        row.hold_positions_overnight = _settings.get("hold_positions_overnight", False)
        row.eod_engine_shutoff_minutes_before_sell = int(_settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120)
        row.eod_sell_window_minutes = int(_settings.get("eod_sell_window_minutes", 5) or 5)
        row.sentiment_lookback_days = int(_settings.get("sentiment_lookback_days", 5) or 5)
        row.sentiment_data_points = int(
            max(
                _MIN_SENTIMENT_DATA_POINTS,
                int(_settings.get("sentiment_data_points", _MIN_SENTIMENT_DATA_POINTS) or _MIN_SENTIMENT_DATA_POINTS),
            )
        )
        row.sentiment_interval = _settings.get("sentiment_interval", "1m") or "1m"
        row.sentiment_bucket_persistence = max(
            1,
            min(20, int(_settings.get("sentiment_bucket_persistence", 3) or 3)),
        )
        row.ai_tag_strategy_enabled = bool(_settings.get("ai_tag_strategy_enabled", False))
        row.ai_sentiment_change_enabled = bool(_settings.get("ai_sentiment_change_enabled", True))
        row.ai_tag_strategies = json.dumps(_settings.get("ai_tag_strategies", {}), sort_keys=True)
        row.ai_tag_allow_overnight = bool(_settings.get("ai_tag_allow_overnight", True))
        row.ai_tag_action_mode = _settings.get("ai_tag_action_mode", "strategy_override") or "strategy_override"
        row.ai_external_sentiment_weight = max(0.0, min(1.0, float(_settings.get("ai_external_sentiment_weight", 0.0) or 0.0)))
        row.ai_tag_long_engine_off = bool(_settings.get("ai_tag_long_engine_off", True))
        row.ai_tag_long_tp_pct = float(_settings.get("ai_tag_long_tp_pct", 0.0) or 0.0)
        row.ai_tag_long_sl_pct = float(_settings.get("ai_tag_long_sl_pct", 0.0) or 0.0)
        row.ai_tag_long_tp_value = float(_settings.get("ai_tag_long_tp_value", 0.0) or 0.0)
        row.ai_tag_long_sl_value = float(_settings.get("ai_tag_long_sl_value", 0.0) or 0.0)
        row.ai_tag_no_loss_sell = bool(_settings.get("ai_tag_no_loss_sell", True))
        row.pending_price_drift_cancel_pct = float(_settings.get("pending_price_drift_cancel_pct", 0.25) or 0.25)
        row.pending_cancel_after_bars = int(max(0, _settings.get("pending_cancel_after_bars", 3) or 3))
        row.sim_buy_fill_rate_pct = max(0.0, min(100.0, float(_settings.get("sim_buy_fill_rate_pct", 60.0) or 0.0)))
        row.sim_sell_fill_rate_pct = max(0.0, min(100.0, float(_settings.get("sim_sell_fill_rate_pct", 70.0) or 0.0)))
        row.auto_trade_buy_price_offset_pct = float(_settings.get("auto_trade_buy_price_offset_pct", 0.01))
        row.auto_trade_sell_price_offset_pct = float(_settings.get("auto_trade_sell_price_offset_pct", 0.01))
        row.default_strategy_name = str(_settings.get("default_strategy_name", _INTRADAY_1M_TEMPLATE) or _INTRADAY_1M_TEMPLATE)
        row.intraday_1m_template_params = json.dumps(_settings.get("intraday_1m_template_params", {}), sort_keys=True)
        row.position_overrides = json.dumps(_settings.get("position_overrides", {}), sort_keys=True)
        row.sentiment_matrix_strategies = json.dumps(_settings.get("sentiment_matrix_strategies", {}), sort_keys=True)
        row.sentiment_matrix_actions = json.dumps(_settings.get("sentiment_matrix_actions", {}), sort_keys=True)
        row.pm_hold_duration_days = max(0, int(_settings.get("pm_hold_duration_days", 1) or 0))
        row.pm_hold_duration_bars = max(0, int(_settings.get("pm_hold_duration_bars", 20) or 0))
        row.pm_hold_extended_multiplier = max(0.0, float(_settings.get("pm_hold_extended_multiplier", 2.0) or 0.0))
        row.pm_hold_trailing_pct = max(0.0, float(_settings.get("pm_hold_trailing_pct", 3.0) or 0.0))
        await db.commit()


def update_manager_settings(new: dict) -> dict:
    allowed = {"transfer_pct", "transfer_interval_s", "indicator_interval_s", "min_position_funds",
               "min_position_funds_mode", "min_position_funds_pct",
               "enabled", "deploy_available_funds", "deploy_target", "deploy_target_symbol",
               "reallocation_enabled", "reallocation_mode", "allow_buy_outside_allocation",
               "market_sentiment_strategies", "symbol_sentiment_strategies",
              "default_strategy_name", "intraday_1m_template_params", "position_overrides",
              "sentiment_strategy_enabled", "sentiment_lookback_days", "sentiment_data_points", "sentiment_interval", "sentiment_bucket_persistence",
              "stop_loss_pct", "take_profit_pct",
              "stop_loss_value", "take_profit_value",
              "hold_positions_overnight", "eod_engine_shutoff_minutes_before_sell", "eod_sell_window_minutes",
              "ai_tag_strategy_enabled", "ai_sentiment_change_enabled", "ai_tag_strategies", "ai_tag_allow_overnight",
              "ai_tag_action_mode", "ai_external_sentiment_weight",
              "ai_tag_long_engine_off", "ai_tag_long_tp_pct", "ai_tag_long_sl_pct",
              "ai_tag_long_tp_value", "ai_tag_long_sl_value",
              "ai_tag_no_loss_sell", "pending_price_drift_cancel_pct",
              "pending_cancel_after_bars",
              "sim_buy_fill_rate_pct", "sim_sell_fill_rate_pct",
              "auto_trade_buy_price_offset_pct", "auto_trade_sell_price_offset_pct",
              "sentiment_matrix_strategies", "sentiment_matrix_actions",
              "pm_hold_duration_days", "pm_hold_duration_bars", "pm_hold_extended_multiplier", "pm_hold_trailing_pct"}
    for k, v in new.items():
        if k in allowed:
            _settings[k] = v

    # Keep enough bars so VWAP/ROC/volume sub-signals are stable.
    if "sentiment_data_points" in new:
        _settings["sentiment_data_points"] = max(
            _MIN_SENTIMENT_DATA_POINTS,
            int(_settings.get("sentiment_data_points", _MIN_SENTIMENT_DATA_POINTS) or _MIN_SENTIMENT_DATA_POINTS),
        )
    if "sentiment_bucket_persistence" in new:
        _settings["sentiment_bucket_persistence"] = max(
            1,
            min(20, int(_settings.get("sentiment_bucket_persistence", 3) or 3)),
        )
    if "default_strategy_name" in new:
        _settings["default_strategy_name"] = str(_settings.get("default_strategy_name") or _INTRADAY_1M_TEMPLATE)
    if "intraday_1m_template_params" in new and not isinstance(_settings.get("intraday_1m_template_params"), dict):
        _settings["intraday_1m_template_params"] = {}
    if "position_overrides" in new:
        raw = _settings.get("position_overrides")
        if isinstance(raw, dict):
            norm: dict[str, dict[str, Any]] = {}
            for sym, ov in raw.items():
                if not isinstance(ov, dict):
                    continue
                key = str(sym or "").strip().upper()
                if not key:
                    continue
                norm[key] = dict(ov)
            _settings["position_overrides"] = norm
        else:
            _settings["position_overrides"] = {}
    if "pm_hold_duration_bars" in new:
        _settings["pm_hold_duration_bars"] = max(0, int(_settings.get("pm_hold_duration_bars", 20) or 0))

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        loop.create_task(_save_settings_to_db())
        if any(key in new for key in ("market_sentiment_strategies", "symbol_sentiment_strategies", "sentiment_strategy_enabled", "sentiment_lookback_days", "sentiment_data_points", "sentiment_interval", "sentiment_bucket_persistence")):
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
                if _settings.get("ai_tag_strategy_enabled", False) and _settings.get("ai_sentiment_change_enabled", True):
                    await _apply_ai_tag_strategies()
            loop.create_task(_refresh_and_apply())
        if any(key in new for key in ("ai_tag_strategy_enabled", "ai_sentiment_change_enabled", "ai_tag_strategies")):
            loop.create_task(_apply_ai_tag_strategies())
    return get_manager_settings()


# ── scoring ───────────────────────────────────────────────────────────────── #

# Scoring can tolerate bars up to this many seconds old – avoids hammering YF
# every 2-minute PM tick and reuses whatever the trading engine already cached.
_PM_SCORE_CACHE_TTL = 600.0  # 10 minutes


async def _fetch_bars(symbol: str) -> pd.DataFrame:
    """Fetch recent intraday bars for scoring (re-uses the shared market_service helper)."""
    from app.services.market_service import get_intraday_df
    lookback_days = _settings.get("sentiment_lookback_days", 5)
    data_points = max(
        _MIN_SENTIMENT_DATA_POINTS,
        int(_settings.get("sentiment_data_points", _MIN_SENTIMENT_DATA_POINTS) or _MIN_SENTIMENT_DATA_POINTS),
    )
    interval = _settings.get("sentiment_interval", "1m")
    range_str = f"{lookback_days}d"
    # Force YF for sentiment scoring – IB pacing is preserved for trading
    # signals and scoring doesn't need tick-level data accuracy.
    # Use a long cache TTL so PM scoring reuses data already fetched by the
    # trading engine / chart requests instead of triggering a fresh YF download.
    df = await get_intraday_df(symbol, range_=range_str, interval=interval,
                               include_pre_post=False, force_yf=True,
                               cache_ttl_override=_PM_SCORE_CACHE_TTL)
    bars = df[["Open", "High", "Low", "Close", "Volume"]]
    return bars.tail(data_points)


def _score_symbol(df: pd.DataFrame) -> tuple[float, str]:
    """
    Return (score, classification) where score is −1..+1 and classification
    is one of 'crash', 'bearish', 'neutral', 'bullish', 'euphoric'.

        Composite of low-lag intraday sub-signals with explicit volume confirmation:
            1. Close vs VWAP baseline (trend location)
            2. 5-bar ROC (velocity)
            3. 1-bar impulse with volume-ratio confirmation
            4. Extreme deviation (euphoric/crash) via VWAP z-score + volume spike
    """
    closes = df["Close"].astype(float)
    volumes = df["Volume"].astype(float)
    if closes.empty or volumes.empty:
        return 0.0, "neutral"

    score_series = pd.Series(0.0, index=closes.index, dtype=float)

    # Session-style cumulative VWAP baseline.
    vwap = (closes * volumes).cumsum() / volumes.cumsum().replace(0.0, pd.NA)

    roc5 = closes.pct_change(5).fillna(0.0)
    roc1 = closes.pct_change(1).fillna(0.0)
    vol_ma10 = volumes.rolling(10).mean().replace(0.0, pd.NA)
    vol_ratio = (volumes / vol_ma10).fillna(1.0)

    dev = closes - vwap
    dev_std = dev.rolling(20).std().replace(0.0, pd.NA)
    vwap_z = (dev / dev_std).fillna(0.0)

    # 1) Structural trend location: price relative to VWAP.
    score_series += (closes > vwap).astype(float) * 0.25
    score_series += (closes < vwap).astype(float) * -0.25

    # 2) Velocity (5-bar ROC) for low-lag directional state.
    score_series += (roc5 >= 0.003).astype(float) * 0.25
    score_series += (roc5 <= -0.003).astype(float) * -0.25

    # 3) Immediate impulse only when confirmed by elevated volume.
    score_series += ((roc1 > 0.0) & (vol_ratio >= 1.5)).astype(float) * 0.20
    score_series += ((roc1 < 0.0) & (vol_ratio >= 1.5)).astype(float) * -0.20

    # 4) Panic/euphoria extremes (large VWAP deviation + volume spike).
    score_series += ((vwap_z >= 3.0) & (vol_ratio >= 1.8)).astype(float) * 0.30
    score_series += ((vwap_z <= -3.0) & (vol_ratio >= 1.8)).astype(float) * -0.30

    score_series = score_series.clip(-1.0, 1.0)
    score_series = score_series.ewm(span=3, adjust=False).mean()
    score = float(score_series.iloc[-1]) if len(score_series) else 0.0
    classification = _score_to_bucket(score)

    return round(score, 3), classification


async def _refresh_scores(symbols: list[str]) -> None:
    """Fetch bars and score all symbols concurrently."""
    persistence = max(1, min(20, int(_settings.get("sentiment_bucket_persistence", 3) or 3)))

    async def _score_one(sym: str):
        try:
            df = await _fetch_bars(sym)
            score, raw_cls = _score_symbol(df)
            bucket_key = f"symbol:{sym.upper()}"
            cls = _debounce_bucket(bucket_key, raw_cls, min_persistence=persistence)
            slot = (_state.get("bucket_debounce") or {}).get(bucket_key, {})
            candidate = slot.get("candidate")
            countdown = max(0, persistence - int(slot.get("count") or 0)) if candidate else 0
            _state["scores"][sym] = {
                "score": score,
                "classification": cls,
                "raw_classification": raw_cls,
                "debounced_classification": cls,
                "debounce_candidate": candidate,
                "debounce_countdown": countdown,
                "debounce_persistence": persistence,
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
    try:
        asyncio.get_running_loop().create_task(_save_scores_to_db())
    except RuntimeError:
        pass


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


def _debounce_bucket(bucket_key: str, proposed_bucket: str, min_persistence: int = 5) -> str:
    """Return a debounced bucket for the given key.

    A new proposed bucket must persist for ``min_persistence`` consecutive
    evaluations before it becomes active.
    """
    if min_persistence <= 1:
        return proposed_bucket

    state = _state.setdefault("bucket_debounce", {})
    slot = state.get(bucket_key)
    if slot is None:
        state[bucket_key] = {
            "active": proposed_bucket,
            "candidate": None,
            "count": 0,
        }
        return proposed_bucket

    active = str(slot.get("active") or proposed_bucket)
    candidate = slot.get("candidate")
    count = int(slot.get("count") or 0)

    if proposed_bucket == active:
        slot["candidate"] = None
        slot["count"] = 0
        return active

    if candidate == proposed_bucket:
        count += 1
    else:
        candidate = proposed_bucket
        count = 1

    if count >= min_persistence:
        slot["active"] = proposed_bucket
        slot["candidate"] = None
        slot["count"] = 0
        return proposed_bucket

    slot["candidate"] = candidate
    slot["count"] = count
    return active


def _compute_market_classification() -> dict:
    """Derive overall market sentiment by averaging all tracked symbol scores."""
    scores = _state.get("scores", {})
    if not scores:
        return {"score": 0.0, "classification": "neutral", "bucket": "neutral"}
    avg_score = sum(v["score"] for v in scores.values()) / len(scores)
    persistence = max(1, min(20, int(_settings.get("sentiment_bucket_persistence", 3) or 3)))
    raw_bucket = _score_to_bucket(avg_score)
    bucket = _debounce_bucket("market", raw_bucket, min_persistence=persistence)
    slot = (_state.get("bucket_debounce") or {}).get("market", {})
    candidate = slot.get("candidate")
    countdown = max(0, persistence - int(slot.get("count") or 0)) if candidate else 0
    classification = bucket
    return {
        "score": round(avg_score, 3),
        "classification": classification,
        "bucket": bucket,
        "raw_bucket": raw_bucket,
        "debounce_candidate": candidate,
        "debounce_countdown": countdown,
        "debounce_persistence": persistence,
    }


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
                sym_bucket = str(sym_score.get("classification") or _score_to_bucket(float(sym_score.get("score", 0.0))))
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
    """Apply strategy and engine changes driven by the 5×5 sentiment matrix.

    For each symbol the current PM market bucket × AI learner tag determines:
      - cell_strategy : strategy name to apply (from sentiment_matrix_strategies)
      - cell_action   : one of trade | hold | engine_off | force_sell | no_trade
                        (from sentiment_matrix_actions)

    Actions
    -------
    trade        – Set strategy; engine runs normally (re-enables engine if off).
    hold         – Buy & Hold: engine off; direct BUY if no open position; hold
                   with TP/SL once in. Auto-released when pm_hold_duration_bars
                   elapses since entry.
    engine_off   – Pause engine (no new entries). No buy/sell.
    force_sell   – Immediately liquidate position and re-enable engine.
    no_trade     – No action this cycle.
    """
    if not _settings.get("ai_tag_strategy_enabled", False):
        return
    if not _settings.get("ai_sentiment_change_enabled", True):
        return

    matrix_strategies: dict[str, dict[str, str]] = _settings.get("sentiment_matrix_strategies", {})
    matrix_actions: dict[str, dict[str, str]] = _settings.get("sentiment_matrix_actions", {})
    # Fall back to the flat ai_tag_strategies map if no matrix row is configured yet.
    flat_tag_strategies: dict[str, str] = _settings.get("ai_tag_strategies", {})

    pm_bucket: str = ((_state.get("market_classification") or {}).get("bucket") or "neutral").lower()

    long_tp = float(_settings.get("ai_tag_long_tp_pct", 0.0) or 0.0)
    long_sl = float(_settings.get("ai_tag_long_sl_pct", 0.0) or 0.0)
    long_tp_value = float(_settings.get("ai_tag_long_tp_value", 0.0) or 0.0)
    long_sl_value = float(_settings.get("ai_tag_long_sl_value", 0.0) or 0.0)
    no_loss_sell = bool(_settings.get("ai_tag_no_loss_sell", True))
    hold_duration_bars = max(0, int(_settings.get("pm_hold_duration_bars", 20) or 0))
    hold_extended_mult = max(0.0, float(_settings.get("pm_hold_extended_multiplier", 2.0) or 0.0))
    hold_trailing_pct = max(0.0, float(_settings.get("pm_hold_trailing_pct", 3.0) or 0.0))
    bar_minutes = max(1e-9, _interval_to_minutes(_settings.get("sentiment_interval", "1m")))
    symbol_overrides = _settings.get("position_overrides", {}) if isinstance(_settings.get("position_overrides"), dict) else {}

    def _is_frenzy_period() -> bool:
        from app.services.sandbox_engine import _ET
        now_et = datetime.now(tz=_ET)
        if now_et.weekday() >= 5:
            return False
        mins = now_et.hour * 60 + now_et.minute
        open_mins = 9 * 60 + 30
        frenzy_end = open_mins + 180
        return open_mins <= mins < frenzy_end

    def _ai_period_for_current_phase(positions: list[SandboxPosition]) -> str:
        hold_overnight = bool(_settings.get("hold_positions_overnight", True))
        ai_overwrite_enabled = bool(_settings.get("ai_tag_strategy_enabled", False))
        ai_allows_overnight = bool(_settings.get("ai_tag_allow_overnight", True))
        effective_overnight_behavior = hold_overnight or (ai_overwrite_enabled and ai_allows_overnight)
        if not effective_overnight_behavior:
            return "2d"
        try:
            from app.services.sandbox_engine import _is_in_pre_sell_engine_shutoff_window, _is_in_eod_sell_window
            eod_mins = int(_settings.get("eod_sell_window_minutes", 30) or 30)
            shutoff_mins = int(_settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120)
            in_shutoff_window = _is_in_pre_sell_engine_shutoff_window(eod_mins, shutoff_mins)
            in_final_sell_window = _is_in_eod_sell_window(eod_mins)
            engine_already_off = any(
                (not bool(getattr(p, "strategy_enabled", True)))
                and (
                    float(getattr(p, "shares", 0.0) or 0.0) > 0.0
                    or float(getattr(p, "pending_shares", 0.0) or 0.0) > 0.0
                    or bool(getattr(p, "pm_managed", False))
                )
                for p in positions
            )
            if in_shutoff_window or in_final_sell_window or engine_already_off:
                return "30d"
        except Exception:
            pass
        return "2d"

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
        insights = await classify_symbols(
            symbols,
            period=_ai_period_for_current_phase(snap),
            external_sentiment_weight=float(_settings.get("ai_external_sentiment_weight", 0.0) or 0.0),
        )
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

    # In IB mode, use real broker positions to keep PM engine control aligned.
    ib_pos_map: dict[str, dict[str, float]] = {}
    try:
        from app.services.ib_service import ib_service
        if ib_service.is_connected:
            ib_rows = await ib_service.get_positions()
            for row in ib_rows:
                sym = str(row.get("symbol") or "").upper()
                if not sym:
                    continue
                qty = max(0.0, float(row.get("quantity") or 0.0))
                avg = max(0.0, float(row.get("avg_cost") or 0.0))
                ib_pos_map[sym] = {"qty": qty, "avg_cost": avg}
    except Exception as exc:
        logger.warning("AI tag IB position sync failed: %s", exc)

    # ── 3. Determine which symbols need current prices ─────────────────── #
    needs_price_set: set[str] = set()
    for p in snap:
        new_tag = (insights.get(p.symbol, {}).get("learner_tag") or "WATCH").upper()
        ib_qty = float(ib_pos_map.get(p.symbol.upper(), {}).get("qty", 0.0))
        has_pos = p.shares > 0 or p.pending_shares > 0 or ib_qty > 0
        cell_action = matrix_actions.get(pm_bucket, {}).get(new_tag, "trade")
        # Treat any advanced_hold:* variant as a hold for price-fetch purposes.
        if cell_action.startswith("advanced_hold"):
            cell_action = "hold"
        if cell_action == "hold":
            needs_price_set.add(p.symbol)       # buy + TP/SL monitoring
        elif cell_action == "force_sell" and has_pos:
            needs_price_set.add(p.symbol)       # need price for sell record

    price_map: dict[str, float] = {}
    if needs_price_set:
        try:
            from app.services.market_service import get_bulk_quotes
            quotes = await get_bulk_quotes(list(needs_price_set))
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
    ib_orders: list[dict[str, Any]] = []
    hold_modes: dict[str, bool] = {}

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        from app.models.sandbox import SandboxAccount
        from app.models.sandbox import SandboxTrade as _ST
        res = await db.execute(sa_select(SandboxPosition))
        positions: list[SandboxPosition] = res.scalars().all()
        db_changed = False

        for pos in positions:
            info = insights.get(pos.symbol, {})
            new_tag = (info.get("learner_tag") or "WATCH").upper()
            ib_info = ib_pos_map.get(pos.symbol.upper(), {})
            ib_qty = float(ib_info.get("qty", 0.0))
            ib_avg_cost = float(ib_info.get("avg_cost", 0.0))
            has_ib_pos = ib_qty > 0

            # Resolve cell strategy + action (fallback to flat map when no matrix row)
            cell_strategy: str = (
                matrix_strategies.get(pm_bucket, {}).get(new_tag)
                or flat_tag_strategies.get(new_tag, "")
            )
            raw_action: str = matrix_actions.get(pm_bucket, {}).get(new_tag, "trade")
            # Parse advanced-hold variant: "advanced_hold:trailing" → ("advanced_hold", "trailing")
            if ":" in raw_action:
                base_action, hold_variant = raw_action.split(":", 1)
            else:
                base_action, hold_variant = raw_action, ""
            # Treat advanced_hold as a hold-family action with a variant.
            if base_action == "advanced_hold":
                cell_action = "hold"
            else:
                cell_action = base_action
                hold_variant = ""

            # ── no_trade: no changes this tick ────────────────────────────
            if cell_action == "no_trade":
                continue

            # ── trade: normal strategy routing, engine runs ────────────────
            if cell_action == "trade":
                if new_tag != "WATCH" and cell_strategy and pos.strategy_name != cell_strategy:
                    old_strat = pos.strategy_name or "none"
                    pos.strategy_name = cell_strategy
                    db_changed = True
                    strategy_changes.append(f"{pos.symbol}[AI:{new_tag}]: {old_strat}→{cell_strategy}")
                # Always re-enable engine when transitioning into a `trade` cell,
                # regardless of whether it was paused by PM hold or engine_off.
                if not pos.strategy_enabled:
                    pos.strategy_enabled = True
                    db_changed = True
                    engine_changes.append(f"{pos.symbol}: engine on (→trade cell, {new_tag})")
                if pos.pm_managed:
                    pos.pm_managed = False
                    pos.pm_hold_started_at = None
                    db_changed = True
                    hold_modes[pos.symbol] = False
                continue

            # ── engine_off: pause engine, no buy/sell ──────────────────────
            if cell_action == "engine_off":
                if new_tag != "WATCH" and cell_strategy and pos.strategy_name != cell_strategy:
                    old_strat = pos.strategy_name or "none"
                    pos.strategy_name = cell_strategy
                    db_changed = True
                    strategy_changes.append(f"{pos.symbol}[AI:{new_tag}]: {old_strat}→{cell_strategy}")
                if pos.strategy_enabled:
                    pos.strategy_enabled = False
                    db_changed = True
                    engine_changes.append(f"{pos.symbol}: engine off (matrix {pm_bucket}×{new_tag})")
                continue

            # ── force_sell: liquidate immediately, re-enable engine ────────
            if cell_action == "force_sell":
                cp = price_map.get(pos.symbol, 0.0)
                effective_qty = float(pos.shares) if pos.shares > 0 else float(ib_qty)
                effective_avg_cost = float(pos.avg_cost) if (pos.shares > 0 and pos.avg_cost > 0) else float(ib_avg_cost)
                has_open = pos.shares > 0 or has_ib_pos
                if cp > 0 and has_open and effective_qty > 0:
                    pnl = round((cp - effective_avg_cost) * effective_qty, 4) if effective_avg_cost > 0 else 0.0
                    if no_loss_sell and pnl < 0:
                        hold_modes[pos.symbol] = True
                        _log_activity(f"AI force-sell deferred for {pos.symbol}: would realize loss ${pnl:.2f}")
                        continue
                    had_local_shares = pos.shares > 0
                    if had_local_shares:
                        total = effective_qty * cp
                        pos.shares = 0.0
                        pos.allocated_funds += total
                        pos.realized_pnl += pnl
                        pos.avg_cost = 0.0
                    pos.pm_managed = False
                    pos.pm_hold_started_at = None
                    pos.strategy_enabled = True
                    db_changed = True
                    hold_modes[pos.symbol] = False
                    if had_local_shares:
                        acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
                        acct = acct_res.scalar_one_or_none()
                        if acct:
                            acct.total_funds += pnl
                        db.add(_ST(
                            symbol=pos.symbol,
                            side="SELL",
                            quantity=effective_qty,
                            price=cp,
                            total=round(effective_qty * cp, 4),
                            strategy_name=pos.strategy_name,
                            reason=f"ai_force_sell ({pm_bucket}×{new_tag})",
                            pnl=pnl,
                        ))
                    ib_orders.append({
                        "symbol": pos.symbol,
                        "side": "SELL",
                        "quantity": float(effective_qty),
                        "reason": f"ai_force_sell ({pm_bucket}×{new_tag})",
                    })
                    engine_changes.append(f"{pos.symbol}: force-sell PnL ${pnl:+.2f}")
                else:
                    # No open position – ensure engine is on
                    if not pos.strategy_enabled:
                        pos.strategy_enabled = True
                        pos.pm_managed = False
                        pos.pm_hold_started_at = None
                        db_changed = True
                        hold_modes[pos.symbol] = False
                continue

            # ── hold (Buy & Hold) + advanced_hold variants ────────────────
            # hold_variant values:
            #   ""                 → simple hold (use pm_hold_duration_bars)
            #   "extended"         → use pm_hold_duration_bars * pm_hold_extended_multiplier
            #   "until_tag_change" → no time cap; exit when learner_tag changes
            #   "trailing"         → no time cap; exit on trailing % drawdown from peak
            if cell_action == "hold":
                if cell_strategy and pos.strategy_name != cell_strategy:
                    pos.strategy_name = cell_strategy
                    db_changed = True
                if pos.strategy_enabled:
                    pos.strategy_enabled = False
                    pos.pm_managed = True
                    db_changed = True
                    label = f"hold:{hold_variant}" if hold_variant else "hold"
                    engine_changes.append(f"{pos.symbol}: engine off ({label}, {new_tag})")

                # Compute per-variant effective duration (0 = no time cap).
                if hold_variant in ("until_tag_change", "trailing"):
                    effective_duration = 0.0
                sym_override = symbol_overrides.get(pos.symbol.upper(), {}) if isinstance(symbol_overrides, dict) else {}
                hold_override_bars = max(0, int(sym_override.get("hold_duration_bars", 0) or 0))
                base_hold_bars = hold_override_bars if hold_override_bars > 0 else hold_duration_bars
                if hold_variant == "extended":
                    effective_duration = float(base_hold_bars) * hold_extended_mult
                else:
                    effective_duration = float(base_hold_bars)

                now_utc = datetime.now(timezone.utc)
                started = getattr(pos, "pm_hold_started_at", None)
                has_open_pos = pos.shares > 0 or has_ib_pos
                cp_live = price_map.get(pos.symbol, 0.0)

                # Update peak price for trailing variant (only while we hold the position).
                if hold_variant == "trailing" and has_open_pos and cp_live > 0:
                    prev_peak = float(getattr(pos, "pm_hold_peak_price", 0.0) or 0.0)
                    if cp_live > prev_peak:
                        pos.pm_hold_peak_price = cp_live
                        db_changed = True

                # Determine exit trigger for this tick.
                # `is_hard_stop` flags risk-limit exits (trailing stop) that must execute
                # regardless of `no_loss_sell` — same priority rule as the long_sl path below.
                exit_reason: str = ""
                is_hard_stop: bool = False
                if has_open_pos:
                    if hold_variant == "until_tag_change":
                        old_tag = old_tags.get(pos.symbol, "")
                        # Trigger only after we've already recorded a hold-entry tag and it changed.
                        if old_tag and old_tag != new_tag:
                            exit_reason = f"ai_hold_tag_change ({old_tag}→{new_tag})"
                    elif hold_variant == "trailing" and hold_trailing_pct > 0:
                        peak = float(getattr(pos, "pm_hold_peak_price", 0.0) or 0.0)
                        if peak > 0 and cp_live > 0:
                            drawdown_pct = (peak - cp_live) / peak * 100.0
                            if drawdown_pct >= hold_trailing_pct:
                                exit_reason = (
                                    f"ai_hold_trailing_stop ({drawdown_pct:.2f}%≥{hold_trailing_pct:.2f}%)"
                                )
                                is_hard_stop = True
                    elif effective_duration > 0 and started is not None:
                        started_aware = started if started.tzinfo else started.replace(tzinfo=timezone.utc)
                        elapsed_bars = (now_utc - started_aware).total_seconds() / (bar_minutes * 60.0)
                        if elapsed_bars >= effective_duration:
                            exit_reason = f"ai_hold_expiry ({effective_duration:.0f} bars)"

                if exit_reason:
                    cp_exp = cp_live
                    eff_qty = float(pos.shares) if pos.shares > 0 else float(ib_qty)
                    eff_avg = float(pos.avg_cost) if (pos.shares > 0 and pos.avg_cost > 0) else float(ib_avg_cost)
                    if cp_exp > 0 and eff_qty > 0:
                        pnl = round((cp_exp - eff_avg) * eff_qty, 4) if eff_avg > 0 else 0.0
                        # Hard stops (trailing) must always execute — they are risk-limit exits.
                        if no_loss_sell and pnl < 0 and not is_hard_stop:
                            hold_modes[pos.symbol] = True
                            _log_activity(
                                f"AI hold-exit SELL deferred for {pos.symbol} ({exit_reason}): would realize loss ${pnl:.2f}"
                            )
                            continue
                        had_local = pos.shares > 0
                        if had_local:
                            total = eff_qty * cp_exp
                            pos.shares = 0.0
                            pos.allocated_funds += total
                            pos.realized_pnl += pnl
                            pos.avg_cost = 0.0
                        pos.pm_managed = False
                        pos.pm_hold_started_at = None
                        pos.pm_hold_peak_price = None
                        pos.strategy_enabled = True
                        db_changed = True
                        hold_modes[pos.symbol] = False
                        if had_local:
                            acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
                            acct = acct_res.scalar_one_or_none()
                            if acct:
                                acct.total_funds += pnl
                            db.add(_ST(
                                symbol=pos.symbol,
                                side="SELL",
                                quantity=eff_qty,
                                price=cp_exp,
                                total=round(eff_qty * cp_exp, 4),
                                strategy_name=pos.strategy_name,
                                reason=exit_reason,
                                pnl=pnl,
                            ))
                        ib_orders.append({
                            "symbol": pos.symbol,
                            "side": "SELL",
                            "quantity": float(eff_qty),
                            "reason": exit_reason,
                        })
                        engine_changes.append(f"{pos.symbol}: {exit_reason} PnL ${pnl:+.2f}")
                        continue

                cp = price_map.get(pos.symbol, 0.0)
                if pos.shares == 0 and pos.pending_shares == 0 and not has_ib_pos:
                    # Buy candidate
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
                                pos.pm_managed = True
                                pos.pm_hold_started_at = datetime.now(timezone.utc)
                                pos.pm_hold_peak_price = cp
                                db_changed = True
                                hold_modes[pos.symbol] = True
                                db.add(_ST(
                                    symbol=pos.symbol,
                                    side="BUY",
                                    quantity=qty,
                                    price=cp,
                                    total=round(total, 4),
                                    strategy_name=pos.strategy_name,
                                    reason=f"ai_hold_buy ({new_tag})",
                                    pnl=None,
                                ))
                                ib_orders.append({
                                    "symbol": pos.symbol,
                                    "side": "BUY",
                                    "quantity": float(qty),
                                    "reason": f"ai_hold_buy ({new_tag})",
                                })
                                engine_changes.append(
                                    f"{pos.symbol}: direct BUY {qty}@${cp:.2f} ({new_tag})"
                                )
                elif pos.shares > 0 or has_ib_pos:
                    # Position held – ensure pm_managed and evaluate TP/SL
                    if not pos.pm_managed:
                        pos.pm_managed = True
                        db_changed = True
                    if getattr(pos, "pm_hold_started_at", None) is None:
                        pos.pm_hold_started_at = datetime.now(timezone.utc)
                        db_changed = True
                    # Seed peak price for trailing variant if missing.
                    if cp > 0 and not (getattr(pos, "pm_hold_peak_price", None) or 0.0):
                        pos.pm_hold_peak_price = cp
                        db_changed = True
                    if pos.shares <= 0:
                        hold_modes[pos.symbol] = True
                    effective_qty = float(pos.shares) if pos.shares > 0 else float(ib_qty)
                    effective_avg_cost = float(pos.avg_cost) if (pos.shares > 0 and pos.avg_cost > 0) else float(ib_avg_cost)
                    if cp > 0 and effective_avg_cost > 0 and effective_qty > 0:
                        sl_targets = []
                        tp_targets = []
                        if long_sl > 0:
                            sl_targets.append(effective_avg_cost * (1.0 - long_sl / 100.0))
                        if long_sl_value > 0:
                            sl_targets.append(effective_avg_cost - long_sl_value)
                        if long_tp > 0:
                            tp_targets.append(effective_avg_cost * (1.0 + long_tp / 100.0))
                        if long_tp_value > 0:
                            tp_targets.append(effective_avg_cost + long_tp_value)
                        sl_trigger = max(sl_targets) if sl_targets else None
                        tp_trigger = min(tp_targets) if tp_targets else None
                        hit_sl = sl_trigger is not None and cp <= sl_trigger
                        hit_tp = tp_trigger is not None and cp >= tp_trigger
                        if hit_sl or hit_tp:
                            reason = (
                                f"ai_long_sl (@ ${cp:.2f})"
                                if hit_sl
                                else f"ai_long_tp (@ ${cp:.2f})"
                            )
                            pnl = round((cp - effective_avg_cost) * effective_qty, 4)
                            # SL is a hard risk-limit exit — it must always execute, even at a loss.
                            # `no_loss_sell` only defers discretionary sells (TP would never be at
                            # a loss anyway, so this guard only matters for SL, which we now bypass).
                            if no_loss_sell and pnl < 0 and not hit_sl:
                                hold_modes[pos.symbol] = True
                                _log_activity(
                                    f"AI hold SELL deferred for {pos.symbol}: would realize loss ${pnl:.2f}"
                                )
                                continue
                            had_local_shares = pos.shares > 0
                            if had_local_shares:
                                total = effective_qty * cp
                                pos.shares = 0.0
                                pos.allocated_funds += total
                                pos.realized_pnl += pnl
                                pos.avg_cost = 0.0
                            else:
                                total = 0.0
                            pos.strategy_enabled = True
                            pos.pm_managed = False
                            pos.pm_hold_started_at = None
                            db_changed = True
                            hold_modes[pos.symbol] = False
                            if had_local_shares:
                                acct_res = await db.execute(sa_select(SandboxAccount).limit(1))
                                acct = acct_res.scalar_one_or_none()
                                if acct:
                                    acct.total_funds += pnl
                                db.add(_ST(
                                    symbol=pos.symbol,
                                    side="SELL",
                                    quantity=effective_qty,
                                    price=cp,
                                    total=round(total, 4),
                                    strategy_name=pos.strategy_name,
                                    reason=reason,
                                    pnl=pnl,
                                ))
                            ib_orders.append({
                                "symbol": pos.symbol,
                                "side": "SELL",
                                "quantity": float(effective_qty),
                                "reason": reason,
                            })
                            engine_changes.append(
                                f"{pos.symbol}: {reason.split('(')[0].strip()} PnL ${pnl:+.2f}"
                            )
                        else:
                            hold_modes[pos.symbol] = True

        if db_changed:
            await _commit_with_retry(db, operation="ai_tag_strategy_apply")
            if strategy_changes:
                _log_activity(f"AI tag strategy: {', '.join(strategy_changes)}")
            if engine_changes:
                _log_activity(f"AI tag engine: {', '.join(engine_changes)}")

    if ib_orders:
        from app.services.ib_service import ib_service

        if ib_service.is_connected:
            for order in ib_orders:
                result = await ib_service.place_order(
                    symbol=order["symbol"],
                    side=order["side"],
                    quantity=float(order["quantity"]),
                    order_type="MKT",
                )
                if result.get("error"):
                    _log_activity(
                        f"IB PM {order['side']} failed for {order['symbol']}: {result['error']}"
                    )
                else:
                    _log_activity(
                        f"IB PM {order['side']} submitted for {order['symbol']} x{float(order['quantity']):.4f}"
                    )

    # Propagate hold_mode flags into the live state so the frontend can display them.
    for sym, info in _state["ai_tags"].items():
        info["hold_mode"] = hold_modes.get(sym, False)


# ── transfer logic ────────────────────────────────────────────────────────── #

def _log_activity(msg: str) -> None:
    entry = {"at": datetime.now(timezone.utc).isoformat(), "msg": msg}
    _state["last_activity"].insert(0, entry)
    _state["last_activity"] = _state["last_activity"][:20]
    logger.info("PortfolioManager: %s", msg)


def _is_sqlite_lock_error(exc: Exception) -> bool:
    msg = str(getattr(exc, "orig", exc)).lower()
    return "database is locked" in msg or "database table is locked" in msg


async def _commit_with_retry(
    db,
    *,
    operation: str,
    retries: int = 5,
    base_delay_s: float = 0.2,
) -> None:
    for attempt in range(retries + 1):
        try:
            await db.commit()
            return
        except OperationalError as exc:
            if (not _is_sqlite_lock_error(exc)) or attempt >= retries:
                raise
            try:
                await db.rollback()
            except Exception:
                pass
            delay = base_delay_s * (attempt + 1)
            logger.warning(
                "PM commit lock during %s; retry %d/%d in %.2fs",
                operation,
                attempt + 1,
                retries,
                delay,
            )
            await asyncio.sleep(delay)


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
    allocated = float(position.allocated_funds or 0.0)
    # pending BUY cost is already debited from allocated_funds when the order is placed.
    return allocated + settled_cost


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


async def _attempt_ib_eod_liquidation() -> None:
    """Best-effort IB EOD liquidation for non-overnight mode.

    When hold_positions_overnight is disabled and we are inside the final sell
    window, submit DAY market SELL orders for all owned long IB positions,
    except symbols explicitly exempted by AI overnight-tag rules.
    """
    from app.services.ib_service import ib_service
    from app.services.sandbox_engine import _is_in_eod_sell_window

    if not ib_service.is_connected:
        return

    hold_overnight = bool(_settings.get("hold_positions_overnight", True))
    if hold_overnight:
        return

    eod_mins = int(_settings.get("eod_sell_window_minutes", 30) or 30)
    if not _is_in_eod_sell_window(eod_mins):
        return

    ib_positions = await ib_service.get_positions()
    owned = [p for p in ib_positions if float(p.get("quantity") or 0.0) > 0]
    if not owned:
        return

    open_orders = await ib_service.get_open_orders()
    active_status = {"PendingSubmit", "ApiPending", "PreSubmitted", "Submitted"}
    open_sell_symbols = {
        str(o.get("symbol") or "").upper()
        for o in open_orders
        if str(o.get("side") or "").upper() == "SELL"
        and float(o.get("remaining") or 0.0) > 0
        and str(o.get("status") or "") in active_status
    }

    ai_allow_overnight = bool(_settings.get("ai_tag_allow_overnight", True))
    ai_enabled = bool(_settings.get("ai_sentiment_change_enabled", True))
    now = datetime.now(timezone.utc)
    cooldown_s = 30

    liquidated: list[str] = []
    for row in owned:
        symbol = str(row.get("symbol") or "").upper()
        qty = float(row.get("quantity") or 0.0)
        if not symbol or qty <= 0:
            continue

        # Optional per-symbol overnight exemption for LONG / STRONG LONG tags.
        if ai_enabled and ai_allow_overnight:
            tag = (
                _state.get("ai_tags", {}).get(symbol, {}).get("learner_tag") or ""
            ).upper()
            if tag in ("LONG", "STRONG LONG"):
                continue

        if symbol in open_sell_symbols:
            continue

        last_try = _ib_eod_liq_last_attempt.get(symbol)
        if last_try and (now - last_try).total_seconds() < cooldown_s:
            continue

        result = await ib_service.place_order(
            symbol=symbol,
            side="SELL",
            quantity=qty,
            order_type="MKT",
        )
        _ib_eod_liq_last_attempt[symbol] = now

        if result.get("error"):
            _log_activity(
                f"IB PM EOD liquidation failed for {symbol}: {result['error']}"
            )
        else:
            liquidated.append(f"{symbol} x{qty:.4f}")

    if liquidated:
        _log_activity(
            f"IB PM EOD liquidation submitted ({eod_mins}m window): {', '.join(liquidated)}"
        )


async def _cancel_ib_pending_orders_price_moved() -> None:
    """Cancel open IB BUY limit orders when market price has moved below limit.

    Mirrors sandbox pending-cancel behavior where a BUY is cancelled if current
    price has already dropped below the intended pending fill price.
    """
    from app.services.ib_service import ib_service

    if not ib_service.is_connected:
        return

    open_orders = await ib_service.get_open_orders()
    active_status = {"PendingSubmit", "ApiPending", "PreSubmitted", "Submitted"}

    candidates: list[dict[str, Any]] = []
    symbols: set[str] = set()
    for o in open_orders:
        side = str(o.get("side") or "").upper()
        status = str(o.get("status") or "")
        order_type = str(o.get("order_type") or "").upper()
        remaining = float(o.get("remaining") or 0.0)
        limit_price = float(o.get("limit_price") or 0.0)
        symbol = str(o.get("symbol") or "").upper()
        if (
            side == "BUY"
            and order_type == "LMT"
            and status in active_status
            and remaining > 0
            and limit_price > 0
            and symbol
        ):
            candidates.append(o)
            symbols.add(symbol)

    if not candidates:
        return

    price_map: dict[str, float] = {}
    try:
        from app.services.market_service import get_bulk_quotes
        quotes = await get_bulk_quotes(list(symbols))
        price_map = {
            sym: float(q["last_price"])
            for sym, q in quotes.items()
            if q and q.get("last_price")
        }
    except Exception as exc:
        logger.warning("PM IB pending-cancel price fetch failed: %s", exc)
        return

    cancelled: list[str] = []
    cancel_events: list[dict[str, Any]] = []
    drift_threshold_pct = max(0.0, float(_settings.get("pending_price_drift_cancel_pct", 0.75) or 0.0))
    for o in candidates:
        symbol = str(o.get("symbol") or "").upper()
        side_raw = str(o.get("side") or "BUY").upper()
        side = "SELL" if side_raw == "SELL" else "BUY"
        qty = float(o.get("remaining") or o.get("quantity") or 0.0)
        limit_price = float(o.get("limit_price") or 0.0)
        cp = float(price_map.get(symbol, 0.0))
        if cp <= 0 or limit_price <= 0:
            continue

        # Cancel if market has drifted materially from the pending limit.
        drift_pct = abs(cp - limit_price) / limit_price * 100.0
        if drift_pct < drift_threshold_pct:
            continue

        oid = int(o.get("ib_order_id") or 0)
        if oid <= 0:
            continue

        result = await ib_service.cancel_order(oid)
        if result.get("error"):
            _log_activity(
                f"IB PM pending BUY cancel failed {symbol} id={oid}: {result['error']}"
            )
        else:
            cancelled.append(
                f"{symbol} id={oid} (drift {drift_pct:.2f}%: ${cp:.2f} vs ${limit_price:.2f})"
            )
            cancel_events.append({
                "symbol": symbol,
                "side": side,
                "quantity": max(0.0, qty),
                "price": max(0.0, limit_price),
                "ib_order_id": oid,
            })

    if cancel_events:
        try:
            from app.config import settings
            from app.models.trade import Trade, OrderSide, OrderStatus, TradingMode

            mode = TradingMode.LIVE if settings.TRADING_MODE == "live" else TradingMode.PAPER
            async with AsyncSessionLocal() as db:
                for ev in cancel_events:
                    db.add(Trade(
                        symbol=ev["symbol"],
                        side=OrderSide.SELL if ev["side"] == "SELL" else OrderSide.BUY,
                        quantity=ev["quantity"],
                        price=ev["price"],
                        status=OrderStatus.CANCELLED,
                        mode=mode,
                        ib_order_id=ev["ib_order_id"],
                        strategy_name="pm_ib_pending_cancel",
                        filled_at=None,
                    ))
                await db.commit()
        except Exception as exc:
            logger.warning("PM IB pending-cancel event persistence failed: %s", exc)

    if cancelled:
        _log_activity(
            f"IB PM cancelled pending BUY(s) price moved away: {', '.join(cancelled)}"
        )


async def _cancel_bearish_pending_orders() -> None:
    """Cancel unsettled pending BUY orders when any of the following is true:

    1. Sentiment score (symbol or market) is bearish/crash (< -0.2).
    2. Current price has dropped below the pending order's fill price
       (already underwater before the order even settles).
    3. AI learner tag for the symbol is SHORT or STRONG SHORT.
     4. We are in the EOD sell window and overnight holding is disabled,
         unless AI tag is LONG or STRONG LONG.

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
        ai_enabled = bool(_settings.get("ai_sentiment_change_enabled", True))
        drift_threshold_pct = max(0.0, float(_settings.get("pending_price_drift_cancel_pct", 0.25) or 0.0))
        pending_cancel_after_bars = max(1, int(_settings.get("pending_cancel_after_bars", 3) or 3))
        bar_minutes = _interval_to_minutes(str(_settings.get("sentiment_interval", "1m") or "1m"))
        pending_cancel_after_minutes = pending_cancel_after_bars * bar_minutes
        now_utc = datetime.now(timezone.utc)

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
            price_drifted = (
                cp > 0
                and fill_price > 0
                and (abs(cp - fill_price) / fill_price * 100.0) >= drift_threshold_pct
            )

            # ── 2b. Pending order has timed out in bar-equivalent minutes ──
            pending_expired = False
            pending_since = getattr(pos, "pending_since", None)
            if pending_since is not None and pending_cancel_after_minutes > 0:
                try:
                    pending_ts = pending_since
                    if pending_ts.tzinfo is None:
                        pending_ts = pending_ts.replace(tzinfo=timezone.utc)
                    elapsed_min = (now_utc - pending_ts).total_seconds() / 60.0
                    pending_expired = elapsed_min >= pending_cancel_after_minutes
                except Exception:
                    pending_expired = False

            # ── 3. AI tag is SHORT or STRONG SHORT ────────────────────────
            ai_tag = (
                _state.get("ai_tags", {}).get(pos.symbol, {}).get("learner_tag") or ""
            ).upper()
            ai_short = ai_enabled and ai_tag in ("SHORT", "STRONG SHORT")
            ai_long = ai_enabled and ai_tag in ("LONG", "STRONG LONG")

            # EOD policy: cancel all pending orders unless AI tag is LONG/STRONG LONG.
            cancel_for_eod = in_eod_window and not ai_long

            if not bearish_sentiment and not price_drifted and not pending_expired and not ai_short and not cancel_for_eod:
                continue

            # ── Build cancel reason ───────────────────────────────────────
            reasons: list[str] = []
            if bearish_sentiment:
                reasons.append(f"sentiment {score:+.3f}")
            if price_drifted:
                drift_pct = abs(cp - fill_price) / fill_price * 100.0 if cp > 0 and fill_price > 0 else 0.0
                reasons.append(f"price drift {drift_pct:.2f}% (${cp:.2f} vs fill ${fill_price:.2f})")
            if pending_expired:
                reasons.append(f"pending timeout {pending_cancel_after_bars} bars")
            if ai_short:
                reasons.append(f"ai_tag {ai_tag}")
            if cancel_for_eod:
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
    ib_owned_symbols: set[str] = set()
    try:
        from app.services.ib_service import ib_service
        if ib_service.is_connected:
            ib_rows = await ib_service.get_positions()
            ib_owned_symbols = {
                str(r.get("symbol") or "").upper()
                for r in ib_rows
                if float(r.get("quantity") or 0.0) > 0
            }
    except Exception as exc:
        logger.warning("PM day-start IB position sync failed: %s", exc)

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

        if ib_owned_symbols:
            positions = [p for p in positions if p.symbol.upper() not in ib_owned_symbols]
            if not positions:
                return 0

        for pos in positions:
            pos.strategy_enabled = True
            pos.engine_error = None
        await db.commit()
        return len(positions)


async def _process_ib_engine_signals() -> None:
    """Consume engine signals in IB mode and route execution through PM rules."""
    from app.services.ib_service import ib_service

    if not ib_service.is_connected:
        return

    async with AsyncSessionLocal() as db:
        from sqlalchemy import select as sa_select
        res = await db.execute(
            sa_select(SandboxPosition).where(
                SandboxPosition.strategy_enabled == True,  # noqa: E712
                SandboxPosition.strategy_name.isnot(None),
            )
        )
        positions: list[SandboxPosition] = res.scalars().all()

    if not positions:
        return

    ib_positions = await ib_service.get_positions()
    ib_by_symbol: dict[str, dict[str, float]] = {}
    for row in ib_positions:
        sym = str(row.get("symbol") or "").upper()
        if not sym:
            continue
        ib_by_symbol[sym] = {
            "qty": float(row.get("quantity") or 0.0),
            "avg_cost": float(row.get("avg_cost") or 0.0),
        }
    ib_avg_cost_by_symbol = {
        sym: float(info.get("avg_cost") or 0.0)
        for sym, info in ib_by_symbol.items()
    }

    open_orders = await ib_service.get_open_orders()
    active_status = {"PendingSubmit", "ApiPending", "PreSubmitted", "Submitted"}
    pending_buy_symbols = {
        str(o.get("symbol") or "").upper()
        for o in open_orders
        if str(o.get("side") or "").upper() == "BUY"
        and str(o.get("status") or "") in active_status
        and float(o.get("remaining") or 0.0) > 0
    }
    pending_sell_symbols = {
        str(o.get("symbol") or "").upper()
        for o in open_orders
        if str(o.get("side") or "").upper() == "SELL"
        and str(o.get("status") or "") in active_status
        and float(o.get("remaining") or 0.0) > 0
    }

    _stop_loss_pct = _settings.get("stop_loss_pct", 0.8)
    _take_profit_pct = _settings.get("take_profit_pct", 2.5)
    stop_loss_pct = float(0.8 if _stop_loss_pct is None else _stop_loss_pct)
    take_profit_pct = float(2.5 if _take_profit_pct is None else _take_profit_pct)
    ai_enabled = bool(_settings.get("ai_sentiment_change_enabled", True))

    order_candidates: list[dict[str, Any]] = []
    buy_symbols_needing_quote: set[str] = set()
    risk_symbols_needing_quote: set[str] = set()
    risk_rows: list[tuple[str, float, float]] = []
    buy_signal_rows: list[tuple[SandboxPosition, str, float, str, str]] = []
    quote_price_map: dict[str, float] = {}

    def _auto_limit_price_from_reference(reference_price: float, side: str) -> float:
        if reference_price <= 0:
            return 0.0
        side_u = str(side or "").upper()
        if side_u == "BUY":
            offset = max(0.0, float(_settings.get("auto_trade_buy_price_offset_pct", 0.145) or 0.0))
            return round(reference_price * (1.0 + offset / 100.0), 4)
        offset = max(0.0, float(_settings.get("auto_trade_sell_price_offset_pct", 0.185) or 0.0))
        return round(reference_price * (1.0 - offset / 100.0), 4)

    async def _fetch_prev_ohlc_mid_map(symbols: set[str]) -> dict[str, float]:
        if not symbols:
            return {}
        from app.services.market_service import get_intraday_df

        async def _one(sym: str) -> tuple[str, float]:
            try:
                df = await get_intraday_df(sym, range_="2d", interval="1m", include_pre_post=False)
                if df is None or df.empty:
                    return sym, 0.0
                idx = -2 if len(df.index) >= 2 else -1
                row = df.iloc[idx]
                o = float(row.get("Open") or 0.0)
                h = float(row.get("High") or 0.0)
                l = float(row.get("Low") or 0.0)
                c = float(row.get("Close") or 0.0)
                if c <= 0.0:
                    return sym, 0.0
                # Previous OHLC midpoint reference for automated IB limit pricing.
                ref = (o + h + l + c) / 4.0 if (o > 0 and h > 0 and l > 0 and c > 0) else c
                return sym, float(ref)
            except Exception as exc:
                logger.debug("PM IB prev OHLC midpoint fetch failed for %s: %s", sym, exc)
                return sym, 0.0

        pairs = await asyncio.gather(*[_one(sym) for sym in sorted(symbols)])
        return {sym: px for sym, px in pairs if px > 0.0}

    for pos in positions:
        symbol = str(pos.symbol or "").upper()
        if not symbol:
            continue

        last_run_at = pos.last_run_at.isoformat() if pos.last_run_at else ""
        signal = int(pos.last_signal or 0)
        if signal not in (-1, 1):
            continue

        process_key = f"{last_run_at}:{signal}"
        if _ib_signal_last_processed_at.get(symbol) == process_key:
            continue

        tag = str((_state.get("ai_tags", {}).get(symbol, {}).get("learner_tag") or "")).upper()
        score = float((_state.get("scores", {}).get(symbol, {}).get("score") or 0.0))
        ib_qty = float(ib_by_symbol.get(symbol, {}).get("qty", 0.0))

        logger.info(
            "PM IB signal observed (symbol=%s signal=%s run_at=%s tag=%s score=%+.3f ib_qty=%.4f)",
            symbol,
            signal,
            (last_run_at or "-"),
            (tag or "WATCH"),
            score,
            ib_qty,
        )

        if signal > 0:
            if ai_enabled and tag in {"SHORT", "STRONG SHORT"}:
                _log_activity(f"IB signal BUY blocked for {symbol}: ai_tag={tag}")
                _ib_signal_last_processed_at[symbol] = process_key
                continue
            if score < -0.2:
                _log_activity(f"IB signal BUY blocked for {symbol}: score={score:+.3f}")
                _ib_signal_last_processed_at[symbol] = process_key
                continue
            if ib_qty > 0 or symbol in pending_buy_symbols:
                _ib_signal_last_processed_at[symbol] = process_key
                continue
            buy_symbols_needing_quote.add(symbol)
            buy_signal_rows.append((pos, symbol, score, tag, process_key))

        elif signal < 0:
            if ib_qty <= 0 or symbol in pending_sell_symbols:
                _ib_signal_last_processed_at[symbol] = process_key
                continue

            order_candidates.append({
                "symbol": symbol,
                "side": "SELL",
                "quantity": float(abs(ib_qty)),
                "reason": f"pm_engine_signal_sell (signal={signal}, score={score:+.3f}, tag={tag or 'WATCH'})",
                "processed_key": process_key,
            })

        if (
            ib_qty > 0
            and float(ib_by_symbol.get(symbol, {}).get("avg_cost") or 0.0) > 0
            and symbol not in pending_sell_symbols
            and (stop_loss_pct > 0.0 or take_profit_pct > 0.0)
        ):
            risk_symbols_needing_quote.add(symbol)
            risk_rows.append((
                symbol,
                ib_qty,
                float(ib_by_symbol.get(symbol, {}).get("avg_cost") or 0.0),
            ))

    quote_symbols = set(buy_symbols_needing_quote) | set(risk_symbols_needing_quote)
    if quote_symbols:
        price_map: dict[str, float] = {}
        try:
            from app.services.market_service import get_bulk_quotes
            quotes = await get_bulk_quotes(sorted(quote_symbols))
            price_map = {
                sym: float(q["last_price"])
                for sym, q in quotes.items()
                if q and q.get("last_price")
            }
            quote_price_map = dict(price_map)
        except Exception as exc:
            logger.warning("PM IB signal quote fetch failed: %s", exc)

        for pos, symbol, score, tag, process_key in buy_signal_rows:
            cp = float(price_map.get(symbol, 0.0))
            alloc = float(pos.allocated_funds or 0.0)
            if cp <= 0.0:
                _log_activity(f"IB signal BUY skipped for {symbol}: no market price")
                _ib_signal_last_processed_at[symbol] = process_key
                continue

            qty = math.floor(alloc / cp)
            if qty <= 0:
                _log_activity(
                    f"IB signal BUY skipped for {symbol}: alloc=${alloc:.2f}, price=${cp:.2f}"
                )
                _ib_signal_last_processed_at[symbol] = process_key
                continue

            logger.info(
                "PM IB BUY candidate (symbol=%s alloc=%.2f price=%.2f qty=%s)",
                symbol,
                alloc,
                cp,
                qty,
            )
            order_candidates.append({
                "symbol": symbol,
                "side": "BUY",
                "quantity": float(qty),
                "alloc": float(alloc),
                "price": cp,
                "reason": f"pm_engine_signal_buy (signal=1, score={score:+.3f}, tag={tag or 'WATCH'})",
                "processed_key": process_key,
            })

        for symbol, qty, avg_cost in risk_rows:
            cp = float(price_map.get(symbol, 0.0))
            if cp <= 0.0 or avg_cost <= 0.0 or qty <= 0.0:
                continue

            hit_sl = stop_loss_pct > 0.0 and cp <= avg_cost * (1.0 - stop_loss_pct / 100.0)
            hit_tp = take_profit_pct > 0.0 and cp >= avg_cost * (1.0 + take_profit_pct / 100.0)
            if not hit_sl and not hit_tp:
                continue

            reason = (
                f"pm_risk_stop_loss ({stop_loss_pct:.2f}% @ ${cp:.2f})"
                if hit_sl
                else f"pm_risk_take_profit ({take_profit_pct:.2f}% @ ${cp:.2f})"
            )
            order_candidates.append({
                "symbol": symbol,
                "side": "SELL",
                "quantity": float(qty),
                "price": cp,
                "reason": reason,
            })

    if not order_candidates:
        return

    ref_symbols = {str(o.get("symbol") or "").upper() for o in order_candidates if o.get("symbol")}
    prev_mid_map = await _fetch_prev_ohlc_mid_map(ref_symbols)

    from app.config import settings
    from app.models.trade import Trade, OrderSide, OrderStatus, TradingMode

    mode = TradingMode.LIVE if settings.TRADING_MODE == "live" else TradingMode.PAPER
    for order in order_candidates:
        symbol = order["symbol"]
        side = order["side"]
        logger.info(
            "PM IB signal dispatch (symbol=%s side=%s qty=%.4f reason=%s)",
            symbol,
            side,
            float(order["quantity"]),
            order.get("reason", ""),
        )
        reference_price = float(
            prev_mid_map.get(symbol)
            or quote_price_map.get(symbol)
            or order.get("price")
            or 0.0
        )
        limit_price = _auto_limit_price_from_reference(reference_price, side)
        if limit_price <= 0.0:
            _log_activity(f"IB PM {side} skipped for {symbol}: no reference price")
            processed_key = order.get("processed_key")
            if processed_key:
                _ib_signal_last_processed_at[symbol] = str(processed_key)
            continue

        qty_to_submit = float(order.get("quantity") or 0.0)
        if side == "BUY":
            alloc = float(order.get("alloc") or 0.0)
            if alloc > 0.0:
                qty_to_submit = float(math.floor(alloc / limit_price))
        if qty_to_submit <= 0.0:
            _log_activity(f"IB PM {side} skipped for {symbol}: zero quantity at ${limit_price:.4f}")
            processed_key = order.get("processed_key")
            if processed_key:
                _ib_signal_last_processed_at[symbol] = str(processed_key)
            continue

        result = await ib_service.place_order(
            symbol=symbol,
            side=side,
            quantity=qty_to_submit,
            order_type="LMT",
            limit_price=limit_price,
        )
        if result.get("error"):
            _log_activity(f"IB PM {side} failed for {symbol}: {result['error']}")
            processed_key = order.get("processed_key")
            if processed_key:
                _ib_signal_last_processed_at[symbol] = str(processed_key)
            continue

        ib_status = str(result.get("status") or "").upper()
        is_filled = ib_status == "FILLED"
        submitted_price = float(limit_price)
        est_pnl = None
        if side == "SELL" and submitted_price > 0:
            avg_cost = float(ib_avg_cost_by_symbol.get(symbol, 0.0) or 0.0)
            if avg_cost > 0:
                est_pnl = round((submitted_price - avg_cost) * qty_to_submit, 4)
        async with AsyncSessionLocal() as db:
            db.add(Trade(
                symbol=symbol,
                side=OrderSide.BUY if side == "BUY" else OrderSide.SELL,
                quantity=qty_to_submit,
                price=submitted_price,
                status=OrderStatus.FILLED if is_filled else OrderStatus.PENDING,
                mode=mode,
                ib_order_id=result.get("ib_order_id"),
                strategy_name="pm_engine_signal",
                pnl=est_pnl,
                filled_at=datetime.now(timezone.utc) if is_filled else None,
            ))
            await db.commit()

        _log_activity(
            f"IB PM {side} submitted from engine signal for {symbol} x{qty_to_submit:.4f} @ ${submitted_price:.4f}"
        )
        processed_key = order.get("processed_key")
        if processed_key:
            _ib_signal_last_processed_at[symbol] = str(processed_key)


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
        if _settings.get("ai_tag_strategy_enabled", False):
            await _apply_ai_tag_strategies()


async def run_portfolio_manager() -> None:
    """Long-running coroutine – start as an asyncio task from app lifespan."""
    _state["running"] = True
    await _load_settings_from_db()
    try:
        await refresh_sentiment_routing()
    except Exception as exc:
        logger.warning("PM startup routing refresh error: %s", exc)
    logger.info("Portfolio Manager task started (enabled=%s).", _settings["enabled"])

    # Score immediately on startup when PM is enabled but scores are cold
    # (no DB cache yet, first-ever run, or new symbols added).
    # This ensures the UI shows sentiment without waiting for the first loop tick.
    if _settings.get("enabled") and not _state.get("scores"):
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
            logger.warning("PM startup score error: %s", exc)

    last_transfer = 0.0
    last_score = 0.0

    while True:
        await asyncio.sleep(10)

        if not _settings["enabled"]:
            continue

        from app.services.sandbox_engine import _ET, _market_is_active, _regular_session_is_open

        now = asyncio.get_event_loop().time()

        # Refresh scores regardless of market hours — YF returns historical
        # data on weekends and holidays so sentiment stays current even when
        # the market is closed.  Only trading operations need an open market.
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

        # Cancel pending orders when sentiment worsens or entering EOD sell window
        try:
            await _cancel_bearish_pending_orders()
        except Exception as exc:
            logger.warning("PM pending cancel check error: %s", exc)

        # Cancel open IB pending BUYs when price has moved away from limit.
        try:
            await _cancel_ib_pending_orders_price_moved()
        except Exception as exc:
            logger.warning("PM IB pending cancel check error: %s", exc)

        # Enforce end-of-day exits for live IB holdings when overnight is disabled.
        try:
            await _attempt_ib_eod_liquidation()
        except Exception as exc:
            logger.warning("PM IB EOD liquidation error: %s", exc)

        # In IB mode, consume latest engine signals and route execution through PM.
        try:
            await _process_ib_engine_signals()
        except Exception as exc:
            logger.warning("PM IB signal processing error: %s", exc)

        # Transfer on interval
        if now - last_transfer >= _settings["transfer_interval_s"]:
            try:
                await _attempt_ib_profit_take_for_unwatched_owned()
                await _do_transfer()
            except Exception as exc:
                logger.warning("PM transfer error: %s", exc)
                _log_activity(f"Transfer error: {exc}")
            last_transfer = now
