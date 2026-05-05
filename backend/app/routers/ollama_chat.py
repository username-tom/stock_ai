"""Ollama-powered chatbot endpoint for script/template authoring assistance."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.custom_script import CustomScript
from app.services.script_executor import DEFAULT_SCRIPT

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/scripts/chat", tags=["chat"])

_TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"
_OLLAMA_URL = "http://localhost:11434/api/chat"
_MODEL = "gemma4"

# ---------------------------------------------------------------------------
# Ollama generation options — keep context window small to reduce TTFT
# ---------------------------------------------------------------------------
_OLLAMA_OPTIONS = {
    "num_ctx": 4096,      # cap context to avoid huge prompt processing overhead
    "temperature": 0.2,   # deterministic/focused answers for code generation
    "num_predict": 1024,  # max tokens to generate per response
}

# ---------------------------------------------------------------------------
# System prompt — intentionally lean: only names/descriptions, NOT full code.
# Full code injection was the primary cause of slow TTFT (3 000–5 000 extra
# tokens processed cold before the first output token).
# The user can always paste a specific script into the chat if needed.
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """\
You are an expert Python quant / algorithmic-trading assistant embedded in a stock-AI platform.
Your job is to help users write, modify, and debug custom trading scripts and strategy templates.

### Script contract (MUST follow)
Every script must define:
  - `get_default_params() -> dict`  (optional but recommended)
  - `generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame`  (required)

Allowed imports: `pandas` (as `pd`), `numpy` (as `np`), `math`, `statistics`.
Signal column: +1 = buy, -1 = sell, 0 = hold.

### Available built-in templates (names only — ask user to paste code if you need details)
{builtin_template_names}

### User's saved scripts (names & descriptions)
{user_script_summaries}

When writing code: use a single ```python fenced block, be concise, always include both functions.
"""


def _extract_description(code: str) -> str:
    """Pull the first docstring or comment from a template file as its description."""
    m = re.search(r'"""(.*?)"""', code, re.DOTALL)
    if m:
        return m.group(1).strip().splitlines()[0].strip()
    m = re.search(r"'''(.*?)'''", code, re.DOTALL)
    if m:
        return m.group(1).strip().splitlines()[0].strip()
    return ""


async def _build_system_prompt(db: AsyncSession) -> str:
    """Build a lean system prompt with only names/descriptions (not full code)."""
    # User scripts — name + description only
    result = await db.execute(select(CustomScript).order_by(CustomScript.created_at.desc()))
    scripts = result.scalars().all()
    if scripts:
        user_script_summaries = "\n".join(
            f"  - {s.name}: {s.description or '(no description)'}"
            for s in scripts
        )
    else:
        user_script_summaries = "  (none yet)"

    # Built-in templates — name + first docstring line only
    template_files = sorted(
        tf for tf in (_TEMPLATES_DIR.glob("*.py") if _TEMPLATES_DIR.exists() else [])
        if not tf.name.startswith("_")
    )
    if template_files:
        names = []
        for tf in template_files:
            try:
                desc = _extract_description(tf.read_text(encoding="utf-8"))
                names.append(f"  - {tf.stem}: {desc}" if desc else f"  - {tf.stem}")
            except Exception:
                names.append(f"  - {tf.stem}")
        builtin_template_names = "\n".join(names)
    else:
        builtin_template_names = "  (none)"

    return _SYSTEM_PROMPT.format(
        builtin_template_names=builtin_template_names,
        user_script_summaries=user_script_summaries,
    )


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


@router.post("")
async def chat(body: ChatRequest, db: AsyncSession = Depends(get_db)):
    """Stream a response from Ollama gemma4 with full script context."""
    system_prompt = await _build_system_prompt(db)

    ollama_messages = [{"role": "system", "content": system_prompt}] + [
        {"role": m.role, "content": m.content} for m in body.messages
    ]

    payload = {
        "model": _MODEL,
        "messages": ollama_messages,
        "stream": True,
        "options": _OLLAMA_OPTIONS,
    }

    async def generate():
        # Signal to the client immediately so it can show a waiting indicator
        yield f"data: {json.dumps({'waiting': True})}\n\n"
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream("POST", _OLLAMA_URL, json=payload) as resp:
                    if resp.status_code != 200:
                        error_body = await resp.aread()
                        yield f"data: {json.dumps({'error': f'Ollama error {resp.status_code}: {error_body.decode()}'})}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                            content = chunk.get("message", {}).get("content", "")
                            done = chunk.get("done", False)
                            yield f"data: {json.dumps({'content': content, 'done': done})}\n\n"
                            if done:
                                break
                        except json.JSONDecodeError:
                            continue
        except httpx.ConnectError:
            yield f"data: {json.dumps({'error': 'Cannot connect to Ollama. Make sure Ollama is running on localhost:11434 with gemma4 pulled.'})}\n\n"
        except Exception as exc:
            logger.exception("Ollama chat error")
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
