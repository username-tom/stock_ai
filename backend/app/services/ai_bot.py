"""AI trade bot — a locally-run Ollama model drives entries and exits.

Design
------
This bot is an *alternative* decision-maker to the sentiment-matrix Portfolio
Manager. It is selected with the ``ai_bot_enabled`` setting; when on, the
sentiment-matrix engine and the per-symbol strategy engine are gated off so the
two modes never trade the same positions simultaneously.

Hard guardrails are enforced **deterministically by this module**, independent
of what the language model returns, so the configured risk settings are always
obeyed:

* **Crash protection** — if today's realised loss breaches the configured
  limit, all positions are liquidated and new entries are blocked for the day.
* **End-of-day liquidation** — when ``hold_positions_overnight`` is off, every
  position is flattened during the EOD sell window and new buys are blocked
  ahead of it.
* **Stop-loss / take-profit** — every held position is checked against the
  configured SL/TP triggers each tick and force-sold when breached.

The model only chooses discretionary BUY / SELL / HOLD actions *within* those
rails. The bot works in both simulated and Interactive Brokers (paper/live)
modes, has access to locally cached 1-minute bars and related financial news,
keeps its context bounded, and resets its working session every trading day.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from statistics import median
from datetime import datetime, timezone, timedelta

import httpx

from app.config import settings as app_settings
from app.database import AsyncSessionLocal

logger = logging.getLogger(__name__)

_OLLAMA_TIMEOUT = 120.0
_FALLBACK_MODEL = "llama3.2"
_MAX_TODAY_ACTIONS = 20          # bounded history fed back into the prompt
_MAX_NEWS_ITEMS = 8
_MODEL_MAX_RETRIES = 3
_MODEL_RETRY_BACKOFF_S = 1.5
_MAX_THINKING_CHARS = 1200
_PROVIDER_OLLAMA = "ollama"
_PROVIDER_LM_STUDIO = "lm_studio"
_DEFAULT_OLLAMA_HOST = "http://localhost:11434"
_DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234/v1"

# Generation options — keep the context window small so the model stays fast
# and the prompt cannot grow unbounded across the trading day.
_OLLAMA_OPTIONS = {
    "num_ctx": 8192,
    "temperature": 0.2,
    "num_predict": 1024,
}

_SYSTEM_PROMPT = """\
You are an automated intraday trading assistant for a set of US equity positions.
You are given the current account, each current position, recent 1-minute
price bars, pre-computed technical indicators, and related financial news.
Decide what to do with each symbol.

Hard rules enforced by the platform (you cannot override them):
- Stop-loss / take-profit, end-of-day liquidation, and crash protection are
  applied automatically. Do not fight them.
- Only long positions are supported (BUY to open/add, SELL to close). No shorts.

Respond with STRICT JSON only, no prose, in exactly this shape:
{"decisions":[{"symbol":"TICKER","action":"buy|sell|hold","order_type":"market|limit","limit_price":123.45,"size_pct":65,"risk_level":"low|medium|high","indicators_used":["RSI","VWAP"],"reason":"short reason","thinking":"short thought process"}]}

Guidance:
- "buy"  = open or add to a long position when the edge looks favourable.
- "sell" = close an existing long position.
- "hold" = take no action this cycle.
- Use "market" when you want an immediate fill.
- Use "limit" when you want a resting or price-controlled order.
- Include "limit_price" for limit orders; omit it for market orders.
- Use "size_pct" (1-100) for partial sizing based on risk assessment.
- "buy": size_pct applies to available allocation room/budget.
- "sell": size_pct applies to currently owned shares.
- Include "risk_level" to justify size choice: low, medium, or high.
- Include "indicators_used" listing only provided signals/indicators you relied on.
- Include "thinking" with the reasoning behind each decision (keep it concise).
- Respect runtime settings shown in the prompt (decision cadence interval, EOD windows,
  risk settings, and buy restrictions) when selecting action/order_type/size.
