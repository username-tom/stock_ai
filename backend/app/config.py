from pydantic_settings import BaseSettings
from typing import List
import os


class Settings(BaseSettings):
    IB_HOST: str = "127.0.0.1"
    IB_PORT: int = 7497
    IB_CLIENT_ID: int = 1
    DATABASE_URL: str = "sqlite+aiosqlite:///./stock_ai.db"
    CORS_ORIGINS: List[str] = ["http://localhost:5173", "http://localhost:3000"]
    TRADING_MODE: str = "paper"
    REPORTS_DIR: str = "reports_output"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

os.makedirs(settings.REPORTS_DIR, exist_ok=True)
