"""Settings endpoints – read and write .env configuration at runtime."""
from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

ENV_PATH = Path(__file__).resolve().parents[2] / ".env"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_env() -> dict[str, str]:
    """Parse the .env file into a plain dict."""
    result: dict[str, str] = {}
    if not ENV_PATH.exists():
        return result
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, val = line.partition("=")
            result[key.strip()] = val.strip()
    return result


def _write_env(data: dict[str, str]) -> None:
    """Rewrite the .env file, preserving comments and order of existing keys,
    then appending any new keys at the end."""
    lines: list[str] = []
    written: set[str] = set()

    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("#") or not stripped:
                lines.append(line)
                continue
            if "=" in stripped:
                key = stripped.partition("=")[0].strip()
                if key in data:
                    lines.append(f"{key}={data[key]}")
                    written.add(key)
                    continue
            lines.append(line)

    # Append keys that didn't exist yet
    for key, val in data.items():
        if key not in written:
            lines.append(f"{key}={val}")

    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class SettingsPayload(BaseModel):
    IB_HOST: str | None = None
    IB_PORT: int | None = None
    IB_CLIENT_ID: int | None = None
    TRADING_MODE: str | None = None
    DATABASE_URL: str | None = None
    CORS_ORIGINS: str | None = None
    REPORTS_DIR: str | None = None
    LOCAL_STORAGE_DIR: str | None = None


# Keys that require a backend restart to take effect
RESTART_REQUIRED_KEYS = {
    "DATABASE_URL",
    "CORS_ORIGINS",
    "LOCAL_STORAGE_DIR",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def get_settings():
    """Return current configuration values grouped by category."""
    env = _read_env()

    def v(key: str, default: str = "") -> str:
        return env.get(key, default)

    return {
        "ib_connection": {
            "IB_HOST":      v("IB_HOST",      settings.IB_HOST),
            "IB_PORT":      v("IB_PORT",      str(settings.IB_PORT)),
            "IB_CLIENT_ID": v("IB_CLIENT_ID", str(settings.IB_CLIENT_ID)),
        },
        "trading": {
            "TRADING_MODE": v("TRADING_MODE", settings.TRADING_MODE),
        },
        "storage": {
            "DATABASE_URL":       v("DATABASE_URL",       settings.DATABASE_URL),
            "REPORTS_DIR":        v("REPORTS_DIR",        settings.REPORTS_DIR),
            "LOCAL_STORAGE_DIR":  v("LOCAL_STORAGE_DIR",  settings.LOCAL_STORAGE_DIR),
        },
        "network": {
            "CORS_ORIGINS": v("CORS_ORIGINS", settings.CORS_ORIGINS),
        },
        "restart_required_keys": list(RESTART_REQUIRED_KEYS),
    }


@router.patch("")
async def update_settings(payload: SettingsPayload):
    """Persist changed settings to .env and apply safe ones in-process.
    Returns which keys require a restart."""
    updates = {k: str(v) for k, v in payload.model_dump().items() if v is not None}

    if not updates:
        raise HTTPException(status_code=400, detail="No settings provided.")

    # Validate known enums
    if "TRADING_MODE" in updates and updates["TRADING_MODE"] not in ("paper", "live"):
        raise HTTPException(status_code=422, detail="TRADING_MODE must be 'paper' or 'live'.")
    if "IB_PORT" in updates:
        try:
            port = int(updates["IB_PORT"])
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            raise HTTPException(status_code=422, detail="IB_PORT must be an integer 1–65535.")
    if "IB_CLIENT_ID" in updates:
        try:
            int(updates["IB_CLIENT_ID"])
        except ValueError:
            raise HTTPException(status_code=422, detail="IB_CLIENT_ID must be an integer.")

    # Write to .env
    _write_env(updates)

    # Apply live-safe settings immediately (no restart needed)
    for key, val in updates.items():
        if key not in RESTART_REQUIRED_KEYS:
            if hasattr(settings, key):
                field_type = type(getattr(settings, key))
                try:
                    setattr(settings, key, field_type(val))
                except Exception:
                    setattr(settings, key, val)

    needs_restart = [k for k in updates if k in RESTART_REQUIRED_KEYS]
    return {
        "saved": list(updates.keys()),
        "restart_required": needs_restart,
    }
