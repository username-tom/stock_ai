"""Chart-building helpers for backtest HTML reports.

This module is intentionally private to the `services` package.  All public
surface lives in `reporter.py`, which calls these functions.
"""
from __future__ import annotations

import base64
import io
from datetime import datetime

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates


# ---------------------------------------------------------------------------
# Indicator detection helpers
# ---------------------------------------------------------------------------

_OSCILLATOR_KEYS = {"rsi", "macd", "macd_signal", "macd_hist"}
_BAND_KEYS = {"upper", "lower", "mid"}
_MA_KEYS = {"fast_ma", "slow_ma"}


def detect_indicators(ohlcv: list[dict]) -> dict[str, list]:
    """Return a dict of present indicator series from the ohlcv list."""
    if not ohlcv:
        return {}
    sample = ohlcv[0]
    found: dict[str, list] = {}
    for key in sample:
        if key in {"date", "open", "high", "low", "close", "volume", "signal"}:
            continue
        values = [o.get(key) for o in ohlcv]
        if any(v is not None for v in values):
            found[key] = values
    return found


def subplot_layout(indicators: dict[str, list]) -> tuple[int, list[str]]:
    """Return (n_rows, oscillator_panel_keys)."""
    oscillator_panels: list[str] = []
    if "rsi" in indicators:
        oscillator_panels.append("rsi")
    if "macd" in indicators:
        oscillator_panels.append("macd")
    return 1 + len(oscillator_panels), oscillator_panels


# ---------------------------------------------------------------------------
# Dark-theme style helper
# ---------------------------------------------------------------------------

def apply_dark_style(fig, axes) -> None:
    fig.patch.set_facecolor("#0f172a")
    for ax in axes:
        ax.set_facecolor("#1e293b")
        ax.tick_params(colors="#94a3b8")
        ax.xaxis.label.set_color("#94a3b8")
        ax.yaxis.label.set_color("#94a3b8")
        ax.title.set_color("#e2e8f0")
        for spine in ax.spines.values():
            spine.set_edgecolor("#334155")
        ax.grid(True, alpha=0.2, color="#334155")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _to_nan_array(values: list) -> np.ndarray:
    return np.array([v if v is not None else np.nan for v in values], dtype=float)


