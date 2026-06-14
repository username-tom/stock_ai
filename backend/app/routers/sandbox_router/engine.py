"""Engine toggle and IB mode endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Any, Optional

from app.database import get_db
from app.models.sandbox import SandboxPosition
from app.routers.sandbox_router._helpers import position_dict, ensure_sandbox_write_allowed, offload_simulated_state

router = APIRouter()


def _should_force_engine_off_for_position(pos: SandboxPosition) -> bool:
    from app.services.portfolio_manager import get_manager_settings
    from app.services.sandbox_engine import should_force_engine_off_without_position

    manager_settings = get_manager_settings()
    return should_force_engine_off_without_position(
        shares=pos.shares,
        pending_shares=pos.pending_shares,
        hold_overnight=bool(manager_settings.get("hold_positions_overnight", True)),
        eod_sell_window_minutes=int(manager_settings.get("eod_sell_window_minutes", 30) or 30),
        eod_engine_shutoff_minutes_before_sell=int(
            manager_settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120
        ),
    )


@router.get("/engine/state")
async def engine_state():
    from app.services.sandbox_engine import get_engine_state
    return get_engine_state()


@router.post("/engine/toggle-all")
async def engine_toggle_all(db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed(allow_while_ib=True)
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.strategy_name.isnot(None)))
    positions = result.scalars().all()
    if not positions:
        raise HTTPException(400, "No positions with a strategy assigned.")
    any_stopped = any(not p.strategy_enabled for p in positions)
    for pos in positions:
        pos.strategy_enabled = any_stopped
        if pos.strategy_enabled and _should_force_engine_off_for_position(pos):
            pos.strategy_enabled = False
    await db.commit()
    await offload_simulated_state(db)
    return {
        "enabled": any(p.strategy_enabled for p in positions),
        "count": len(positions),
    }


@router.post("/engine/toggle/{symbol}")
async def engine_toggle(symbol: str, db: AsyncSession = Depends(get_db)):
    ensure_sandbox_write_allowed(allow_while_ib=True)
    symbol = symbol.upper()
    result = await db.execute(select(SandboxPosition).where(SandboxPosition.symbol == symbol))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(404, f"Position {symbol} not found.")
    if not pos.strategy_name:
        raise HTTPException(400, "Assign a strategy before enabling the engine.")
    pos.strategy_enabled = not pos.strategy_enabled
    if pos.strategy_enabled and _should_force_engine_off_for_position(pos):
        pos.strategy_enabled = False
    await db.commit()
    await db.refresh(pos)
    await offload_simulated_state(db)
    return position_dict(pos)


class IBModeRequest(BaseModel):
    mode: str = Field(..., pattern="^(paper|live)$")


@router.post("/ib-mode")
async def set_ib_mode(req: IBModeRequest):
    from app.config import settings
    settings.TRADING_MODE = req.mode
    return {"mode": settings.TRADING_MODE}


@router.get("/ib-mode")
async def get_ib_mode():
    from app.config import settings
    return {"mode": settings.TRADING_MODE}


class PortfolioManagerSettingsRequest(BaseModel):
    enabled: Optional[bool] = None
    transfer_pct: Optional[float] = Field(default=None, ge=0.01, le=1.0)
    transfer_interval_s: Optional[int] = Field(default=None, ge=30)
    indicator_interval_s: Optional[int] = Field(default=None, ge=30)
    min_position_funds: Optional[float] = Field(default=None, ge=0)
    min_position_funds_mode: Optional[str] = Field(default=None, pattern="^(dollar|percent)$")
    min_position_funds_pct: Optional[float] = Field(default=None, ge=0, le=100)
    deploy_available_funds: Optional[bool] = None
    deploy_target: Optional[str] = Field(default=None, pattern="^(most_bearish|most_bullish|most_held|least_held|specific)$")
    deploy_target_symbol: Optional[str] = None
    reallocation_enabled: Optional[bool] = None
    reallocation_mode: Optional[str] = Field(default=None, pattern="^(to_stock|to_available)$")
    allow_buy_outside_allocation: Optional[bool] = None
    market_sentiment_strategies: Optional[dict[str, str]] = None
    symbol_sentiment_strategies: Optional[dict[str, str]] = None
    sentiment_strategy_enabled: Optional[bool] = None
    stop_loss_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    take_profit_pct: Optional[float] = Field(default=None, ge=0.0, le=1000.0)
    stop_loss_sell_market_enabled: Optional[bool] = None
    stop_loss_value: Optional[float] = Field(default=None, ge=0.0, le=10000.0)
    take_profit_value: Optional[float] = Field(default=None, ge=0.0, le=10000.0)
    crash_protection_enabled: Optional[bool] = None
    crash_protection_mode: Optional[str] = Field(default=None, pattern="^(percent|dollar)$")
    crash_protection_value: Optional[float] = Field(default=None, ge=0.0, le=1000000.0)
    crash_auto_restart: Optional[bool] = None
    hold_positions_overnight: Optional[bool] = None
    premarket_order_placement_enabled: Optional[bool] = None
    eod_engine_shutoff_minutes_before_sell: Optional[int] = Field(default=None, ge=0, le=480)
    eod_sell_window_minutes: Optional[int] = Field(default=None, ge=1, le=240)
    sentiment_lookback_days: Optional[int] = Field(default=None, ge=1, le=30)
    sentiment_data_points: Optional[int] = Field(default=None, ge=35, le=5000)
    sentiment_interval: Optional[str] = None
    sentiment_bucket_persistence: Optional[int] = Field(default=None, ge=1, le=20)
    ai_tag_strategy_enabled: Optional[bool] = None
    ai_sentiment_change_enabled: Optional[bool] = None
    ai_tag_strategies: Optional[dict[str, str]] = None
    ai_tag_allow_overnight: Optional[bool] = None
    ai_tag_action_mode: Optional[str] = Field(default=None, pattern="^(strategy_override|direct)$")
    ai_external_sentiment_weight: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    ai_tag_long_engine_off: Optional[bool] = None
    ai_tag_long_tp_pct: Optional[float] = Field(default=None, ge=0.0, le=1000.0)
    ai_tag_long_sl_pct: Optional[float] = Field(default=None, ge=0.0, le=1000.0)
    ai_tag_long_tp_value: Optional[float] = Field(default=None, ge=0.0, le=10000.0)
    ai_tag_long_sl_value: Optional[float] = Field(default=None, ge=0.0, le=10000.0)
    ai_tag_no_loss_sell: Optional[bool] = None
    pending_price_drift_cancel_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    pending_cancel_after_bars: Optional[int] = Field(default=None, ge=0, le=120)
    paper_buy_mkt_after_bars: Optional[int] = Field(default=None, ge=0, le=120)
    pending_sell_tp_near_mode: Optional[str] = Field(default=None, pattern="^(percent|dollar)$")
    pending_sell_tp_near_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    pending_sell_tp_near_value: Optional[float] = Field(default=None, ge=0.0, le=10000.0)
    pending_repost_cooldown_seconds: Optional[int] = Field(default=None, ge=0, le=3600)
    sim_buy_fill_rate_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    sim_sell_fill_rate_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    auto_trade_buy_price_offset_mode: Optional[str] = Field(default=None, pattern="^(percent|dollar)$")
    auto_trade_sell_price_offset_mode: Optional[str] = Field(default=None, pattern="^(percent|dollar)$")
    auto_trade_buy_price_offset_pct: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    auto_trade_sell_price_offset_pct: Optional[float] = Field(default=None, ge=0.0, le=10.0)
    default_strategy_name: Optional[str] = None
    pm_hold_extended_multiplier: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    pm_hold_trailing_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)
    pm_hold_duration_bars: Optional[int] = Field(default=None, ge=0, le=50000)
    intraday_1m_template_params: Optional[dict[str, Any]] = None
    sentiment_matrix_strategies: Optional[dict[str, dict[str, str]]] = None
    sentiment_matrix_actions: Optional[dict[str, dict[str, str]]] = None
    bar_predictor_enabled: Optional[bool] = None
    bar_predictor_buy_min_bias: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    bar_predictor_sell_min_bias: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    position_overrides: Optional[dict[str, dict[str, Any]]] = None
    # AI trade bot (locally-run Ollama model)
    ai_bot_enabled: Optional[bool] = None
    ai_bot_prompt: Optional[str] = Field(default=None, max_length=8000)
    ai_bot_model: Optional[str] = Field(default=None, max_length=120)
    ai_bot_interval_s: Optional[int] = Field(default=None, ge=30, le=86400)
    ai_bot_use_local_1m: Optional[bool] = None
    ai_bot_use_news: Optional[bool] = None
    ai_bot_max_context_bars: Optional[int] = Field(default=None, ge=10, le=500)


@router.get("/manager/state")
async def get_manager_state():
    from app.services.portfolio_manager import get_manager_state
    return get_manager_state()


@router.get("/manager/ai-bot/models")
async def get_ai_bot_models():
    """List locally-installed Ollama models available to the AI trade bot."""
    from app.services.ai_bot import list_installed_models, get_state
    return {"models": await list_installed_models(), "state": get_state()}


@router.get("/manager/activity-log")
async def get_manager_activity_log(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=500),
    day: str | None = Query(default=None),
):
    from app.services.local_storage import read_portfolio_activity_entries

    return read_portfolio_activity_entries(
        page=page,
        page_size=page_size,
        day=day,
        source="portfolio_manager",
    )


@router.patch("/manager/settings")
async def update_manager_settings(req: PortfolioManagerSettingsRequest):
    ensure_sandbox_write_allowed(allow_while_ib=True)
    from app.services.portfolio_manager import update_manager_settings
    payload = {k: v for k, v in req.model_dump().items() if v is not None}
    return update_manager_settings(payload)


@router.post("/manager/toggle")
async def toggle_manager():
    ensure_sandbox_write_allowed(allow_while_ib=True)
    from app.services.portfolio_manager import get_manager_settings, update_manager_settings
    current = get_manager_settings()
    return update_manager_settings({"enabled": not current["enabled"]})


@router.post("/manager/reset-crash")
async def reset_crash_shutdown():
    """Manually clear a crash-triggered shutdown to re-enable PM operations."""
    ensure_sandbox_write_allowed(allow_while_ib=True)
    from app.services.portfolio_manager import _state
    _state["crash_triggered_day"] = None
    _state["crash_triggered_at"] = None
    _state["crash_trigger_reason"] = None
    _state["crash_last_triggered_day"] = None
    _state["crash_shutdown_active"] = False
    return {"ok": True, "message": "Crash shutdown cleared — PM operations will resume on next tick"}