- Only include symbols from the provided positions. Keep reasons under 140 chars.
"""

# Regime-aware profiles tuned from local sweep artifacts under tmp/:
# - baseline-tight  -> asym_b90_s90 (best for sell-off / high-vol shock)
# - trend-base      -> asym_b50_s90 (best for mixed trend)
# - trend-swing     -> asym_b70_s90 (best for directional sessions)
_REGIME_PROFILE_TABLE: dict[str, dict] = {
    "selloff_tight": {
        "source": "tmp/pm_head2head_phase2_by_profile.json",
        "scenario": "baseline-tight",
        "profile": "asym_b90_s90",
        "sim_buy_fill_rate_pct": 90.0,
        "sim_sell_fill_rate_pct": 90.0,
        "avg_total_return_pct": 17.6562,
        "avg_sharpe_ratio": 0.3067,
        "buy_indicator_weights": {
            "rsi14": 0.24,
            "vwap_distance_pct": 0.22,
            "bar_predictor_bias": 0.16,
            "macd_hist": 0.14,
            "volume_ratio_5_20": 0.12,
            "ema_spread_pct": 0.08,
            "atr14_pct": 0.04,
        },
        "sell_indicator_weights": {
            "vwap_distance_pct": 0.23,
            "ema_spread_pct": 0.20,
            "bar_predictor_bias": 0.18,
            "macd_hist": 0.15,
            "volume_ratio_5_20": 0.12,
            "atr14_pct": 0.07,
            "rsi14": 0.05,
        },
        "size_policy": {
            "max_buy_size_pct": 65,
            "max_add_size_pct": 40,
            "max_sell_size_pct": 100,
            "prefer_market_sells": True,
        },
    },
    "trend_base": {
        "source": "tmp/pm_head2head_phase2_by_profile.json",
        "scenario": "trend-base",
        "profile": "asym_b50_s90",
        "sim_buy_fill_rate_pct": 50.0,
        "sim_sell_fill_rate_pct": 90.0,
        "avg_total_return_pct": 16.1147,
        "avg_sharpe_ratio": 0.4,
        "buy_indicator_weights": {
            "ema_spread_pct": 0.21,
            "macd_hist": 0.20,
            "bar_predictor_bias": 0.19,
            "vwap_distance_pct": 0.16,
            "volume_ratio_5_20": 0.10,
            "rsi14": 0.09,
            "atr14_pct": 0.05,
        },
        "sell_indicator_weights": {
            "bar_predictor_bias": 0.21,
            "macd_hist": 0.20,
            "ema_spread_pct": 0.19,
            "vwap_distance_pct": 0.15,
            "rsi14": 0.11,
            "volume_ratio_5_20": 0.08,
            "atr14_pct": 0.06,
        },
        "size_policy": {
            "max_buy_size_pct": 75,
            "max_add_size_pct": 55,
            "max_sell_size_pct": 100,
            "prefer_market_sells": False,
        },
    },
    "trend_swing": {
        "source": "tmp/pm_head2head_phase2_by_profile.json",
        "scenario": "trend-swing",
        "profile": "asym_b70_s90",
        "sim_buy_fill_rate_pct": 70.0,
        "sim_sell_fill_rate_pct": 90.0,
        "avg_total_return_pct": 15.001,
        "avg_sharpe_ratio": 0.5867,
        "buy_indicator_weights": {
            "ema_spread_pct": 0.24,
            "macd_hist": 0.22,
            "bar_predictor_bias": 0.18,
            "vwap_distance_pct": 0.14,
            "volume_ratio_5_20": 0.10,
            "rsi14": 0.07,
            "atr14_pct": 0.05,
        },
        "sell_indicator_weights": {
            "bar_predictor_bias": 0.24,
            "macd_hist": 0.22,
            "ema_spread_pct": 0.18,
            "vwap_distance_pct": 0.13,
            "rsi14": 0.09,
            "volume_ratio_5_20": 0.08,
            "atr14_pct": 0.06,
        },
        "size_policy": {
            "max_buy_size_pct": 80,
            "max_add_size_pct": 60,
            "max_sell_size_pct": 100,
            "prefer_market_sells": False,
        },
    },
}

# ── runtime state ──────────────────────────────────────────────────────────── #

_state: dict[str, object] = {
    "running": False,
    "session_day": None,        # ET date string of the current working session
    "last_run_at": None,
    "last_error": None,
    "last_model": None,
    "today_actions": [],        # bounded list of executed actions this session
    "last_decisions": [],       # raw decisions from the most recent model call
    "session_cycle_count": 0,
    "last_daily_summary": None,
    "last_daily_summary_day": None,
    "last_query_attempts": 0,
    "last_query_duration_ms": None,
    "last_retry_events": [],
    "last_eod_skip_log_at": None,
}


def get_state() -> dict:
    """Return a JSON-serialisable snapshot of the AI bot runtime state."""
    return {
        "running": bool(_state.get("running")),
        "session_day": _state.get("session_day"),
        "last_run_at": _state.get("last_run_at"),
        "last_error": _state.get("last_error"),
        "last_model": _state.get("last_model"),
        "session_cycle_count": int(_state.get("session_cycle_count") or 0),
        "last_daily_summary": _state.get("last_daily_summary"),
        "last_daily_summary_day": _state.get("last_daily_summary_day"),
        "last_query_attempts": int(_state.get("last_query_attempts") or 0),
        "last_query_duration_ms": _state.get("last_query_duration_ms"),
        "last_retry_events": list(_state.get("last_retry_events") or []),
        "last_eod_skip_log_at": _state.get("last_eod_skip_log_at"),
        "today_actions": list(_state.get("today_actions") or [])[:_MAX_TODAY_ACTIONS],
        "last_decisions": list(_state.get("last_decisions") or []),
    }


# ── model provider helpers ──────────────────────────────────────────────────── #

def _provider_label(provider: str) -> str:
    return "LM Studio" if provider == _PROVIDER_LM_STUDIO else "Ollama"


def _normalize_provider(value: object) -> str:
    provider = str(value or _PROVIDER_OLLAMA).strip().lower()
    return provider if provider in {_PROVIDER_OLLAMA, _PROVIDER_LM_STUDIO} else _PROVIDER_OLLAMA


def _provider_settings(settings: dict | None = None) -> dict:
    active = settings or _get_settings()
    provider = _normalize_provider(active.get("ai_bot_provider"))
    base_url = str(active.get("ai_bot_base_url", "") or "").strip()
    if not base_url:
        if provider == _PROVIDER_LM_STUDIO:
            base_url = str(getattr(app_settings, "LM_STUDIO_BASE_URL", _DEFAULT_LM_STUDIO_BASE_URL) or _DEFAULT_LM_STUDIO_BASE_URL)
        else:
            base_url = str(getattr(app_settings, "OLLAMA_HOST", _DEFAULT_OLLAMA_HOST) or _DEFAULT_OLLAMA_HOST)
    return {
        "provider": provider,
        "base_url": base_url.rstrip("/"),
    }


def _provider_models_url(settings: dict | None = None) -> str:
    provider_cfg = _provider_settings(settings)
    if provider_cfg["provider"] == _PROVIDER_LM_STUDIO:
        return f"{provider_cfg['base_url']}/models"
    return f"{provider_cfg['base_url']}/api/tags"


def _provider_generation_url(settings: dict | None = None) -> str:
    provider_cfg = _provider_settings(settings)
    if provider_cfg["provider"] == _PROVIDER_LM_STUDIO:
        return f"{provider_cfg['base_url']}/chat/completions"
    return f"{provider_cfg['base_url']}/api/generate"


def _provider_connection_error_message(settings: dict | None = None) -> str:
    provider_cfg = _provider_settings(settings)
    label = _provider_label(provider_cfg["provider"])
    return f"Cannot reach {label} at {provider_cfg['base_url']}. Check that the local server is running and the URL is correct."


async def list_installed_models(settings: dict | None = None) -> list[str]:
    """Return the list of models visible to the configured local model provider."""
    provider_cfg = _provider_settings(settings)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(_provider_models_url(settings))
            resp.raise_for_status()
            data = resp.json()
        models = []
        if provider_cfg["provider"] == _PROVIDER_LM_STUDIO:
            for item in data.get("data", []) or []:
                name = str(item.get("id") or item.get("model") or item.get("name") or "").strip()
                if name:
                    models.append(name)
        else:
            for item in data.get("models", []) or []:
                name = str(item.get("name") or item.get("model") or "").strip()
                if name:
                    models.append(name)
        return sorted(set(models))
    except Exception as exc:
        logger.debug("AI bot: could not list %s models: %s", _provider_label(provider_cfg["provider"]), exc)
        return []


async def _resolve_model(settings: dict | None = None) -> str:
    """Pick the model to use: the configured one if available, else first local."""
    active = settings or _get_settings()
    configured = str(active.get("ai_bot_model", "") or "").strip()
    installed = await list_installed_models(active)
    if configured and (configured in installed or not installed):
        return configured
    if installed:
        return installed[0]
    return configured or _FALLBACK_MODEL


def _parse_decisions(raw: str) -> list[dict]:
    raw = str(raw or "").strip()
    if not raw:
        return []

    def _strip_code_fences(text: str) -> str:
        t = text.strip()
        if t.startswith("```"):
            lines = t.splitlines()
            if lines:
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            return "\n".join(lines).strip()
        return t

    def _find_balanced_json_block(text: str) -> str:
        start = -1
        opening = ""
        for i, ch in enumerate(text):
            if ch == "{" or ch == "[":
                start = i
                opening = ch
                break
        if start < 0:
            return ""
        closing = "}" if opening == "{" else "]"
        depth = 0
        in_string = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == opening:
                depth += 1
            elif ch == closing:
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
        return ""

    # Try the raw response first, then progressively more tolerant extraction.
    parse_candidates = [raw]
    stripped = _strip_code_fences(raw)
    if stripped and stripped not in parse_candidates:
        parse_candidates.append(stripped)
    fenced_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, flags=re.IGNORECASE)
    if fenced_match:
        candidate = str(fenced_match.group(1) or "").strip()
        if candidate and candidate not in parse_candidates:
            parse_candidates.append(candidate)
    balanced = _find_balanced_json_block(raw)
    if balanced and balanced not in parse_candidates:
        parse_candidates.append(balanced)

    parsed = None
    for candidate in parse_candidates:
        try:
            parsed = json.loads(candidate)
            break
        except json.JSONDecodeError:
            continue
    if parsed is None:
        logger.warning("AI bot: model returned non-JSON output; ignoring this cycle")
        return []

    if isinstance(parsed, dict) and "decisions" not in parsed and "symbol" in parsed:
        decisions = [parsed]
    else:
        decisions = parsed.get("decisions") if isinstance(parsed, dict) else parsed
    if not isinstance(decisions, list):
        return []
    cleaned: list[dict] = []
    aliases = {
        "wait": "hold",
        "none": "hold",
        "skip": "hold",
        "no_action": "hold",
        "no-action": "hold",
    }
    for d in decisions:
        if not isinstance(d, dict):
            continue
        symbol = str(d.get("symbol") or "").strip().upper()
        action = str(d.get("action") or "hold").strip().lower()
        action = aliases.get(action, action)
        if not symbol or action not in {"buy", "sell", "hold"}:
            continue
        order_type = str(d.get("order_type") or "market").strip().lower()
        if order_type in {"lmt", "limit"}:
            order_type = "limit"
        else:
            order_type = "market"
        limit_price = d.get("limit_price")
        try:
            limit_price_num = float(limit_price)
        except (TypeError, ValueError):
            limit_price_num = None
        if limit_price_num is not None and limit_price_num <= 0:
            limit_price_num = None
        size_pct = d.get("size_pct")
        try:
            size_pct_num = float(size_pct)
        except (TypeError, ValueError):
            size_pct_num = None
        if size_pct_num is not None:
            if size_pct_num <= 0:
                size_pct_num = None
            else:
                size_pct_num = min(100.0, size_pct_num)

        risk_level = str(d.get("risk_level") or d.get("risk") or "").strip().lower()
        if risk_level not in {"low", "medium", "high"}:
            risk_level = ""

        indicators_raw = d.get("indicators_used") or d.get("indicators") or []
        indicators: list[str] = []
        if isinstance(indicators_raw, str):
            parts = [part.strip() for part in indicators_raw.split(",") if part.strip()]
            indicators = parts[:8]
        elif isinstance(indicators_raw, list):
            for item in indicators_raw:
                text = str(item or "").strip()
                if text:
                    indicators.append(text)
                if len(indicators) >= 8:
                    break
        thinking = str(d.get("thinking") or d.get("analysis") or "").strip()
        cleaned.append({
            "symbol": symbol,
            "action": action,
            "order_type": order_type,
            "limit_price": limit_price_num,
            "size_pct": size_pct_num,
            "risk_level": risk_level,
            "indicators_used": indicators,
            "reason": str(d.get("reason") or "")[:140],
            "thinking": thinking[:_MAX_THINKING_CHARS],
        })
    return cleaned


def _normalize_symbol_decisions(decisions: list[dict], symbols: list[str]) -> list[dict]:
    """De-duplicate and backfill decisions so every requested symbol has an action."""
    symbol_set = {str(s or "").strip().upper() for s in symbols if str(s or "").strip()}
    if not symbol_set:
        return []

    # Keep the latest model decision for each symbol.
    by_symbol: dict[str, dict] = {}
    for d in decisions:
        symbol = str((d or {}).get("symbol") or "").strip().upper()
        if symbol and symbol in symbol_set:
            by_symbol[symbol] = d

    missing = sorted(symbol_set.difference(by_symbol.keys()))
    if missing:
        _pm_log(
            f"model returned {len(by_symbol)}/{len(symbol_set)} symbols; defaulting HOLD for: {', '.join(missing)}"
        )
        for symbol in missing:
            by_symbol[symbol] = {
                "symbol": symbol,
                "action": "hold",
                "order_type": "market",
                "limit_price": None,
                "size_pct": None,
                "risk_level": "",
                "indicators_used": [],
                "reason": "no model decision; default hold",
                "thinking": "",
            }

    return [by_symbol[symbol] for symbol in sorted(symbol_set)]


async def get_status(settings: dict | None = None) -> dict:
    active = settings or _get_settings()
    provider_cfg = _provider_settings(active)
    configured_model = str(active.get("ai_bot_model", "") or "").strip()
    started_at = datetime.now(timezone.utc)
    models = await list_installed_models(active)
    reachable = bool(models)
    message = None
    status = "healthy"
    if reachable:
        message = f"{len(models)} model(s) available from {_provider_label(provider_cfg['provider'])}."
    else:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(_provider_models_url(active))
                resp.raise_for_status()
            reachable = True
            status = "no_models"
            message = f"{_provider_label(provider_cfg['provider'])} is reachable, but no models are currently available."
        except httpx.ConnectError:
            status = "unreachable"
            message = _provider_connection_error_message(active)
        except httpx.HTTPStatusError as exc:
            status = "error"
            message = f"{_provider_label(provider_cfg['provider'])} returned HTTP {exc.response.status_code} while listing models."
        except Exception as exc:
            status = "error"
            message = f"{_provider_label(provider_cfg['provider'])} status check failed: {exc}"

    resolved_model = configured_model
    if models:
        resolved_model = configured_model if configured_model in models else models[0]
    elif not resolved_model:
        resolved_model = _FALLBACK_MODEL

    runtime_state = get_state()
    ai_active = _is_ai_bot_active(active)
    interval_s = max(30, int(active.get("ai_bot_interval_s", 300) or 300))
    last_error = str(runtime_state.get("last_error") or "").strip()
    last_run_raw = str(runtime_state.get("last_run_at") or "").strip()
    last_run_at: datetime | None = None
    if last_run_raw:
        try:
            last_run_at = datetime.fromisoformat(last_run_raw.replace("Z", "+00:00"))
            if last_run_at.tzinfo is None:
                last_run_at = last_run_at.replace(tzinfo=timezone.utc)
        except Exception:
            last_run_at = None

    if not ai_active:
        status = "disabled"
        message = "AI bot is disabled because PM is off or AI mode is not selected."
    elif status == "healthy" and last_error:
        status = "degraded"
        message = f"Last run failed: {last_error}"
    elif status == "healthy" and last_run_at is None:
        status = "starting"
        message = "AI bot is enabled and waiting for the first successful run."
    elif status == "healthy" and last_run_at is not None:
        stale_after = timedelta(seconds=(interval_s * 2) + 30)
        if datetime.now(timezone.utc) - last_run_at > stale_after:
            status = "stalled"
            message = (
                f"AI bot appears stalled: last run was {last_run_at.astimezone(timezone.utc).isoformat()} "
                f"(interval={interval_s}s)."
            )

    runtime_state.update({
        "provider": provider_cfg["provider"],
        "provider_label": _provider_label(provider_cfg["provider"]),
        "endpoint": provider_cfg["base_url"],
        "configured_model": configured_model,
        "resolved_model": resolved_model,
        "configured_model_available": (not configured_model) or (configured_model in models) or (not models),
        "reachable": reachable,
        "active": ai_active,
        "status": status,
        "message": message,
        "checked_at": started_at.isoformat(),
        "model_count": len(models),
    })
    return {
        "provider": provider_cfg["provider"],
        "provider_label": _provider_label(provider_cfg["provider"]),
        "endpoint": provider_cfg["base_url"],
        "available_models": models,
        "models": models,
        "configured_model": configured_model,
        "resolved_model": resolved_model,
        "configured_model_available": runtime_state["configured_model_available"],
        "reachable": reachable,
        "status": status,
        "message": message,
        "checked_at": runtime_state["checked_at"],
        "state": runtime_state,
    }


async def _query_model(model: str, system_prompt: str, user_prompt: str, settings: dict | None = None) -> list[dict]:
    """Call the configured local provider and parse a strict-JSON list of decisions."""
    provider_cfg = _provider_settings(settings)
    last_exc: Exception | None = None
    retry_events: list[str] = []
    started = datetime.now(timezone.utc)
    for attempt in range(1, _MODEL_MAX_RETRIES + 1):
        _state["last_query_attempts"] = attempt
        try:
            async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
                if provider_cfg["provider"] == _PROVIDER_LM_STUDIO:
                    payload = {
                        "model": model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        "temperature": _OLLAMA_OPTIONS["temperature"],
                        "max_tokens": _OLLAMA_OPTIONS["num_predict"],
                        "stream": False,
                    }
                    resp = await client.post(_provider_generation_url(settings), json=payload)
                    resp.raise_for_status()
                    body = resp.json()
                    choices = body.get("choices") or []
                    message = choices[0].get("message") if choices and isinstance(choices[0], dict) else {}
                    raw = str((message or {}).get("content") or "").strip()
                    decisions = _parse_decisions(raw)
                else:
                    payload = {
                        "model": model,
                        "prompt": user_prompt,
                        "system": system_prompt,
                        "stream": False,
                        "format": "json",
                        "options": _OLLAMA_OPTIONS,
                    }
                    resp = await client.post(_provider_generation_url(settings), json=payload)
                    resp.raise_for_status()
                    body = resp.json()
                    raw = str(body.get("response") or "").strip()
                    decisions = _parse_decisions(raw)

            elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
            _state["last_query_duration_ms"] = elapsed_ms
            _state["last_retry_events"] = retry_events[-10:]
            if attempt > 1:
                _pm_log(
                    f"model recovered after retry {attempt}/{_MODEL_MAX_RETRIES} "
                    f"({_provider_label(provider_cfg['provider'])}, {elapsed_ms}ms)"
                )
            return decisions
        except (httpx.TimeoutException, httpx.ConnectError, httpx.HTTPStatusError) as exc:
            last_exc = exc
            kind = (
                "timeout" if isinstance(exc, httpx.TimeoutException)
                else "connect" if isinstance(exc, httpx.ConnectError)
                else "http"
            )
            detail = str(exc)
            event = f"attempt {attempt}/{_MODEL_MAX_RETRIES} {kind}: {detail}"
            retry_events.append(event)
            _pm_log(f"model query {event}")
            if attempt >= _MODEL_MAX_RETRIES:
                break
            await asyncio.sleep(_MODEL_RETRY_BACKOFF_S * attempt)
        except Exception as exc:
            last_exc = exc
            event = f"attempt {attempt}/{_MODEL_MAX_RETRIES} error: {exc}"
            retry_events.append(event)
            _pm_log(f"model query {event}")
            if attempt >= _MODEL_MAX_RETRIES:
                break
            await asyncio.sleep(_MODEL_RETRY_BACKOFF_S * attempt)

    elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    _state["last_query_duration_ms"] = elapsed_ms
    _state["last_retry_events"] = retry_events[-10:]
    if last_exc is not None:
        raise last_exc
    return []


# ── context gathering ────────────────────────────────────────────────────────── #

async def _gather_watchlist_positions(*, use_ib_execution: bool) -> list[dict]:
    from sqlalchemy import select as sa_select
    from app.models.sandbox import SandboxPosition

    async with AsyncSessionLocal() as db:
        res = await db.execute(sa_select(SandboxPosition).order_by(SandboxPosition.symbol))
        rows = res.scalars().all()

    positions_by_symbol: dict[str, dict] = {}
    for p in rows:
        symbol = str(p.symbol or "").upper().strip()
        if not symbol:
            continue
        shares = float(p.shares or 0.0)
        pending_shares = float(getattr(p, "pending_shares", 0.0) or 0.0)
        if not bool(getattr(p, "is_on_watchlist", True)) and shares <= 0.0 and pending_shares <= 0.0:
            continue
        positions_by_symbol[symbol] = {
            "id": int(p.id),
            "symbol": symbol,
            "shares": shares,
            "avg_cost": float(p.avg_cost or 0.0),
            "allocated_funds": float(p.allocated_funds or 0.0),
            "max_allocation_mode": str(p.max_allocation_mode or "dollar"),
            "max_allocation_value": float(p.max_allocation_value or 0.0),
            "source": "sim",
        }

    if use_ib_execution:
        try:
            from app.services.ib_service import ib_service

            ib_positions = await ib_service.get_positions()
            for row in ib_positions:
                symbol = str(row.get("symbol") or "").upper().strip()
                if not symbol:
                    continue
                qty = float(row.get("quantity") or 0.0)
                avg_cost = float(row.get("avg_cost") or 0.0)
                pos = positions_by_symbol.get(symbol)
                if not pos:
                    positions_by_symbol[symbol] = {
                        "id": None,
                        "symbol": symbol,
                        "shares": qty,
                        "avg_cost": avg_cost,
                        "allocated_funds": 0.0,
                        "max_allocation_mode": "dollar",
                        "max_allocation_value": 0.0,
                        "source": "ib",
                    }
                    continue
                local_shares = float(pos.get("shares") or 0.0)
                pos["ib_qty"] = qty
                pos["shares"] = qty
                pos["source"] = "ib" if local_shares <= 0.0 else "sim+ib"
                if avg_cost > 0.0:
                    pos["avg_cost"] = avg_cost
        except Exception as exc:
            logger.warning("AI bot IB snapshot failed: %s", exc)

    return sorted(positions_by_symbol.values(), key=lambda item: str(item.get("symbol") or ""))


async def _gather_quotes(symbols: list[str]) -> dict[str, float]:
    if not symbols:
        return {}
    try:
        from app.services.market_service import get_bulk_quotes
        quotes = await get_bulk_quotes(symbols)
        return {
            sym: float(q["last_price"])
            for sym, q in quotes.items()
            if q and q.get("last_price")
        }
    except Exception as exc:
        logger.debug("AI bot quote fetch failed: %s", exc)
        return {}


def _summarise_1m_bars(symbol: str, max_bars: int) -> dict | None:
    """Load locally-cached 1m bars and summarise the most recent ``max_bars``."""
    from datetime import timedelta
    import zoneinfo
    try:
        from app.services.data_provider import load_intraday_history_records
        et = zoneinfo.ZoneInfo("America/New_York")
        today = datetime.now(tz=et).date()
        start = (today - timedelta(days=4)).isoformat()
        end = today.isoformat()
        result = load_intraday_history_records(symbol, start, end, source="auto", interval="1m")
        data = result.get("data") or []
        if not data:
            return None
        recent = data[-max_bars:]
        closes = [float(r["close"]) for r in recent if r.get("close") is not None]
        if not closes:
            return None

        def _ema(values: list[float], period: int) -> float | None:
            if len(values) < max(2, period):
                return None
            alpha = 2.0 / (period + 1.0)
            cur = float(values[0])
            for v in values[1:]:
                cur = float(v) * alpha + cur * (1.0 - alpha)
            return cur

        def _rsi(values: list[float], period: int = 14) -> float | None:
            if len(values) <= period:
                return None
            gains = 0.0
            losses = 0.0
            for i in range(len(values) - period, len(values)):
                delta = float(values[i]) - float(values[i - 1])
                if delta >= 0:
                    gains += delta
                else:
                    losses -= delta
            avg_gain = gains / period
            avg_loss = losses / period
            if avg_loss <= 1e-12:
                return 100.0
            rs = avg_gain / avg_loss
            return 100.0 - (100.0 / (1.0 + rs))

        def _atr(rows: list[dict], period: int = 14) -> float | None:
            if len(rows) <= period:
                return None
            trs: list[float] = []
            prev_close: float | None = None
            for r in rows[-(period + 1):]:
                hi_raw = r.get("high")
                lo_raw = r.get("low")
                cl_raw = r.get("close")
                if hi_raw is None or lo_raw is None or cl_raw is None:
                    continue
                high = float(hi_raw)
                low = float(lo_raw)
                close = float(cl_raw)
                if prev_close is None:
                    tr = high - low
                else:
                    tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
                trs.append(float(tr))
                prev_close = close
            if len(trs) < period:
                return None
            return sum(trs[-period:]) / float(period)

        def _macd_hist(values: list[float]) -> float | None:
            if len(values) < 26:
                return None
            win = values[-90:]
            macd_series: list[float] = []
            for i in range(26, len(win) + 1):
                fast = _ema(win[:i], 12)
                slow = _ema(win[:i], 26)
                if fast is not None and slow is not None:
                    macd_series.append(fast - slow)
            if not macd_series:
                return None
            signal = _ema(macd_series, 9)
            if signal is None:
                return None
            return macd_series[-1] - signal

        def _vwap(rows: list[dict]) -> float | None:
            cum_pv = 0.0
            cum_v = 0.0
            for r in rows:
                h = r.get("high")
                l = r.get("low")
                c = r.get("close")
                v = r.get("volume")
                if h is None or l is None or c is None or v is None:
                    continue
                vol = float(v)
                if vol <= 0:
                    continue
                tp = (float(h) + float(l) + float(c)) / 3.0
                cum_pv += tp * vol
                cum_v += vol
            return (cum_pv / cum_v) if cum_v > 0 else None

        def _volume_ratio(rows: list[dict], short_n: int = 5, long_n: int = 20) -> float | None:
            vols = [float(r.get("volume") or 0.0) for r in rows if r.get("volume") is not None]
            if len(vols) < max(short_n, long_n):
                return None
            short_avg = sum(vols[-short_n:]) / float(short_n)
            long_avg = sum(vols[-long_n:]) / float(long_n)
            if long_avg <= 1e-12:
                return None
            return short_avg / long_avg

        first, last = closes[0], closes[-1]
        change_pct = ((last - first) / first * 100.0) if first else 0.0
        ema9 = _ema(closes[-120:], 9)
        ema21 = _ema(closes[-120:], 21)
        rsi14 = _rsi(closes, 14)
        atr14 = _atr(recent, 14)
        macd_hist = _macd_hist(closes)
        vwap_val = _vwap(recent)
        roc7 = None
        if len(closes) >= 8 and closes[-8] > 0:
            roc7 = ((closes[-1] - closes[-8]) / closes[-8]) * 100.0
        vol_ratio_5_20 = _volume_ratio(recent, 5, 20)
        ema_spread_pct = None
        if ema9 is not None and ema21 is not None and ema21 > 0:
            ema_spread_pct = ((ema9 - ema21) / ema21) * 100.0
        vwap_dist_pct = None
        if vwap_val is not None and vwap_val > 0:
            vwap_dist_pct = ((last - vwap_val) / vwap_val) * 100.0

        bar_predictor_bias = None
        try:
            from app.services.bar_predictor import compute_bar_predictor_bias

            bar_predictor_bias = float(compute_bar_predictor_bias(recent, lookback=min(30, len(recent))))
        except Exception:
            bar_predictor_bias = None

        indicators = {
            "vwap": round(vwap_val, 4) if vwap_val is not None else None,
            "vwap_distance_pct": round(vwap_dist_pct, 3) if vwap_dist_pct is not None else None,
            "rsi14": round(rsi14, 2) if rsi14 is not None else None,
            "ema9": round(ema9, 4) if ema9 is not None else None,
            "ema21": round(ema21, 4) if ema21 is not None else None,
            "ema_spread_pct": round(ema_spread_pct, 3) if ema_spread_pct is not None else None,
            "macd_hist": round(macd_hist, 6) if macd_hist is not None else None,
            "roc7_pct": round(roc7, 3) if roc7 is not None else None,
            "atr14_pct": round((atr14 / last) * 100.0, 3) if atr14 is not None and last > 0 else None,
            "volume_ratio_5_20": round(vol_ratio_5_20, 3) if vol_ratio_5_20 is not None else None,
            "bar_predictor_bias": round(bar_predictor_bias, 3) if bar_predictor_bias is not None else None,
        }

        return {
            "bars": len(recent),
            "first_close": round(first, 4),
            "last_close": round(last, 4),
            "high": round(max(r["high"] for r in recent if r.get("high") is not None), 4),
            "low": round(min(r["low"] for r in recent if r.get("low") is not None), 4),
            "change_pct": round(change_pct, 3),
            "indicators": indicators,
        }
    except Exception as exc:
        logger.debug("AI bot 1m summary failed for %s: %s", symbol, exc)
        return None


async def _gather_news(symbols: list[str]) -> list[dict]:
    if not symbols:
        return []
    try:
        from app.services.market_service import get_news
        result = await get_news(symbols)
        items = result.get("items") if isinstance(result, dict) else result
        out = []
        for item in (items or [])[:_MAX_NEWS_ITEMS]:
            out.append({
                "title": str(item.get("title") or "")[:160],
                "source": str(item.get("source") or ""),
                "related": item.get("related") or [],
            })
        return out
    except Exception as exc:
        logger.debug("AI bot news fetch failed: %s", exc)
        return []


def _interval_cadence_profile(interval_s: int) -> dict[str, str]:
    s = max(30, int(interval_s or 300))
    if s <= 75:
        return {
            "profile": "micro_scalp",
            "guidance": "minute-level cadence; favor quicker reactions with tighter risk and smaller incremental adds/exits",
        }
    if s <= 360:
        return {
            "profile": "intraday_swing",
            "guidance": "multi-minute cadence; prioritize confirmation and moderate position changes over rapid churn",
        }
    return {
        "profile": "slow_swing",
        "guidance": "slow cadence; only act on stronger conviction setups and avoid frequent order edits",
    }


def _median_or_none(values: list[float]) -> float | None:
    if not values:
        return None
    try:
        return float(median(values))
    except Exception:
        return None


def _clip(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _build_regime_context(*, bars: dict[str, dict], interval_s: int) -> dict:
    """Infer market regime from current bars and return tuned indicator weights."""
    if not bars:
        fallback = _REGIME_PROFILE_TABLE["trend_base"]
        return {
            "regime": "trend_base",
            "confidence": 0.35,
            "sample_size": 0,
            "market_snapshot": {},
            "profile": fallback,
            "reason": "insufficient_intraday_bars",
        }

    changes: list[float] = []
    vwap_dists: list[float] = []
    ema_spreads: list[float] = []
    atr_pcts: list[float] = []

    for row in bars.values():
        change = row.get("change_pct")
        if change is not None:
            changes.append(float(change))
        indicators = row.get("indicators") or {}
        vwap_dist = indicators.get("vwap_distance_pct")
        ema_spread = indicators.get("ema_spread_pct")
        atr_pct = indicators.get("atr14_pct")
        if vwap_dist is not None:
            vwap_dists.append(float(vwap_dist))
        if ema_spread is not None:
            ema_spreads.append(float(ema_spread))
        if atr_pct is not None:
            atr_pcts.append(float(atr_pct))

    sample_size = len(changes)
    breadth_negative = (sum(1 for x in changes if x < 0.0) / sample_size) if sample_size > 0 else 0.0
    breadth_positive = (sum(1 for x in changes if x > 0.0) / sample_size) if sample_size > 0 else 0.0
    median_change = _median_or_none(changes) or 0.0
    median_vwap_dist = _median_or_none(vwap_dists) or 0.0
    median_ema_spread = _median_or_none(ema_spreads) or 0.0
    median_atr = _median_or_none(atr_pcts) or 0.0
    trend_agreement = max(breadth_positive, breadth_negative)

    # Sell-off / tape pressure: broad negative breadth + below-VWAP bias.
    if (
        sample_size >= 3
        and breadth_negative >= 0.65
        and median_change <= -0.20
        and median_vwap_dist <= -0.10
    ):
        regime = "selloff_tight"
        confidence = _clip(0.45 + (breadth_negative - 0.65) + min(0.25, abs(median_change) / 2.0), 0.45, 0.95)
        reason = "negative_breadth_and_below_vwap"
    # Directional trend day: strong breadth alignment + persistent EMA separation.
    elif sample_size >= 3 and trend_agreement >= 0.60 and abs(median_ema_spread) >= 0.08 and abs(median_change) >= 0.15:
        regime = "trend_swing"
        confidence = _clip(0.40 + (trend_agreement - 0.60) + min(0.20, abs(median_ema_spread)), 0.40, 0.90)
        reason = "directional_breadth_with_ema_separation"
    else:
        regime = "trend_base"
        confidence = _clip(0.35 + min(0.25, abs(median_change) / 2.0) + min(0.20, median_atr / 3.0), 0.35, 0.80)
        reason = "mixed_or_transitional_tape"

    profile = dict(_REGIME_PROFILE_TABLE.get(regime, _REGIME_PROFILE_TABLE["trend_base"]))
    profile["cadence_profile"] = _interval_cadence_profile(interval_s)["profile"]

    return {
        "regime": regime,
        "confidence": round(confidence, 3),
        "sample_size": sample_size,
        "market_snapshot": {
            "breadth_negative": round(breadth_negative, 3),
            "breadth_positive": round(breadth_positive, 3),
            "median_change_pct": round(median_change, 3),
            "median_vwap_distance_pct": round(median_vwap_dist, 3),
            "median_ema_spread_pct": round(median_ema_spread, 3),
            "median_atr14_pct": round(median_atr, 3),
        },
        "profile": profile,
        "reason": reason,
    }


def _build_runtime_constraints(*, settings: dict, interval_s: int, in_shutoff: bool,
                               in_sell_window: bool, use_ib_execution: bool,
                               ib_mode: str, regime_context: dict) -> dict:
    cadence = _interval_cadence_profile(interval_s)
    return {
        "execution_mode": "IB" if use_ib_execution else "SIM",
        "trading_mode": ib_mode,
        "cadence_seconds": interval_s,
        "cadence_profile": cadence["profile"],
        "cadence_guidance": cadence["guidance"],
        "hold_positions_overnight": bool(settings.get("hold_positions_overnight", False)),
        "eod_sell_window_minutes": int(settings.get("eod_sell_window_minutes", 5) or 5),
        "eod_engine_shutoff_minutes_before_sell": int(settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120),
        "pre_sell_buy_block_active": bool(in_shutoff),
        "sell_only_window_active": bool(in_sell_window),
        "stop_loss_pct": float(settings.get("stop_loss_pct", 0.0) or 0.0),
        "take_profit_pct": float(settings.get("take_profit_pct", 0.0) or 0.0),
        "stop_loss_value": float(settings.get("stop_loss_value", 0.0) or 0.0),
        "take_profit_value": float(settings.get("take_profit_value", 0.0) or 0.0),
        "crash_protection_enabled": bool(settings.get("crash_protection_enabled", False)),
        "crash_protection_mode": str(settings.get("crash_protection_mode", "percent") or "percent"),
        "crash_protection_value": float(settings.get("crash_protection_value", 0.0) or 0.0),
        "regime": regime_context.get("regime"),
        "regime_confidence": regime_context.get("confidence"),
        "regime_reason": regime_context.get("reason"),
        "regime_market_snapshot": regime_context.get("market_snapshot") or {},
        "regime_profile": regime_context.get("profile") or {},
    }


def _build_user_prompt(*, instruction: str, account: dict, positions: list[dict],
                       quotes: dict[str, float], bars: dict[str, dict],
                       news: list[dict], today_actions: list[dict],
                       runtime_constraints: dict, regime_context: dict) -> str:
    default_instruction = "help me make money using the positions in watchlist."
    effective_instruction = str(instruction or "").strip()
    if not effective_instruction or effective_instruction.lower() == default_instruction:
        effective_instruction = (
            "Maximize risk-adjusted intraday P&L while minimizing churn and drawdown. "
            "Prioritize capital protection during sell-offs, scale into high-conviction setups only, "
            "and exit quickly when weighted evidence degrades."
        )

    lines: list[str] = []
    lines.append(f"User instruction: {effective_instruction}")
    lines.append("")
    lines.append(f"Account: {json.dumps(account, default=str)}")
    lines.append("")
    lines.append(f"Runtime settings: {json.dumps(runtime_constraints, default=str)}")
    lines.append("")
    lines.append(
        "Regime tuning (derived from current intraday bars and validated against local historical sweeps): "
        f"{json.dumps(regime_context, default=str)}"
    )
    lines.append(
        "Indicator weighting policy: for each BUY/SELL decision, prioritize evidence in proportion to the regime"
        " profile's indicator weights. Prefer actions where weighted evidence is aligned across >=3 indicators."
    )
    lines.append(
        "Sizing policy: respect the regime size_policy caps and downsize when evidence conflicts, volatility (ATR14%)"
        " rises, or confidence is below 0.55."
    )
    lines.append(
        "Cadence policy: adapt aggressiveness, order type, and size to cadence_profile. "
        "Faster cadence can use smaller/frequent edits; slower cadence should require stronger confirmation and lower churn."
    )
    lines.append("")
    lines.append("Current positions:")
    for p in positions:
        sym = p["symbol"]
        price = quotes.get(sym)
        bar = bars.get(sym)
        lines.append(
            f"- {sym} [{p.get('source', 'sim')}]: shares={p['shares']:.4f} avg_cost={p['avg_cost']:.4f} "
            f"price={price if price is not None else 'n/a'} "
            f"alloc=${p['allocated_funds']:.2f} 1m={json.dumps(bar) if bar else 'n/a'}"
        )
    if news:
        lines.append("")
        lines.append("Related financial news:")
        for n in news:
            lines.append(f"- {n['title']} ({n['source']})")
    if today_actions:
        lines.append("")
        lines.append("Actions already taken today (avoid churn):")
        for a in today_actions[-_MAX_TODAY_ACTIONS:]:
            lines.append(f"- {a}")
    lines.append("")
    lines.append("Return JSON decisions for the provided symbols now.")
    return "\n".join(lines)


def _summary_num(summary: dict, key: str) -> float:
    """Extract numeric account-summary values from IB payloads.

    IB account summary rows are returned as nested objects:
      {"NetLiquidation": {"value": "12345.67", "currency": "USD"}, ...}
    but callers sometimes also pass flattened numeric strings.
    """
    raw = summary.get(key)
    if isinstance(raw, dict):
        raw = raw.get("value")
    if raw is None:
        return 0.0
    text = str(raw).strip().replace(",", "")
    if not text:
        return 0.0
    try:
        return float(text)
    except (TypeError, ValueError):
        return 0.0


# ── guardrail + execution helpers ──────────────────────────────────────────────── #

def _record_action(text: str) -> None:
    actions = list(_state.get("today_actions") or [])
    actions.append(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {text}")
    _state["today_actions"] = actions[-_MAX_TODAY_ACTIONS:]


def _pm_log(msg: str) -> None:
    try:
        from app.services.portfolio_manager import _log_activity
        _log_activity(f"AI bot: {msg}")
    except Exception:
        logger.info("AI bot: %s", msg)


def _log_decision_batch(decisions: list[dict], symbols: list[str], model: str) -> None:
    """Write the model output summary to the existing PM activity log."""
    safe_symbols = [str(s or "").upper() for s in symbols if str(s or "").strip()]
    if not decisions:
        _pm_log(
            f"model={model} produced no actionable decisions for {len(safe_symbols)} watchlist symbols"
        )
        return

    # Keep log lines compact and readable in the existing PM activity table.
    formatted = []
    for d in decisions[:20]:
        symbol = str(d.get("symbol") or "").upper()
        action = str(d.get("action") or "hold").lower()
        order_type = str(d.get("order_type") or "market").upper()
        limit_price = d.get("limit_price")
        size_pct = d.get("size_pct")
        risk_level = str(d.get("risk_level") or "").strip().lower()
        indicators = d.get("indicators_used") or []
        limit_note = f" @${float(limit_price):.2f}" if limit_price is not None else ""
        size_note = f" size={float(size_pct):.0f}%" if size_pct is not None else ""
        risk_note = f" risk={risk_level}" if risk_level else ""
        indicators_note = ""
        if isinstance(indicators, list) and indicators:
            indicators_note = f" ind=[{', '.join(str(x) for x in indicators[:5])}]"
        reason = str(d.get("reason") or "").strip()
        thinking = str(d.get("thinking") or "").strip()
        if reason:
            formatted.append(f"{symbol}:{action}/{order_type}{limit_note}{size_note}{risk_note}{indicators_note} ({reason})")
        else:
            formatted.append(f"{symbol}:{action}/{order_type}{limit_note}{size_note}{risk_note}{indicators_note}")
        if thinking:
            _pm_log(f"model thinking {symbol}: {thinking[:400]}")

    _pm_log(
        f"model={model} decisions ({len(decisions)}): " + "; ".join(formatted)
    )


def _is_after_market_close_et() -> bool:
    import zoneinfo

    et = zoneinfo.ZoneInfo("America/New_York")
    now_et = datetime.now(tz=et)
    if now_et.weekday() >= 5:
        return False
    return (now_et.hour, now_et.minute) >= (16, 0)


async def _build_daily_summary() -> str | None:
    session_day = str(_state.get("session_day") or "").strip()
    if not session_day:
        return None

    settings = _get_settings()
    provider_cfg = _provider_settings(settings)
    today_actions = list(_state.get("today_actions") or [])
    last_decisions = list(_state.get("last_decisions") or [])
    cycle_count = int(_state.get("session_cycle_count") or 0)

    buy_count = sum(1 for entry in today_actions if str(entry).split(" ", 1)[-1].startswith("BUY "))
    sell_count = sum(1 for entry in today_actions if str(entry).split(" ", 1)[-1].startswith("SELL "))

    decision_counts = {"buy": 0, "sell": 0, "hold": 0}
    for decision in last_decisions:
        action = str((decision or {}).get("action") or "hold").lower()
        if action in decision_counts:
            decision_counts[action] += 1

    use_ib_execution = False
    try:
        ib_mode = str(getattr(app_settings, "TRADING_MODE", "paper") or "paper").lower()
        from app.services.ib_service import ib_service
        use_ib_execution = bool(getattr(ib_service, "is_connected", False) and ib_mode in {"paper", "live"})
    except Exception:
        use_ib_execution = False

    positions = await _gather_watchlist_positions(use_ib_execution=use_ib_execution)
    held_positions = [p for p in positions if float(p.get("shares") or 0.0) > 0.0]
    held_symbols = [str(p.get("symbol") or "").upper() for p in held_positions if str(p.get("symbol") or "").strip()]

    realised_pnl = 0.0
    pnl_label = "SIM"
    try:
        ib_mode = str(getattr(app_settings, "TRADING_MODE", "paper") or "paper").lower()
        from app.services.ib_service import ib_service
        if bool(getattr(ib_service, "is_connected", False)) and ib_mode in {"paper", "live"}:
            from app.services.portfolio_manager import _get_today_ib_realized_gain
            realised_pnl = float(await _get_today_ib_realized_gain(ib_mode) or 0.0)
            pnl_label = ib_mode.upper()
        else:
            raise RuntimeError("simulated")
    except Exception:
        try:
            from app.services.portfolio_manager import _get_today_simulated_realized_gain
            realised_pnl = float(await _get_today_simulated_realized_gain() or 0.0)
        except Exception:
            realised_pnl = 0.0

    summary = (
        f"daily summary {session_day}: cycles={cycle_count}, actions={len(today_actions)} "
        f"(buy={buy_count}, sell={sell_count}), last_decisions={len(last_decisions)} "
        f"(buy={decision_counts['buy']}, sell={decision_counts['sell']}, hold={decision_counts['hold']}), "
        f"realised_pnl[{pnl_label}]=${realised_pnl:.2f}, open_positions={len(held_positions)}, "
        f"provider={_provider_label(provider_cfg['provider'])}, model={_state.get('last_model') or 'auto'}"
    )
    if held_symbols:
        summary += f", held={','.join(held_symbols[:10])}"
    return summary


async def _emit_daily_summary_if_due() -> None:
    session_day = str(_state.get("session_day") or "").strip()
    if not session_day:
        return
    if str(_state.get("last_daily_summary_day") or "") == session_day:
        return
    if int(_state.get("session_cycle_count") or 0) <= 0:
        return
    if not _is_after_market_close_et():
        return

    summary = await _build_daily_summary()
    if not summary:
        return
    _state["last_daily_summary"] = summary
    _state["last_daily_summary_day"] = session_day
    _pm_log(summary)


async def _sell_position(*, pos: dict, price: float, reason: str, ib_mode: bool, ib_connected: bool,
                         order_type: str = "market", limit_price: float | None = None,
                         size_pct: float | None = None) -> None:
    """Flatten a single long position via IB (if connected) or the sim engine."""
    symbol = pos["symbol"]
    kind = "LMT" if str(order_type or "market").strip().lower() == "limit" else "MKT"
    if ib_connected:
        from app.services.ib_service import ib_service
        from app.services.top_of_book import market_fill_price, simulate_top_of_book_from_quote
        held_qty = float(pos.get("ib_qty") or pos.get("shares") or 0.0)
        if held_qty <= 0:
            return
        target_pct = min(100.0, max(1.0, float(size_pct or 100.0)))
        qty = held_qty if target_pct >= 99.999 else max(1.0, math.floor(held_qty * (target_pct / 100.0)))
        qty = min(held_qty, qty)
        if qty <= 0:
            return
        submit_limit = float(limit_price) if limit_price is not None else None
        if kind == "LMT" and submit_limit is None:
            book = simulate_top_of_book_from_quote(symbol, {"last_price": price})
            submit_limit = float(market_fill_price(book, "SELL", price) or price)
        result = await ib_service.place_order(
            symbol=symbol,
            side="SELL",
            quantity=qty,
            order_type=kind,
            limit_price=submit_limit,
        )
        if result.get("error"):
            _pm_log(f"IB SELL failed for {symbol}: {result['error']}")
            return
        await _record_ib_trade_submission(
            symbol=symbol,
            side="SELL",
            quantity=qty,
            reference_price=float(price or 0.0),
            result=result,
            ib_mode=ib_mode,
            strategy_name="ai_bot:sell",
        )
        _pm_log(
            f"IB SELL {symbol} x{qty:.4f} type={kind} "
            f"limit={('$' + format(submit_limit, '.2f')) if submit_limit is not None else '-'} ({reason})"
        )
    else:
        from app.services.top_of_book import market_fill_price, simulate_top_of_book_from_quote
        held_qty = float(pos.get("shares") or 0.0)
        if held_qty <= 0:
            return
        target_pct = min(100.0, max(1.0, float(size_pct or 100.0)))
        qty = held_qty if target_pct >= 99.999 else max(1.0, math.floor(held_qty * (target_pct / 100.0)))
        qty = min(held_qty, qty)
        if qty <= 0:
            return
        fill_price = price
        submit_limit = float(limit_price) if limit_price is not None else None
        if kind == "LMT":
            book = simulate_top_of_book_from_quote(symbol, {"last_price": price})
            touch_price = market_fill_price(book, "SELL", price)
            submit_limit = submit_limit if submit_limit is not None else touch_price
            if touch_price <= 0 or submit_limit is None or touch_price < submit_limit:
                _pm_log(f"SIM SELL {symbol} LMT not filled at ${submit_limit:.2f} (touch ${touch_price:.2f})")
                return
            fill_price = touch_price
        await _sim_trade(pos_id=pos["id"], side="SELL", price=fill_price, reason=reason, quantity=qty)
        _pm_log(
            f"SIM SELL {symbol} x{qty:.4f} type={kind} "
            f"limit={('$' + format(submit_limit, '.2f')) if submit_limit is not None else '-'} ({reason})"
        )
    _record_action(
        f"SELL {symbol} x{qty:.4f} type={kind} "
        f"limit={('$' + format(submit_limit, '.2f')) if submit_limit is not None else '-'} :: {reason}"
    )


async def _buy_position(*, pos: dict, price: float, reason: str, ib_mode: bool, ib_connected: bool,
                        account: dict, order_type: str = "market", limit_price: float | None = None,
                        size_pct: float | None = None, risk_level: str = "") -> None:
    symbol = pos["symbol"]
    if price <= 0:
        return
    kind = "LMT" if str(order_type or "market").strip().lower() == "limit" else "MKT"
    if ib_connected:
        from app.services.ib_service import ib_service
        from app.services.portfolio_manager import _position_max_allocation
        from app.services.top_of_book import market_fill_price, simulate_top_of_book_from_quote

        # Recreate a lightweight object only for sizing via the shared
        # allocation helper. For percent caps, use the same denominator style as
        # PM's IB path: prefer a positive equity-like base, then cash-like bases.
        base = float(
            account.get("cap_base")
            or account.get("equity")
            or account.get("total_funds")
            or account.get("available_funds")
            or account.get("buying_power")
            or 0.0
        )

        class _P:  # noqa: D401 - tiny shim with the attributes the helper reads
            pass
        shim = _P()
        shim.max_allocation_mode = pos.get("max_allocation_mode", "dollar")
        shim.max_allocation_value = pos.get("max_allocation_value", 0.0)
        shim.shares = pos.get("ib_qty", 0.0)
        shim.avg_cost = pos.get("avg_cost", 0.0)
        try:
            cap = _position_max_allocation(shim, base)
        except Exception:
            cap = 0.0
        available_funds = float(account.get("available_funds") or 0.0)
        buying_power = float(account.get("buying_power") or 0.0)
        # In IB paper accounts, AvailableFunds can intermittently report 0 while
        # BuyingPower remains valid. Use the best positive budget source.
        available_budget = max(available_funds, buying_power)

        # Cap-aware budget: always honour per-symbol allocation limits when set.
        if cap and cap != float("inf"):
            current_shares = float(pos.get("ib_qty") or pos.get("shares") or 0.0)
            ref_price = float(price or pos.get("avg_cost") or 0.0)
            used_value = max(0.0, current_shares * max(0.0, ref_price))
            remaining_room = max(0.0, cap - used_value)
            budget = min(remaining_room, available_budget)
        else:
            budget = available_budget

        target_pct = size_pct
        if target_pct is None:
            # Risk-driven default sizing when model omits explicit size.
            risk_defaults = {"low": 100.0, "medium": 60.0, "high": 35.0}
            target_pct = risk_defaults.get(str(risk_level or "").lower(), 100.0)
        target_pct = min(100.0, max(1.0, float(target_pct)))
        budget = budget * (target_pct / 100.0)

        qty = math.floor(budget / price)
        if qty <= 0:
            _pm_log(
                f"IB BUY skipped {symbol}: insufficient budget (${budget:.2f} @ ${price:.2f}) "
                f"[cap={('inf' if cap == float('inf') else f'${cap:.2f}')}, "
                f"available=${available_funds:.2f}, buying_power=${buying_power:.2f}]"
            )
            return
        submit_limit = float(limit_price) if limit_price is not None else None
        if kind == "LMT" and submit_limit is None:
            book = simulate_top_of_book_from_quote(symbol, {"last_price": price})
            submit_limit = float(market_fill_price(book, "BUY", price) or price)
        result = await ib_service.place_order(
            symbol=symbol,
            side="BUY",
            quantity=float(qty),
            order_type=kind,
            limit_price=submit_limit,
        )
        if result.get("error"):
            _pm_log(f"IB BUY failed for {symbol}: {result['error']}")
            return
        await _record_ib_trade_submission(
            symbol=symbol,
            side="BUY",
            quantity=float(qty),
            reference_price=float(price or 0.0),
            result=result,
            ib_mode=ib_mode,
            strategy_name="ai_bot:buy",
        )
        _pm_log(
            f"IB BUY {symbol} x{qty} type={kind} "
            f"limit={('$' + format(submit_limit, '.2f')) if submit_limit is not None else '-'} ({reason})"
        )
    else:
        from app.services.top_of_book import market_fill_price, simulate_top_of_book_from_quote
        # Sim mode: use per-position allocation room so AI can scale in.
        cap_mode = str(pos.get("max_allocation_mode") or "dollar").strip().lower()
        cap_val = float(pos.get("max_allocation_value") or 0.0)
        if cap_val <= 0.0:
            cap = float("inf")
        elif cap_mode == "percent":
            base = float(account.get("total_funds") or account.get("equity") or 0.0)
            cap = max(0.0, base * cap_val / 100.0)
        else:
            cap = max(0.0, cap_val)

        current_shares = float(pos.get("shares") or 0.0)
        ref_price = float(price or pos.get("avg_cost") or 0.0)
        used_value = max(0.0, current_shares * max(0.0, ref_price))
        remaining_room = max(0.0, cap - used_value) if cap != float("inf") else float(account.get("available_funds") or 0.0)
        available_budget = max(0.0, float(account.get("available_funds") or 0.0))
        budget = min(remaining_room, available_budget) if cap != float("inf") else available_budget

        target_pct = size_pct
        if target_pct is None:
            risk_defaults = {"low": 100.0, "medium": 60.0, "high": 35.0}
            target_pct = risk_defaults.get(str(risk_level or "").lower(), 100.0)
        target_pct = min(100.0, max(1.0, float(target_pct)))
        budget = budget * (target_pct / 100.0)

        qty = math.floor(budget / price)
        if qty <= 0:
            _pm_log(
                f"SIM BUY skipped {symbol}: insufficient allocation room (${budget:.2f} @ ${price:.2f})"
            )
            return

        fill_price = price
        submit_limit = float(limit_price) if limit_price is not None else None
        if kind == "LMT":
            book = simulate_top_of_book_from_quote(symbol, {"last_price": price})
            touch_price = market_fill_price(book, "BUY", price)
            submit_limit = submit_limit if submit_limit is not None else touch_price
            if touch_price <= 0 or submit_limit is None or touch_price > submit_limit:
                _pm_log(f"SIM BUY {symbol} LMT not filled at ${submit_limit:.2f} (touch ${touch_price:.2f})")
                return
            fill_price = touch_price
        await _sim_trade(pos_id=pos["id"], side="BUY", price=fill_price, reason=reason, quantity=float(qty))
        _pm_log(
            f"SIM BUY {symbol} x{qty} type={kind} "
            f"limit={('$' + format(submit_limit, '.2f')) if submit_limit is not None else '-'} ({reason})"
        )
    _record_action(
        f"BUY {symbol} type={kind} size={target_pct:.0f}% "
        f"limit={('$' + format(submit_limit, '.2f')) if submit_limit is not None else '-'} :: {reason}"
    )


async def _record_ib_trade_submission(*, symbol: str, side: str, quantity: float, reference_price: float,
                                      result: dict, ib_mode: str, strategy_name: str = "ai_bot") -> None:
    """Persist AI-bot IB order submissions to Trade rows for UI + PnL reconciliation."""
    if quantity <= 0:
        return
    try:
        from app.models.trade import Trade, TradingMode, OrderSide, OrderStatus

        status_raw = str(result.get("status") or "").upper()
        is_filled = status_raw == "FILLED"
        mode = TradingMode.LIVE if str(ib_mode or "").strip().lower() == "live" else TradingMode.PAPER
        side_enum = OrderSide.BUY if str(side).upper() == "BUY" else OrderSide.SELL

        async with AsyncSessionLocal() as db:
            db.add(Trade(
                symbol=str(symbol or "").upper(),
                side=side_enum,
                quantity=float(quantity),
                price=float(reference_price or 0.0),
                status=OrderStatus.FILLED if is_filled else OrderStatus.PENDING,
                mode=mode,
                ib_order_id=result.get("ib_order_id"),
                strategy_name=strategy_name,
                filled_at=datetime.now(timezone.utc) if is_filled else None,
            ))
            await db.commit()
    except Exception as exc:
        _pm_log(f"failed to persist IB {side} trade row for {symbol}: {exc}")


async def _sim_trade(*, pos_id: int, side: str, price: float, reason: str, quantity: float | None = None) -> None:
    """Route a simulated trade through the sandbox engine's executor."""
    from sqlalchemy import select as sa_select
    from app.models.sandbox import SandboxPosition
    from app.services.sandbox_engine import _execute_trade
    from app.services.top_of_book import simulate_top_of_book_from_quote

    async with AsyncSessionLocal() as db:
        res = await db.execute(sa_select(SandboxPosition).where(SandboxPosition.id == pos_id))
        pos = res.scalar_one_or_none()
        if not pos:
            return
    if quantity is not None and float(quantity) <= 0.0:
        return
    book = simulate_top_of_book_from_quote(pos.symbol, {"last_price": price})
    await _execute_trade(pos, side, price, f"ai_bot:{reason}", top_of_book=book, quantity_override=quantity)


