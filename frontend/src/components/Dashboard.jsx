import { useState, useEffect } from 'react'
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
      setSearchParams({}, { replace: true })
    }
  }, [searchParams])
  const [indicators, setIndicators] = useState({ bb: true, fastMa: true, slowMa: true, rsi: true, macd: true })
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

  const { data: quotesMap, isLoading: quotesLoading } = useQuery({
    queryKey: ['bulk-quotes', watchlist],
    queryFn: () => getBulkQuotes(watchlist),
    staleTime: 30_000,
    refetchInterval: marketOpen ? appSettings.quotes_refresh_ms : 5 * 60_000,
    refetchIntervalInBackground: true,
    enabled: watchlist.length > 0,
  })

  // Feed quotesMap back into the hook so market_state signals are used
  useEffect(() => { setQuotesMapForHook(quotesMap ?? null) }, [quotesMap])

  const shortPeriod = ['1d', '2d', '5d', '2w'].includes(chartPeriod)
  const histRefetchInterval = shortPeriod ? (marketOpen ? appSettings.chart_refresh_ms : 5 * 60_000) : 15 * 60_000
  const histStaleTime       = shortPeriod ? (marketOpen ? appSettings.chart_refresh_ms - 5_000 : 4 * 60_000) : 840_000

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ['history', chartSymbol, chartPeriod],
    queryFn: () => getHistory(chartSymbol, chartPeriod),
    staleTime: histStaleTime,
    refetchInterval: histRefetchInterval,
    refetchIntervalInBackground: true,
    enabled: !!chartSymbol,
  })

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
              quoteTelemetry={quotesMap?.[chartSymbol]?.ib_telemetry ?? null}
            />
          </div>
        </div>
      )}
    </div>
  )
}
