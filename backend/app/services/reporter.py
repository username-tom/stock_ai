"""
Report generator: produces HTML reports from backtest results.
"""
from __future__ import annotations

import base64
import io
import os
from datetime import datetime
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from app.config import settings


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
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100)
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()


def _price_chart_b64(ohlcv: list[dict], trades: list[dict]) -> str:
    dates = [datetime.strptime(o["date"], "%Y-%m-%d") for o in ohlcv]
    closes = [o["close"] for o in ohlcv]

    buy_dates = [datetime.strptime(t["entry_date"], "%Y-%m-%d") for t in trades]
    buy_prices = [t["entry_price"] for t in trades]
    sell_dates = [datetime.strptime(t["exit_date"], "%Y-%m-%d") for t in trades]
    sell_prices = [t["exit_price"] for t in trades]

    fig, ax = plt.subplots(figsize=(12, 4))
    ax.plot(dates, closes, color="#94a3b8", linewidth=1, label="Close")
    ax.scatter(buy_dates, buy_prices, marker="^", color="#4ade80", s=60, zorder=5,
               label="Buy")
    ax.scatter(sell_dates, sell_prices, marker="v", color="#f87171", s=60, zorder=5,
               label="Sell")
    ax.set_title("Price Chart with Trade Signals", fontsize=14)
    ax.set_xlabel("Date")
    ax.set_ylabel("Price ($)")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
    plt.xticks(rotation=45)
    ax.legend()
    ax.grid(True, alpha=0.3)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100)
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

    trade_rows = "".join(
        f"""<tr>
            <td>{t['entry_date']}</td>
            <td>{t['exit_date']}</td>
            <td>{t['entry_price']:.4f}</td>
            <td>{t['exit_price']:.4f}</td>
            <td>{int(t['quantity'])}</td>
            <td class="{'pos' if t['pnl']>=0 else 'neg'}">${t['pnl']:,.2f}</td>
        </tr>"""
        for t in trades
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
  td {{ padding:10px 14px; border-bottom:1px solid #1e293b; font-size:.9rem; }}
  tr:hover td {{ background:#1e293b44; }}
  .pos {{ color:#4ade80; }}
  .neg {{ color:#f87171; }}
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

<h2>Price Chart with Signals</h2>
{"<img src='data:image/png;base64," + price_img + "' alt='Price Chart'/>" if price_img else "<p>No data.</p>"}

<h2>Trade Log ({len(trades)} trades)</h2>
<table>
  <thead>
    <tr>
      <th>Entry Date</th><th>Exit Date</th>
      <th>Entry Price</th><th>Exit Price</th>
      <th>Quantity</th><th>P&amp;L</th>
    </tr>
  </thead>
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
