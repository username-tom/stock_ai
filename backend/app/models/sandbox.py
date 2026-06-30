"""Sandbox portfolio models – simulated paper trading environment."""
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, text
from sqlalchemy.sql import func
from app.database import Base


class SandboxAccount(Base):
    __tablename__ = "sandbox_account"

    id = Column(Integer, primary_key=True, index=True)
    total_funds = Column(Float, default=0.0, nullable=False)
    total_deposited = Column(Float, default=0.0, nullable=False)  # cumulative add-funds deposits
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())


class SandboxPosition(Base):
    """One row per symbol tracked in the sandbox (watchlist or held)."""
    __tablename__ = "sandbox_positions"

    id = Column(Integer, primary_key=True, index=True)
    symbol = Column(String(20), nullable=False, unique=True, index=True)
    allocated_funds = Column(Float, default=0.0)   # cash assigned to this symbol
    shares = Column(Float, default=0.0)            # current shares held
    avg_cost = Column(Float, default=0.0)          # average cost basis per share
    pending_shares = Column(Float, default=0.0)         # shares awaiting settlement (open order)
    pending_avg_cost = Column(Float, default=0.0)       # avg cost of the pending shares
    pending_since = Column(DateTime(timezone=True), nullable=True)  # UTC time the pending order was placed
    strategy_name = Column(String(100), nullable=True)
    # Automated engine columns
    strategy_enabled = Column(Boolean, default=False, nullable=False)  # engine active
    pm_managed = Column(Boolean, default=False, nullable=False)        # PM holds this position; engine must stay off
    pm_hold_started_at = Column(DateTime(timezone=True), nullable=True)  # when PM buy-and-hold entered
    pm_hold_peak_price = Column(Float, nullable=True)                    # highest price seen since PM hold entry (trailing stop)
    last_signal = Column(Integer, nullable=True)      # +1 buy / -1 sell / 0 hold
    last_run_at = Column(DateTime(timezone=True), nullable=True)
    engine_error = Column(Text, nullable=True)
    realized_pnl = Column(Float, default=0.0)
    total_invested = Column(Float, default=0.0)    # cumulative cost of all BUY fills
    max_allocation_mode = Column(String(20), default="dollar", nullable=False)
    max_allocation_value = Column(Float, nullable=True)
    sentiment_mode = Column(String(20), nullable=True)  # None | 'market' | 'symbol'
    is_on_watchlist = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())


