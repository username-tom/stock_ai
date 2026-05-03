"""
Report generator: produces HTML reports from backtest results.
"""
from __future__ import annotations

import base64
import io
import os
from datetime import datetime
from typing import Any

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from app.config import settings

# ---------------------------------------------------------------------------
# Indicator detection helpers
# ---------------------------------------------------------------------------

_OSCILLATOR_KEYS = {"rsi", "macd", "macd_signal", "macd_hist"}
_BAND_KEYS = {"upper", "lower", "mid"}
_MA_KEYS = {"fast_ma", "slow_ma"}


def _detect_indicators(ohlcv: list[dict]) -> dict[str, list]:
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


def _subplot_layout(indicators: dict[str, list]) -> tuple[int, list[str]]:
    """
    Decide how many subplot rows are needed and which oscillator panels to add.
    Returns (n_rows, oscillator_panel_keys).
    """
    has_rsi = "rsi" in indicators
    has_macd = "macd" in indicators
    oscillator_panels: list[str] = []
    if has_rsi:
        oscillator_panels.append("rsi")
    if has_macd:
        oscillator_panels.append("macd")
    n_rows = 1 + len(oscillator_panels)
    return n_rows, oscillator_panels


# ---------------------------------------------------------------------------
# Dark-theme style helper
# ---------------------------------------------------------------------------

def _apply_dark_style(fig, axes):
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
# Chart builders
# ---------------------------------------------------------------------------

def _equity_chart_b64(equity_curve: list[dict]) -> str:
    dates = [datetime.strptime(e["date"], "%Y-%m-%d") for e in equity_curve]
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
    _apply_dark_style(fig, [ax])
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


def _to_nan_array(values: list) -> "np.ndarray":
    """Convert a list that may contain None to a float numpy array with NaN for missing."""
    return np.array([v if v is not None else np.nan for v in values], dtype=float)


def _build_price_axes(fig, axes, dates, closes, indicators,
                      buy_dates, buy_prices, sell_dates, sell_prices,
                      title="Price Chart with Trade Signals",
                      x_locator=None, x_formatter=None):
    """Populate price + indicator sub-axes (shared logic for full & zoomed charts)."""
    ax_price = axes[0]
    ax_price.plot(dates, closes, color="#94a3b8", linewidth=1, label="Close")

    # Bollinger Bands / band overlays
    if "upper" in indicators and "lower" in indicators:
        upper = _to_nan_array(indicators["upper"])
        lower = _to_nan_array(indicators["lower"])
        mid_raw = indicators.get("mid")
        ax_price.plot(dates, upper, color="#60a5fa", linewidth=0.8,
                      linestyle="--", label="BB Upper", alpha=0.8)
        ax_price.plot(dates, lower, color="#f472b6", linewidth=0.8,
                      linestyle="--", label="BB Lower", alpha=0.8)
        if mid_raw:
            ax_price.plot(dates, _to_nan_array(mid_raw), color="#fbbf24", linewidth=0.8,
                          linestyle=":", label="BB Mid", alpha=0.8)
        valid = ~(np.isnan(upper) | np.isnan(lower))
        ax_price.fill_between(dates, upper, lower, where=valid, alpha=0.06, color="#60a5fa")

    # Moving averages
    if "fast_ma" in indicators:
        ax_price.plot(dates, _to_nan_array(indicators["fast_ma"]), color="#facc15",
                      linewidth=0.9, label="Fast MA", alpha=0.9)
    if "slow_ma" in indicators:
        ax_price.plot(dates, _to_nan_array(indicators["slow_ma"]), color="#fb923c",
                      linewidth=0.9, label="Slow MA", alpha=0.9)

    # Trade markers
    if buy_dates:
        ax_price.scatter(buy_dates, buy_prices, marker="^", color="#4ade80",
                         s=70, zorder=5, label="Buy")
    if sell_dates:
        ax_price.scatter(sell_dates, sell_prices, marker="v", color="#f87171",
                         s=70, zorder=5, label="Sell")

    ax_price.set_title(title, fontsize=13)
    ax_price.set_ylabel("Price ($)")
    ax_price.legend(fontsize=7, loc="upper left",
                    facecolor="#1e293b", edgecolor="#334155",
                    labelcolor="#e2e8f0")

    n_rows, oscillator_panels = _subplot_layout(indicators)

    for panel_idx, panel_key in enumerate(oscillator_panels):
        ax_osc = axes[1 + panel_idx]
        if panel_key == "rsi":
            rsi_arr = _to_nan_array(indicators["rsi"])
            ax_osc.plot(dates, rsi_arr, color="#a78bfa", linewidth=1, label="RSI")
            ax_osc.axhline(70, color="#f87171", linewidth=0.7, linestyle="--", alpha=0.7)
            ax_osc.axhline(30, color="#4ade80", linewidth=0.7, linestyle="--", alpha=0.7)
            valid_rsi = ~np.isnan(rsi_arr)
            ax_osc.fill_between(dates, rsi_arr, 70,
                                 where=valid_rsi & (rsi_arr >= 70),
                                 alpha=0.2, color="#f87171")
            ax_osc.fill_between(dates, rsi_arr, 30,
                                 where=valid_rsi & (rsi_arr <= 30),
                                 alpha=0.2, color="#4ade80")
            ax_osc.set_ylabel("RSI")
            ax_osc.set_ylim(0, 100)
            ax_osc.legend(fontsize=7, loc="upper left",
                           facecolor="#1e293b", edgecolor="#334155",
                           labelcolor="#e2e8f0")
        elif panel_key == "macd":
            macd_raw = indicators.get("macd", [])
            macd_sig_raw = indicators.get("macd_signal", [])
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
                           facecolor="#1e293b", edgecolor="#334155",
                           labelcolor="#e2e8f0")

    # X-axis formatting on the bottom-most axes
    bottom_ax = axes[-1]
    if x_formatter is None:
        x_formatter = mdates.DateFormatter("%Y-%m")
    if x_locator is None:
        x_locator = mdates.MonthLocator(interval=3)
    bottom_ax.xaxis.set_major_formatter(x_formatter)
    bottom_ax.xaxis.set_major_locator(x_locator)
    plt.setp(bottom_ax.xaxis.get_majorticklabels(), rotation=45, ha="right")

    # Hide x tick labels on non-bottom panels
    for ax in axes[:-1]:
        plt.setp(ax.xaxis.get_majorticklabels(), visible=False)


