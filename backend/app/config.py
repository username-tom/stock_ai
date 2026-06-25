from pydantic_settings import BaseSettings
from typing import List
import os
import json

_DEFAULT_CORS = "http://localhost:5173,http://localhost:3000"


class Settings(BaseSettings):
    IB_HOST: str = "127.0.0.1"
    IB_PORT: int = 4002
    IB_CLIENT_ID: int = 1
    # 1=real-time, 2=frozen, 3=delayed, 4=delayed-frozen
    IB_MARKET_DATA_TYPE: int = 3
    DATABASE_URL: str = "sqlite+aiosqlite:///./stock_ai.db"
    CORS_ORIGINS: str = _DEFAULT_CORS
    TRADING_MODE: str = "paper"
    REPORTS_DIR: str = "reports_output"
    LOCAL_STORAGE_DIR: str = "local_storage"
    AUTO_UPDATE: bool = False
    DATA_MANAGER_AUTO_WARM_ENABLED: bool = True
    DATA_MANAGER_AUTO_WARM_INTERVAL_MIN: int = 15
    DATA_MANAGER_AUTO_WARM_LOOKBACK_DAYS: int = 35
    DATA_MANAGER_AUTO_WARM_SOURCE: str = "auto"
    DATA_MANAGER_AUTO_WARM_PREFER_IB: bool = True
    DATA_MANAGER_AUTO_WARM_CHUNK_DAYS: int = 20
    # Local LLM endpoints used by the AI trade bot and script chat.
    OLLAMA_HOST: str = "http://localhost:11434"
    LM_STUDIO_BASE_URL: str = "http://localhost:1234/v1"

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
