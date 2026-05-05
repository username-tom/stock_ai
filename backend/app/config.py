from pydantic_settings import BaseSettings
from typing import List
import os
import json

_DEFAULT_CORS = "http://localhost:5173,http://localhost:3000"


class Settings(BaseSettings):
    IB_HOST: str = "127.0.0.1"
    IB_PORT: int = 7497
    IB_CLIENT_ID: int = 1
    DATABASE_URL: str = "sqlite+aiosqlite:///./stock_ai.db"
    CORS_ORIGINS: str = _DEFAULT_CORS
    TRADING_MODE: str = "paper"
    REPORTS_DIR: str = "reports_output"
    LOCAL_STORAGE_DIR: str = "local_storage"

    @property
    def cors_origins_list(self) -> List[str]:
        raw = (self.CORS_ORIGINS or _DEFAULT_CORS).strip()
        if raw.startswith("["):
            try:
                return [o.strip() for o in json.loads(raw) if o.strip()]
            except json.JSONDecodeError:
                pass
        return [o.strip() for o in raw.split(",") if o.strip()]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

os.makedirs(settings.REPORTS_DIR, exist_ok=True)
os.makedirs(settings.LOCAL_STORAGE_DIR, exist_ok=True)
os.makedirs(os.path.join(settings.LOCAL_STORAGE_DIR, "backtest_reports"), exist_ok=True)
os.makedirs(os.path.join(settings.LOCAL_STORAGE_DIR, "trade_logs"), exist_ok=True)
os.makedirs(os.path.join(settings.LOCAL_STORAGE_DIR, "portfolio_activities"), exist_ok=True)
os.makedirs(os.path.join(settings.LOCAL_STORAGE_DIR, "custom_scripts"), exist_ok=True)