# ── main loop ─────────────────────────────────────────────────────────────────── #

async def _run_once() -> None:
    settings = _get_settings()
    if not _is_ai_bot_active(settings):
        return

    # Determine execution mode.
    ib_connected = False
    ib_mode = str(getattr(app_settings, "TRADING_MODE", "paper") or "paper").lower()
    use_ib_execution = False
    try:
        from app.services.ib_service import ib_service
        ib_connected = ib_service.is_connected
        use_ib_execution = bool(ib_connected and ib_mode in {"paper", "live"})
    except Exception:
        ib_connected = False
        use_ib_execution = False

    _pm_log(f"execution mode={'IB' if use_ib_execution else 'SIM'} (trading_mode={ib_mode}, ib_connected={ib_connected})")

    from app.services.sandbox_engine import (
        _regular_session_is_open,
        _is_in_eod_sell_window,
        _is_in_pre_sell_engine_shutoff_window,
    )
    from app.services.portfolio_manager import (
        _state as pm_state,
        _current_trading_day_key_et,
        _cancel_bearish_pending_orders,
        _cancel_ib_pending_orders_price_moved,
    )

    try:
        await _cancel_bearish_pending_orders()
    except Exception as exc:
        logger.warning("AI bot pending-cancel check error: %s", exc)
    try:
        await _cancel_ib_pending_orders_price_moved()
    except Exception as exc:
        logger.warning("AI bot IB pending-cancel check error: %s", exc)

    positions = await _gather_watchlist_positions(use_ib_execution=use_ib_execution)
    if not positions:
        return
    symbols = [p["symbol"] for p in positions]
    quotes = await _gather_quotes(symbols)

    # Snapshot IB holdings so guardrails act on broker truth in IB mode.
    account = {
        "total_funds": 0.0,
        "available_funds": 0.0,
        "buying_power": 0.0,
        "equity": 0.0,
        "cap_base": 0.0,
    }
    if use_ib_execution:
        try:
            from app.services.ib_service import ib_service
            ib_positions = await ib_service.get_positions()
            ib_by_symbol = {
                str(r.get("symbol") or "").upper(): (
                    float(r.get("quantity") or 0.0), float(r.get("avg_cost") or 0.0)
                )
                for r in ib_positions
            }
            for p in positions:
                qty, avg = ib_by_symbol.get(p["symbol"], (0.0, 0.0))
                p["ib_qty"] = qty
                if qty > 0 and avg > 0:
                    p["avg_cost"] = avg
                p["shares"] = qty
            summary = await ib_service.get_account_summary()
            if isinstance(summary, dict) and not summary.get("error"):
                account["equity"] = _summary_num(summary, "NetLiquidation")
                account["available_funds"] = _summary_num(summary, "AvailableFunds")
                account["buying_power"] = _summary_num(summary, "BuyingPower")
                account["total_funds"] = account["equity"]
                # Use the first positive equity/cash metric as the allocation-cap base.
                for key in ("NetLiquidation", "TotalCashValue", "AvailableFunds"):
                    value = _summary_num(summary, key)
                    if value > 0.0:
                        account["cap_base"] = value
                        break
        except Exception as exc:
            logger.warning("AI bot IB snapshot failed: %s", exc)
    else:
        try:
            from sqlalchemy import select as sa_select
            from app.models.sandbox import SandboxAccount
            async with AsyncSessionLocal() as db:
                acct = (await db.execute(sa_select(SandboxAccount).limit(1))).scalar_one_or_none()
            if acct:
                account["total_funds"] = float(acct.total_funds or 0.0)
                account["equity"] = float(acct.total_funds or 0.0)
                account["available_funds"] = float(acct.total_funds or 0.0)
        except Exception:
            pass

    held = [p for p in positions if float(p.get("shares") or 0.0) > 0]

    # ── Guardrail 1: crash protection (hard) ─────────────────────────────────── #
    crash_active = await _enforce_crash_protection(
        settings=settings, account=account, held=held, quotes=quotes,
        ib_connected=use_ib_execution, ib_mode=ib_mode, pm_state=pm_state,
        trading_day=_current_trading_day_key_et(),
    )
    if crash_active:
        return

    # Only trade during the regular session.
    if not _regular_session_is_open():
        return

    hold_overnight = bool(settings.get("hold_positions_overnight", False))
    eod_window = int(settings.get("eod_sell_window_minutes", 5) or 5)
    shutoff = int(settings.get("eod_engine_shutoff_minutes_before_sell", 120) or 120)
    interval_s = max(30, int(settings.get("ai_bot_interval_s", 300) or 300))
    in_sell_window = (not hold_overnight) and _is_in_eod_sell_window(eod_window)
    in_shutoff = (not hold_overnight) and _is_in_pre_sell_engine_shutoff_window(eod_window, shutoff)

    # ── Guardrail 2: end-of-day liquidation (hard) ───────────────────────────── #
    if in_sell_window:
        # User safety override: AI bot must NOT auto-flatten positions during
        # final sell window. This avoids silent broker liquidations that bypass
        # AI-specific trade journaling semantics.
        now = datetime.now(timezone.utc)
        last_logged_raw = _state.get("last_eod_skip_log_at")
        should_log = True
        if isinstance(last_logged_raw, str) and last_logged_raw:
            try:
                last_logged = datetime.fromisoformat(last_logged_raw.replace("Z", "+00:00"))
                if last_logged.tzinfo is None:
                    last_logged = last_logged.replace(tzinfo=timezone.utc)
                should_log = (now - last_logged) >= timedelta(minutes=5)
            except Exception:
                should_log = True
        if should_log:
            _pm_log(
                f"final sell window active ({eod_window}m): AI auto-flatten disabled; "
                "holding existing positions unless explicit model/risk exits trigger"
            )
            _state["last_eod_skip_log_at"] = now.isoformat()
        return  # sell-window mode; AI does not auto-liquidate

    # ── Guardrail 3: stop-loss / take-profit (hard) ──────────────────────────── #
    risk_handled: set[str] = set()
    sl_pct = float(settings.get("stop_loss_pct", 0.0) or 0.0)
    tp_pct = float(settings.get("take_profit_pct", 0.0) or 0.0)
    sl_val = float(settings.get("stop_loss_value", 0.0) or 0.0)
    tp_val = float(settings.get("take_profit_value", 0.0) or 0.0)
    for p in held:
        price = quotes.get(p["symbol"], 0.0)
        avg = float(p.get("avg_cost") or 0.0)
        if price <= 0 or avg <= 0:
            continue
        sl_targets = []
        tp_targets = []
        if sl_pct > 0:
            sl_targets.append(avg * (1 - sl_pct / 100.0))
        if sl_val > 0:
            sl_targets.append(avg - sl_val)
        if tp_pct > 0:
            tp_targets.append(avg * (1 + tp_pct / 100.0))
        if tp_val > 0:
            tp_targets.append(avg + tp_val)
        sl_trigger = max(sl_targets) if sl_targets else None
        tp_trigger = min(tp_targets) if tp_targets else None
        if sl_trigger is not None and price <= sl_trigger:
            await _sell_position(pos=p, price=price, reason=f"stop_loss @ ${price:.2f}",
                                 ib_mode=ib_mode, ib_connected=use_ib_execution)
            risk_handled.add(p["symbol"])
        elif tp_trigger is not None and price >= tp_trigger:
            await _sell_position(pos=p, price=price, reason=f"take_profit @ ${price:.2f}",
                                 ib_mode=ib_mode, ib_connected=use_ib_execution)
            risk_handled.add(p["symbol"])

    # ── Model-driven discretionary decisions (within rails) ──────────────────── #
    bars: dict[str, dict] = {}
    if settings.get("ai_bot_use_local_1m", True):
        max_bars = int(settings.get("ai_bot_max_context_bars", 60) or 60)
        for sym in symbols:
            summary = await asyncio.to_thread(_summarise_1m_bars, sym, max_bars)
            if summary:
                bars[sym] = summary
    news = await _gather_news(symbols) if settings.get("ai_bot_use_news", True) else []
    regime_context = _build_regime_context(bars=bars, interval_s=interval_s)

    model = await _resolve_model(settings)
    _state["last_model"] = model
    runtime_constraints = _build_runtime_constraints(
        settings=settings,
        interval_s=interval_s,
        in_shutoff=in_shutoff,
        in_sell_window=in_sell_window,
        use_ib_execution=use_ib_execution,
        ib_mode=ib_mode,
        regime_context=regime_context,
    )
    user_prompt = _build_user_prompt(
        instruction=str(settings.get("ai_bot_prompt") or "Help me make money using the positions in watchlist."),
        account=account, positions=positions, quotes=quotes, bars=bars, news=news,
        today_actions=list(_state.get("today_actions") or []),
        runtime_constraints=runtime_constraints,
        regime_context=regime_context,
    )
    decisions = await _query_model(model, _SYSTEM_PROMPT, user_prompt, settings)
    decisions = _normalize_symbol_decisions(decisions, symbols)
    _state["last_decisions"] = decisions
    _log_decision_batch(decisions, symbols, model)

    pos_by_symbol = {p["symbol"]: p for p in positions}
    for d in decisions:
        symbol = d["symbol"]
        action = d["action"]
        order_type = str(d.get("order_type") or "market").lower()
        limit_price = d.get("limit_price")
        size_pct = d.get("size_pct")
        risk_level = str(d.get("risk_level") or "").strip().lower()
        reason = d["reason"] or action
        pos = pos_by_symbol.get(symbol)
        if not pos or action == "hold" or symbol in risk_handled:
            continue
        price = quotes.get(symbol, 0.0)
        if action == "buy":
            if in_shutoff or in_sell_window:
                continue  # no new entries near the close
            await _buy_position(pos=pos, price=price, reason=reason,
                                ib_mode=ib_mode, ib_connected=use_ib_execution,
                                account=account, order_type=order_type, limit_price=limit_price,
                                size_pct=size_pct, risk_level=risk_level)
        elif action == "sell":
            if float(pos.get("shares") or 0.0) <= 0:
                continue
            await _sell_position(pos=pos, price=price, reason=reason,
                                 ib_mode=ib_mode, ib_connected=use_ib_execution,
                                 order_type=order_type, limit_price=limit_price,
                                 size_pct=size_pct)


