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
from datetime import datetime, timezone

import httpx

from app.config import settings as app_settings
from app.database import AsyncSessionLocal

logger = logging.getLogger(__name__)

_OLLAMA_TIMEOUT = 120.0
_FALLBACK_MODEL = "llama3.2"
_MAX_TODAY_ACTIONS = 20          # bounded history fed back into the prompt
_MAX_NEWS_ITEMS = 8

# Generation options — keep the context window small so the model stays fast
# and the prompt cannot grow unbounded across the trading day.
_OLLAMA_OPTIONS = {
    "num_ctx": 8192,
    "temperature": 0.2,
    "num_predict": 1024,
}

_SYSTEM_PROMPT = """\
You are an automated intraday trading assistant for a watchlist of US equities.
You are given the current account, each watchlist position, recent 1-minute
price bars, and related financial news. Decide what to do with each symbol.

Hard rules enforced by the platform (you cannot override them):
- Stop-loss / take-profit, end-of-day liquidation, and crash protection are
  applied automatically. Do not fight them.
- Only long positions are supported (BUY to open/add, SELL to close). No shorts.

Respond with STRICT JSON only, no prose, in exactly this shape:
{"decisions":[{"symbol":"TICKER","action":"buy|sell|hold","reason":"short reason"}]}

Guidance:
- "buy"  = open or add to a long position when the edge looks favourable.
- "sell" = close an existing long position.
- "hold" = take no action this cycle.
- Only include symbols from the provided watchlist. Keep reasons under 140 chars.
"""

# ── runtime state ──────────────────────────────────────────────────────────── #

_state: dict[str, object] = {
    "running": False,
    "session_day": None,        # ET date string of the current working session
    "last_run_at": None,
    "last_error": None,
    "last_model": None,
    "today_actions": [],        # bounded list of executed actions this session
    "last_decisions": [],       # raw decisions from the most recent model call
}


def get_state() -> dict:
    """Return a JSON-serialisable snapshot of the AI bot runtime state."""
    return {
        "running": bool(_state.get("running")),
        "session_day": _state.get("session_day"),
        "last_run_at": _state.get("last_run_at"),
        "last_error": _state.get("last_error"),
        "last_model": _state.get("last_model"),
        "today_actions": list(_state.get("today_actions") or [])[:_MAX_TODAY_ACTIONS],
        "last_decisions": list(_state.get("last_decisions") or []),
    }


# ── Ollama helpers ───────────────────────────────────────────────────────────── #

def _ollama_base() -> str:
    return str(getattr(app_settings, "OLLAMA_HOST", "http://localhost:11434") or "http://localhost:11434").rstrip("/")


