from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import asyncio
import logging
import os

from app.config import settings
from app.database import init_db
from app.routers import trading, backtest, market_data, ws, scripts
from app.services import market_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DASHBOARD_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "SPY"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initialising database …")
    await init_db()
    logger.info("Database ready.")
    asyncio.create_task(market_service.pre_warm(DASHBOARD_SYMBOLS, periods=["1y"]))
    yield
    logger.info("Application shutdown.")


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