async def _enforce_crash_protection(*, settings: dict, account: dict, held: list[dict],
                                    quotes: dict, ib_connected: bool, ib_mode: str,
                                    pm_state: dict, trading_day: str) -> bool:
    """Liquidate + block for the day when the daily realised loss limit is hit.

    Returns True when crash protection is active (caller must stop trading).
    """
    # Honour an already-triggered crash for the current day.
    if pm_state.get("crash_triggered_day") == trading_day or pm_state.get("crash_shutdown_active"):
        return True
    if not bool(settings.get("crash_protection_enabled", False)):
        return False
    crash_value = max(0.0, float(settings.get("crash_protection_value", 0.0) or 0.0))
    if crash_value <= 0.0:
        return False
    crash_mode = "dollar" if str(settings.get("crash_protection_mode", "percent")).lower() == "dollar" else "percent"

    try:
        from app.services.portfolio_manager import (
            _get_today_simulated_realized_gain,
            _get_today_ib_realized_gain,
        )
        if ib_connected:
            daily_gain = await _get_today_ib_realized_gain(ib_mode)
        else:
            daily_gain = await _get_today_simulated_realized_gain()
    except Exception as exc:
        logger.warning("AI bot crash gain calc failed: %s", exc)
        return False

    baseline = float(account.get("equity") or account.get("total_funds") or 0.0)
    loss_threshold = (crash_value / 100.0 * baseline) if crash_mode == "percent" else crash_value
    if loss_threshold <= 0.0 or daily_gain > -loss_threshold:
        return False

    # Breached — liquidate everything and lock the day.
    pm_state["crash_triggered_day"] = trading_day
    pm_state["crash_triggered_at"] = datetime.now(timezone.utc).isoformat()
    pm_state["crash_trigger_reason"] = f"AI bot: daily realised ${daily_gain:.2f} breached -{loss_threshold:.2f}"
    pm_state["crash_last_triggered_day"] = trading_day
    pm_state["crash_shutdown_active"] = True
    _pm_log(f"crash protection triggered (daily realised ${daily_gain:.2f})")
    for p in held:
        price = quotes.get(p["symbol"], 0.0)
        try:
            await _sell_position(pos=p, price=price, reason="crash_protection",
                                 ib_mode=ib_mode, ib_connected=ib_connected)
        except Exception as exc:
            logger.warning("AI bot crash liquidation failed for %s: %s", p["symbol"], exc)
    return True


