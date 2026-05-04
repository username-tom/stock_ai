from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.config import settings

engine = create_async_engine(settings.DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


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
    ]
    for stmt in migrations:
        try:
            await conn.execute(text(stmt))
        except Exception:
            pass