def _price_chart_b64(ohlcv: list[dict], trades: list[dict]) -> str:
    dates = [datetime.strptime(o["date"], "%Y-%m-%d") for o in ohlcv]
    closes = [o["close"] for o in ohlcv]
    indicators = _detect_indicators(ohlcv)

    buy_dates = [datetime.strptime(t["entry_date"], "%Y-%m-%d") for t in trades]
    buy_prices = [t["entry_price"] for t in trades]
    sell_dates = [datetime.strptime(t["exit_date"], "%Y-%m-%d") for t in trades]
    sell_prices = [t["exit_price"] for t in trades]

    n_rows, oscillator_panels = _subplot_layout(indicators)
    heights = [3] + [1] * len(oscillator_panels)
    fig, axes_raw = plt.subplots(
        n_rows, 1, figsize=(12, 3 + 2 * n_rows),
        sharex=True, gridspec_kw={"height_ratios": heights}
    )
    axes = [axes_raw] if n_rows == 1 else list(axes_raw)

    _build_price_axes(fig, axes, dates, closes, indicators,
                      buy_dates, buy_prices, sell_dates, sell_prices)
    _apply_dark_style(fig, axes)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


def _trade_chart_b64(ohlcv: list[dict], trade: dict, context_days: int = 5) -> str:
    """
    Generate a zoomed-in chart for a single trade, including `context_days`
    trading days before entry and after exit (where available).
    """
    all_dates_str = [o["date"] for o in ohlcv]
    entry_str = trade["entry_date"]
    exit_str = trade["exit_date"]

    try:
        entry_idx = all_dates_str.index(entry_str)
    except ValueError:
        entry_idx = 0
    try:
        exit_idx = all_dates_str.index(exit_str)
    except ValueError:
        exit_idx = len(ohlcv) - 1

    start_idx = max(0, entry_idx - context_days)
    end_idx = min(len(ohlcv) - 1, exit_idx + context_days)
    subset = ohlcv[start_idx: end_idx + 1]

    dates = [datetime.strptime(o["date"], "%Y-%m-%d") for o in subset]
    closes = [o["close"] for o in subset]
    indicators = _detect_indicators(subset)

    entry_dt = datetime.strptime(entry_str, "%Y-%m-%d")
    exit_dt = datetime.strptime(exit_str, "%Y-%m-%d")

    n_rows, oscillator_panels = _subplot_layout(indicators)
    heights = [3] + [1] * len(oscillator_panels)
    fig, axes_raw = plt.subplots(
        n_rows, 1, figsize=(10, 3 + 2 * n_rows),
        sharex=True, gridspec_kw={"height_ratios": heights}
    )
    axes = [axes_raw] if n_rows == 1 else list(axes_raw)

    pnl_color = "#4ade80" if trade.get("pnl", 0) >= 0 else "#f87171"
    pnl_sign = "+" if trade.get("pnl", 0) >= 0 else ""
    title = (
        f"Trade Detail  |  Entry: {entry_str} @ ${trade['entry_price']:.4f}"
        f"  →  Exit: {exit_str} @ ${trade['exit_price']:.4f}"
        f"  |  P&L: {pnl_sign}${trade['pnl']:,.2f}"
    )

    _build_price_axes(
        fig, axes, dates, closes, indicators,
        [entry_dt], [trade["entry_price"]],
        [exit_dt], [trade["exit_price"]],
        title=title,
        x_locator=mdates.AutoDateLocator(),
        x_formatter=mdates.DateFormatter("%b %d"),
    )

    # Shade the trade holding period
    ax_price = axes[0]
    ax_price.axvspan(entry_dt, exit_dt, alpha=0.12, color=pnl_color, zorder=0)

    _apply_dark_style(fig, axes)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