async def list_installed_models() -> list[str]:
    """Return the list of model tags installed in the local Ollama server."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{_ollama_base()}/api/tags")
            resp.raise_for_status()
            data = resp.json()
        models = []
        for item in data.get("models", []) or []:
            name = str(item.get("name") or item.get("model") or "").strip()
            if name:
                models.append(name)
        return sorted(set(models))
    except Exception as exc:
        logger.debug("AI bot: could not list Ollama models: %s", exc)
        return []


async def _resolve_model(configured: str) -> str:
    """Pick the model to use: the configured one if installed, else first local."""
    configured = (configured or "").strip()
    installed = await list_installed_models()
    if configured and (configured in installed or not installed):
        return configured
    if installed:
        return installed[0]
    return _FALLBACK_MODEL


async def _query_model(model: str, system_prompt: str, user_prompt: str) -> list[dict]:
    """Call Ollama and parse a strict-JSON list of decisions."""
    payload = {
        "model": model,
        "prompt": user_prompt,
        "system": system_prompt,
        "stream": False,
        "format": "json",
        "options": _OLLAMA_OPTIONS,
    }
    async with httpx.AsyncClient(timeout=_OLLAMA_TIMEOUT) as client:
        resp = await client.post(f"{_ollama_base()}/api/generate", json=payload)
        resp.raise_for_status()
        body = resp.json()
    raw = str(body.get("response") or "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("AI bot: model returned non-JSON output; ignoring this cycle")
        return []
    decisions = parsed.get("decisions") if isinstance(parsed, dict) else parsed
    if not isinstance(decisions, list):
        return []
    cleaned: list[dict] = []
    for d in decisions:
        if not isinstance(d, dict):
            continue
        symbol = str(d.get("symbol") or "").strip().upper()
        action = str(d.get("action") or "hold").strip().lower()
        if not symbol or action not in {"buy", "sell", "hold"}:
            continue
        cleaned.append({
            "symbol": symbol,
            "action": action,
            "reason": str(d.get("reason") or "")[:140],
        })
    return cleaned


# ── context gathering ────────────────────────────────────────────────────────── #

async def _gather_watchlist_positions() -> list[dict]:
    from sqlalchemy import select as sa_select
    from app.models.sandbox import SandboxPosition

    async with AsyncSessionLocal() as db:
        res = await db.execute(
            sa_select(SandboxPosition).where(SandboxPosition.is_on_watchlist == True)  # noqa: E712
        )
        rows = res.scalars().all()
    return [
        {
            "id": int(p.id),
            "symbol": str(p.symbol or "").upper(),
            "shares": float(p.shares or 0.0),
            "avg_cost": float(p.avg_cost or 0.0),
            "allocated_funds": float(p.allocated_funds or 0.0),
            "max_allocation_mode": str(p.max_allocation_mode or "dollar"),
            "max_allocation_value": float(p.max_allocation_value or 0.0),
        }
        for p in rows
        if str(p.symbol or "").strip()
    ]


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
        closes = [r["close"] for r in recent if r.get("close") is not None]
        if not closes:
            return None
        first, last = closes[0], closes[-1]
        change_pct = ((last - first) / first * 100.0) if first else 0.0
        return {
            "bars": len(recent),
            "first_close": round(first, 4),
            "last_close": round(last, 4),
            "high": round(max(r["high"] for r in recent if r.get("high") is not None), 4),
            "low": round(min(r["low"] for r in recent if r.get("low") is not None), 4),
            "change_pct": round(change_pct, 3),
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


def _build_user_prompt(*, instruction: str, account: dict, positions: list[dict],
                       quotes: dict[str, float], bars: dict[str, dict],
                       news: list[dict], today_actions: list[dict]) -> str:
    lines: list[str] = []
    lines.append(f"User instruction: {instruction}")
    lines.append("")
    lines.append(f"Account: {json.dumps(account, default=str)}")
    lines.append("")
    lines.append("Watchlist positions:")
    for p in positions:
        sym = p["symbol"]
        price = quotes.get(sym)
        bar = bars.get(sym)
        lines.append(
            f"- {sym}: shares={p['shares']:.4f} avg_cost={p['avg_cost']:.4f} "
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
    lines.append("Return JSON decisions for the watchlist symbols now.")
    return "\n".join(lines)


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


async def _sell_position(*, pos: dict, price: float, reason: str, ib_mode: bool, ib_connected: bool) -> None:
    """Flatten a single long position via IB (if connected) or the sim engine."""
    symbol = pos["symbol"]
    if ib_connected:
        from app.services.ib_service import ib_service
        qty = float(pos.get("ib_qty") or pos.get("shares") or 0.0)
        if qty <= 0:
            return
        result = await ib_service.place_order(symbol=symbol, side="SELL", quantity=qty, order_type="MKT")
        if result.get("error"):
            _pm_log(f"IB SELL failed for {symbol}: {result['error']}")
            return
        _pm_log(f"IB SELL {symbol} x{qty:.4f} ({reason})")
    else:
        await _sim_trade(pos_id=pos["id"], side="SELL", price=price, reason=reason)
        _pm_log(f"SIM SELL {symbol} ({reason})")
    _record_action(f"SELL {symbol} :: {reason}")


async def _buy_position(*, pos: dict, price: float, reason: str, ib_mode: bool, ib_connected: bool,
                        account: dict) -> None:
    symbol = pos["symbol"]
    if price <= 0:
        return
    if ib_connected:
        from app.services.ib_service import ib_service
        from app.services.portfolio_manager import _position_max_allocation

        # Recreate a lightweight ORM-like object only for sizing via the shared
        # allocation helper, using the account net-liquidation as the base.
        base = float(account.get("equity") or account.get("total_funds") or 0.0)

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
        avail = float(account.get("available_funds") or 0.0)
        budget = min(cap, avail) if cap and cap != float("inf") else avail
        if budget <= 0:
            budget = avail
        import math
        qty = math.floor(budget / price)
        if qty <= 0:
            _pm_log(f"IB BUY skipped {symbol}: insufficient budget (${budget:.2f} @ ${price:.2f})")
            return
        result = await ib_service.place_order(symbol=symbol, side="BUY", quantity=float(qty), order_type="MKT")
        if result.get("error"):
            _pm_log(f"IB BUY failed for {symbol}: {result['error']}")
            return
        _pm_log(f"IB BUY {symbol} x{qty} ({reason})")
    else:
        await _sim_trade(pos_id=pos["id"], side="BUY", price=price, reason=reason)
        _pm_log(f"SIM BUY {symbol} ({reason})")
    _record_action(f"BUY {symbol} :: {reason}")


async def _sim_trade(*, pos_id: int, side: str, price: float, reason: str) -> None:
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
    book = simulate_top_of_book_from_quote(pos.symbol, {"last_price": price})
    await _execute_trade(pos, side, price, f"ai_bot:{reason}", top_of_book=book)


# ── main loop ─────────────────────────────────────────────────────────────────── #

async def _run_once() -> None:
    settings = _get_settings()
    if not settings.get("ai_bot_enabled"):
        return

    # Determine execution mode.
    ib_connected = False
    ib_mode = str(getattr(app_settings, "TRADING_MODE", "paper") or "paper").lower()
    try:
        from app.services.ib_service import ib_service
        ib_connected = ib_service.is_connected
    except Exception:
        ib_connected = False

    from app.services.sandbox_engine import (
        _regular_session_is_open,
        _is_in_eod_sell_window,
        _is_in_pre_sell_engine_shutoff_window,
    )
    from app.services.portfolio_manager import _state as pm_state, _current_trading_day_key_et

    positions = await _gather_watchlist_positions()
    if not positions:
        return
    symbols = [p["symbol"] for p in positions]
    quotes = await _gather_quotes(symbols)

    # Snapshot IB holdings so guardrails act on broker truth in IB mode.
    account = {"total_funds": 0.0, "available_funds": 0.0, "equity": 0.0}
    if ib_connected:
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
                account["equity"] = float(summary.get("NetLiquidation") or 0.0)
                account["available_funds"] = float(summary.get("AvailableFunds") or 0.0)
                account["total_funds"] = account["equity"]
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
        ib_connected=ib_connected, ib_mode=ib_mode, pm_state=pm_state,
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
    in_sell_window = (not hold_overnight) and _is_in_eod_sell_window(eod_window)
    in_shutoff = (not hold_overnight) and _is_in_pre_sell_engine_shutoff_window(eod_window, shutoff)

    # ── Guardrail 2: end-of-day liquidation (hard) ───────────────────────────── #
    if in_sell_window:
        for p in held:
            price = quotes.get(p["symbol"], 0.0)
            await _sell_position(pos=p, price=price, reason="eod_liquidation",
                                 ib_mode=ib_mode, ib_connected=ib_connected)
        return  # sell-only mode; do not consult the model

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
                                 ib_mode=ib_mode, ib_connected=ib_connected)
            risk_handled.add(p["symbol"])
        elif tp_trigger is not None and price >= tp_trigger:
            await _sell_position(pos=p, price=price, reason=f"take_profit @ ${price:.2f}",
                                 ib_mode=ib_mode, ib_connected=ib_connected)
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

    model = await _resolve_model(str(settings.get("ai_bot_model", "")))
    _state["last_model"] = model
    user_prompt = _build_user_prompt(
        instruction=str(settings.get("ai_bot_prompt") or "Help me make money using the positions in watchlist."),
        account=account, positions=positions, quotes=quotes, bars=bars, news=news,
        today_actions=list(_state.get("today_actions") or []),
    )
    decisions = await _query_model(model, _SYSTEM_PROMPT, user_prompt)
    _state["last_decisions"] = decisions

    pos_by_symbol = {p["symbol"]: p for p in positions}
    for d in decisions:
        symbol = d["symbol"]
        action = d["action"]
        reason = d["reason"] or action
        pos = pos_by_symbol.get(symbol)
        if not pos or action == "hold" or symbol in risk_handled:
            continue
        price = quotes.get(symbol, 0.0)
        if action == "buy":
            if in_shutoff or in_sell_window:
                continue  # no new entries near the close
            if float(pos.get("shares") or 0.0) > 0:
                continue  # already long; bot adds via fresh symbols only
            await _buy_position(pos=pos, price=price, reason=reason,
                                ib_mode=ib_mode, ib_connected=ib_connected, account=account)
        elif action == "sell":
            if float(pos.get("shares") or 0.0) <= 0:
                continue
            await _sell_position(pos=pos, price=price, reason=reason,
                                 ib_mode=ib_mode, ib_connected=ib_connected)


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


def _maybe_reset_session() -> None:
    """Clear the working session at each trading-day rollover."""
    import zoneinfo
    et = zoneinfo.ZoneInfo("America/New_York")
    today = datetime.now(tz=et).date().isoformat()
    if _state.get("session_day") != today:
        _state["session_day"] = today
        _state["today_actions"] = []
        _state["last_decisions"] = []
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
        if not settings.get("ai_bot_enabled"):
            continue
        interval = max(30, int(settings.get("ai_bot_interval_s", 300) or 300))
        now = asyncio.get_event_loop().time()
        if now - last_run < interval:
            continue
        last_run = now
        try:
            await _run_once()
            _state["last_run_at"] = datetime.now(timezone.utc).isoformat()
            _state["last_error"] = None
        except httpx.ConnectError:
            _state["last_error"] = "Cannot reach Ollama. Is it running on the configured host?"
            logger.warning("AI bot: Ollama connection error")
        except Exception as exc:
            _state["last_error"] = str(exc)
            logger.exception("AI bot run error")
