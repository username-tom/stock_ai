import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getReports, getReport, deleteReport } from '../api/client'
import EquityChart from './charts/EquityChart'
import SubplotChart from './charts/SubplotChart'
import {
  DocumentChartBarIcon,
  TrashIcon,
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  ArrowDownTrayIcon,
  CodeBracketIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@heroicons/react/24/outline'

function MetricBadge({ value, isPositive }) {
  if (value == null) return <span className="text-slate-500">—</span>
  const pos = isPositive ?? value >= 0
  return (
    <span className={pos ? 'pos' : 'neg'}>
      {value >= 0 ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

const REASON_COLORS = {
  rsi:           'bg-purple-900/50 text-purple-300 border-purple-700/40',
  rsi_exit:      'bg-purple-900/30 text-purple-400 border-purple-700/30',
  bb:            'bg-blue-900/50 text-blue-300 border-blue-700/40',
  bb_exit:       'bg-blue-900/30 text-blue-400 border-blue-700/30',
  ma:            'bg-yellow-900/50 text-yellow-300 border-yellow-700/40',
  ma_exit:       'bg-yellow-900/30 text-yellow-400 border-yellow-700/30',
  macd:          'bg-cyan-900/50 text-cyan-300 border-cyan-700/40',
  macd_exit:     'bg-cyan-900/30 text-cyan-400 border-cyan-700/30',
  stop_loss:     'bg-red-900/60 text-red-300 border-red-700/50',
  take_profit:   'bg-emerald-900/50 text-emerald-300 border-emerald-700/40',
  fallback_exit: 'bg-slate-700/50 text-slate-400 border-slate-600/40',
  signal:        'bg-emerald-900/40 text-emerald-300 border-emerald-700/30',
  strategy_exit: 'bg-slate-700/50 text-slate-400 border-slate-600/40',
}

const SENTIMENT_BUCKETS = [
  { key: 'crash', label: 'Crash' },
  { key: 'bearish', label: 'Bearish' },
  { key: 'neutral', label: 'Neutral' },
  { key: 'bullish', label: 'Bullish' },
  { key: 'euphoric', label: 'Euphoric' },
]

function formatStrategyName(value) {
  if (!value) return '—'
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function extractAdvancedSentimentSettings(detail) {
  if (!detail || detail.strategy_type !== 'sentiment_switching') return null
  const params = (detail.parameters && typeof detail.parameters === 'object') ? detail.parameters : {}
  const maybeMap =
    params.sentiment_strategies && typeof params.sentiment_strategies === 'object'
      ? params.sentiment_strategies
      : params

  const strategyMap = {}
  SENTIMENT_BUCKETS.forEach(({ key }) => {
    if (maybeMap[key]) strategyMap[key] = maybeMap[key]
  })

  return {
    strategyMap,
    sentimentWarmup: params.sentiment_warmup,
    stopLossPct: params.stop_loss_pct,
    takeProfitPct: params.take_profit_pct,
  }
}

function ReasonBadge({ value }) {
  if (!value) return <span className="text-slate-600">—</span>
  const cls = REASON_COLORS[value] ?? 'bg-slate-700/50 text-slate-400 border-slate-600/40'
  const label = value.replace(/_/g, ' ')
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium leading-tight whitespace-nowrap ${cls}`}>
      {label}
    </span>
  )
}

function normalizeTimestamp(value) {
  if (!value) return ''
  return String(value)
    .replace('T', ' ')
    .replace('_', ' ')
    .replace(/\.\d+$/, '')
    .trim()
}

function mergeTradeSignalsIntoOhlcv(ohlcv = [], trades = []) {
  if (!Array.isArray(ohlcv) || ohlcv.length === 0) return []

  const merged = ohlcv.map(bar => ({ ...bar, signal: Number(bar.signal) || 0 }))
  const byExactTime = new Map()
  const byDay = new Map()

  merged.forEach((bar, idx) => {
    const key = normalizeTimestamp(bar.date)
    if (!key) return
    byExactTime.set(key, idx)
    const day = key.slice(0, 10)
    if (day && !byDay.has(day)) byDay.set(day, idx)
  })

  const markSignal = (timestamp, signal) => {
    const key = normalizeTimestamp(timestamp)
    if (!key) return
    let idx = byExactTime.get(key)
    if (idx == null) idx = byDay.get(key.slice(0, 10))
    if (idx == null) return
    if (!merged[idx].signal) merged[idx].signal = signal
  }

  trades.forEach((t) => {
    markSignal(t?.entry_date, 1)
    markSignal(t?.exit_date, -1)
  })

  return merged
}

export default function ReportsPanel() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState(null)
  const [scriptOpen, setScriptOpen] = useState(false)
  const [search, setSearch] = useState('')

  const { data: listData, isLoading } = useQuery({
    queryKey: ['reports'],
    queryFn: getReports,
  })

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['report', selected],
    queryFn: () => getReport(selected),
    enabled: !!selected,
  })

  const deleteMut = useMutation({
    mutationFn: deleteReport,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports'] })
      if (detail?.id === selected) setSelected(null)
    },
  })

  const reports = listData?.reports ?? []
  const q = search.trim().toUpperCase()
  const filtered = q
    ? reports.filter(r => r.symbol.includes(q) || r.strategy_type.toUpperCase().includes(q))
    : reports
  const reportOhlcvWithSignals = mergeTradeSignalsIntoOhlcv(
    detail?.result_data?.ohlcv ?? [],
    detail?.result_data?.trades ?? [],
  )
  const advancedSettings = extractAdvancedSentimentSettings(detail)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Reports</h1>
        <p className="text-sm text-slate-400 mt-0.5">Saved backtest reports</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* List */}
        <div className="card xl:col-span-1 space-y-2 max-h-[80vh] overflow-y-auto">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
            {filtered.length}{q ? ` of ${reports.length}` : ''} Report{reports.length !== 1 ? 's' : ''}
          </h2>
          <div className="relative mb-3">
            <input
              className="input w-full pl-8 py-1.5 text-sm"
              placeholder="Search symbol or strategy…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              spellCheck={false}
            />
            <svg className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-500 pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-2 text-slate-500 hover:text-slate-300">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          {isLoading && (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-16 bg-dark-700 rounded-lg animate-pulse" />
              ))}
            </div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="text-center text-slate-500 text-sm py-12">
              <DocumentChartBarIcon className="h-8 w-8 mx-auto mb-2 text-slate-600" />
              {reports.length === 0 ? 'No reports yet. Run a backtest first.' : 'No reports match your search.'}
            </div>
          )}
          {filtered.map(r => (
            <button
              key={r.id}
              onClick={() => { setSelected(r.id); setScriptOpen(false) }}
              className={`w-full text-left p-3 rounded-lg border transition-all ${
                selected === r.id
                  ? 'border-emerald-600/50 bg-emerald-600/10'
                  : 'border-dark-500 hover:border-dark-400 bg-dark-900/30 hover:bg-dark-700/50'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm text-slate-200 truncate">{r.symbol}</div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">
                    {r.strategy_type.replace(/_/g, ' ')} · {r.start_date} → {r.end_date}
                  </div>
                </div>
                <div className="flex-shrink-0 text-right">
                  <div className={`text-sm font-mono font-bold ${r.total_return_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.total_return_pct >= 0 ? '+' : ''}{r.total_return_pct?.toFixed(1)}%
                  </div>
                  <div className="text-xs text-slate-500">{r.total_trades} trades</div>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Detail */}
        <div className="xl:col-span-2 space-y-5">
          {selected && detail && !detailLoading ? (
            <>
              <div className="card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 className="font-bold text-lg text-slate-100">{detail.symbol} — {detail.strategy_type}</h2>
                    <p className="text-sm text-slate-400">{detail.start_date} → {detail.end_date}</p>
                  </div>
                  <div className="flex gap-2">
                    {detail.html_report_path && (
                      <a
                        href={`/reports/${detail.html_report_path.split('/').pop()}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary text-xs"
                      >
                        <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                        HTML Report
                      </a>
                    )}
                    {detail.script_snapshot && (
                      <button
                        type="button"
                        onClick={() => {
                          const blob = new Blob([detail.script_snapshot], { type: 'text/plain' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `${detail.name ?? 'backtest_script'}.py`
                          a.click()
                          URL.revokeObjectURL(url)
                        }}
                        className="btn-secondary text-xs"
                      >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                        Script
                      </button>
                    )}
                    <button
                      onClick={() => deleteMut.mutate(detail.id)}
                      className="btn-danger text-xs"
                      disabled={deleteMut.isPending}
                    >
                      <TrashIcon className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Return', value: detail.metrics?.total_return_pct, unit: '%', isReturn: true },
                    { label: 'Annualised', value: detail.metrics?.annualized_return_pct, unit: '%', isReturn: true },
                    { label: 'Sharpe Ratio', value: detail.metrics?.sharpe_ratio, unit: '' },
                    { label: 'Max Drawdown', value: detail.metrics?.max_drawdown_pct, unit: '%', forceNeg: true },
                    { label: 'Win Rate', value: detail.metrics?.win_rate_pct, unit: '%' },
                    { label: 'Total Trades', value: detail.metrics?.total_trades, noColor: true },
                    { label: 'Final Value', value: detail.metrics?.final_value, prefix: '$', noColor: true },
                    { label: 'Initial Capital', value: detail.initial_capital, prefix: '$', noColor: true },
                  ].map(m => (
                    <div key={m.label} className="metric-card">
                      <div className="metric-label">{m.label}</div>
                      <div className={`metric-value ${
                        m.noColor ? 'text-slate-100' :
                        m.forceNeg ? 'text-red-400' :
                        m.isReturn ? (m.value >= 0 ? 'text-emerald-400' : 'text-red-400') :
                        m.value >= 1 ? 'text-emerald-400' : 'text-slate-100'
                      } text-lg`}>
                        {m.prefix}{typeof m.value === 'number'
                          ? m.noColor ? m.value?.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : (m.value >= 0 && m.isReturn ? '+' : '') + m.value?.toFixed(2)
                          : '—'}{m.unit}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {advancedSettings && (
                <div className="card space-y-4">
                  <div>
                    <h3 className="font-medium text-slate-200">Advanced Backtest Settings</h3>
                    <p className="text-xs text-slate-500 mt-0.5">Sentiment switching configuration saved with this report.</p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="metric-card">
                      <div className="metric-label">Sentiment Warmup</div>
                      <div className="metric-value text-slate-100 text-lg">
                        {advancedSettings.sentimentWarmup != null ? advancedSettings.sentimentWarmup : '—'}
                      </div>
                      <div className="text-xs text-slate-500">bars</div>
                    </div>
                    <div className="metric-card">
                      <div className="metric-label">Stop-Loss</div>
                      <div className="metric-value text-red-400 text-lg">
                        {advancedSettings.stopLossPct != null ? `${Number(advancedSettings.stopLossPct).toFixed(2)}%` : '—'}
                      </div>
                      <div className="text-xs text-slate-500">0 = disabled</div>
                    </div>
                    <div className="metric-card">
                      <div className="metric-label">Take-Profit</div>
                      <div className="metric-value text-emerald-400 text-lg">
                        {advancedSettings.takeProfitPct != null ? `${Number(advancedSettings.takeProfitPct).toFixed(2)}%` : '—'}
                      </div>
                      <div className="text-xs text-slate-500">0 = disabled</div>
                    </div>
                  </div>

                  {Object.keys(advancedSettings.strategyMap).length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs text-slate-500 uppercase tracking-wider">Sentiment to Strategy Map</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {SENTIMENT_BUCKETS.map(({ key, label }) => (
                          <div key={key} className="bg-dark-900/40 border border-dark-600 rounded-lg p-2">
                            <div className="text-xs text-slate-500">{label}</div>
                            <div className="text-sm font-medium text-slate-200 mt-0.5">
                              {formatStrategyName(advancedSettings.strategyMap[key])}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Equity curve */}
              {detail.result_data?.equity_curve?.length > 0 && (
                <div className="card">
                  <h3 className="font-medium text-slate-200 mb-4">Equity Curve</h3>
                  <EquityChart
                    data={detail.result_data.equity_curve}
                    initialCapital={detail.initial_capital}
                    height={260}
                  />
                </div>
              )}

              {reportOhlcvWithSignals.length > 0 && (
                <div className="card">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-slate-200">Price Chart</h3>
                    <span className="text-xs text-slate-500">Buy/Sell flags from trade log</span>
                  </div>
                  <SubplotChart data={reportOhlcvWithSignals} height={240} />
                </div>
              )}

              {/* Trades */}
              {detail.result_data?.trades?.length > 0 && (
                <div className="card">
                  <h3 className="font-medium text-slate-200 mb-3">
                    Trade Log ({detail.result_data.trades.length} trades)
                  </h3>
                  <div className="table-container max-h-72 overflow-y-auto">
                    <table>
                      <thead>
                        <tr>
                          <th>Entry</th><th>Exit</th>
                          <th>Entry $</th><th>Exit $</th>
                          <th>Qty</th><th>Buy Reason</th><th>Sell Reason</th><th>P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.result_data.trades.map((t, i) => (
                          <tr key={i}>
                            <td className="font-mono text-xs">{t.entry_date}</td>
                            <td className="font-mono text-xs">{t.exit_date}</td>
                            <td className="font-mono">${t.entry_price}</td>
                            <td className="font-mono">${t.exit_price}</td>
                            <td>{t.quantity}</td>
                            <td><ReasonBadge value={t.entry_reason} /></td>
                            <td><ReasonBadge value={t.exit_reason} /></td>
                            <td className={t.pnl >= 0 ? 'pos' : 'neg'}>
                              {t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {/* Script snapshot */}
              {detail.script_snapshot && (
                <div className="card">
                  <button
                    type="button"
                    onClick={() => setScriptOpen(o => !o)}
                    className="w-full flex items-center justify-between text-sm font-medium text-slate-200 hover:text-slate-100 transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <CodeBracketIcon className="h-4 w-4 text-slate-400" />
                      Script used for this backtest
                    </span>
                    <span className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation()
                          const blob = new Blob([detail.script_snapshot], { type: 'text/plain' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `${detail.name ?? 'backtest_script'}.py`
                          a.click()
                          URL.revokeObjectURL(url)
                        }}
                        className="btn-secondary text-xs flex items-center gap-1 py-0.5 px-2"
                      >
                        <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                        Download
                      </button>
                      {scriptOpen
                        ? <ChevronUpIcon className="h-4 w-4 text-slate-400" />
                        : <ChevronDownIcon className="h-4 w-4 text-slate-400" />}
                    </span>
                  </button>
                  {scriptOpen && (
                    <div className="mt-3 rounded-lg overflow-hidden border border-dark-600">
                      <div className="flex items-center justify-between px-3 py-1.5 bg-dark-800 border-b border-dark-600">
                        <span className="text-xs text-slate-500 font-mono">python</span>
                        <button
                          type="button"
                          onClick={() => navigator.clipboard?.writeText(detail.script_snapshot)}
                          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="overflow-x-auto p-4 text-xs font-mono text-slate-300 bg-[#0f172a] leading-relaxed max-h-[480px] overflow-y-auto">
                        <code>{detail.script_snapshot}</code>
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : selected && detailLoading ? (
            <div className="card h-64 flex items-center justify-center text-slate-500 text-sm">
              Loading report…
            </div>
          ) : (
            <div className="card flex flex-col items-center justify-center h-64 text-slate-500">
              <ChevronRightIcon className="h-10 w-10 mb-3 text-slate-600" />
              <p className="font-medium">Select a report to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