def generate_html_report(result: dict[str, Any], report_name: str) -> str:
    """Generate an HTML report and save it; return the file path."""
    m = result["metrics"]
    trades = result.get("trades", [])
    equity_curve = result.get("equity_curve", [])
    ohlcv = result.get("ohlcv", [])

    equity_img = _equity_chart_b64(equity_curve) if equity_curve else ""
    price_img = _price_chart_b64(ohlcv, trades) if ohlcv else ""

    # Pre-generate a zoomed chart for every trade
    trade_chart_b64s: list[str] = []
    if ohlcv:
        for t in trades:
            trade_chart_b64s.append(_trade_chart_b64(ohlcv, t))
    else:
        trade_chart_b64s = [""] * len(trades)

    def _trade_row(idx: int, t: dict, chart_b64: str) -> str:
        pnl_cls = "pos" if t["pnl"] >= 0 else "neg"
        img_tag = (
            f'<img src="data:image/png;base64,{chart_b64}" '
            f'alt="Trade {idx+1} Chart" style="max-width:100%;border-radius:6px;'
            f'border:1px solid #334155;margin-top:10px;"/>'
            if chart_b64 else ""
        )
        summary_label = (
            f'Trade #{idx+1} &nbsp; {t["entry_date"]} → {t["exit_date"]} &nbsp;'
            f'<span class="{pnl_cls}">${t["pnl"]:,.2f}</span>'
        )
        return f"""<tr>
            <td colspan="6" style="padding:0;">
              <details>
                <summary style="cursor:pointer;padding:10px 14px;list-style:none;
                                display:flex;align-items:center;gap:8px;">
                  <span class="expand-icon">▶</span>
                  {summary_label}
                </summary>
                <div style="padding:0 14px 14px 14px;">
                  <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
                    <tr>
                      <th style="text-align:left;color:#94a3b8;font-size:.8rem;
                                 padding:4px 8px;">Entry Date</th>
                      <th style="text-align:left;color:#94a3b8;font-size:.8rem;
                                 padding:4px 8px;">Exit Date</th>
                      <th style="text-align:left;color:#94a3b8;font-size:.8rem;
                                 padding:4px 8px;">Entry Price</th>
                      <th style="text-align:left;color:#94a3b8;font-size:.8rem;
                                 padding:4px 8px;">Exit Price</th>
                      <th style="text-align:left;color:#94a3b8;font-size:.8rem;
                                 padding:4px 8px;">Qty</th>
                      <th style="text-align:left;color:#94a3b8;font-size:.8rem;
                                 padding:4px 8px;">P&amp;L</th>
                    </tr>
                    <tr>
                      <td style="padding:4px 8px;">{t['entry_date']}</td>
                      <td style="padding:4px 8px;">{t['exit_date']}</td>
                      <td style="padding:4px 8px;">{t['entry_price']:.4f}</td>
                      <td style="padding:4px 8px;">{t['exit_price']:.4f}</td>
                      <td style="padding:4px 8px;">{int(t['quantity'])}</td>
                      <td class="{pnl_cls}" style="padding:4px 8px;">${t['pnl']:,.2f}</td>
                    </tr>
                  </table>
                  {img_tag}
                </div>
              </details>
            </td>
        </tr>"""

    trade_rows = "".join(
        _trade_row(i, t, trade_chart_b64s[i]) for i, t in enumerate(trades)
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{report_name}</title>
<style>
  body {{ font-family: 'Segoe UI', Arial, sans-serif; background:#0f172a; color:#e2e8f0;
         margin:0; padding:24px; }}
  h1 {{ color:#4ade80; border-bottom:1px solid #334155; padding-bottom:10px; }}
  h2 {{ color:#94a3b8; margin-top:2rem; }}
  .meta {{ color:#94a3b8; font-size:.9rem; margin-bottom:1.5rem; }}
  .metrics {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr));
              gap:16px; margin-bottom:2rem; }}
  .metric-card {{ background:#1e293b; border:1px solid #334155; border-radius:8px;
                  padding:16px; }}
  .metric-card .label {{ color:#94a3b8; font-size:.8rem; text-transform:uppercase;
                          letter-spacing:.05em; margin-bottom:4px; }}
  .metric-card .value {{ font-size:1.5rem; font-weight:700; color:#f1f5f9; }}
  .metric-card .value.pos {{ color:#4ade80; }}
  .metric-card .value.neg {{ color:#f87171; }}
  img {{ max-width:100%; border-radius:8px; margin-bottom:1.5rem; border:1px solid #334155; }}
  table {{ width:100%; border-collapse:collapse; margin-top:1rem; }}
  th {{ background:#1e293b; color:#94a3b8; padding:10px 14px; text-align:left;
        font-size:.85rem; text-transform:uppercase; letter-spacing:.05em; }}
  td {{ border-bottom:1px solid #1e293b; font-size:.9rem; }}
  tr:has(details):hover > td {{ background:#1e293b33; }}
  .pos {{ color:#4ade80; }}
  .neg {{ color:#f87171; }}
  details summary {{ user-select:none; }}
  details summary::-webkit-details-marker {{ display:none; }}
  details[open] .expand-icon {{ transform:rotate(90deg); }}
  .expand-icon {{ display:inline-block; transition:transform .2s; color:#94a3b8;
                  font-size:.7rem; }}
  details > div {{ background:#111827; border-top:1px solid #334155; }}
</style>
</head>
<body>
<h1>📈 {report_name}</h1>
<p class="meta">
  Symbol: <strong>{result['symbol']}</strong> &nbsp;|&nbsp;
  Strategy: <strong>{result['strategy_type']}</strong> &nbsp;|&nbsp;
  Period: <strong>{result['start_date']} → {result['end_date']}</strong> &nbsp;|&nbsp;
  Generated: <strong>{datetime.now().strftime('%Y-%m-%d %H:%M')}</strong>
</p>

<h2>Performance Metrics</h2>
<div class="metrics">
  <div class="metric-card">
    <div class="label">Initial Capital</div>
    <div class="value">${result['initial_capital']:,.0f}</div>
  </div>
  <div class="metric-card">
    <div class="label">Final Value</div>
    <div class="value">${m['final_value']:,.2f}</div>
  </div>
  <div class="metric-card">
    <div class="label">Total Return</div>
    <div class="value {'pos' if m['total_return_pct']>=0 else 'neg'}">{m['total_return_pct']:+.2f}%</div>
  </div>
  <div class="metric-card">
    <div class="label">Annualised Return</div>
    <div class="value {'pos' if m['annualized_return_pct']>=0 else 'neg'}">{m['annualized_return_pct']:+.2f}%</div>
  </div>
  <div class="metric-card">
    <div class="label">Sharpe Ratio</div>
    <div class="value {'pos' if m['sharpe_ratio']>=1 else 'neg'}">{m['sharpe_ratio']:.2f}</div>
  </div>
  <div class="metric-card">
    <div class="label">Max Drawdown</div>
    <div class="value neg">{m['max_drawdown_pct']:.2f}%</div>
  </div>
  <div class="metric-card">
    <div class="label">Win Rate</div>
    <div class="value {'pos' if m['win_rate_pct']>=50 else 'neg'}">{m['win_rate_pct']:.1f}%</div>
  </div>
  <div class="metric-card">
    <div class="label">Total Trades</div>
    <div class="value">{m['total_trades']}</div>
  </div>
</div>

<h2>Equity Curve</h2>
{"<img src='data:image/png;base64," + equity_img + "' alt='Equity Curve'/>" if equity_img else "<p>No data.</p>"}

<h2>Price Chart with Signals &amp; Indicators</h2>
{"<img src='data:image/png;base64," + price_img + "' alt='Price Chart'/>" if price_img else "<p>No data.</p>"}

<h2>Trade Log ({len(trades)} trades) — click a row to expand</h2>
<table>
  <tbody>{trade_rows}</tbody>
</table>
</body>
</html>"""

    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in report_name)
    filename = f"{safe_name}.html"
    filepath = os.path.join(settings.REPORTS_DIR, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(html)

    return filepath
