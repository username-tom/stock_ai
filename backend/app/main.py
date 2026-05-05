from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import asyncio
import logging
import os

from app.config import settings
from app.database import init_db
from app.routers import trading, backtest, market_data, ws, scripts, settings as settings_router
from app.routers.ollama_chat import router as ollama_chat_router
from app.routers.sandbox_router import router as sandbox_router
from app.services import market_service, symbol_registry
from app.services.sandbox_engine import run_engine
from app.services.portfolio_manager import run_portfolio_manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DASHBOARD_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "SPY"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initialising database …")
    await init_db()
    logger.info("Database ready.")
    market_service._cache.load_from_disk()
    logger.info("Market disk cache loaded.")
    asyncio.create_task(market_service.pre_warm(DASHBOARD_SYMBOLS, periods=["1d", "1y"]))
    asyncio.create_task(symbol_registry.ensure_registry())
    asyncio.create_task(_daily_registry_refresh())
    asyncio.create_task(run_engine())
    asyncio.create_task(run_portfolio_manager())
    yield
    logger.info("Application shutdown.")


async def _daily_registry_refresh():
    """Re-download the symbol registry every 24 h while the server is running."""
    while True:
        await asyncio.sleep(86_400)
        logger.info("Daily symbol registry refresh …")
        await symbol_registry.ensure_registry(force=True)


app = FastAPI(
    title="Stock AI – Automated Trading Platform",
    description=(
        "Backtesting, report generation, simulated and live trading "
        "with Interactive Brokers integration."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trading.router)
app.include_router(backtest.router)
app.include_router(market_data.router)
app.include_router(ws.router)
app.include_router(scripts.router)
app.include_router(ollama_chat_router)
app.include_router(sandbox_router)
app.include_router(settings_router.router)

# Serve HTML reports as static files
os.makedirs(settings.REPORTS_DIR, exist_ok=True)
app.mount(
    "/reports",
    StaticFiles(directory=settings.REPORTS_DIR),
    name="reports",
)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}
