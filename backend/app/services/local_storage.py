"""Local PC storage helpers.

Saves backtest reports, portfolio activities, and trade logs as JSON / CSV
files under LOCAL_STORAGE_DIR so that data is preserved independently of
the SQLite database.
"""
from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from app.config import settings

# Sub-directories
_BACKTEST_DIR = Path(settings.LOCAL_STORAGE_DIR) / "backtest_reports"
_TRADE_DIR = Path(settings.LOCAL_STORAGE_DIR) / "trade_logs"
_PORTFOLIO_DIR = Path(settings.LOCAL_STORAGE_DIR) / "portfolio_activities"
_SCRIPTS_DIR = Path(settings.LOCAL_STORAGE_DIR) / "custom_scripts"


# ---------------------------------------------------------------------------
# Backtest report helpers
# ---------------------------------------------------------------------------

def save_backtest_report(report_id: int, name: str, data: dict[str, Any]) -> str:
    """Persist full backtest report data (metrics + result_data) as JSON.

    Returns the path of the saved file relative to the working directory.
    """
    safe_name = _safe_filename(name)
    filename = f"{report_id}_{safe_name}.json"
    path = _BACKTEST_DIR / filename
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, default=str)
    return str(path)


def load_backtest_report(report_id: int, name: str) -> dict[str, Any] | None:
    """Load a previously saved backtest report JSON file.  Returns None if missing."""
    safe_name = _safe_filename(name)
    filename = f"{report_id}_{safe_name}.json"
    path = _BACKTEST_DIR / filename
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def list_backtest_report_files() -> list[dict[str, Any]]:
    """List all saved backtest report JSON files with metadata."""
    files = []
    for p in sorted(_BACKTEST_DIR.glob("*.json")):
        stat = p.stat()
        files.append({
            "filename": p.name,
            "path": str(p),
            "size_bytes": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return files


# ---------------------------------------------------------------------------
# Trade log helpers
# ---------------------------------------------------------------------------

def save_trade_logs_csv(trades: list[dict[str, Any]], filename_prefix: str = "trade_logs") -> str:
    """Write trade records to a CSV file.  Returns the file path."""
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{filename_prefix}_{timestamp}.csv"
    path = _TRADE_DIR / filename
    if not trades:
        path.write_text("", encoding="utf-8")
        return str(path)
    fieldnames = list(trades[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(trades)
    return str(path)


def save_trade_logs_json(trades: list[dict[str, Any]], filename_prefix: str = "trade_logs") -> str:
    """Write trade records to a JSON file.  Returns the file path."""
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{filename_prefix}_{timestamp}.json"
    path = _TRADE_DIR / filename
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(trades, fh, indent=2, default=str)
    return str(path)


def list_trade_log_files() -> list[dict[str, Any]]:
    """List all saved trade log files."""
    files = []
    for p in sorted(_TRADE_DIR.iterdir()):
        if p.suffix in {".csv", ".json"}:
            stat = p.stat()
            files.append({
                "filename": p.name,
                "path": str(p),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
    return files


# ---------------------------------------------------------------------------
# Portfolio activity helpers
# ---------------------------------------------------------------------------

def save_portfolio_activities_csv(
    activities: list[dict[str, Any]],
    filename_prefix: str = "portfolio_activities",
) -> str:
    """Write portfolio activity records (sandbox trades + fund events) to CSV."""
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{filename_prefix}_{timestamp}.csv"
    path = _PORTFOLIO_DIR / filename
    if not activities:
        path.write_text("", encoding="utf-8")
        return str(path)
    fieldnames = list(activities[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(activities)
    return str(path)


def save_portfolio_activities_json(
    activities: list[dict[str, Any]],
    filename_prefix: str = "portfolio_activities",
) -> str:
    """Write portfolio activity records to JSON."""
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{filename_prefix}_{timestamp}.json"
    path = _PORTFOLIO_DIR / filename
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(activities, fh, indent=2, default=str)
    return str(path)


def list_portfolio_activity_files() -> list[dict[str, Any]]:
    """List all saved portfolio activity files."""
    files = []
    for p in sorted(_PORTFOLIO_DIR.iterdir()):
        if p.suffix in {".csv", ".json"}:
            stat = p.stat()
            files.append({
                "filename": p.name,
                "path": str(p),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
    return files


# ---------------------------------------------------------------------------
# Streaming helpers (return in-memory bytes for FastAPI FileResponse)
# ---------------------------------------------------------------------------

def records_to_csv_bytes(records: list[dict[str, Any]]) -> bytes:
    """Serialise a list of dicts to CSV bytes (UTF-8 with BOM for Excel)."""
    if not records:
        return b"\xef\xbb\xbf"  # BOM only
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(records[0].keys()))
    writer.writeheader()
    writer.writerows(records)
    return ("\xef\xbb\xbf" + buf.getvalue()).encode("utf-8")


def records_to_json_bytes(records: list[dict[str, Any]]) -> bytes:
    return json.dumps(records, indent=2, default=str).encode("utf-8")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _safe_filename(name: str, max_len: int = 80) -> str:
    """Strip characters that are unsafe in file names."""
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
    return safe[:max_len]


# ---------------------------------------------------------------------------
# Custom script helpers
# ---------------------------------------------------------------------------

def save_custom_script(script_id: int, name: str, code: str) -> str:
    """Persist a custom script as a .py file on local storage.

    Returns the path of the saved file as a string.
    """
    _SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_filename(name)
    filename = f"{script_id}_{safe_name}.py"
    path = _SCRIPTS_DIR / filename
    path.write_text(code, encoding="utf-8")
    return str(path)


def delete_custom_script_file(script_id: int, name: str) -> None:
    """Remove the .py file for a custom script if it exists."""
    safe_name = _safe_filename(name)
    filename = f"{script_id}_{safe_name}.py"
    path = _SCRIPTS_DIR / filename
    if path.exists():
        path.unlink()


def get_custom_script_path(script_id: int, name: str) -> str | None:
    """Return the local file path for a custom script, or None if not saved yet."""
    safe_name = _safe_filename(name)
    filename = f"{script_id}_{safe_name}.py"
    path = _SCRIPTS_DIR / filename
    return str(path) if path.exists() else None


def list_custom_script_files() -> list[dict[str, Any]]:
    """List all custom script .py files with metadata."""
    if not _SCRIPTS_DIR.exists():
        return []
    files = []
    for p in sorted(_SCRIPTS_DIR.glob("*.py")):
        stat = p.stat()
        files.append({
            "filename": p.name,
            "path": str(p),
            "size_bytes": stat.st_size,
            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return files
