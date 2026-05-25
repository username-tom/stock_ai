import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getReports, getReport, deleteReport, offloadAllReports } from '../api/client'
import EquityChart from './charts/EquityChart'
import SubplotChart from './charts/SubplotChart'
import CandlestickChart from './charts/CandlestickChart'
import SandboxResultsView from './backtest/SandboxResultsView'
import { getReportFilename } from '../utils/reportPaths'
import {
  DocumentChartBarIcon,
  TrashIcon,
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
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

function findBarIndexForTimestamp(ohlcv = [], timestamp) {
  const key = normalizeTimestamp(timestamp)
  if (!key || !Array.isArray(ohlcv) || ohlcv.length === 0) return -1

  let exact = -1
  for (let i = 0; i < ohlcv.length; i += 1) {
    if (normalizeTimestamp(ohlcv[i]?.date) === key) {
      exact = i
      break
    }
  }
  if (exact >= 0) return exact

  const day = key.slice(0, 10)
  if (!day) return -1
  for (let i = 0; i < ohlcv.length; i += 1) {
    if (normalizeTimestamp(ohlcv[i]?.date).slice(0, 10) === day) {
      return i
    }
  }
  return -1
}

function buildTradeContextWindow(ohlcv = [], trade, contextBars = 12) {
  const entryIdx = findBarIndexForTimestamp(ohlcv, trade?.entry_date)
  const exitIdx = findBarIndexForTimestamp(ohlcv, trade?.exit_date)
  const seedIdx = [entryIdx, exitIdx].filter(v => v >= 0)
  if (!seedIdx.length) return null

  const lo = Math.max(0, Math.min(...seedIdx) - contextBars)
  const hi = Math.min(ohlcv.length - 1, Math.max(...seedIdx) + contextBars)
  return {
    start: lo,
    end: hi,
    bars: ohlcv.slice(lo, hi + 1),
  }
}

export default function ReportsPanel() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState(null)
  const [scriptOpen, setScriptOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [listCollapsed, setListCollapsed] = useState(false)
  const [page, setPage] = useState(1)
  const [offloadMessage, setOffloadMessage] = useState('')
  const [offloadProgress, setOffloadProgress] = useState(null)
  const [expandedTrades, setExpandedTrades] = useState({})
  const pageSize = 50

  const formatDuration = (seconds) => {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
    const s = Math.round(seconds)
    const m = Math.floor(s / 60)
    const rem = s % 60
    return `${m}:${String(rem).padStart(2, '0')}`
  }

  const {
    data: listData,
    isLoading,
    isError,
    error,
    refetch: refetchReports,
  } = useQuery({
    queryKey: ['reports', page, pageSize],
    queryFn: () => getReports({ page, pageSize }),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  })

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['report', selected],
    queryFn: () => getReport(selected),
    enabled: !!selected,
    staleTime: 0,
  })

  const deleteMut = useMutation({
    mutationFn: deleteReport,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports'] })
      if (detail?.id === selected) setSelected(null)
    },
  })

  const offloadMut = useMutation({
    mutationFn: async () => {
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
      const runBatchWithRetry = async (offset, batchSize) => {
        const maxAttempts = 5
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            return await offloadAllReports({ offset, batchSize })
          } catch (err) {
            const status = err?.response?.status
            const retryable = !status || status >= 500 || status === 429
            if (!retryable || attempt === maxAttempts) throw err
            await sleep(300 * attempt)
          }
        }
        throw new Error('Unexpected offload retry state')
      }

      let offset = 0
      const batchSize = 40
      let totalOffloaded = 0
      let totalCleared = 0
      let totalFailed = 0
      let totalSkippedMissing = 0
      let totalProcessed = 0
      let totalCount = 0
      let loops = 0
      let hasMore = true
      const startedAt = Date.now()

      setOffloadProgress({
        running: true,
        percent: 0,
        processed: 0,
        total: 0,
        elapsedSec: 0,
        etaSec: null,
      })

      while (loops < 300 && hasMore) {
        loops += 1
        const data = await runBatchWithRetry(offset, batchSize)
        const batchProcessed = Number(data?.processed ?? 0)
        totalProcessed += batchProcessed
        totalCount = Number(data?.total_count ?? totalCount)
        totalOffloaded += Number(data?.offloaded ?? 0)
        totalCleared += Number(data?.cleared_db_blobs ?? 0)
        totalFailed += Number(data?.failed ?? 0)
        totalSkippedMissing += Number(data?.skipped_missing_detail ?? 0)
        hasMore = !!data?.has_more

        const elapsedSec = (Date.now() - startedAt) / 1000
        const rate = totalProcessed > 0 ? (totalProcessed / Math.max(elapsedSec, 0.001)) : 0
        const remaining = totalCount > 0 ? Math.max(0, totalCount - totalProcessed) : 0
        const etaSec = rate > 0 ? (remaining / rate) : null
        const percent = totalCount > 0 ? Math.min(100, (totalProcessed / totalCount) * 100) : 0

        setOffloadProgress({
          running: true,
          percent,
          processed: totalProcessed,
          total: totalCount,
          elapsedSec,
          etaSec,
        })

        if (!hasMore) break
        offset = Number(data?.next_offset ?? (offset + batchSize))
      }

      if (hasMore) {
        throw new Error('Offload exceeded max batches before completion.')
      }

      const finalElapsed = (Date.now() - startedAt) / 1000
      setOffloadProgress({
        running: false,
        percent: 100,
        processed: totalProcessed,
        total: totalCount,
        elapsedSec: finalElapsed,
        etaSec: 0,
      })

      return {
        offloaded: totalOffloaded,
        cleared_db_blobs: totalCleared,
        skipped_missing_detail: totalSkippedMissing,
        failed: totalFailed,
      }
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['reports'] })
      const msg = `Offload complete: ${data?.offloaded ?? 0} saved, ${data?.cleared_db_blobs ?? 0} DB blobs cleared, ${data?.skipped_missing_detail ?? 0} skipped (missing historical detail), ${data?.failed ?? 0} hard failures.`
      setOffloadMessage(msg)
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail
      setOffloadMessage(`Offload failed${detail ? `: ${detail}` : '.'}`)
      setOffloadProgress(prev => prev ? { ...prev, running: false } : null)
    },
  })

  const reports = listData?.reports ?? []
  const totalCount = listData?.total_count ?? reports.length
  const hasNextPage = !!listData?.has_next
  const hasPrevPage = !!listData?.has_prev
  const pageStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1
  const pageEnd = totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount)

  const q = search.trim().toUpperCase()
  const filtered = q
    ? reports.filter(r => r.symbol.includes(q) || r.strategy_type.toUpperCase().includes(q))
    : reports
  const showingCount = filtered.length
  const reportOhlcvWithSignals = mergeTradeSignalsIntoOhlcv(
    detail?.result_data?.ohlcv ?? [],
    detail?.result_data?.trades ?? [],
  )
  const groupedTrades = (detail?.result_data?.trades ?? []).map((t, idx) => ({
    ...t,
    _id: `${idx}-${t.entry_date ?? ''}-${t.exit_date ?? ''}`,
    _context: buildTradeContextWindow(detail?.result_data?.ohlcv ?? [], t),
  }))
  const advancedSettings = extractAdvancedSentimentSettings(detail)

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Reports</h1>
          <p className="text-xs text-slate-500">Saved backtest reports</p>
          {offloadMessage && (
            <p className={`text-xs mt-1 ${offloadMessage.startsWith('Offload failed') ? 'text-red-400' : 'text-emerald-400'}`}>{offloadMessage}</p>
          )}
          {offloadProgress && (
            <div className="mt-2 w-full max-w-lg rounded-md border border-dark-600 bg-dark-900/40 p-2">
              <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                <span>{offloadProgress.running ? 'Offloading reports…' : 'Offload progress'}</span>
                <span>{Math.round(offloadProgress.percent ?? 0)}%</span>
              </div>
              <div className="h-2 rounded bg-dark-700 overflow-hidden">
                <div
                  className={`h-full ${offloadProgress.running ? 'bg-emerald-500' : 'bg-emerald-600'}`}
                  style={{ width: `${Math.max(0, Math.min(100, offloadProgress.percent ?? 0))}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {offloadProgress.processed ?? 0}
                {offloadProgress.total ? ` / ${offloadProgress.total}` : ''} processed
                {' · '}elapsed {formatDuration(offloadProgress.elapsedSec)}
                {' · '}ETA {offloadProgress.running ? formatDuration(offloadProgress.etaSec) : '0:00'}
              </div>
            </div>
          )}
          {isError && (
            <p className="text-xs text-red-400 mt-1">Failed to load reports: {error?.message ?? 'Unknown error'}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setOffloadMessage('')
              offloadMut.mutate()
            }}
            disabled={offloadMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-emerald-700/80 hover:bg-emerald-700 border border-emerald-500/50 rounded-md transition-colors disabled:opacity-50"
            title="Save all reports to local files and clear DB blobs"
          >
            {offloadMut.isPending ? 'Offloading…' : 'Offload All To Local'}
          </button>
          <button
            type="button"
            onClick={() => setListCollapsed(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-dark-800 hover:bg-dark-700 border border-dark-500 rounded-md transition-colors"
            title={listCollapsed ? 'Show report list' : 'Hide report list'}
          >
            {listCollapsed ? (
              <>
                <ChevronRightIcon className="h-3.5 w-3.5" />
                Show list ({filtered.length})
              </>
            ) : (
              <>
                <ChevronLeftIcon className="h-3.5 w-3.5" />
                Hide list
              </>
            )}
          </button>
        </div>
      </div>

      <div className={listCollapsed ? 'block' : 'grid grid-cols-1 xl:grid-cols-4 gap-3'}>
        {/* List */}
        {!listCollapsed && (
        <div className="card xl:col-span-1 space-y-2 max-h-[85vh] overflow-y-auto p-3">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
            {showingCount}{q ? ` of ${reports.length}` : ''} on page · {totalCount} total
          </h2>
          <div className="relative mb-3">
            <input
              className="input w-full pl-8 py-1.5 text-sm"
              placeholder="Search symbol or strategy…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              disabled={isError}
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
              {isError
                ? 'Could not load reports.'
                : (reports.length === 0 ? 'No reports yet. Run a backtest first.' : 'No reports match your search.')}
              {isError && (
                <div className="mt-3">
                  <button type="button" className="btn-secondary text-xs" onClick={() => refetchReports()}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          )}
          {filtered.map(r => (
            <button
              key={r.id}
              onClick={() => { setSelected(r.id); setScriptOpen(false); setListCollapsed(true) }}
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
          <div className="mt-2 pt-2 border-t border-dark-600 flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              Showing {pageStart}-{pageEnd}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary text-xs px-2 py-1 disabled:opacity-40"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={!hasPrevPage || isLoading}
              >
                Prev
              </button>
              <span>Page {page}</span>
              <button
                type="button"
                className="btn-secondary text-xs px-2 py-1 disabled:opacity-40"
                onClick={() => setPage(p => p + 1)}
                disabled={!hasNextPage || isLoading}
              >
                Next
              </button>
            </div>
          </div>
        </div>
        )}

        {/* Detail */}
        <div className={listCollapsed ? 'space-y-3' : 'xl:col-span-3 space-y-3'}>
          {selected && detail && !detailLoading ? (
            <>
              <div className="card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 className="font-bold text-lg text-slate-100">
                      {detail.strategy_type === 'sandbox_portfolio'
                        ? `Sandbox Portfolio — ${(detail.result_data?.per_symbol?.length ?? 0)} symbols`
                        : `${detail.symbol} — ${detail.strategy_type}`}
                    </h2>
                    <p className="text-sm text-slate-400">{detail.start_date} → {detail.end_date}</p>
                    {detail.data_warning && (
                      <p className="text-xs text-amber-400 mt-1">{detail.data_warning}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {detail.html_report_path && (
                      <a
                        href={`/report-files/${getReportFilename(detail.html_report_path)}`}
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

              {/* Sandbox-portfolio: dedicated multi-symbol view (activity log, per-symbol
                  charts with buy/sell markers, realized equity curve) */}
              {detail.strategy_type === 'sandbox_portfolio' && (
                <SandboxResultsView
                  result={detail.result_data ?? {}}
                  metrics={detail.metrics ?? {}}
                />
              )}

              {/* Equity curve */}
              {detail.strategy_type !== 'sandbox_portfolio' && detail.result_data?.equity_curve?.length > 0 && (
                <div className="card">
                  <h3 className="font-medium text-slate-200 mb-4">Equity Curve</h3>
                  <EquityChart
                    data={detail.result_data.equity_curve}
                    initialCapital={detail.initial_capital}
                    height={260}
                  />
                </div>
              )}

              {detail.strategy_type !== 'sandbox_portfolio' && reportOhlcvWithSignals.length > 0 && (
                <div className="card">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-slate-200">Price Chart</h3>
                    <span className="text-xs text-slate-500">Buy/Sell flags from trade log</span>
                  </div>
                  <SubplotChart data={reportOhlcvWithSignals} height={240} />
                </div>
              )}

              {/* Trades */}
              {detail.strategy_type !== 'sandbox_portfolio' && groupedTrades.length > 0 && (
                <div className="card">
                  <h3 className="font-medium text-slate-200 mb-3">
                    Trade Log ({groupedTrades.length} grouped buy/sell trades)
                  </h3>
                  <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
                    {groupedTrades.map((t, i) => {
                      const isOpen = !!expandedTrades[t._id]
                      return (
                        <div key={t._id} className="border border-dark-600 rounded-lg overflow-hidden bg-dark-900/30">
                          <button
                            type="button"
                            onClick={() => setExpandedTrades(prev => ({ ...prev, [t._id]: !prev[t._id] }))}
                            className="w-full px-3 py-2 text-left hover:bg-dark-800/50 transition-colors"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-xs text-slate-500">Trade #{i + 1}</div>
                                <div className="text-sm text-slate-200 truncate font-mono">
                                  {t.entry_date} → {t.exit_date}
                                </div>
                              </div>
                              <div className="flex items-center gap-3 text-xs">
                                <span className="text-slate-400">Qty {Number(t.quantity ?? 0).toFixed(4)}</span>
                                <span className="text-slate-400 font-mono">${Number(t.entry_price ?? 0).toFixed(4)} → ${Number(t.exit_price ?? 0).toFixed(4)}</span>
                                <span className={t.pnl >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
                                  {t.pnl >= 0 ? '+' : ''}${Number(t.pnl ?? 0).toFixed(2)}
                                </span>
                                {isOpen ? <ChevronUpIcon className="h-4 w-4 text-slate-500" /> : <ChevronDownIcon className="h-4 w-4 text-slate-500" />}
                              </div>
                            </div>
                          </button>
                          {isOpen && (
                            <div className="px-3 pb-3 space-y-3 border-t border-dark-700/80 bg-dark-900/50">
                              <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
                                <span className="text-slate-400">Buy:</span><ReasonBadge value={t.entry_reason} />
                                <span className="text-slate-400 ml-3">Sell:</span><ReasonBadge value={t.exit_reason} />
                              </div>
                              {t._context?.bars?.length ? (
                                <div>
                                  <div className="text-xs text-slate-500 mb-2">
                                    Candlestick context ({t._context.bars.length} bars around entry/exit)
                                  </div>
                                  <CandlestickChart
                                    data={t._context.bars}
                                    height={220}
                                    showFloatingTooltip={true}
                                    hidePremarketAfterOpen={false}
                                  />
                                </div>
                              ) : (
                                <div className="text-xs text-slate-500">No nearby OHLC bars found for this trade window.</div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
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