class SandboxFundEvent(Base):
    """Deposit and withdrawal events for the sandbox account."""
    __tablename__ = "sandbox_fund_events"

    id = Column(Integer, primary_key=True, index=True)
    event_type = Column(String(20), nullable=False)  # 'deposit' | 'withdrawal'
    amount = Column(Float, nullable=False)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SandboxTrade(Base):
    """Individual trade records in the sandbox."""
    __tablename__ = "sandbox_trades"

    id = Column(Integer, primary_key=True, index=True)
    symbol = Column(String(20), nullable=False, index=True)
    side = Column(String(10), nullable=False)   # BUY | SELL
    quantity = Column(Float, nullable=False)
    price = Column(Float, nullable=False)
    total = Column(Float, nullable=False)        # quantity * price
    strategy_name = Column(String(100), nullable=True)
    reason = Column(Text, nullable=True)         # human-readable buy/sell reason
    pnl = Column(Float, nullable=True)           # realised PnL for SELL trades
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SandboxAllocationEvent(Base):
    """Records every time funds are moved between positions or the account pool.

    event_type values:
      'allocate'     – funds moved from account pool → position (add/update allocation)
      'deallocate'   – funds moved from position → account pool
      'reallocate'   – funds moved between positions (portfolio manager rebalance)
      'deploy'       – unallocated account cash deployed to a position by PM
    """
    __tablename__ = "sandbox_allocation_events"

    id = Column(Integer, primary_key=True, index=True)
    event_type = Column(String(20), nullable=False)
    from_symbol = Column(String(20), nullable=True)   # None = account pool
    to_symbol = Column(String(20), nullable=True)     # None = account pool
    amount = Column(Float, nullable=False)
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PortfolioManagerSettings(Base):
    """Persisted portfolio manager configuration (single row, id=1)."""
    __tablename__ = "portfolio_manager_settings"

    id = Column(Integer, primary_key=True, index=True)
    enabled = Column(Boolean, default=False, nullable=False)
    transfer_pct = Column(Float, default=0.50, nullable=False)
    transfer_interval_s = Column(Integer, default=300, nullable=False)
    indicator_interval_s = Column(Integer, default=120, nullable=False)
    min_position_funds = Column(Float, default=100.0, nullable=False)
    min_position_funds_mode = Column(String(20), default="dollar", nullable=False)
    min_position_funds_pct = Column(Float, default=1.0, nullable=False)
    deploy_available_funds = Column(Boolean, default=True, nullable=False)
    deploy_target = Column(String(20), default="most_bearish", nullable=False)
    deploy_target_symbol = Column(String(20), default="", nullable=False)
    reallocation_enabled = Column(Boolean, default=True, nullable=False)
    reallocation_mode = Column(String(20), default="to_stock", nullable=False)
    allow_buy_outside_allocation = Column(Boolean, default=False, nullable=False)
    market_sentiment_strategies = Column(Text, nullable=False, server_default=text("'{}'"))
    symbol_sentiment_strategies = Column(Text, nullable=False, server_default=text("'{}'"))
    sentiment_strategy_enabled = Column(Boolean, default=True, nullable=False)
    stop_loss_pct = Column(Float, default=0.8, nullable=False)
    take_profit_pct = Column(Float, default=2.5, nullable=False)
    stop_loss_sell_market_enabled = Column(Boolean, default=True, nullable=False)
    stop_loss_value = Column(Float, default=0.0, nullable=False)
    take_profit_value = Column(Float, default=0.0, nullable=False)
    crash_protection_enabled = Column(Boolean, default=False, nullable=False)
    crash_protection_mode = Column(String(20), default="percent", nullable=False)
    crash_protection_value = Column(Float, default=0.0, nullable=False)
    crash_auto_restart = Column(Boolean, default=False, nullable=False)
    hold_positions_overnight = Column(Boolean, default=True, nullable=False)
    premarket_order_placement_enabled = Column(Boolean, default=False, nullable=False)
    eod_engine_shutoff_minutes_before_sell = Column(Integer, default=120, nullable=False)
    eod_sell_window_minutes = Column(Integer, default=30, nullable=False)
    sentiment_lookback_days = Column(Integer, default=5, nullable=False)
    sentiment_data_points = Column(Integer, default=35, nullable=False)
    sentiment_interval = Column(String(10), default="1m", nullable=False)
    sentiment_bucket_persistence = Column(Integer, default=3, nullable=False)
    # AI tag (learner) strategy routing
    ai_tag_strategy_enabled = Column(Boolean, default=False, nullable=False)
    ai_sentiment_change_enabled = Column(Boolean, default=True, nullable=False)
    # Weight (0..1) blending external news/social sentiment into AI learner score.
    # 0 = pure learner output (default), 1 = ignore learner and follow external feed.
    ai_external_sentiment_weight = Column(Float, default=0.0, nullable=False)
    ai_tag_strategies = Column(Text, nullable=False, server_default=text("'{}'"))
    ai_tag_allow_overnight = Column(Boolean, default=True, nullable=False)
    ai_tag_action_mode = Column(String(20), default="strategy_override", nullable=False)
    # AI tag long-hold mode: disable engine after buy, re-enable on TP/SL or tag change
    ai_tag_long_engine_off = Column(Boolean, default=True, nullable=False)
    ai_tag_long_tp_pct = Column(Float, default=0.0, nullable=False)
    ai_tag_long_sl_pct = Column(Float, default=0.0, nullable=False)
    ai_tag_long_tp_value = Column(Float, default=0.0, nullable=False)
    ai_tag_long_sl_value = Column(Float, default=0.0, nullable=False)
    ai_tag_no_loss_sell = Column(Boolean, default=True, nullable=False)
    ai_no_loss_full_alloc_only = Column(Boolean, default=True, nullable=False)
    ai_no_loss_emergency_cap_pct = Column(Float, default=10.0, nullable=False)
    ai_fill_near_sl_enabled = Column(Boolean, default=False, nullable=False)
    ai_fill_near_sl_distance_pct = Column(Float, default=0.25, nullable=False)
    ai_fill_near_sl_size_pct = Column(Float, default=50.0, nullable=False)
    ai_sl_tp_decay_enabled = Column(Boolean, default=False, nullable=False)
    ai_sl_tp_decay_bars = Column(Integer, default=120, nullable=False)
    ai_sl_decay_total_pct = Column(Float, default=50.0, nullable=False)
    ai_tp_decay_total_pct = Column(Float, default=80.0, nullable=False)
    pending_price_drift_cancel_pct = Column(Float, default=0.75, nullable=False)
    pending_cancel_after_bars = Column(Integer, default=3, nullable=False)
    paper_buy_mkt_after_bars = Column(Integer, default=0, nullable=False)
    pending_sell_tp_near_mode = Column(String(20), default="percent", nullable=False)
    pending_sell_tp_near_pct = Column(Float, default=0.20, nullable=False)
    pending_sell_tp_near_value = Column(Float, default=0.0, nullable=False)
    pending_repost_cooldown_seconds = Column(Integer, default=60, nullable=False)
    sim_buy_fill_rate_pct = Column(Float, default=80.0, nullable=False)
    sim_sell_fill_rate_pct = Column(Float, default=90.0, nullable=False)
    auto_trade_buy_price_offset_mode = Column(String(20), default="percent", nullable=False)
    auto_trade_sell_price_offset_mode = Column(String(20), default="percent", nullable=False)
    auto_trade_buy_price_offset_pct = Column(Float, default=0.01, nullable=False)
    auto_trade_sell_price_offset_pct = Column(Float, default=0.01, nullable=False)
    # 5×5 sentiment × AI-tag matrix (JSON)
    sentiment_matrix_strategies = Column(Text, nullable=False, server_default=text("'{}'"  ))
    sentiment_matrix_actions = Column(Text, nullable=False, server_default=text("'{}'"))
    default_strategy_name = Column(String(120), default="template:intraday_1m_regime_template.py", nullable=False)
    intraday_1m_template_params = Column(Text, nullable=False, server_default=text("'{}'"))
    position_overrides = Column(Text, nullable=False, server_default=text("'{}'"))
    # Buy & Hold (matrix `hold` action) max duration in days; 0 = no limit. Day-trade default.
    pm_hold_duration_days = Column(Integer, default=1, nullable=False)
    # Buy & Hold max duration in bars; supersedes day-based cap when >0.
    pm_hold_duration_bars = Column(Integer, default=20, nullable=False)
    # Advanced Hold multiplier applied to duration when cell action is `advanced_hold:extended`
    pm_hold_extended_multiplier = Column(Float, default=2.0, nullable=False)
    # Trailing stop % used for `advanced_hold:trailing` (exit when price drops this % from peak)
    pm_hold_trailing_pct = Column(Float, default=3.0, nullable=False)
    cached_scores = Column(Text, nullable=False, server_default=text("'{}'"))
    # Bar predictor gating for PM buy/sell decisions
    bar_predictor_enabled = Column(Boolean, default=False, nullable=False)
    bar_predictor_buy_min_bias = Column(Float, default=0.3, nullable=False)
    bar_predictor_sell_min_bias = Column(Float, default=0.3, nullable=False)
    # ── AI trade bot (locally-run Ollama model) ──────────────────────────── #
    # When enabled, the AI bot drives trade decisions instead of the sentiment
    # matrix engine. The same risk settings above (SL/TP, crash protection,
    # EOD liquidation via hold_positions_overnight) are still hard-enforced.
    ai_bot_enabled = Column(Boolean, default=False, nullable=False)
    ai_bot_prompt = Column(Text, nullable=False, server_default=text("'Help me make money using the positions in watchlist.'"))
    ai_bot_provider = Column(String(20), nullable=False, server_default=text("'ollama'"))
    ai_bot_base_url = Column(String(255), nullable=False, server_default=text("''"))
    ai_bot_model = Column(String(120), nullable=False, server_default=text("''"))
    ai_bot_interval_s = Column(Integer, default=300, nullable=False)
    ai_bot_use_local_1m = Column(Boolean, default=True, nullable=False)
    ai_bot_use_news = Column(Boolean, default=True, nullable=False)
    ai_bot_max_context_bars = Column(Integer, default=60, nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