def _fig_to_b64(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


# ---------------------------------------------------------------------------
# Axis builder (shared between full and zoomed charts)
# ---------------------------------------------------------------------------

def build_price_axes(
    fig,
    axes,
    dates,
    closes,
    indicators,
    buy_dates,
    buy_prices,
    sell_dates,
    sell_prices,
    title: str = "Price Chart with Trade Signals",
    x_locator=None,
    x_formatter=None,
) -> None:
    ax_price = axes[0]
    ax_price.plot(dates, closes, color="#94a3b8", linewidth=1, label="Close")

    if "upper" in indicators and "lower" in indicators:
        upper = _to_nan_array(indicators["upper"])
        lower = _to_nan_array(indicators["lower"])
        mid_raw = indicators.get("mid")
        ax_price.plot(dates, upper, color="#60a5fa", linewidth=0.8,
                      linestyle="--", label="BB Upper", alpha=0.8)
        ax_price.plot(dates, lower, color="#f472b6", linewidth=0.8,
                      linestyle="--", label="BB Lower", alpha=0.8)
        if mid_raw:
            ax_price.plot(dates, _to_nan_array(mid_raw), color="#fbbf24",
                          linewidth=0.8, linestyle=":", label="BB Mid", alpha=0.8)
        valid = ~(np.isnan(upper) | np.isnan(lower))
        ax_price.fill_between(dates, upper, lower, where=valid, alpha=0.06, color="#60a5fa")

    if "fast_ma" in indicators:
        ax_price.plot(dates, _to_nan_array(indicators["fast_ma"]), color="#facc15",
                      linewidth=0.9, label="Fast MA", alpha=0.9)
    if "slow_ma" in indicators:
        ax_price.plot(dates, _to_nan_array(indicators["slow_ma"]), color="#fb923c",
                      linewidth=0.9, label="Slow MA", alpha=0.9)

    if buy_dates:
        ax_price.scatter(buy_dates, buy_prices, marker="^", color="#4ade80",
                         s=70, zorder=5, label="Buy")
    if sell_dates:
        ax_price.scatter(sell_dates, sell_prices, marker="v", color="#f87171",
                         s=70, zorder=5, label="Sell")

    ax_price.set_title(title, fontsize=13)
    ax_price.set_ylabel("Price ($)")
    ax_price.legend(fontsize=7, loc="upper left",
                    facecolor="#1e293b", edgecolor="#334155", labelcolor="#e2e8f0")

    _, oscillator_panels = subplot_layout(indicators)
    for panel_idx, panel_key in enumerate(oscillator_panels):
        ax_osc = axes[1 + panel_idx]
        if panel_key == "rsi":
            rsi_arr = _to_nan_array(indicators["rsi"])
            ax_osc.plot(dates, rsi_arr, color="#a78bfa", linewidth=1, label="RSI")
            ax_osc.axhline(70, color="#f87171", linewidth=0.7, linestyle="--", alpha=0.7)
            ax_osc.axhline(30, color="#4ade80", linewidth=0.7, linestyle="--", alpha=0.7)
            valid_rsi = ~np.isnan(rsi_arr)
            ax_osc.fill_between(dates, rsi_arr, 70,
                                 where=valid_rsi & (rsi_arr >= 70), alpha=0.2, color="#f87171")
            ax_osc.fill_between(dates, rsi_arr, 30,
                                 where=valid_rsi & (rsi_arr <= 30), alpha=0.2, color="#4ade80")
            ax_osc.set_ylabel("RSI")
            ax_osc.set_ylim(0, 100)
            ax_osc.legend(fontsize=7, loc="upper left",
                           facecolor="#1e293b", edgecolor="#334155", labelcolor="#e2e8f0")
        elif panel_key == "macd":
            macd_raw      = indicators.get("macd", [])
            macd_sig_raw  = indicators.get("macd_signal", [])
            macd_hist_raw = indicators.get("macd_hist", [])
            if macd_raw:
                ax_osc.plot(dates, _to_nan_array(macd_raw), color="#60a5fa",
                             linewidth=1, label="MACD")
            if macd_sig_raw:
                ax_osc.plot(dates, _to_nan_array(macd_sig_raw), color="#f97316",
                             linewidth=0.9, linestyle="--", label="Signal")
            if macd_hist_raw:
                hist_arr = _to_nan_array(macd_hist_raw)
                colors = ["#4ade80" if (not np.isnan(v) and v >= 0) else "#f87171"
                          for v in hist_arr]
                ax_osc.bar(dates, hist_arr, color=colors, alpha=0.5,
                           width=1.5, label="Histogram")
            ax_osc.axhline(0, color="#475569", linewidth=0.7)
            ax_osc.set_ylabel("MACD")
            ax_osc.legend(fontsize=7, loc="upper left",
                           facecolor="#1e293b", edgecolor="#334155", labelcolor="#e2e8f0")

    bottom_ax = axes[-1]
    bottom_ax.xaxis.set_major_formatter(x_formatter or mdates.DateFormatter("%Y-%m"))
    bottom_ax.xaxis.set_major_locator(x_locator or mdates.MonthLocator(interval=3))
    plt.setp(bottom_ax.xaxis.get_majorticklabels(), rotation=45, ha="right")
    for ax in axes[:-1]:
        plt.setp(ax.xaxis.get_majorticklabels(), visible=False)


# ---------------------------------------------------------------------------
# Public chart builders
# ---------------------------------------------------------------------------

def equity_chart_b64(equity_curve: list[dict]) -> str:
    dates  = [datetime.strptime(e["date"], "%Y-%m-%d") for e in equity_curve]
    values = [e["value"] for e in equity_curve]

    fig, ax = plt.subplots(figsize=(12, 4))
    ax.plot(dates, values, color="#4ade80", linewidth=1.5)
    ax.fill_between(dates, values, min(values), alpha=0.15, color="#4ade80")
    ax.set_title("Portfolio Equity Curve", fontsize=14)
    ax.set_xlabel("Date")
    ax.set_ylabel("Portfolio Value ($)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
    plt.xticks(rotation=45)
    apply_dark_style(fig, [ax])
    fig.tight_layout()
    return _fig_to_b64(fig)


def price_chart_b64(ohlcv: list[dict], trades: list[dict]) -> str:
    dates  = [datetime.strptime(o["date"], "%Y-%m-%d") for o in ohlcv]
    closes = [o["close"] for o in ohlcv]
    indicators = detect_indicators(ohlcv)

    buy_dates   = [datetime.strptime(t["entry_date"], "%Y-%m-%d") for t in trades]
    buy_prices  = [t["entry_price"] for t in trades]
    sell_dates  = [datetime.strptime(t["exit_date"],  "%Y-%m-%d") for t in trades]
    sell_prices = [t["exit_price"]  for t in trades]

    n_rows, oscillator_panels = subplot_layout(indicators)
    heights = [3] + [1] * len(oscillator_panels)
    fig, axes_raw = plt.subplots(
        n_rows, 1, figsize=(12, 3 + 2 * n_rows),
        sharex=True, gridspec_kw={"height_ratios": heights},
    )
    axes = [axes_raw] if n_rows == 1 else list(axes_raw)

    build_price_axes(fig, axes, dates, closes, indicators,
                     buy_dates, buy_prices, sell_dates, sell_prices)
    apply_dark_style(fig, axes)
    fig.tight_layout()
    return _fig_to_b64(fig)


def trade_chart_b64(ohlcv: list[dict], trade: dict, context_days: int = 5) -> str:
    """Zoomed chart for a single trade with `context_days` padding."""
    all_dates_str = [o["date"] for o in ohlcv]
    entry_str = trade["entry_date"]
    exit_str  = trade["exit_date"]

    try:
        entry_idx = all_dates_str.index(entry_str)
    except ValueError:
        entry_idx = 0
    try:
        exit_idx = all_dates_str.index(exit_str)
    except ValueError:
        exit_idx = len(ohlcv) - 1

    start_idx = max(0, entry_idx - context_days)
    end_idx   = min(len(ohlcv) - 1, exit_idx + context_days)
    subset    = ohlcv[start_idx: end_idx + 1]

    dates      = [datetime.strptime(o["date"], "%Y-%m-%d") for o in subset]
    closes     = [o["close"] for o in subset]
    indicators = detect_indicators(subset)

    entry_dt = datetime.strptime(entry_str, "%Y-%m-%d")
    exit_dt  = datetime.strptime(exit_str,  "%Y-%m-%d")

    n_rows, oscillator_panels = subplot_layout(indicators)
    heights = [3] + [1] * len(oscillator_panels)
    fig, axes_raw = plt.subplots(
        n_rows, 1, figsize=(10, 3 + 2 * n_rows),
        sharex=True, gridspec_kw={"height_ratios": heights},
    )
    axes = [axes_raw] if n_rows == 1 else list(axes_raw)

    pnl_color = "#4ade80" if trade.get("pnl", 0) >= 0 else "#f87171"
    pnl_sign  = "+" if trade.get("pnl", 0) >= 0 else ""
    title = (
        f"Trade Detail  |  Entry: {entry_str} @ ${trade['entry_price']:.4f}"
        f"  →  Exit: {exit_str} @ ${trade['exit_price']:.4f}"
        f"  |  P&L: {pnl_sign}${trade['pnl']:,.2f}"
    )

    build_price_axes(
        fig, axes, dates, closes, indicators,
        [entry_dt], [trade["entry_price"]],
        [exit_dt],  [trade["exit_price"]],
        title=title,
        x_locator=mdates.AutoDateLocator(),
        x_formatter=mdates.DateFormatter("%b %d"),
    )

    axes[0].axvspan(entry_dt, exit_dt, alpha=0.12, color=pnl_color, zorder=0)
    apply_dark_style(fig, axes)
    fig.tight_layout()
    return _fig_to_b64(fig)
