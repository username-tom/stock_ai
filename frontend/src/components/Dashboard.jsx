import { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getBulkQuotes, getHistory, getIBStatus } from '../api/client'
import { useMarketOpen } from '../hooks/useMarketOpen'
import { useWatchlist } from '../hooks/useWatchlist'
import { useAppSettings } from '../hooks/useAppSettings'
import WatchlistPanel from './dashboard/WatchlistPanel'
import PriceChartPanel from './dashboard/PriceChartPanel'
import SymbolDetailPanel from './dashboard/SymbolDetailPanel'
import MoversTab from './dashboard/MoversTab'
import NewsTab from './dashboard/NewsTab'
import EarningsTab from './dashboard/EarningsTab'

const TABS = [
  { key: 'charts', label: 'Charts' },
  { key: 'movers',   label: 'Gainers & Losers' },
  { key: 'news',     label: 'News' },
  { key: 'earnings', label: 'Earnings' },
]

const QUOTE_CACHE_KEY = 'dashboard_quote_cache_v1'
const QUOTE_CACHE_TTL_MS = 15 * 60_000
const QUOTE_CACHE_MAX_SYMBOLS = 300
const HISTORY_CACHE_KEY = 'dashboard_history_cache_v2'
const HISTORY_CACHE_SHORT_TTL_MS = 10 * 60_000
const HISTORY_CACHE_LONG_TTL_MS = 6 * 60 * 60_000
const HISTORY_CACHE_MAX_ENTRIES = 200
const DASHBOARD_CHART_TYPE_KEY = 'dashboard_chart_type_v1'

const CHART_TYPE_OPTIONS = [
  { key: 'line', label: 'Price Line' },
  { key: 'candles', label: 'Candlestick' },
]

const LINE_PERIOD_OPTIONS = [
  { key: '1d',  label: '1D' },
  { key: '2d',  label: '2D' },
  { key: '5d',  label: '5D' },
  { key: '2w',  label: '2W' },
  { key: '1mo', label: '1M' },
  { key: '3mo', label: '3M' },
  { key: '6mo', label: '6M' },
  { key: '1y',  label: '1Y' },
  { key: '2y',  label: '2Y' },
  { key: '5y',  label: '5Y' },
  { key: 'max', label: 'Max' },
]

const CANDLE_PERIOD_OPTIONS = LINE_PERIOD_OPTIONS

const PERIOD_INTERVAL_HINTS = {
  '1d': '1m',
  '2d': '1m',
  '5d': '15m',
  '2w': '15m',
  '1mo': '1h',
  '3mo': '1d',
  '6mo': '1d',
  '1y': '1d',
  '2y': '1d',
  '5y': '1d',
  'max': '1d',
}

const CANDLE_PERIOD_INTERVAL_HINTS = {
  ...PERIOD_INTERVAL_HINTS,
  max: '3mo',
}

