import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getBulkQuotes, getHistory } from '../api/client'
import { deriveMarketOpen } from '../utils/marketHours'
import { useWatchlist } from '../hooks/useWatchlist'
import WatchlistPanel from './dashboard/WatchlistPanel'
import PriceChartPanel from './dashboard/PriceChartPanel'
import MoversTab from './dashboard/MoversTab'
import NewsTab from './dashboard/NewsTab'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'movers',   label: 'Gainers & Losers' },
  { key: 'news',     label: 'News' },
]

export default function Dashboard() {
  const watchlistState = useWatchlist()
  const { watchlist, updateWatchlist } = watchlistState

  const [chartSymbol, setChartSymbol] = useState(() => watchlist[0] ?? 'AAPL')
  const [chartPeriod, setChartPeriod] = useState('1d')
  const [indicators, setIndicators] = useState({ bb: true, fastMa: true, slowMa: true, rsi: true, macd: true })
  const [activeTab, setActiveTab] = useState('overview')

  const toggleIndicator = (key) => setIndicators(prev => ({ ...prev, [key]: !prev[key] }))

  const wrappedUpdateWatchlist = (next) => {
    updateWatchlist(next)
    if (!next.includes(chartSymbol)) setChartSymbol(next[0] ?? '')
  }

  const { data: quotesMap, isLoading: quotesLoading } = useQuery({
    queryKey: ['bulk-quotes', watchlist],
    queryFn: () => getBulkQuotes(watchlist),
    staleTime: 45_000,
    refetchInterval: (query) => deriveMarketOpen(query.state.data) ? 60_000 : 5 * 60_000,
    enabled: watchlist.length > 0,
  })

  const [clockTick, setClockTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setClockTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marketOpen = useMemo(() => deriveMarketOpen(quotesMap), [quotesMap, clockTick])

  const shortPeriod = ['1d', '2d', '5d', '2w'].includes(chartPeriod)
  const histRefetchInterval = shortPeriod ? (marketOpen ? 60_000 : 5 * 60_000) : 15 * 60_000
  const histStaleTime       = shortPeriod ? (marketOpen ? 55_000 : 4 * 60_000) : 840_000

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ['history', chartSymbol, chartPeriod],
    queryFn: () => getHistory(chartSymbol, chartPeriod),
    staleTime: histStaleTime,
    refetchInterval: histRefetchInterval,
    enabled: !!chartSymbol,
  })

  return (
    <div className="p-6 pb-12 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Real-time market overview</p>
        </div>
        <div className="text-xs text-slate-500 font-mono">{new Date().toLocaleString()}</div>
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

      {activeTab === 'overview' && (
        <>
          <WatchlistPanel
            {...watchlistState}
            updateWatchlist={wrappedUpdateWatchlist}
            quotesMap={quotesMap}
            quotesLoading={quotesLoading}
            chartSymbol={chartSymbol}
            setChartSymbol={setChartSymbol}
          />
          <PriceChartPanel
            chartSymbol={chartSymbol}
            chartPeriod={chartPeriod}
            setChartPeriod={setChartPeriod}
            indicators={indicators}
            toggleIndicator={toggleIndicator}
            histData={histData}
            histLoading={histLoading}
          />
        </>
      )}
    </div>
  )
}
