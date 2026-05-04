"""
Report generator: produces HTML reports from backtest results.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from app.config import settings
from app.services.report_charts import (
    equity_chart_b64 as _equity_chart_b64,
    price_chart_b64 as _price_chart_b64,
    trade_chart_b64 as _trade_chart_b64,
)


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