function readQuoteCache() {
  try {
    const raw = localStorage.getItem(QUOTE_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeQuoteCache(quotesMap) {
  if (!quotesMap || typeof quotesMap !== 'object') return

  const now = Date.now()
  const merged = readQuoteCache()

  for (const [symbol, quote] of Object.entries(quotesMap)) {
    if (!symbol || !quote) continue
    merged[symbol] = { ts: now, quote }
  }

  for (const [symbol, entry] of Object.entries(merged)) {
    if (!entry?.ts || now - entry.ts > QUOTE_CACHE_TTL_MS) {
      delete merged[symbol]
    }
  }

  const entries = Object.entries(merged)
  if (entries.length > QUOTE_CACHE_MAX_SYMBOLS) {
    entries.sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0))
    const trimmed = Object.fromEntries(entries.slice(0, QUOTE_CACHE_MAX_SYMBOLS))
    try { localStorage.setItem(QUOTE_CACHE_KEY, JSON.stringify(trimmed)) } catch {}
    return
  }

  try { localStorage.setItem(QUOTE_CACHE_KEY, JSON.stringify(merged)) } catch {}
}

function getCachedQuotesForSymbols(symbols) {
  if (!symbols?.length) return undefined

  const now = Date.now()
  const cache = readQuoteCache()
  const out = {}

  for (const symbol of symbols) {
    const entry = cache?.[symbol]
    if (entry?.quote && entry?.ts && (now - entry.ts) <= QUOTE_CACHE_TTL_MS) {
      out[symbol] = entry.quote
    }
  }

  return Object.keys(out).length ? out : undefined
}

function readHistoryCache() {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function readStoredChartType() {
  try {
    const raw = localStorage.getItem(DASHBOARD_CHART_TYPE_KEY)
    return raw === 'candles' ? 'candles' : 'line'
  } catch {
    return 'line'
  }
}

function getHistoryCacheTTL(period) {
  return ['1d', '2d', '5d', '2w'].includes(period)
    ? HISTORY_CACHE_SHORT_TTL_MS
    : HISTORY_CACHE_LONG_TTL_MS
}

function trimIntradayRowsToRecentDays(rows, daysToKeep) {
  if (!Array.isArray(rows) || !rows.length) return rows
  if (!Number.isFinite(daysToKeep) || daysToKeep <= 0) return rows

  const withDay = rows
    .map((row, idx) => ({
      row,
      idx,
      day: (typeof row?.date === 'string' ? row.date.slice(0, 5) : ''),
    }))
    .filter(item => /^\d{2}\/\d{2}$/.test(item.day))

  if (!withDay.length) return rows

  const distinctDays = []
  for (const item of withDay) {
    if (!distinctDays.includes(item.day)) distinctDays.push(item.day)
  }
  const keepDays = new Set(distinctDays.slice(-daysToKeep))
  const kept = withDay.filter(item => keepDays.has(item.day)).map(item => item.row)
  return kept.length ? kept : rows
}

function sanitizeCachedHistoryByPeriod(data, period) {
  if (!data || !Array.isArray(data.data)) return data
  if (period === '1d') {
    return { ...data, data: trimIntradayRowsToRecentDays(data.data, 1) }
  }
  if (period === '2d') {
    return { ...data, data: trimIntradayRowsToRecentDays(data.data, 2) }
  }
  return data
}

function historyCacheKey(symbol, period, interval) {
  return `${symbol || ''}|${period || ''}|${interval || ''}`
}

function getCachedHistory(symbol, period, interval) {
  if (!symbol || !period || !interval) return undefined

  const cache = readHistoryCache()
  const key = historyCacheKey(symbol, period, interval)
  const entry = cache?.[key]
  if (!entry?.data || !entry?.ts) return undefined

  if (Date.now() - entry.ts > getHistoryCacheTTL(period)) {
    return undefined
  }

  return sanitizeCachedHistoryByPeriod(entry.data, period)
}

/**
 * Merge two histData objects by their `.data` OHLCV arrays.
 * For bars with the same date, the fresh value wins (handles intraday updates).
 * Bars present only in cached are preserved (prior history).
 * Result `.data` is sorted ascending by date.
 */
function mergeHistoryData(cachedObj, freshObj) {
  if (!cachedObj) return freshObj
  if (!freshObj)  return cachedObj
  const cachedRows = Array.isArray(cachedObj.data) ? cachedObj.data : []
  const freshRows  = Array.isArray(freshObj.data)  ? freshObj.data  : []
  if (!cachedRows.length) return freshObj
  if (!freshRows.length)  return cachedObj

  const dateStyle = (rows) => {
    const sample = rows.find(r => typeof r?.date === 'string')?.date ?? ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) return 'iso-date'
    if (/^\d{2}\/\d{2} \d{2}:\d{2}$/.test(sample)) return 'intraday-label'
    return 'other'
  }
  const cachedStyle = dateStyle(cachedRows)
  const freshStyle = dateStyle(freshRows)
  if (cachedStyle !== freshStyle && freshStyle !== 'other') {
    // Do not merge incompatible label formats (legacy cache vs new format).
    return freshObj
  }

  const map = new Map(cachedRows.map(d => [d.date, d]))
  for (const d of freshRows) map.set(d.date, d)
  const sorted = Array.from(map.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
  return { ...freshObj, data: sorted }
}

function writeHistoryCache(symbol, period, interval, data) {
  if (!symbol || !period || !interval || !data) return

  const now = Date.now()
  const cache = readHistoryCache()
  const existing = cache[historyCacheKey(symbol, period, interval)]?.data
  const shouldMerge = !['1d', '2d'].includes(period)
  const merged = shouldMerge ? mergeHistoryData(existing, data) : data
  cache[historyCacheKey(symbol, period, interval)] = { ts: now, data: merged }

  for (const [key, entry] of Object.entries(cache)) {
    const parts = key.split('|')
    const entryPeriod = parts[1] || ''
    if (!entry?.ts || now - entry.ts > getHistoryCacheTTL(entryPeriod)) {
      delete cache[key]
    }
  }

  const entries = Object.entries(cache)
  if (entries.length > HISTORY_CACHE_MAX_ENTRIES) {
    entries.sort((a, b) => (b[1]?.ts ?? 0) - (a[1]?.ts ?? 0))
    const trimmed = Object.fromEntries(entries.slice(0, HISTORY_CACHE_MAX_ENTRIES))
    try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(trimmed)) } catch {}
    return
  }

  try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(cache)) } catch {}
}

