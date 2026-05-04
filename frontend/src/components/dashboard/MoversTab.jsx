import { useState, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpIcon, ArrowDownIcon, EyeIcon, EyeSlashIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/solid'
import SubplotChart from '../charts/SubplotChart'
import { getMovers, getHistory } from '../../api/client'
import { useMarketOpen } from '../../hooks/useMarketOpen'
import { quotesentiment, SENTIMENT_COLORS, SENTIMENT_LABELS, quotesignal, SIGNAL_COLORS, SIGNAL_LABELS } from '../../utils/sentiment'

function fmt(n, digits = 2) { return n != null ? n.toFixed(digits) : '—' }
function fmtVol(v) {
  if (!v) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  return `${(v / 1e3).toFixed(0)}K`
}
function fmtMktCap(v) {
  if (!v) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(1)}M`
  return `$${v}`
}

/** Tooltip card that pops near the symbol name, flipping to stay in-viewport */
function MoverTooltip({ q, pos = {} }) {
  const positive = q.change_pct >= 0
  const rangePct = (q.last_price != null && q.day_high != null && q.day_low != null && q.day_high !== q.day_low)
    ? ((q.last_price - q.day_low) / (q.day_high - q.day_low) * 100).toFixed(1)
    : null

  return (
    <div
      className="pointer-events-none absolute z-50 w-64
                  rounded-lg bg-dark-600 border border-dark-400 shadow-2xl
                  opacity-0 group-hover:opacity-100 transition-opacity duration-150"
      style={pos}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-dark-500">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-slate-100 font-mono">{q.symbol}</span>
          <span className={`text-xs font-semibold font-mono ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
            {positive ? '+' : ''}{fmt(q.change_pct)}%
          </span>
        </div>
        {q.company_name && <p className="text-xs text-slate-400 mt-0.5 truncate">{q.company_name}</p>}
      </div>
      {/* Price block */}
      <div className="px-3 py-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-b border-dark-500">
        <div className="flex justify-between"><span className="text-slate-500">Price</span><span className="text-slate-200 font-mono">${fmt(q.last_price)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Prev Close</span><span className="text-slate-200 font-mono">${fmt(q.previous_close)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Day High</span><span className="text-emerald-400 font-mono">${fmt(q.day_high)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Day Low</span><span className="text-red-400 font-mono">${fmt(q.day_low)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Open</span><span className="text-slate-200 font-mono">${fmt(q.open)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Bid/Ask</span>
          <span className="text-slate-200 font-mono">
            {q.bid != null && q.ask != null ? `${fmt(q.bid)} / ${fmt(q.ask)}` : '—'}
          </span>
        </div>
      </div>
      {/* Volume / mkt cap */}
      <div className="px-3 py-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs border-b border-dark-500">
        <div className="flex justify-between"><span className="text-slate-500">Volume</span><span className="text-slate-200 font-mono">{fmtVol(q.volume)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Avg Vol</span><span className="text-slate-200 font-mono">{fmtVol(q.avg_volume)}</span></div>
        <div className="flex justify-between col-span-2"><span className="text-slate-500">Mkt Cap</span><span className="text-slate-200 font-mono">{fmtMktCap(q.market_cap)}</span></div>
      </div>
      {/* Day range bar */}
      {rangePct != null && (
        <div className="px-3 py-2 text-xs border-b border-dark-500">
          <div className="flex justify-between text-slate-500 mb-1">
            <span>Day Range</span><span>{rangePct}% from low</span>
          </div>
          <div className="h-1.5 w-full bg-dark-500 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-red-500 via-yellow-400 to-emerald-500 rounded-full"
                 style={{ width: `${rangePct}%` }} />
          </div>
          <div className="flex justify-between text-slate-600 mt-1">
            <span>${fmt(q.day_low)}</span><span>${fmt(q.day_high)}</span>
          </div>
        </div>
      )}
      {/* Signals */}
      {(() => {
        const s = quotesentiment(q); const sig = quotesignal(q)
        if (!s && !sig) return null
        return (
          <div className="px-3 py-2 flex gap-2">
            {s && <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SENTIMENT_COLORS[s]}`}>{SENTIMENT_LABELS[s]}</span>}
            {sig && <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SIGNAL_COLORS[sig]}`}>{SIGNAL_LABELS[sig]}</span>}
          </div>
        )
      })()}
    </div>
  )
}

const CHART_PERIODS = [
  { label: '1D', period: '1d', interval: '5m' },
  { label: '2D', period: '2d', interval: '15m' },
  { label: '5D', period: '5d', interval: '30m' },
]

function ChartDropdown({ symbol }) {
  const [activeTab, setActiveTab] = useState('1D')
  const tab = CHART_PERIODS.find(p => p.label === activeTab)
  const marketOpen = useMarketOpen()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['mover-history', symbol, tab.period, tab.interval],
    queryFn: () => getHistory(symbol, tab.period, tab.interval),
    staleTime: marketOpen ? 55_000 : 5 * 60_000,
    refetchInterval: marketOpen ? 60_000 : 5 * 60_000,
    refetchIntervalInBackground: true,
  })

  return (
    <div className="mt-1 mb-2 rounded-lg bg-dark-800 border border-dark-600 p-3">
      <div className="flex gap-1 mb-2">
        {CHART_PERIODS.map(p => (
          <button key={p.label}
            onClick={e => { e.stopPropagation(); setActiveTab(p.label) }}
            className={`px-2.5 py-0.5 rounded text-xs font-medium transition-colors
              ${activeTab === p.label
                ? 'bg-emerald-600 text-white'
                : 'text-slate-500 hover:text-slate-300 hover:bg-dark-700'}`}>
            {p.label}
          </button>
        ))}
      </div>
      {isLoading && (
        <div className="h-[180px] flex items-center justify-center text-slate-600 text-xs animate-pulse">
          Loading…
        </div>
      )}
      {isError && (
        <div className="h-[180px] flex items-center justify-center text-red-500 text-xs">
          Failed to load chart data
        </div>
      )}
      {!isLoading && !isError && (
        <SubplotChart
          data={data?.data ?? []}
          height={180}
          indicators={{ rsi: false, macd: false, bb: false, fastMa: false, slowMa: false }}
          period={tab.period}
          prevClose={data?.prev_close}
        />
      )}
    </div>
  )
}

function SymbolWithTooltip({ q }) {
  const anchorRef = useRef(null)
  const [pos, setPos] = useState({ top: '100%', left: 0 })

  const measurePosition = useCallback(() => {
    if (!anchorRef.current) return
    const anchor = anchorRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const TOOLTIP_H = 280
    const TOOLTIP_W = 256
    const GAP = 6

    // Vertical: prefer below, flip above if not enough room
    const spaceBelow = vh - anchor.bottom
    const spaceAbove = anchor.top
    let topStyle, bottomStyle
    if (spaceBelow >= TOOLTIP_H + GAP || spaceBelow >= spaceAbove) {
      topStyle    = anchor.height + GAP
      bottomStyle = 'auto'
    } else {
      topStyle    = 'auto'
      bottomStyle = anchor.height + GAP
    }

    // Horizontal: align left, clamp so it doesn't overflow right edge
    let leftStyle = 0
    const rightEdge = anchor.left + TOOLTIP_W
    if (rightEdge > vw - 8) {
      leftStyle = vw - 8 - rightEdge
    }

    setPos({ top: topStyle, bottom: bottomStyle, left: leftStyle })
  }, [])

  return (
    <div className="group relative" ref={anchorRef} onMouseEnter={measurePosition}>
      <a
        href={`https://finance.yahoo.com/quote/${q.symbol}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="text-sm font-semibold font-mono w-16 inline-block text-sky-400 hover:text-sky-300 hover:underline transition-colors"
      >
        {q.symbol}
      </a>
      <MoverTooltip q={q} pos={pos} />
    </div>
  )
}

function MoverRow({ q, rank, inWatchlist, onToggleWatchlist }) {
  const [expanded, setExpanded] = useState(false)
  const positive = q.change_pct >= 0
  return (
    <div className="border-b border-dark-700 last:border-0">
      <div
        className="flex items-center justify-between py-2 cursor-pointer hover:bg-dark-700/40 rounded transition-colors px-1 -mx-1"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-600 w-5 text-right">{rank}</span>
          {/* Symbol with rich tooltip */}
          <SymbolWithTooltip q={q} />
          <span className="text-sm font-mono text-slate-300">${fmt(q.last_price)}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            Vol: {fmtVol(q.volume)}
          </span>
          <span className={`flex items-center gap-0.5 text-sm font-semibold font-mono ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
            {positive ? <ArrowUpIcon className="h-3.5 w-3.5" /> : <ArrowDownIcon className="h-3.5 w-3.5" />}
            {Math.abs(q.change_pct).toFixed(2)}%
          </span>
          {(() => {
            const s = quotesentiment(q)
            if (!s) return null
            return (
              <span className={`hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SENTIMENT_COLORS[s]}`}>
                {SENTIMENT_LABELS[s]}
              </span>
            )
          })()}
          {(() => {
            const sig = quotesignal(q)
            if (!sig) return null
            return (
              <span className={`hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SIGNAL_COLORS[sig]}`}>
                {SIGNAL_LABELS[sig]}
              </span>
            )
          })()}
          <button
            onClick={e => { e.stopPropagation(); onToggleWatchlist(q.symbol) }}
            title={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
            className={`p-1 rounded transition-colors ${
              inWatchlist
                ? 'text-emerald-400 hover:text-red-400'
                : 'text-slate-600 hover:text-emerald-400'
            }`}
          >
            {inWatchlist
              ? <EyeIcon className="h-4 w-4" />
              : <EyeSlashIcon className="h-4 w-4" />}
          </button>
          {expanded
            ? <ChevronUpIcon className="h-3.5 w-3.5 text-slate-500" />
            : <ChevronDownIcon className="h-3.5 w-3.5 text-slate-500" />}
        </div>
      </div>
      {expanded && <ChartDropdown symbol={q.symbol} />}
    </div>
  )
}

export default function MoversTab({ watchlist = [], toggleSymbol }) {
  const marketOpen = useMarketOpen()
  const queryClient = useQueryClient()
  const [forceLoading, setForceLoading] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['movers'],
    queryFn: () => getMovers(25),
    staleTime: marketOpen ? 4 * 60_000 : 10 * 60_000,
    refetchInterval: marketOpen ? 5 * 60_000 : false,
    refetchIntervalInBackground: true,
  })

  const handleRefresh = async () => {
    setForceLoading(true)
    try {
      const fresh = await getMovers(25, true)
      queryClient.setQueryData(['movers'], fresh)
    } catch {
      refetch()
    } finally {
      setForceLoading(false)
    }
  }

  const asOf = data?.as_of ? new Date(data.as_of).toLocaleTimeString() : null

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-slate-500">
          {asOf ? `As of ${asOf}` : marketOpen ? 'Refreshes every 5 min' : 'Market closed'}
        </p>
        <button
          onClick={handleRefresh}
          disabled={forceLoading}
          className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 px-2 py-0.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {forceLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {(isLoading || isError) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[0, 1].map(col => (
            <div key={col} className="space-y-1">
              <div className="h-4 w-24 bg-dark-600 rounded animate-pulse mb-3" />
              {Array.from({ length: 13 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-dark-700">
                  <div className="flex items-center gap-3">
                    <div className="h-3 w-4 bg-dark-700 rounded animate-pulse" />
                    <div className="h-4 w-14 bg-dark-600 rounded animate-pulse" />
                    <div className="h-4 w-12 bg-dark-700 rounded animate-pulse" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-3 w-16 bg-dark-700 rounded animate-pulse" />
                    <div className="h-4 w-14 bg-dark-600 rounded animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <ArrowUpIcon className="h-3.5 w-3.5" /> Top Gainers
            </h3>
            {data.gainers.map((q, i) => (
              <MoverRow key={q.symbol} q={q} rank={i + 1}
                inWatchlist={watchlist.includes(q.symbol)}
                onToggleWatchlist={toggleSymbol} />
            ))}
          </div>
          <div>
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <ArrowDownIcon className="h-3.5 w-3.5" /> Top Losers
            </h3>
            {data.losers.map((q, i) => (
              <MoverRow key={q.symbol} q={q} rank={i + 1}
                inWatchlist={watchlist.includes(q.symbol)}
                onToggleWatchlist={toggleSymbol} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
