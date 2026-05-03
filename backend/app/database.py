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
        from app.models import trade, strategy, report, custom_script  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
        # Add columns that may not exist in older databases
        await _migrate(conn)


async def _migrate(conn):
    """Apply lightweight schema migrations for new columns."""
    from sqlalchemy import text
    migrations = [
        # backtest_reports.script_snapshot  (added for custom-script version snapshots)
        "ALTER TABLE backtest_reports ADD COLUMN script_snapshot TEXT",
    ]
    for stmt in migrations:
        try:
            await conn.execute(text(stmt))
        except Exception:
            # Column already exists – ignore
            pass