export default function Dashboard() {
  const appSettings = useAppSettings()
  const watchlistState = useWatchlist()
  const { watchlist, updateWatchlist } = watchlistState

  const { pathname } = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [chartSymbol, setChartSymbol] = useState(() => searchParams.get('symbol') || watchlist[0] || 'AAPL')
  const [chartPeriod, setChartPeriod] = useState('1d')
  const [chartType, setChartType] = useState(readStoredChartType)
  // IB-only 5-second candles toggle. Only meaningful for the 1D candle view.
  const [useFiveSec, setUseFiveSec] = useState(false)

  const { data: ibStatus } = useQuery({
    queryKey: ['ib-status'],
    queryFn: getIBStatus,
    refetchInterval: appSettings.trading_status_ms ?? 30_000,
    staleTime: 15_000,
  })
  const ibConnected = ibStatus?.connected === true
  const ibHasLiveMarketData = Number(ibStatus?.market_data_type) === 1

  // Consume ?symbol= param on navigation from sandbox.
  // Guard with pathname === '/' so this panel doesn't strip params
  // intended for other persistent panels (e.g. /sandbox?symbol=X).
  useEffect(() => {
    if (pathname !== '/') return
    const sym = searchParams.get('symbol')
    if (sym) {
      setChartSymbol(sym)
      setActiveTab('charts')
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, pathname])
  const [indicators, setIndicators] = useState({ bb: true, ma9: false, ma20: true, ma50: true, ma100: false, ma200: true, rsi: true, macd: true })
  const [activeTab, setActiveTab] = useState('charts')

  const periodOptions = chartType === 'candles' ? CANDLE_PERIOD_OPTIONS : LINE_PERIOD_OPTIONS
  const intervalHints = chartType === 'candles' ? CANDLE_PERIOD_INTERVAL_HINTS : PERIOD_INTERVAL_HINTS

  useEffect(() => {
    if (!periodOptions.some(p => p.key === chartPeriod)) {
      setChartPeriod(periodOptions[0]?.key ?? '1d')
    }
  }, [chartPeriod, periodOptions])

  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_CHART_TYPE_KEY, chartType)
    } catch {
      // Ignore storage failures (private mode/quota) and keep UI functional.
    }
  }, [chartType])

  const toggleIndicator = (key) => setIndicators(prev => ({ ...prev, [key]: !prev[key] }))

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1_000)
    return () => clearInterval(id)
  }, [])

  const wrappedUpdateWatchlist = (next) => {
    updateWatchlist(next)
    if (!next.includes(chartSymbol)) setChartSymbol(next[0] ?? '')
  }

  // marketOpen is initialized from clock; updates again once quotesMap arrives
  const [quotesMapForHook, setQuotesMapForHook] = useState(null)
  const marketOpen = useMarketOpen(quotesMapForHook)

  const cachedQuotesMap = useMemo(() => getCachedQuotesForSymbols(watchlist), [watchlist])

  const { data: quotesMap, isLoading: quotesLoading } = useQuery({
    queryKey: ['bulk-quotes', watchlist],
    queryFn: () => getBulkQuotes(watchlist),
    initialData: cachedQuotesMap,
    staleTime: 30_000,
    refetchInterval: marketOpen ? appSettings.quotes_refresh_ms : 5 * 60_000,
    refetchIntervalInBackground: true,
    enabled: watchlist.length > 0,
  })

  useEffect(() => {
    if (quotesMap) writeQuoteCache(quotesMap)
  }, [quotesMap])

  // Feed quotesMap back into the hook so market_state signals are used
  useEffect(() => { setQuotesMapForHook(quotesMap ?? null) }, [quotesMap])

  const fiveSecActive =
    useFiveSec && ibConnected && ibHasLiveMarketData &&
    chartType === 'candles' && chartPeriod === '1d'
  const chartInterval = fiveSecActive ? '5s' : (intervalHints[chartPeriod] ?? '1d')

  // Reflect capability changes in toggle state.
  useEffect(() => {
    if (useFiveSec && (!ibConnected || !ibHasLiveMarketData)) setUseFiveSec(false)
  }, [useFiveSec, ibConnected, ibHasLiveMarketData])

  const shortPeriod = ['1d', '2d', '5d', '2w'].includes(chartPeriod)
  // 5s bars need a much faster refresh; 1m+ falls back to user-configured cadence.
  const histRefetchInterval = fiveSecActive
    ? 10_000
    : (shortPeriod ? (marketOpen ? appSettings.chart_refresh_ms : 5 * 60_000) : 15 * 60_000)
  const histStaleTime = fiveSecActive
    ? 5_000
    : (shortPeriod ? (marketOpen ? appSettings.chart_refresh_ms - 5_000 : 4 * 60_000) : 840_000)
  const cachedHistory = useMemo(
    () => getCachedHistory(chartSymbol, chartPeriod, chartInterval),
    [chartSymbol, chartPeriod, chartInterval]
  )

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ['history', chartSymbol, chartPeriod, chartInterval],
    queryFn: () => getHistory(chartSymbol, chartPeriod, chartInterval),
    initialData: cachedHistory,
    staleTime: histStaleTime,
    refetchInterval: histRefetchInterval,
    refetchIntervalInBackground: true,
    enabled: !!chartSymbol,
  })

  // Fetch 1Y daily data as warmup for indicator seeding on short-period charts.
  // Indicator warmup needs to match the visible chart interval. Mixing daily
  // warmup bars into intraday series distorts Bollinger Bands at the left edge.
  const warmupPeriodByChartPeriod = {
    '5d': '1mo',
    '2w': '1mo',
    '1mo': '3mo',
    '3mo': '6mo',
    '6mo': '1y',
  }
  const warmupPeriod = warmupPeriodByChartPeriod[chartPeriod] ?? null
  const needsWarmup = !!warmupPeriod
  const warmupInterval = chartInterval || '1d'
  const cachedWarmup = useMemo(
    () => (warmupPeriod ? getCachedHistory(chartSymbol, warmupPeriod, warmupInterval) : null),
    [chartSymbol, warmupPeriod, warmupInterval]
  )
  const { data: warmupHistData } = useQuery({
    // Use the same interval as the visible chart so seeded indicators stay aligned.
    queryKey: ['history', chartSymbol, warmupPeriod, warmupInterval],
    queryFn: () => getHistory(chartSymbol, warmupPeriod, warmupInterval),
    initialData: cachedWarmup,
    staleTime: 24 * 60 * 60_000,  // 24h — daily bars don’t change retroactively
    refetchIntervalInBackground: false,
    enabled: !!chartSymbol && needsWarmup,
  })
  const warmupData = needsWarmup ? (warmupHistData?.data ?? null) : null

  useEffect(() => {
    if (histData && chartSymbol && chartPeriod && chartInterval) {
      writeHistoryCache(chartSymbol, chartPeriod, chartInterval, histData)
    }
  }, [histData, chartSymbol, chartPeriod, chartInterval])

  // Persist warmup data so the next page load skips the same-interval fetch entirely
  useEffect(() => {
    if (warmupHistData && chartSymbol) {
      writeHistoryCache(chartSymbol, warmupPeriod, warmupInterval, warmupHistData)
    }
  }, [warmupHistData, chartSymbol, warmupPeriod, warmupInterval])

  // Cap displayed bars when in 5s mode so the chart stays readable and snappy.
  // ~60 min of trading (5s bars) is enough to gauge short-term momentum without
  // overwhelming the X-axis.
  const FIVE_SEC_MAX_BARS = 720
  const displayHistData = useMemo(() => {
    if (!fiveSecActive || !histData?.data?.length) return histData
    const rows = histData.data
    if (rows.length <= FIVE_SEC_MAX_BARS) return histData
    return { ...histData, data: rows.slice(-FIVE_SEC_MAX_BARS) }
  }, [fiveSecActive, histData])

  const chartPrevClose =
    quotesMap?.[chartSymbol]?.previous_close ??
    histData?.prev_close ??
    null

  return (
    <div className="p-6 pb-12 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Real-time market charts</p>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${marketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
            <span className="text-xs text-slate-500">{marketOpen ? 'Market Open' : 'Market Closed'}</span>
          </div>
          <div className="text-xs text-slate-600 font-mono tabular-nums mt-0.5">
            {now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            {' · '}
            {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b border-dark-600 -mb-2">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'movers' && (
        <div className="card">
          <MoversTab watchlist={watchlist} toggleSymbol={watchlistState.toggleSymbol} />
        </div>
      )}

      {activeTab === 'news' && (
        <NewsTab watchlist={watchlist} />
      )}

      {activeTab === 'earnings' && (
        <EarningsTab watchlist={watchlist} />
      )}

      {activeTab === 'charts' && (
        <div className="flex gap-4" style={{ minHeight: '520px' }}>
          {/* Left: scrollable symbol list */}
          <div className="w-72 flex-shrink-0 card flex flex-col overflow-visible" style={{ maxHeight: '80vh', minHeight: '400px' }}>
            <WatchlistPanel
              {...watchlistState}
              updateWatchlist={wrappedUpdateWatchlist}
              quotesMap={quotesMap}
              quotesLoading={quotesLoading}
              chartSymbol={chartSymbol}
              setChartSymbol={setChartSymbol}
            />
          </div>
          {/* Middle: symbol details */}
          <div className="w-52 flex-shrink-0">
            <SymbolDetailPanel
              symbol={chartSymbol}
              quoteData={quotesMap?.[chartSymbol] ?? null}
              isLoading={quotesLoading}
            />
          </div>
          {/* Right: price chart */}
          <div className="flex-1 min-w-0">
            <PriceChartPanel
              chartSymbol={chartSymbol}
              chartType={chartType}
              setChartType={setChartType}
              chartPeriod={chartPeriod}
              setChartPeriod={setChartPeriod}
              chartInterval={chartInterval}
              chartTypeOptions={CHART_TYPE_OPTIONS}
              periodOptions={periodOptions}
              indicators={indicators}
              toggleIndicator={toggleIndicator}
              histData={displayHistData}
              histLoading={histLoading}
              chartPrevClose={chartPrevClose}
              warmupData={warmupData}
              quoteTelemetry={quotesMap?.[chartSymbol]?.ib_telemetry ?? null}
              isInWatchlist={watchlist.includes(chartSymbol)}
              ibConnected={ibConnected}
              useFiveSec={useFiveSec}
              setUseFiveSec={setUseFiveSec}
              fiveSecAvailable={ibConnected && ibHasLiveMarketData}
            />
          </div>
        </div>
      )}
    </div>
  )
}
