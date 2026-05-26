import { useMemo, useState } from 'react'

function formatStrategyLabel(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (lower === 'template:intraday_1m_regime_template.py') return 'intraday 1M regime'
  if (lower.startsWith('template:')) {
    const name = raw.slice('template:'.length).replace(/\.py$/i, '')
    return name.replace(/[_-]+/g, ' ')
  }
  return raw
}

/**
 * Shared view for sandbox-portfolio backtest results.
 *
 * Used by:
 *   - BacktestPanel (live results from /api/backtest/run-sandbox)
 *   - ReportsPanel  (persisted result_data of a sandbox_portfolio report)
 *
 * Props:
 *   result   — backend "result" payload: { equity_curve, per_symbol, activity_log,
 *              initial_capital, use_sentiment_routing, ... }
 *   metrics  — backend "metrics" payload: { final_value, total_return_pct,
 *              win_rate_pct, total_trades, symbols_run, symbols_failed, ... }
 */
export default function SandboxResultsView({ result, metrics }) {
  const r = result ?? {}
  const m = metrics ?? {}

  const portfolioBreakdown = useMemo(() => {
    const rows = Array.isArray(r.per_symbol) ? r.per_symbol : []
    const initialCapital = Number(r.initial_capital ?? 0) || 0
    const finalValue = Number(m.final_value ?? initialCapital) || initialCapital
    let realizedPnl = 0
    let unrealizedPnl = 0
    for (const row of rows) {
      realizedPnl += Number(row?.realized_pnl ?? 0) || 0
      unrealizedPnl += Number(row?.unrealized_pnl ?? 0) || 0
    }
    const totalPnl = finalValue - initialCapital
    const reconciliationDelta = totalPnl - realizedPnl - unrealizedPnl
    const totalReturnPct = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0
    const realizedReturnPct = initialCapital > 0 ? (realizedPnl / initialCapital) * 100 : 0
    const unrealizedReturnPct = initialCapital > 0 ? (unrealizedPnl / initialCapital) * 100 : 0
    return {
      initialCapital,
      finalValue,
      totalPnl,
      realizedPnl,
      unrealizedPnl,
      reconciliationDelta,
      totalReturnPct,
      realizedReturnPct,
      unrealizedReturnPct,
    }
  }, [r.per_symbol, r.initial_capital, m.final_value])

  // Trade-level analytics derived from the SELL events in the activity log.
  const tradeStats = useMemo(() => {
    const sells = (r.activity_log ?? []).filter(e => e.side === 'SELL' && e.pnl != null)
    if (sells.length === 0) {
      return {
        count: 0, wins: 0, losses: 0,
        grossWin: 0, grossLoss: 0, netPnl: 0,
        avgWin: 0, avgLoss: 0, bestTrade: null, worstTrade: null,
        profitFactor: null, expectancy: 0, avgTrade: 0,
      }
    }
    let grossWin = 0
    let grossLoss = 0   // positive number representing absolute losses
    let wins = 0
    let losses = 0
    let best = sells[0]
    let worst = sells[0]
    for (const t of sells) {
      const pnl = Number(t.pnl) || 0
      if (pnl >= 0) { wins += 1; grossWin += pnl } else { losses += 1; grossLoss += -pnl }
      if (pnl > (Number(best.pnl) || 0)) best = t
      if (pnl < (Number(worst.pnl) || 0)) worst = t
    }
    const netPnl = grossWin - grossLoss
    const avgWin = wins > 0 ? grossWin / wins : 0
    const avgLoss = losses > 0 ? grossLoss / losses : 0
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null)
    const winRate = sells.length > 0 ? wins / sells.length : 0
    const expectancy = winRate * avgWin - (1 - winRate) * avgLoss
    const avgTrade = netPnl / sells.length
    return { count: sells.length, wins, losses, grossWin, grossLoss, netPnl,
             avgWin, avgLoss, bestTrade: best, worstTrade: worst,
             profitFactor, expectancy, avgTrade }
  }, [r.activity_log])

  // Per-symbol return spread (best/worst/avg).
  const symbolStats = useMemo(() => {
    const rows = (r.per_symbol ?? []).filter(p => !p.error && p.total_return_pct != null)
    if (rows.length === 0) return { best: null, worst: null, avg: 0, winners: 0, losers: 0 }
    let best = rows[0]
    let worst = rows[0]
    let sum = 0
    let winners = 0, losers = 0
    for (const p of rows) {
      const ret = Number(p.total_return_pct) || 0
      if (ret > (Number(best.total_return_pct) || 0)) best = p
      if (ret < (Number(worst.total_return_pct) || 0)) worst = p
      sum += ret
      if (ret > 0) winners += 1
      else if (ret < 0) losers += 1
    }
    return { best, worst, avg: sum / rows.length, winners, losers }
  }, [r.per_symbol])

  const fmtMoney = (v) => `${v < 0 ? '-' : ''}$${Math.abs(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const fmtMoneyShort = (v) => {
    const n = Number(v) || 0
    const a = Math.abs(n)
    if (a >= 1_000_000) return `${n < 0 ? '-' : ''}$${(a / 1_000_000).toFixed(2)}M`
    if (a >= 1_000) return `${n < 0 ? '-' : ''}$${(a / 1_000).toFixed(1)}k`
    return `${n < 0 ? '-' : ''}$${a.toFixed(0)}`
  }
  const fmtPct = (v) => `${v >= 0 ? '+' : ''}${Number(v || 0).toFixed(2)}%`

  return (
    <div className="space-y-3 pb-12 px-3">
      {/* Portfolio summary header */}
      <div className="card bg-dark-900/60 border border-dark-500 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-0.5">Portfolio Summary</div>
            <div className="text-2xl font-bold text-slate-100">
              ${Number(m.final_value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className={`text-sm font-medium mt-0.5 ${(m.total_return_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {(m.total_return_pct ?? 0) >= 0 ? '+' : ''}{Number(m.total_return_pct ?? 0).toFixed(2)}%
              {' '}from ${Number(r.initial_capital ?? 0).toLocaleString()}
              <span className="text-slate-500 ml-2 whitespace-nowrap">
                ({portfolioBreakdown.realizedPnl >= 0 ? '+' : ''}{fmtMoneyShort(portfolioBreakdown.realizedPnl)} realized,
                {' '}{portfolioBreakdown.unrealizedPnl >= 0 ? '+' : ''}{fmtMoneyShort(portfolioBreakdown.unrealizedPnl)} unrealized)
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Reconciliation: {fmtPct(portfolioBreakdown.totalReturnPct)} total = {fmtPct(portfolioBreakdown.realizedReturnPct)} realized + {fmtPct(portfolioBreakdown.unrealizedReturnPct)} unrealized
              {Math.abs(portfolioBreakdown.reconciliationDelta) >= 0.01 && (
                <span className="ml-2">(delta {portfolioBreakdown.reconciliationDelta >= 0 ? '+' : ''}{fmtMoney(portfolioBreakdown.reconciliationDelta)})</span>
              )}
            </div>
          </div>
          <div className="text-xs text-slate-500 text-right space-y-0.5">
            <div>{m.symbols_run ?? 0} ran · {m.symbols_failed ?? 0} failed</div>
            <div>
              <span className="text-emerald-400">{symbolStats.winners} winners</span>
              {' · '}
              <span className="text-red-400">{symbolStats.losers} losers</span>
            </div>
            <div>{r.use_sentiment_routing ? 'sentiment routing' : 'position strategies'}</div>
          </div>
        </div>
      </div>

      {/* Risk / return metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">Total Return</div>
          <div className={`metric-value ${(m.total_return_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {(m.total_return_pct ?? 0) >= 0 ? '+' : ''}{Number(m.total_return_pct ?? 0).toFixed(2)}%
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Annualised (CAGR)</div>
          <div className={`metric-value ${m.annualized_return_pct == null ? 'text-slate-500' : ((m.annualized_return_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}`}>
            {m.annualized_return_pct == null
              ? '—'
              : `${m.annualized_return_pct >= 0 ? '+' : ''}${Number(m.annualized_return_pct).toFixed(2)}%`}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Sharpe Ratio</div>
          <div className={`metric-value ${m.sharpe_ratio == null ? 'text-slate-500' : (m.sharpe_ratio >= 1 ? 'text-emerald-400' : (m.sharpe_ratio >= 0 ? 'text-slate-100' : 'text-red-400'))}`}>
            {m.sharpe_ratio == null ? '—' : Number(m.sharpe_ratio).toFixed(2)}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Max Drawdown</div>
          <div className={`metric-value ${m.max_drawdown_pct == null ? 'text-slate-500' : 'text-red-400'}`}>
            {m.max_drawdown_pct == null ? '—' : `${Number(m.max_drawdown_pct).toFixed(2)}%`}
          </div>
        </div>
      </div>

      {/* Trade analytics cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">Win Rate</div>
          <div className={`metric-value ${(m.win_rate_pct ?? 0) >= 50 ? 'text-emerald-400' : 'text-slate-100'}`}>
            {Number(m.win_rate_pct ?? 0).toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            {tradeStats.wins}W / {tradeStats.losses}L
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Total Trades</div>
          <div className="metric-value text-slate-100">{m.total_trades ?? 0}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            {tradeStats.count} closed
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Profit Factor</div>
          <div className={`metric-value ${
            tradeStats.profitFactor == null ? 'text-slate-500'
              : (tradeStats.profitFactor === Infinity || tradeStats.profitFactor >= 1.5) ? 'text-emerald-400'
              : tradeStats.profitFactor >= 1 ? 'text-slate-100'
              : 'text-red-400'
          }`}>
            {tradeStats.profitFactor == null
              ? '—'
              : tradeStats.profitFactor === Infinity ? '∞'
              : tradeStats.profitFactor.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">gross win / loss</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Expectancy / Trade</div>
          <div className={`metric-value ${tradeStats.expectancy >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {tradeStats.count === 0 ? '—' : fmtMoneyShort(tradeStats.expectancy)}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            avg {tradeStats.count === 0 ? '—' : fmtMoneyShort(tradeStats.avgTrade)}
          </div>
        </div>
      </div>

      {/* Detailed P&L breakdown */}
      {tradeStats.count > 0 && (
        <div className="card grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">Net P&amp;L</div>
            <div className={`text-sm font-mono font-semibold ${tradeStats.netPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {tradeStats.netPnl >= 0 ? '+' : ''}{fmtMoney(tradeStats.netPnl)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">Gross Win</div>
            <div className="text-sm font-mono font-semibold text-emerald-400">
              +{fmtMoney(tradeStats.grossWin)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">Gross Loss</div>
            <div className="text-sm font-mono font-semibold text-red-400">
              -{fmtMoney(tradeStats.grossLoss)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">Avg Win / Loss</div>
            <div className="text-sm font-mono">
              <span className="text-emerald-400">+{fmtMoneyShort(tradeStats.avgWin)}</span>
              <span className="text-slate-600"> / </span>
              <span className="text-red-400">-{fmtMoneyShort(tradeStats.avgLoss)}</span>
            </div>
          </div>
          {tradeStats.bestTrade && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Best Trade</div>
              <div className="text-sm font-mono font-semibold text-emerald-400">
                +{fmtMoneyShort(tradeStats.bestTrade.pnl)}
              </div>
              <div className="text-[10px] text-slate-500 truncate">
                {tradeStats.bestTrade.symbol}
              </div>
            </div>
          )}
          {tradeStats.worstTrade && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Worst Trade</div>
              <div className="text-sm font-mono font-semibold text-red-400">
                {fmtMoneyShort(tradeStats.worstTrade.pnl)}
              </div>
              <div className="text-[10px] text-slate-500 truncate">
                {tradeStats.worstTrade.symbol}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Symbol-level highlights */}
      {(symbolStats.best || symbolStats.worst) && (
        <div className="card grid grid-cols-1 sm:grid-cols-3 gap-4">
          {symbolStats.best && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Best Symbol</div>
              <div className="text-sm font-semibold text-slate-100">{symbolStats.best.symbol}</div>
              <div className="text-sm font-mono text-emerald-400">
                +{Number(symbolStats.best.total_return_pct).toFixed(2)}%
              </div>
            </div>
          )}
          {symbolStats.worst && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Worst Symbol</div>
              <div className="text-sm font-semibold text-slate-100">{symbolStats.worst.symbol}</div>
              <div className={`text-sm font-mono ${Number(symbolStats.worst.total_return_pct) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {Number(symbolStats.worst.total_return_pct) >= 0 ? '+' : ''}{Number(symbolStats.worst.total_return_pct).toFixed(2)}%
              </div>
            </div>
          )}
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider">Avg Symbol Return</div>
            <div className={`text-sm font-mono ${symbolStats.avg >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {symbolStats.avg >= 0 ? '+' : ''}{symbolStats.avg.toFixed(2)}%
            </div>
            <div className="text-[10px] text-slate-500">across {symbolStats.winners + symbolStats.losers} symbols</div>
          </div>
        </div>
      )}

      {/* PM settings (if persisted) */}
      {r.pm_settings && (
        <div className="card space-y-2">
          <div className="text-xs text-slate-500 uppercase tracking-wider">PM Settings Used</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Stop Loss</div>
              <div className="text-sm font-mono text-slate-200">
                {Number(r.pm_settings.stop_loss_pct ?? 0).toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Take Profit</div>
              <div className="text-sm font-mono text-slate-200">
                {Number(r.pm_settings.take_profit_pct ?? 0).toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Hold Overnight</div>
              <div className="text-sm font-mono text-slate-200">
                {r.pm_settings.hold_positions_overnight ? 'Yes' : 'No'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">EOD Window</div>
              <div className="text-sm font-mono text-slate-200">
                {r.pm_settings.eod_sell_window_minutes ?? 30}m
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Sentiment Warmup</div>
              <div className="text-sm font-mono text-slate-200">
                {r.pm_settings.sentiment_warmup ?? '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Per-symbol results table */}
      <div className="card space-y-3">
        <div className="text-xs text-slate-500 uppercase tracking-wider">Per-Symbol Results</div>
        <div className="table-container max-h-96 overflow-y-auto">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Start Equity</th>
                <th>End Equity</th>
                <th>Return %</th>
                <th>Realized P&amp;L</th>
                <th>Unrealized P&amp;L</th>
                <th>Sharpe</th>
                <th>Max DD %</th>
                <th>Trades</th>
                <th>Win %</th>
              </tr>
            </thead>
            <tbody>
              {(r.per_symbol ?? []).map(row => (
                <tr key={row.symbol}>
                  <td className="font-semibold">
                    {row.symbol}
                    {row.error ? <span className="text-red-400"> · {row.error}</span> : null}
                  </td>
                  <td className="font-mono">${Number(row.equity_start ?? row.initial_capital ?? 0).toFixed(2)}</td>
                  <td className="font-mono">${Number(row.equity_end ?? row.final_value ?? 0).toFixed(2)}</td>
                  <td className={(row.total_return_pct ?? 0) >= 0 ? 'pos' : 'neg'}>
                    {(row.total_return_pct ?? 0) >= 0 ? '+' : ''}{Number(row.total_return_pct ?? 0).toFixed(2)}%
                  </td>
                  <td className={(row.realized_pnl ?? 0) >= 0 ? 'pos font-mono' : 'neg font-mono'}>
                    {(row.realized_pnl ?? 0) >= 0 ? '+' : ''}{fmtMoney(row.realized_pnl ?? 0)}
                  </td>
                  <td className={(row.unrealized_pnl ?? 0) >= 0 ? 'pos font-mono' : 'neg font-mono'}>
                    {(row.unrealized_pnl ?? 0) >= 0 ? '+' : ''}{fmtMoney(row.unrealized_pnl ?? 0)}
                  </td>
                  <td className="font-mono">{row.sharpe_ratio != null ? Number(row.sharpe_ratio).toFixed(2) : '—'}</td>
                  <td className="font-mono">{row.max_drawdown_pct != null ? Number(row.max_drawdown_pct).toFixed(2) : '—'}</td>
                  <td>{row.total_trades ?? 0}</td>
                  <td>{row.win_rate_pct != null ? `${Number(row.win_rate_pct).toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(r.per_symbol?.length) && (
            <div className="text-center text-slate-500 text-sm py-8">No per-symbol results</div>
          )}
        </div>
      </div>

      {/* Activity Log */}
      {(r.activity_log?.length ?? 0) > 0 && (
        <ActivityLog events={r.activity_log} />
      )}

      {/* Per-Symbol Price Charts with buy/sell markers */}
      {(r.per_symbol?.some(p => (p.ohlcv?.length ?? 0) > 0)) && (
        <div className="card space-y-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider">
            Per-Symbol Price Charts
            <span className="ml-2 normal-case text-slate-600">
              <span className="text-slate-400">┊ buy</span> ·{' '}
              <span className="text-emerald-400">▲ sell gain</span> ·{' '}
              <span className="text-red-400">▼ sell loss</span>
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4">
            {r.per_symbol
              .filter(p => (p.ohlcv?.length ?? 0) > 0)
              .map(p => {
                const W = 1200
                const H = 220
                const padL = 8
                const padR = 8
                const padT = 18
                const padB = 30
                const innerW = W - padL - padR
                const innerH = H - padT - padB
                const closes = p.ohlcv.map(b => Number(b.close)).filter(v => Number.isFinite(v))
                const minC = Math.min(...closes)
                const maxC = Math.max(...closes)
                const rangeC = maxC - minC || 1
                const n = p.ohlcv.length

                // Parse timestamps once. Backend uses "YYYY-MM-DD_HH:MM:SS"
                // (or "YYYY-MM-DD") — convert to ms-epoch for accurate
                // time-based positioning that doesn't get distorted by OHLCV
                // downsampling (which previously bunched markers onto the
                // few bars that survived).
                const toMs = (s) => {
                  if (s == null) return NaN
                  const iso = String(s).replace('_', 'T')
                  const t = Date.parse(iso)
                  return Number.isFinite(t) ? t : NaN
                }
                const bars = p.ohlcv.map(b => ({
                  t: toMs(b.date),
                  close: Number(b.close),
                  dayKey: String(b.date ?? '').split('_')[0],
                }))
                const validBars = []
                for (let i = 0; i < bars.length; i++) {
                  const b = bars[i]
                  if (Number.isFinite(b.t) && Number.isFinite(b.close)) {
                    validBars.push({ ...b, i })
                  }
                }
                const m = validBars.length
                const xAtRank = (rank) => {
                  if (m <= 1) return padL + innerW / 2
                  const clamped = Math.max(0, Math.min(m - 1, rank))
                  return padL + (clamped * innerW) / (m - 1)
                }
                const xAtTCompressed = (ts) => {
                  if (!Number.isFinite(ts) || m === 0) return padL + innerW / 2
                  if (ts <= validBars[0].t) return xAtRank(0)
                  if (ts >= validBars[m - 1].t) return xAtRank(m - 1)

                  let lo = 0
                  let hi = m - 1
                  while (lo <= hi) {
                    const mid = (lo + hi) >> 1
                    const mt = validBars[mid].t
                    if (mt === ts) return xAtRank(mid)
                    if (mt < ts) lo = mid + 1
                    else hi = mid - 1
                  }

                  const right = lo
                  const left = Math.max(0, right - 1)
                  const lt = validBars[left].t
                  const rt = validBars[right].t
                  if (!Number.isFinite(lt) || !Number.isFinite(rt) || rt <= lt) return xAtRank(left)
                  const frac = (ts - lt) / (rt - lt)
                  return xAtRank(left + frac)
                }
                const yAt = price => padT + innerH - ((Number(price) - minC) / rangeC) * innerH
                const points = validBars
                  .map((b, rank) => `${xAtRank(rank).toFixed(2)},${yAt(b.close).toFixed(2)}`)
                  .join(' ')

                const daySeparators = []
                for (let rank = 1; rank < m; rank++) {
                  if (validBars[rank].dayKey !== validBars[rank - 1].dayKey) {
                    daySeparators.push(xAtRank(rank - 0.5))
                  }
                }

                const markers = []
                for (const t of (p.trades ?? [])) {
                  const eMs = toMs(t.entry_date)
                  const xMs = toMs(t.exit_date)
                  if (Number.isFinite(eMs) && Number.isFinite(Number(t.entry_price))) {
                    markers.push({
                      side: 'buy',
                      x: xAtTCompressed(eMs),
                      y: yAt(t.entry_price),
                      price: t.entry_price,
                      date: t.entry_date,
                      strategy: t.entry_strategy,
                    })
                  }
                  if (Number.isFinite(xMs) && Number.isFinite(Number(t.exit_price))) {
                    markers.push({
                      side: 'sell',
                      x: xAtTCompressed(xMs),
                      y: yAt(t.exit_price),
                      price: t.exit_price,
                      date: t.exit_date,
                      reason: t.exit_reason,
                      pnl: t.pnl,
                    })
                  }
                }

                const ret = Number(p.total_return_pct ?? 0)
                const startEq = Number(p.equity_start ?? p.initial_capital ?? 0)
                const realizedPnl = Number(p.realized_pnl ?? 0)
                const unrealizedPnl = Number(p.unrealized_pnl ?? 0)
                const realizedPct = startEq > 0 ? (realizedPnl / startEq) * 100 : 0
                const tradeCount = (p.trades?.length ?? 0)
                return (
                  <div key={p.symbol} className="bg-dark-900/40 border border-dark-600 rounded-lg p-3">
                    <div className="flex items-baseline justify-between mb-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-bold text-slate-100">{p.symbol}</span>
                        <span className="text-xs text-slate-500">{formatStrategyLabel(p.strategy) ?? '—'}</span>
                      </div>
                      <div className="text-xs">
                        <span className={ret >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {ret >= 0 ? '+' : ''}{ret.toFixed(2)}%
                        </span>
                        <span className="text-slate-500 ml-2">{tradeCount} trades</span>
                        <span className={`ml-2 ${realizedPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {realizedPct >= 0 ? '+' : ''}{realizedPct.toFixed(2)}% realized
                        </span>
                        {Math.abs(unrealizedPnl) > 0.005 && (
                          <span className={`ml-2 ${unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {unrealizedPnl >= 0 ? '+' : ''}{fmtMoneyShort(unrealizedPnl)} open
                          </span>
                        )}
                      </div>
                    </div>
                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
                      <line x1={padL} x2={W - padR} y1={yAt(maxC)} y2={yAt(maxC)}
                        stroke="#334155" strokeDasharray="2 3" strokeWidth="0.5" />
                      <line x1={padL} x2={W - padR} y1={yAt(minC)} y2={yAt(minC)}
                        stroke="#334155" strokeDasharray="2 3" strokeWidth="0.5" />
                      {daySeparators.map((x, i) => (
                        <line
                          key={`day-sep-${i}`}
                          x1={x}
                          x2={x}
                          y1={padT}
                          y2={padT + innerH}
                          stroke="#334155"
                          strokeDasharray="2 3"
                          strokeWidth="0.8"
                          opacity="0.8"
                        />
                      ))}
                      {points && (
                        <polyline
                          points={points}
                          fill="none"
                          stroke="#64748b"
                          strokeWidth="1.2"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      )}
                      {markers.map((mk, i) => {
                        if (mk.side === 'buy') {
                          // Gray dashed vertical line through entry point
                          return (
                            <line
                              key={i}
                              x1={mk.x}
                              x2={mk.x}
                              y1={padT}
                              y2={padT + innerH}
                              stroke="#94a3b8"
                              strokeWidth="1"
                              strokeDasharray="3 3"
                              opacity="0.7"
                            >
                              <title>BUY {mk.date} @ ${Number(mk.price).toFixed(2)}{mk.strategy ? ` · ${formatStrategyLabel(mk.strategy)}` : ''}</title>
                            </line>
                          )
                        }
                        // SELL: categorize by gain/loss
                        const isGain = mk.pnl != null && Number(mk.pnl) >= 0
                        const top = padT
                        const bottom = padT + innerH
                        const triSize = 5
                        if (isGain) {
                          // Green up-triangle at bottom, vertical line from triangle up to sell price
                          const triTipY = bottom - 2
                          const triBaseY = bottom + triSize - 2
                          return (
                            <g key={i}>
                              <line
                                x1={mk.x} x2={mk.x}
                                y1={mk.y} y2={triTipY}
                                stroke="#10b981"
                                strokeWidth="1"
                                opacity="0.85"
                              />
                              <polygon
                                points={`${mk.x},${triTipY} ${mk.x - triSize},${triBaseY} ${mk.x + triSize},${triBaseY}`}
                                fill="#10b981"
                                stroke="#064e3b"
                                strokeWidth="0.5"
                              >
                                <title>SELL (gain) {mk.date} @ ${Number(mk.price).toFixed(2)}{mk.reason ? ` · ${mk.reason}` : ''}{mk.pnl != null ? ` · P&L +${Number(mk.pnl).toFixed(2)}` : ''}</title>
                              </polygon>
                            </g>
                          )
                        }
                        // Loss: red down-triangle at top, vertical line down to sell price
                        const triTipY = top + 2
                        const triBaseY = top - triSize + 2
                        return (
                          <g key={i}>
                            <line
                              x1={mk.x} x2={mk.x}
                              y1={triTipY} y2={mk.y}
                              stroke="#ef4444"
                              strokeWidth="1"
                              opacity="0.85"
                            />
                            <polygon
                              points={`${mk.x},${triTipY} ${mk.x - triSize},${triBaseY} ${mk.x + triSize},${triBaseY}`}
                              fill="#ef4444"
                              stroke="#7f1d1d"
                              strokeWidth="0.5"
                            >
                              <title>SELL (loss) {mk.date} @ ${Number(mk.price).toFixed(2)}{mk.reason ? ` · ${mk.reason}` : ''}{mk.pnl != null ? ` · P&L ${Number(mk.pnl).toFixed(2)}` : ''}</title>
                            </polygon>
                          </g>
                        )
                      })}
                      <text x={padL} y={yAt(maxC) - 2} fill="#64748b" fontSize="9" fontFamily="monospace">
                        ${maxC.toFixed(2)}
                      </text>
                      <text x={padL} y={yAt(minC) + 9} fill="#64748b" fontSize="9" fontFamily="monospace">
                        ${minC.toFixed(2)}
                      </text>
                      <text x={padL} y={H - 4} fill="#64748b" fontSize="9" fontFamily="monospace">
                        {p.ohlcv[0]?.date}
                      </text>
                      <text x={W - padR} y={H - 4} fill="#64748b" fontSize="9" fontFamily="monospace" textAnchor="end">
                        {p.ohlcv[p.ohlcv.length - 1]?.date}
                      </text>
                    </svg>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* Realized equity curve from activity log */}
      {(r.activity_log?.some(e => e.side === 'SELL') || (r.equity_curve?.length ?? 0) > 0) && (() => {
        const initCap = Number(r.initial_capital ?? 0)
        const sells = (r.activity_log ?? [])
          .filter(e => e.side === 'SELL' && e.pnl != null)
          .slice()
          .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        let cum = 0
        const series = [{ t: null, v: initCap }]
        for (const e of sells) {
          cum += Number(e.pnl) || 0
          series.push({ t: e.timestamp, v: initCap + cum })
        }
        if (series.length < 2) return null

        const W = 1600
        const H = 240
        const padL = 56
        const padR = 16
        const padT = 16
        const padB = 28
        const innerW = W - padL - padR
        const innerH = H - padT - padB
        const vals = series.map(p => p.v)
        const minV = Math.min(...vals, initCap)
        const maxV = Math.max(...vals, initCap)
        const pad = (maxV - minV) * 0.08 || initCap * 0.02 || 1
        const yMin = minV - pad
        const yMax = maxV + pad
        const yRange = yMax - yMin || 1
        const n = series.length
        const xAt = i => padL + (n > 1 ? (i * innerW) / (n - 1) : innerW / 2)
        const yAt = v => padT + innerH - ((v - yMin) / yRange) * innerH
        const baselineY = yAt(initCap)

        let d = `M ${xAt(0).toFixed(2)} ${yAt(series[0].v).toFixed(2)}`
        for (let i = 1; i < n; i++) {
          const x = xAt(i)
          const y = yAt(series[i].v)
          const yPrev = yAt(series[i - 1].v)
          d += ` L ${x.toFixed(2)} ${yPrev.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`
        }
        const areaPath = `${d} L ${xAt(n - 1).toFixed(2)} ${(padT + innerH).toFixed(2)} L ${xAt(0).toFixed(2)} ${(padT + innerH).toFixed(2)} Z`

        const finalV = series[n - 1].v
        const isUp = finalV >= initCap
        const lineColor = isUp ? '#10b981' : '#ef4444'
        const areaFill = isUp ? 'url(#sandboxEquityUp)' : 'url(#sandboxEquityDown)'
        const totalRet = initCap > 0 ? ((finalV - initCap) / initCap) * 100 : 0

        const ticks = [yMax, yMax - yRange * 0.33, yMax - yRange * 0.66, yMin]
        const fmt = v => {
          const a = Math.abs(v)
          if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
          if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}k`
          return `$${v.toFixed(0)}`
        }
        const firstLabel = sells[0]?.timestamp ?? ''
        const lastLabel = sells[sells.length - 1]?.timestamp ?? ''

        return (
          <div className="card space-y-3">
            <div className="flex items-baseline justify-between">
              <div className="text-xs text-slate-500 uppercase tracking-wider">
                Realized Equity Curve
                <span className="ml-2 normal-case text-slate-600">
                  cumulative realized P&amp;L · {sells.length} closed trades
                </span>
              </div>
              <div className="text-sm">
                <span className="text-slate-400">{fmt(finalV)}</span>
                <span className={`ml-2 font-medium ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                  {isUp ? '+' : ''}{totalRet.toFixed(2)}%
                </span>
              </div>
            </div>
            <div className="w-full">
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block">
                <defs>
                  <linearGradient id="sandboxEquityUp" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="sandboxEquityDown" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {ticks.map((tv, i) => (
                  <g key={i}>
                    <line x1={padL} x2={W - padR} y1={yAt(tv)} y2={yAt(tv)} stroke="#1f2937" strokeWidth="1" />
                    <text x={padL - 6} y={yAt(tv) + 3} fill="#475569" fontSize="10" fontFamily="monospace" textAnchor="end">
                      {fmt(tv)}
                    </text>
                  </g>
                ))}
                {initCap >= yMin && initCap <= yMax && (
                  <>
                    <line x1={padL} x2={W - padR} y1={baselineY} y2={baselineY}
                      stroke="#64748b" strokeDasharray="4 4" strokeWidth="1" />
                    <text x={W - padR - 4} y={baselineY - 4} fill="#94a3b8"
                      fontSize="10" fontFamily="monospace" textAnchor="end">
                      Start {fmt(initCap)}
                    </text>
                  </>
                )}
                <path d={areaPath} fill={areaFill} />
                <path d={d} fill="none" stroke={lineColor} strokeWidth="1.75"
                  strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={xAt(n - 1)} cy={yAt(finalV)} r="3" fill={lineColor} stroke="#0f172a" strokeWidth="1" />
                <text x={padL} y={H - 6} fill="#475569" fontSize="10" fontFamily="monospace">
                  {firstLabel}
                </text>
                <text x={W - padR} y={H - 6} fill="#475569" fontSize="10" fontFamily="monospace" textAnchor="end">
                  {lastLabel}
                </text>
              </svg>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Activity Log with filtering (symbol, side, win/loss) and sorting    */
/* ------------------------------------------------------------------ */
function ActivityLog({ events }) {
  const [symbolFilter, setSymbolFilter] = useState('ALL')
  const [sideFilter, setSideFilter] = useState('ALL')        // ALL | BUY | SELL
  const [outcomeFilter, setOutcomeFilter] = useState('ALL')  // ALL | WIN | LOSS | OPEN
  const [sortKey, setSortKey] = useState('timestamp')
  const [sortDir, setSortDir] = useState('asc')              // 'asc' | 'desc'

  const symbols = useMemo(() => {
    const s = new Set()
    for (const e of events) if (e.symbol) s.add(e.symbol)
    return Array.from(s).sort()
  }, [events])

  const filtered = useMemo(() => {
    return events.filter(e => {
      if (symbolFilter !== 'ALL' && e.symbol !== symbolFilter) return false
      if (sideFilter !== 'ALL' && e.side !== sideFilter) return false
      if (outcomeFilter !== 'ALL') {
        if (outcomeFilter === 'OPEN' && e.pnl != null) return false
        if (outcomeFilter === 'WIN' && !(e.pnl != null && e.pnl > 0)) return false
        if (outcomeFilter === 'LOSS' && !(e.pnl != null && e.pnl < 0)) return false
      }
      return true
    })
  }, [events, symbolFilter, sideFilter, outcomeFilter])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      // nulls always last
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return arr
  }, [filtered, sortKey, sortDir])

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sortIndicator = (key) => {
    if (sortKey !== key) return <span className="text-slate-600 ml-1">↕</span>
    return <span className="text-indigo-400 ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>
  }

  const cols = [
    { key: 'timestamp',   label: 'Time' },
    { key: 'symbol',      label: 'Symbol' },
    { key: 'side',        label: 'Side' },
    { key: 'price',       label: 'Price' },
    { key: 'quantity',    label: 'Qty' },
    { key: 'value',       label: 'Value' },
    { key: 'strategy',    label: 'Strategy' },
    { key: 'pnl',         label: 'P&L' },
    { key: 'exit_reason', label: 'Reason' },
    { key: 'notes',       label: 'Notes' },
  ]

  const buyCount = filtered.filter(e => e.side === 'BUY').length
  const sellCount = filtered.filter(e => e.side === 'SELL').length
  const winCount = filtered.filter(e => e.pnl != null && e.pnl > 0).length
  const lossCount = filtered.filter(e => e.pnl != null && e.pnl < 0).length
  const filteredSells = filtered.filter(e => e.side === 'SELL' && e.pnl != null)
  const filteredNetPnl = filteredSells.reduce((acc, e) => acc + (Number(e.pnl) || 0), 0)

  const selectCls = 'bg-dark-800 border border-dark-500 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500'

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-500 uppercase tracking-wider">Activity Log</div>
        <div className="text-xs text-slate-500">
          {filtered.length} / {events.length} events ·{' '}
          <span className="text-emerald-400">{buyCount} buys</span> ·{' '}
          <span className="text-red-400">{sellCount} sells</span> ·{' '}
          <span className="text-emerald-400">{winCount} wins</span> ·{' '}
          <span className="text-red-400">{lossCount} losses</span> ·{' '}
          <span className={filteredNetPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            net closed P&amp;L {filteredNetPnl >= 0 ? '+' : ''}${Math.abs(filteredNetPnl).toFixed(2)}
          </span>
        </div>
      </div>

      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-500">Symbol
          <select
            className={`${selectCls} ml-1`}
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
          >
            <option value="ALL">All ({symbols.length})</option>
            {symbols.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500">Side
          <select
            className={`${selectCls} ml-1`}
            value={sideFilter}
            onChange={(e) => setSideFilter(e.target.value)}
          >
            <option value="ALL">All</option>
            <option value="BUY">Buy</option>
            <option value="SELL">Sell</option>
          </select>
        </label>
        <label className="text-xs text-slate-500">Outcome
          <select
            className={`${selectCls} ml-1`}
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
          >
            <option value="ALL">All</option>
            <option value="WIN">Wins</option>
            <option value="LOSS">Losses</option>
            <option value="OPEN">Open (no P&L)</option>
          </select>
        </label>
        {(symbolFilter !== 'ALL' || sideFilter !== 'ALL' || outcomeFilter !== 'ALL') && (
          <button
            type="button"
            className="text-xs text-indigo-400 hover:text-indigo-300 underline"
            onClick={() => { setSymbolFilter('ALL'); setSideFilter('ALL'); setOutcomeFilter('ALL') }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="table-container max-h-80 overflow-y-auto">
        <table>
          <thead>
            <tr>
              {cols.map(c => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className="cursor-pointer select-none hover:text-indigo-300"
                  title="Click to sort"
                >
                  {c.label}{sortIndicator(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, i) => (
              <tr key={i}>
                <td className="font-mono text-xs">{e.timestamp}</td>
                <td className="font-semibold">{e.symbol}</td>
                <td>
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    e.side === 'BUY'
                      ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/40'
                      : 'bg-red-900/40 text-red-300 border border-red-700/40'
                  }`}>{e.side}</span>
                </td>
                <td className="font-mono">${Number(e.price ?? 0).toFixed(2)}</td>
                <td className="font-mono">{Number(e.quantity ?? 0).toFixed(2)}</td>
                <td className="font-mono">${Number(e.value ?? 0).toFixed(2)}</td>
                <td className="text-xs text-indigo-300">{formatStrategyLabel(e.strategy) ?? '—'}</td>
                <td className={e.pnl == null ? 'text-slate-500' : (e.pnl >= 0 ? 'pos' : 'neg')}>
                  {e.pnl == null ? '—' : `${e.pnl >= 0 ? '+' : ''}$${Number(e.pnl).toFixed(2)}`}
                </td>
                <td className="text-xs text-slate-400">{e.exit_reason || '—'}</td>
                <td className="text-xs text-slate-500 max-w-[16rem] truncate" title={e.notes || ''}>{e.notes || '—'}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="text-center text-xs text-slate-500 py-4">
                  No events match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
