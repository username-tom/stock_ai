import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getBulkQuotes, getHistory } from '../api/client'
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
const HISTORY_CACHE_KEY = 'dashboard_history_cache_v1'
const HISTORY_CACHE_SHORT_TTL_MS = 10 * 60_000
const HISTORY_CACHE_LONG_TTL_MS = 6 * 60 * 60_000
const HISTORY_CACHE_MAX_ENTRIES = 200

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

function getHistoryCacheTTL(period) {
  return ['1d', '2d', '5d', '2w'].includes(period)
    ? HISTORY_CACHE_SHORT_TTL_MS
    : HISTORY_CACHE_LONG_TTL_MS
}

function historyCacheKey(symbol, period) {
  return `${symbol || ''}|${period || ''}`
}

function getCachedHistory(symbol, period) {
  if (!symbol || !period) return undefined

  const cache = readHistoryCache()
  const key = historyCacheKey(symbol, period)
  const entry = cache?.[key]
  if (!entry?.data || !entry?.ts) return undefined

  if (Date.now() - entry.ts > getHistoryCacheTTL(period)) {
    return undefined
  }

  return entry.data
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
  const map = new Map(cachedRows.map(d => [d.date, d]))
  for (const d of freshRows) map.set(d.date, d)
  const sorted = Array.from(map.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
  return { ...freshObj, data: sorted }
}

function writeHistoryCache(symbol, period, data) {
  if (!symbol || !period || !data) return

  const now = Date.now()
  const cache = readHistoryCache()
  const existing = cache[historyCacheKey(symbol, period)]?.data
  const merged   = mergeHistoryData(existing, data)
  cache[historyCacheKey(symbol, period)] = { ts: now, data: merged }

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

  const [searchParams, setSearchParams] = useSearchParams()
  const [chartSymbol, setChartSymbol] = useState(() => searchParams.get('symbol') || watchlist[0] || 'AAPL')
  const [chartPeriod, setChartPeriod] = useState('1d')

  // Consume ?symbol= param on navigation from sandbox
  useEffect(() => {
    const sym = searchParams.get('symbol')
    if (sym) {
      setChartSymbol(sym)
      setActiveTab('charts')
      setSearchParams({}, { replace: true })
    }
  }, [searchParams])
  const [indicators, setIndicators] = useState({ bb: true, ma9: false, ma20: true, ma50: true, ma100: false, ma200: true, rsi: true, macd: true })
  const [activeTab, setActiveTab] = useState('charts')

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

  const shortPeriod = ['1d', '2d', '5d', '2w'].includes(chartPeriod)
  const histRefetchInterval = shortPeriod ? (marketOpen ? appSettings.chart_refresh_ms : 5 * 60_000) : 15 * 60_000
  const histStaleTime       = shortPeriod ? (marketOpen ? appSettings.chart_refresh_ms - 5_000 : 4 * 60_000) : 840_000
  const cachedHistory = useMemo(() => getCachedHistory(chartSymbol, chartPeriod), [chartSymbol, chartPeriod])

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ['history', chartSymbol, chartPeriod],
    queryFn: () => getHistory(chartSymbol, chartPeriod),
    initialData: cachedHistory,
    staleTime: histStaleTime,
    refetchInterval: histRefetchInterval,
    refetchIntervalInBackground: true,
    enabled: !!chartSymbol,
  })

  // Fetch 1Y daily data as warmup for indicator seeding on short-period charts.
  // MA(200) needs ~200 trading days; 1Y gives ~252.  Only needed for periods
  // where the visible data alone is too short to seed the indicators.
  const needsWarmup = ['5d', '2w', '1mo', '3mo', '6mo'].includes(chartPeriod)
  // Warmup shares the '1y' localStorage slot; serves as initialData so the
  // chart renders immediately on load without a network round-trip.
  const cachedWarmup = useMemo(() => getCachedHistory(chartSymbol, '1y'), [chartSymbol])
  const { data: warmupHistData } = useQuery({
    // Reuse the same key as the 1Y chart view so they share React Query's cache.
    queryKey: ['history', chartSymbol, '1y'],
    queryFn: () => getHistory(chartSymbol, '1y'),
    initialData: cachedWarmup,
    staleTime: 24 * 60 * 60_000,  // 24h — daily bars don’t change retroactively
    refetchIntervalInBackground: false,
    enabled: !!chartSymbol && needsWarmup,
  })
  const warmupData = needsWarmup ? (warmupHistData?.data ?? null) : null

  useEffect(() => {
    if (histData && chartSymbol && chartPeriod) {
      writeHistoryCache(chartSymbol, chartPeriod, histData)
    }
  }, [histData, chartSymbol, chartPeriod])

  // Persist warmup data so the next page load skips the 1Y fetch entirely
  useEffect(() => {
    if (warmupHistData && chartSymbol) {
      writeHistoryCache(chartSymbol, '1y', warmupHistData)
    }
  }, [warmupHistData, chartSymbol])

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
              chartPeriod={chartPeriod}
              setChartPeriod={setChartPeriod}
              indicators={indicators}
              toggleIndicator={toggleIndicator}
              histData={histData}
              histLoading={histLoading}
              chartPrevClose={chartPrevClose}
              warmupData={warmupData}
              quoteTelemetry={quotesMap?.[chartSymbol]?.ib_telemetry ?? null}
              isInWatchlist={watchlist.includes(chartSymbol)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
