from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import logging
import os

from app.config import settings
from app.database import init_db
from app.routers import trading, backtest, market_data, ws

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initialising database …")
    await init_db()
    logger.info("Database ready.")
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
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trading.router)
app.include_router(backtest.router)
app.include_router(market_data.router)
app.include_router(ws.router)

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
