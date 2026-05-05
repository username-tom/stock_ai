"""CRUD endpoints for custom Python trading scripts."""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.config import settings
from app.database import get_db
from app.models.custom_script import CustomScript
from app.services.script_executor import DEFAULT_SCRIPT, validate_script
from app.services.local_storage import (
    save_custom_script, delete_custom_script_file, get_custom_script_path,
)

router = APIRouter(prefix="/api/scripts", tags=["scripts"])

_TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #

class ScriptCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(default="")
    script_code: str = Field(..., min_length=1)


class ScriptUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    script_code: str | None = Field(default=None, min_length=1)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _serialize(s: CustomScript) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "script_code": s.script_code,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        "file_path": get_custom_script_path(s.id, s.name),
    }


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

@router.get("/template")
async def get_template():
    """Return the default script template."""
    return {"template": DEFAULT_SCRIPT}


@router.get("/storage-info")
async def get_storage_info():
    """Return the resolved path of the database file and local scripts folder."""
    from app.services.local_storage import _SCRIPTS_DIR
    raw_url = settings.DATABASE_URL  # e.g. sqlite+aiosqlite:////app/data/stock_ai.db
    parsed = urlparse(raw_url)
    db_path = parsed.path  # absolute path portion after the scheme
    return {"db_path": db_path, "scripts_dir": str(_SCRIPTS_DIR.resolve())}


@router.get("/builtin-templates")
async def list_builtin_templates():
    """Return all built-in strategy templates from the templates directory."""
    templates = []
    for path in sorted(_TEMPLATES_DIR.glob("*.py")):
        code = path.read_text(encoding="utf-8")
        # Extract the module-level docstring as the description
        match = re.match(r'"""(.*?)"""', code, re.DOTALL)
        description = match.group(1).strip() if match else ""
        # Use the first non-empty line of the docstring as the short description
        short_desc = next((l.strip() for l in description.splitlines() if l.strip()), "")
        templates.append({
            "name": path.stem.replace("_", " ").title().replace(" Template", ""),
            "filename": path.name,
            "description": short_desc,
            "script_code": code,
        })
    return {"templates": templates}


@router.get("")
async def list_scripts(db: AsyncSession = Depends(get_db)):
    """List all saved custom scripts."""
    result = await db.execute(select(CustomScript).order_by(CustomScript.created_at.desc()))
    scripts = result.scalars().all()
    return {"scripts": [_serialize(s) for s in scripts]}


@router.post("", status_code=201)
async def create_script(body: ScriptCreate, db: AsyncSession = Depends(get_db)):
    """Create a new custom script."""
    # Check for duplicate name
    existing = await db.execute(select(CustomScript).where(CustomScript.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"A script named '{body.name}' already exists.")

    script = CustomScript(
        name=body.name,
        description=body.description,
        script_code=body.script_code,
    )
    db.add(script)
    await db.commit()
    await db.refresh(script)
    save_custom_script(script.id, script.name, script.script_code)
    return _serialize(script)


@router.get("/{script_id}")
async def get_script(script_id: int, db: AsyncSession = Depends(get_db)):
    """Retrieve a single script by ID."""
    script = await db.get(CustomScript, script_id)
    if not script:
        raise HTTPException(status_code=404, detail="Script not found.")
    return _serialize(script)


@router.put("/{script_id}")
async def update_script(
    script_id: int,
    body: ScriptUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update a script's name, description, or code."""
    script = await db.get(CustomScript, script_id)
    if not script:
        raise HTTPException(status_code=404, detail="Script not found.")

    if body.name is not None:
        # Check uniqueness
        dup = await db.execute(
            select(CustomScript).where(
                CustomScript.name == body.name,
                CustomScript.id != script_id,
            )
        )
        if dup.scalar_one_or_none():
            raise HTTPException(
                status_code=409,
                detail=f"A script named '{body.name}' already exists.",
            )
        # Remove old file before renaming so stale files don't accumulate
        delete_custom_script_file(script.id, script.name)
        script.name = body.name

    if body.description is not None:
        script.description = body.description

    if body.script_code is not None:
        script.script_code = body.script_code

    await db.commit()
    await db.refresh(script)
    save_custom_script(script.id, script.name, script.script_code)
    return _serialize(script)


@router.delete
async def delete_script(script_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a script."""
    script = await db.get(CustomScript, script_id)
    if not script:
        raise HTTPException(status_code=404, detail="Script not found.")
    delete_custom_script_file(script.id, script.name)
    await db.delete(script)
    await db.commit()


@router.post("/validate")
async def validate_script_code(body: ScriptCreate):
    """Validate script code without saving it."""
    result = validate_script(body.script_code)
    # Return only known-safe fields to avoid leaking internal paths
    return {
        "valid": result["valid"],
        "error": result.get("error"),
        "default_params": result.get("default_params", {}),
    }


@router.post("/{script_id}/validate")
async def validate_script_endpoint(script_id: int, db: AsyncSession = Depends(get_db)):
    """Validate the syntax and structure of a saved script."""
    script = await db.get(CustomScript, script_id)
    if not script:
        raise HTTPException(status_code=404, detail="Script not found.")
    result = validate_script(script.script_code)
    # Return only known-safe fields to avoid leaking internal paths
    return {
        "valid": result["valid"],
        "error": result.get("error"),
        "default_params": result.get("default_params", {}),
    }
