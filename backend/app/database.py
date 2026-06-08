from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import event
from app.config import settings

_IS_SQLITE = settings.DATABASE_URL.startswith("sqlite")
_engine_kwargs = {"echo": False}
if _IS_SQLITE:
    # Give writers more time before SQLite returns "database is locked".
    _engine_kwargs["connect_args"] = {"timeout": 30}

engine = create_async_engine(settings.DATABASE_URL, **_engine_kwargs)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


if _IS_SQLITE:
    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA busy_timeout=30000")
        finally:
            cursor.close()


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def init_db():
    async with engine.begin() as conn:
        from app.models import trade, strategy, report, custom_script, sandbox  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
        # Add columns that may not exist in older databases
        await _migrate(conn)


async def _migrate(conn):
    """Apply lightweight schema migrations for new columns."""
    from sqlalchemy import text
    migrations = [
        # backtest_reports.script_snapshot  (added for custom-script version snapshots)
        "ALTER TABLE backtest_reports ADD COLUMN script_snapshot TEXT",
        # sandbox_positions engine columns (added for automated trading engine)
        "ALTER TABLE sandbox_positions ADD COLUMN strategy_enabled INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sandbox_positions ADD COLUMN last_signal INTEGER",
        "ALTER TABLE sandbox_positions ADD COLUMN last_run_at DATETIME",
        "ALTER TABLE sandbox_positions ADD COLUMN engine_error TEXT",
        # sandbox_account seed row (ensure at least one row exists)
        "INSERT OR IGNORE INTO sandbox_account (id, total_funds) VALUES (1, 0.0)",
        # portfolio_manager_settings seed row
        "INSERT OR IGNORE INTO portfolio_manager_settings (id, enabled, transfer_pct, transfer_interval_s, indicator_interval_s, min_position_funds, deploy_available_funds, deploy_target, deploy_target_symbol) VALUES (1, 0, 0.5, 300, 120, 100.0, 1, 'most_bearish', '')",
        # portfolio_manager_settings reallocation columns (added for reallocation mode feature)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN reallocation_enabled INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN reallocation_mode VARCHAR(20) NOT NULL DEFAULT 'to_stock'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN allow_buy_outside_allocation BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN market_sentiment_strategies TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN symbol_sentiment_strategies TEXT NOT NULL DEFAULT '{}'",
        # portfolio_manager_settings overnight/EOD exit and sentiment history columns
        "ALTER TABLE portfolio_manager_settings ADD COLUMN hold_positions_overnight BOOLEAN NOT NULL DEFAULT 1",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN premarket_order_placement_enabled BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN eod_engine_shutoff_minutes_before_sell INTEGER NOT NULL DEFAULT 120",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN eod_sell_window_minutes INTEGER NOT NULL DEFAULT 30",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sentiment_lookback_days INTEGER NOT NULL DEFAULT 5",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sentiment_data_points INTEGER NOT NULL DEFAULT 35",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sentiment_interval VARCHAR(10) NOT NULL DEFAULT '1m'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sentiment_bucket_persistence INTEGER NOT NULL DEFAULT 3",
        # sandbox_account total_deposited column (added to track cumulative deposits for repair logic)
        "ALTER TABLE sandbox_account ADD COLUMN total_deposited REAL NOT NULL DEFAULT 0.0",
        # sandbox_fund_events table (deposit/withdrawal history)
        """CREATE TABLE IF NOT EXISTS sandbox_fund_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type VARCHAR(20) NOT NULL,
            amount REAL NOT NULL,
            note TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
        )""",
        # backtest_reports.result_data_path (offloaded JSON on local storage)
        "ALTER TABLE backtest_reports ADD COLUMN result_data_path VARCHAR(500)",
        # speed up paginated newest-first report list
        "CREATE INDEX IF NOT EXISTS idx_backtest_reports_created_at ON backtest_reports(created_at DESC)",
        # sandbox_positions pending open-order columns (simulated order fill latency)
        "ALTER TABLE sandbox_positions ADD COLUMN pending_shares REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE sandbox_positions ADD COLUMN pending_avg_cost REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE sandbox_positions ADD COLUMN pending_since DATETIME",
        # sandbox_allocation_events table (fund movement history between positions / pool)
        """CREATE TABLE IF NOT EXISTS sandbox_allocation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type VARCHAR(20) NOT NULL,
            from_symbol VARCHAR(20),
            to_symbol VARCHAR(20),
            amount REAL NOT NULL,
            note TEXT,
            created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
        )""",
        # sandbox_positions.total_invested (cumulative cost of all BUY fills for realized % calc)
        "ALTER TABLE sandbox_positions ADD COLUMN total_invested REAL NOT NULL DEFAULT 0.0",
        # sandbox_positions max allocation cap per symbol
        "ALTER TABLE sandbox_positions ADD COLUMN max_allocation_mode VARCHAR(20) NOT NULL DEFAULT 'dollar'",
        "ALTER TABLE sandbox_positions ADD COLUMN max_allocation_value REAL",
        # portfolio_manager_settings min funds mode (dollar vs percent of total funds)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN min_position_funds_mode VARCHAR(20) NOT NULL DEFAULT 'dollar'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN min_position_funds_pct REAL NOT NULL DEFAULT 1.0",
        # sandbox_positions sentiment-driven strategy mode
        "ALTER TABLE sandbox_positions ADD COLUMN sentiment_mode VARCHAR(20)",
        # portfolio_manager_settings global sentiment strategy toggle
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sentiment_strategy_enabled BOOLEAN NOT NULL DEFAULT 1",
        # portfolio_manager_settings global risk exits (sandbox engine)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN stop_loss_pct REAL NOT NULL DEFAULT 0.8",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN take_profit_pct REAL NOT NULL DEFAULT 2.5",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN stop_loss_sell_market_enabled BOOLEAN NOT NULL DEFAULT 1",
        # portfolio_manager_settings AI tag strategy routing
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_strategy_enabled BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_strategies TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_allow_overnight BOOLEAN NOT NULL DEFAULT 1",
        # portfolio_manager_settings AI tag action mode (strategy_override | direct)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_action_mode VARCHAR(20) NOT NULL DEFAULT 'strategy_override'",
        # sandbox_positions pm_managed flag (PM holds position, skip day-start engine re-enable)
        "ALTER TABLE sandbox_positions ADD COLUMN pm_managed BOOLEAN NOT NULL DEFAULT 0",
        # portfolio_manager_settings AI tag long-hold mode (disable engine after buy for LONG/STRONG LONG)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_long_engine_off BOOLEAN NOT NULL DEFAULT 1",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_long_tp_pct REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_long_sl_pct REAL NOT NULL DEFAULT 0.0",
        # portfolio_manager_settings AI sentiment controls and pending drift handling
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_sentiment_change_enabled BOOLEAN NOT NULL DEFAULT 1",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_no_loss_sell BOOLEAN NOT NULL DEFAULT 1",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pending_price_drift_cancel_pct REAL NOT NULL DEFAULT 0.75",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pending_cancel_after_bars INTEGER NOT NULL DEFAULT 3",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN paper_buy_mkt_after_bars INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pending_sell_tp_near_mode VARCHAR(20) NOT NULL DEFAULT 'percent'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pending_sell_tp_near_pct REAL NOT NULL DEFAULT 0.20",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pending_sell_tp_near_value REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pending_repost_cooldown_seconds INTEGER NOT NULL DEFAULT 60",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sim_buy_fill_rate_pct REAL NOT NULL DEFAULT 80.0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sim_sell_fill_rate_pct REAL NOT NULL DEFAULT 90.0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN auto_trade_buy_price_offset_mode VARCHAR(20) NOT NULL DEFAULT 'percent'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN auto_trade_sell_price_offset_mode VARCHAR(20) NOT NULL DEFAULT 'percent'",
        # portfolio_manager_settings automated IB order price offsets (vs previous OHLC midpoint)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN auto_trade_buy_price_offset_pct REAL NOT NULL DEFAULT 0.01",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN auto_trade_sell_price_offset_pct REAL NOT NULL DEFAULT 0.01",
        # Rename legacy strategy name 'bollinger' → 'bollinger_bands' on any existing positions
        "UPDATE sandbox_positions SET strategy_name = 'bollinger_bands' WHERE strategy_name = 'bollinger'",
        # Keep enough bars so PM RSI/MACD/SMA sentiment scoring is meaningful.
        "UPDATE portfolio_manager_settings SET sentiment_data_points = 35 WHERE sentiment_data_points IS NULL OR sentiment_data_points < 35",
        # portfolio_manager_settings cached scores (persist between restarts for instant UI display)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN cached_scores TEXT NOT NULL DEFAULT '{}'",
        # portfolio_manager_settings AI external sentiment blend weight (0..1)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_external_sentiment_weight REAL NOT NULL DEFAULT 0.0",
        # 5×5 strategy + action matrices for PM-sentiment × AI-tag routing
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sentiment_matrix_strategies TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN sentiment_matrix_actions TEXT NOT NULL DEFAULT '{}'",
        # Buy & Hold duration cap (days) for matrix `hold` action (day-trade default = 1)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pm_hold_duration_days INTEGER NOT NULL DEFAULT 1",
        # Advanced Hold tuning: extended-duration multiplier and trailing-stop %
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pm_hold_extended_multiplier REAL NOT NULL DEFAULT 2.0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pm_hold_trailing_pct REAL NOT NULL DEFAULT 3.0",
        # PM global numeric TP/SL ($ from average entry)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN stop_loss_value REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN take_profit_value REAL NOT NULL DEFAULT 0.0",
        # PM crash protection kill switch (liquidate and pause engines for current day)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN crash_protection_enabled BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN crash_protection_mode VARCHAR(20) NOT NULL DEFAULT 'percent'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN crash_protection_value REAL NOT NULL DEFAULT 0.0",
        # PM long-hold numeric TP/SL ($ from average entry)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_long_tp_value REAL NOT NULL DEFAULT 0.0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN ai_tag_long_sl_value REAL NOT NULL DEFAULT 0.0",
        # PM default strategy + template params + per-symbol overrides
        "ALTER TABLE portfolio_manager_settings ADD COLUMN default_strategy_name VARCHAR(120) NOT NULL DEFAULT 'template:intraday_1m_regime_template.py'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN intraday_1m_template_params TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN position_overrides TEXT NOT NULL DEFAULT '{}'",
        # Buy & Hold duration cap in bars (0 = no limit)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN pm_hold_duration_bars INTEGER NOT NULL DEFAULT 20",
        # Track when PM buy-and-hold position entered
        "ALTER TABLE sandbox_positions ADD COLUMN pm_hold_started_at TIMESTAMP",
        # Track peak price since PM hold entry (for trailing-stop advanced hold)
        "ALTER TABLE sandbox_positions ADD COLUMN pm_hold_peak_price REAL",
        # Bar predictor gating for PM buy/sell signals
        "ALTER TABLE portfolio_manager_settings ADD COLUMN bar_predictor_enabled BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN bar_predictor_buy_min_bias REAL NOT NULL DEFAULT 0.3",
        "ALTER TABLE portfolio_manager_settings ADD COLUMN bar_predictor_sell_min_bias REAL NOT NULL DEFAULT 0.3",
        # PM crash protection: auto-restart engines next trading day after crash shutdown (default off)
        "ALTER TABLE portfolio_manager_settings ADD COLUMN crash_auto_restart BOOLEAN NOT NULL DEFAULT 0",
    ]
    for stmt in migrations:
        try:
            await conn.execute(text(stmt))
        except Exception:
            pass

    # Backfill total_deposited for existing accounts that have funds but no tracked deposits.
    # Best-effort: assume current total_funds is what was deposited (minus realized pnl drift).
    # We do this only when total_deposited is still 0 but total_funds > 0.
    try:
        from app.models.sandbox import SandboxAccount, SandboxPosition
        from sqlalchemy import select as sa_select
        acct_res = await conn.execute(text("SELECT id, total_funds, total_deposited FROM sandbox_account WHERE id=1"))
        row = acct_res.fetchone()
        if row and row[2] == 0.0 and row[1] > 0.0:
            pos_res = await conn.execute(text("SELECT COALESCE(SUM(realized_pnl),0) FROM sandbox_positions"))
            total_realized = pos_res.fetchone()[0] or 0.0
            # Best-guess deposit = current total_funds - realized_pnl
            seeded = max(0.0, round(row[1] - total_realized, 4))
            await conn.execute(text(f"UPDATE sandbox_account SET total_deposited={seeded} WHERE id=1"))
    except Exception:
        pass