def _get_settings() -> dict:
    from app.services.portfolio_manager import get_manager_settings
    return get_manager_settings()


def _is_ai_bot_active(settings: dict) -> bool:
    return bool(settings.get("enabled", False)) and bool(settings.get("ai_bot_enabled", False))


def _maybe_reset_session() -> None:
    """Clear the working session at each trading-day rollover."""
    import zoneinfo
    et = zoneinfo.ZoneInfo("America/New_York")
    today = datetime.now(tz=et).date().isoformat()
    if _state.get("session_day") != today:
        _state["session_day"] = today
        _state["today_actions"] = []
        _state["last_decisions"] = []
        _state["session_cycle_count"] = 0
        if _state.get("running"):
            _pm_log(f"session reset for {today}")


async def run_ai_bot() -> None:
    """Long-running coroutine — start as an asyncio task from app lifespan."""
    _state["running"] = True
    logger.info("AI trade bot task started.")
    # Allow the rest of the app (DB, PM settings) to initialise first.
    await asyncio.sleep(15)
    last_run = 0.0
    while True:
        await asyncio.sleep(10)
        _maybe_reset_session()
        try:
            settings = _get_settings()
        except Exception:
            continue
        if not _is_ai_bot_active(settings):
            continue
        try:
            await _emit_daily_summary_if_due()
        except Exception as exc:
            logger.warning("AI bot daily summary failed: %s", exc)
        interval = max(30, int(settings.get("ai_bot_interval_s", 300) or 300))
        now = asyncio.get_event_loop().time()
        if now - last_run < interval:
            continue
        last_run = now
        try:
            await _run_once()
            _state["session_cycle_count"] = int(_state.get("session_cycle_count") or 0) + 1
            _state["last_run_at"] = datetime.now(timezone.utc).isoformat()
            _state["last_error"] = None
        except httpx.ConnectError:
            _state["last_error"] = _provider_connection_error_message(settings)
            logger.warning("AI bot: model provider connection error")
            _pm_log(_state["last_error"])
        except httpx.HTTPStatusError as exc:
            provider_cfg = _provider_settings(settings)
            _state["last_error"] = (
                f"{_provider_label(provider_cfg['provider'])} request failed with HTTP {exc.response.status_code}."
            )
            logger.warning("AI bot: provider HTTP error: %s", exc)
            _pm_log(_state["last_error"])
        except httpx.TimeoutException:
            provider_cfg = _provider_settings(settings)
            _state["last_error"] = f"{_provider_label(provider_cfg['provider'])} timed out while generating a response."
            logger.warning("AI bot: provider timeout")
            _pm_log(_state["last_error"])
        except Exception as exc:
            _state["last_error"] = str(exc)
            logger.exception("AI bot run error")
            _pm_log(f"run error: {_state['last_error']}")
