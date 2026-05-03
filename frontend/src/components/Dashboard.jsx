import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getBulkQuotes, getHistory, getQuote, getMovers, searchSymbols } from '../api/client'
import SubplotChart from './charts/SubplotChart'
import { ArrowUpIcon, ArrowDownIcon, PencilSquareIcon, CheckIcon, PlusIcon, XMarkIcon, Bars3Icon } from '@heroicons/react/24/solid'

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']
const STORAGE_KEY = 'dashboard_watchlist'

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return DEFAULT_WATCHLIST
}

function saveWatchlist(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch {}
}

function QuoteCard({ data, isLoading }) {
  if (isLoading)
    return (
      <div className="card animate-pulse">
        <div className="h-5 w-16 bg-dark-500 rounded mb-2" />
        <div className="h-8 w-24 bg-dark-500 rounded" />
      </div>
    )

  if (!data)
    return (
      <div className="card opacity-50">
        <div className="text-xs text-slate-500">No data</div>
      </div>
    )

  const price = data.last_price ?? data.previous_close ?? 0
  const prev = data.previous_close ?? price
  const changePct = data.change_pct ?? (prev ? ((price - prev) / prev) * 100 : 0)
  const positive = changePct >= 0

  return (
    <div className="card hover:border-dark-500/80 transition-all cursor-default">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="group relative inline-block">
            <div className="text-sm font-semibold text-slate-300">{data.symbol}</div>
            {data.company_name && (
              <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 z-50
                             whitespace-nowrap rounded-md bg-dark-600 border border-dark-400
                             px-2 py-1 text-xs text-slate-200 shadow-lg
                             opacity-0 group-hover:opacity-100 transition-opacity">
                {data.company_name}
              </div>
            )}
          </div>
          <div className="text-xl font-bold font-mono mt-0.5">
            ${price.toFixed(2)}
          </div>
        </div>
        <span className={positive ? 'badge-green' : 'badge-red'}>
          {positive ? (
            <ArrowUpIcon className="h-3 w-3" />
          ) : (
            <ArrowDownIcon className="h-3 w-3" />
          )}
          {Math.abs(changePct).toFixed(2)}%
        </span>
      </div>
      <div className="flex gap-3 mt-2 text-xs text-slate-500">
        <span>H: ${data.day_high?.toFixed(2) ?? '—'}</span>
        <span>L: ${data.day_low?.toFixed(2) ?? '—'}</span>
      </div>
    </div>
  )
}

function MoverRow({ q, rank }) {
  const positive = q.change_pct >= 0
  return (
    <div className="flex items-center justify-between py-2 border-b border-dark-700 last:border-0">
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-600 w-5 text-right">{rank}</span>
        <div className="group relative">
          <span className="text-sm font-semibold text-slate-200 font-mono w-16 inline-block">{q.symbol}</span>
          {q.company_name && (
            <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 z-50
                            whitespace-nowrap rounded-md bg-dark-600 border border-dark-400
                            px-2 py-1 text-xs text-slate-200 shadow-lg
                            opacity-0 group-hover:opacity-100 transition-opacity">
              {q.company_name}
            </div>
          )}
        </div>
        <span className="text-sm font-mono text-slate-300">${q.last_price?.toFixed(2) ?? '—'}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500">
          Vol: {q.volume ? (q.volume >= 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`) : '—'}
        </span>
        <span className={`flex items-center gap-0.5 text-sm font-semibold font-mono ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
          {positive ? <ArrowUpIcon className="h-3.5 w-3.5" /> : <ArrowDownIcon className="h-3.5 w-3.5" />}
          {Math.abs(q.change_pct).toFixed(2)}%
        </span>
      </div>
    </div>
  )
}

function MoversTab() {
  const { data, isLoading, isError, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['movers'],
    queryFn: () => getMovers(10),
    refetchInterval: 5 * 60_000,
  })

  const asOf = data?.as_of ? new Date(data.as_of).toLocaleTimeString() : null

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-slate-500">{asOf ? `As of ${asOf}` : 'Refreshes every 5 min'}</p>
        <button
          onClick={() => refetch()}
          className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 px-2 py-0.5 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-9 bg-dark-700 rounded animate-pulse" />
          ))}
        </div>
      )}
      {isError && (
        <p className="text-sm text-slate-500 text-center py-8">Failed to load movers.</p>
      )}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <ArrowUpIcon className="h-3.5 w-3.5" /> Top Gainers
            </h3>
            {data.gainers.map((q, i) => <MoverRow key={q.symbol} q={q} rank={i + 1} />)}
          </div>
          <div>
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <ArrowDownIcon className="h-3.5 w-3.5" /> Top Losers
            </h3>
            {data.losers.map((q, i) => <MoverRow key={q.symbol} q={q} rank={i + 1} />)}
          </div>
        </div>
      )}
    </div>
  )
}

const INDICATOR_OPTIONS = [
  { key: 'bb',     label: 'BB' },
  { key: 'fastMa', label: 'Fast MA' },
  { key: 'slowMa', label: 'Slow MA' },
  { key: 'rsi',    label: 'RSI' },
  { key: 'macd',   label: 'MACD' },
]

export default function Dashboard() {
  const [watchlist, setWatchlist] = useState(loadWatchlist)
  const [chartSymbol, setChartSymbol] = useState(() => loadWatchlist()[0] ?? 'AAPL')
  const [chartPeriod, setChartPeriod] = useState('1y')
  const [indicators, setIndicators] = useState({ bb: true, fastMa: true, slowMa: true, rsi: true, macd: true })
  const [editing, setEditing] = useState(false)
  const [addInput, setAddInput] = useState('')
  const [addError, setAddError] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addSuggestions, setAddSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const addDebounce = useRef(null)
  const [activeTab, setActiveTab] = useState('overview')
  const dragItem = useRef(null)
  const dragOver = useRef(null)

  const toggleIndicator = (key) =>
    setIndicators(prev => ({ ...prev, [key]: !prev[key] }))

  const updateWatchlist = (next) => {
    setWatchlist(next)
    saveWatchlist(next)
    if (!next.includes(chartSymbol)) setChartSymbol(next[0] ?? '')
    window.dispatchEvent(new Event('watchlist-updated'))
  }

  const removeSymbol = (sym) => updateWatchlist(watchlist.filter(s => s !== sym))

  const handleAdd = async (sym = addInput.trim().toUpperCase()) => {
    if (!sym) return
    setShowSuggestions(false)
    if (watchlist.includes(sym)) { setAddError('Already in watchlist'); return }
    setAddLoading(true)
    setAddError('')
    try {
      await getQuote(sym)
      updateWatchlist([...watchlist, sym])
      setAddInput('')
      setAddSuggestions([])
    } catch {
      setAddError('Symbol not found')
    } finally {
      setAddLoading(false)
    }
  }

  const handleAddInputChange = (e) => {
    const val = e.target.value.toUpperCase()
    setAddInput(val)
    setAddError('')
    clearTimeout(addDebounce.current)
    if (val.length < 1) { setAddSuggestions([]); setShowSuggestions(false); return }
    addDebounce.current = setTimeout(() => {
      searchSymbols(val, 8).then(results => {
        setAddSuggestions(results)
        setShowSuggestions(results.length > 0)
      }).catch(() => {})
    }, 200)
  }

  const handleAddKey = (e) => {
    if (e.key === 'Enter') handleAdd()
    else if (e.key === 'Escape') { setShowSuggestions(false) }
  }

  const onDragStart = (index) => { dragItem.current = index }
  const onDragEnter = (index) => { dragOver.current = index }
  const onDragEnd = () => {
    if (dragItem.current === null || dragOver.current === null || dragItem.current === dragOver.current) {
      dragItem.current = null; dragOver.current = null; return
    }
    const next = [...watchlist]
    const [moved] = next.splice(dragItem.current, 1)
    next.splice(dragOver.current, 0, moved)
    dragItem.current = null; dragOver.current = null
    updateWatchlist(next)
  }

  const { data: quotesMap, isLoading: quotesLoading } = useQuery({
    queryKey: ['bulk-quotes', watchlist],
    queryFn: () => getBulkQuotes(watchlist),
    refetchInterval: 60_000,
    enabled: watchlist.length > 0,
  })

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ['history', chartSymbol, chartPeriod],
    queryFn: () => getHistory(chartSymbol, chartPeriod),
    enabled: !!chartSymbol,
  })

  return (
    <div className="p-6 pb-12 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Real-time market overview</p>
        </div>
        <div className="text-xs text-slate-500 font-mono">
          {new Date().toLocaleString()}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-dark-600 -mb-2">
        {[
          { key: 'overview', label: 'Overview' },
          { key: 'movers',   label: 'Gainers & Losers' },
        ].map(tab => (
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
          <MoversTab />
        </div>
      )}

      {activeTab === 'overview' && (<>
      {/* Watchlist quotes */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            Watchlist
          </h2>
          <button
            onClick={() => { setEditing(e => !e); setAddInput(''); setAddError('') }}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors ${
              editing
                ? 'bg-emerald-600/20 border-emerald-600 text-emerald-400'
                : 'border-dark-500 text-slate-400 hover:text-slate-200 hover:border-dark-400'
            }`}
          >
            {editing ? <CheckIcon className="h-3.5 w-3.5" /> : <PencilSquareIcon className="h-3.5 w-3.5" />}
            {editing ? 'Done' : 'Edit'}
          </button>
        </div>

        {/* Add symbol row */}
        {editing && (
          <div className="flex items-start gap-2 mb-5">
            <div className="relative flex-1 max-w-xs">
              <input
                value={addInput}
                onChange={handleAddInputChange}
                onKeyDown={handleAddKey}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                onFocus={() => addSuggestions.length > 0 && setShowSuggestions(true)}
                placeholder="Add symbol or company name…"
                maxLength={10}
                className="w-full bg-dark-700 border border-dark-500 rounded-md px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-600 font-mono uppercase"
              />
              {addError && (
                <p className="absolute -bottom-5 left-0 text-xs text-red-400">{addError}</p>
              )}
              {showSuggestions && (
                <ul className="absolute top-full left-0 right-0 mt-1 z-50 bg-dark-700 border border-dark-500 rounded-md shadow-xl overflow-hidden max-h-56 overflow-y-auto">
                  {addSuggestions.map(s => (
                    <li
                      key={s.symbol}
                      onMouseDown={() => handleAdd(s.symbol)}
                      className="flex items-center justify-between px-3 py-2 hover:bg-dark-600 cursor-pointer"
                    >
                      <span className="font-mono font-semibold text-sm text-slate-200">{s.symbol}</span>
                      <span className="text-xs text-slate-400 truncate ml-3 text-right">{s.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              onClick={() => handleAdd()}
              disabled={addLoading || !addInput.trim()}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40 transition-colors"
            >
              {addLoading ? (
                <span className="h-3.5 w-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin inline-block" />
              ) : (
                <PlusIcon className="h-3.5 w-3.5" />
              )}
              Add
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 mt-1">
          {watchlist.map((sym, idx) => (
            <div
              key={sym}
              draggable={editing}
              onDragStart={() => onDragStart(idx)}
              onDragEnter={() => onDragEnter(idx)}
              onDragEnd={onDragEnd}
              onDragOver={e => e.preventDefault()}
              onClick={() => { if (!editing) setChartSymbol(sym) }}
              className={`relative rounded-xl transition-all ${
                sym === chartSymbol && !editing
                  ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-dark-900'
                  : ''
              } ${editing ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
            >
              <QuoteCard data={quotesMap?.[sym]} isLoading={quotesLoading} />
              {editing && (
                <>
                  <button
                    onClick={e => { e.stopPropagation(); removeSymbol(sym) }}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center shadow-lg transition-colors z-10"
                  >
                    <XMarkIcon className="h-3 w-3 text-white" />
                  </button>
                  <div className="absolute top-1.5 left-1.5 text-slate-500 pointer-events-none">
                    <Bars3Icon className="h-3.5 w-3.5" />
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Price chart */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-slate-200">{chartSymbol} Price Chart</h2>
          </div>
          <div className="flex gap-1">
            {['1mo', '3mo', '6mo', '1y', '2y'].map(p => (
              <button
                key={p}
                onClick={() => setChartPeriod(p)}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  chartPeriod === p
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        {/* Indicator toggles */}
        <div className="flex flex-wrap gap-1 mb-3">
          {INDICATOR_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => toggleIndicator(key)}
              className={`px-2 py-0.5 text-xs rounded-md border transition-colors ${
                indicators[key]
                  ? 'bg-dark-600 border-emerald-600 text-emerald-400'
                  : 'bg-dark-800 border-dark-500 text-slate-500 hover:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {histLoading ? (
          <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
            Loading chart…
          </div>
        ) : (
          <SubplotChart data={histData?.data ?? []} height={220} indicators={indicators} />
        )}
      </div>

      </>)}
    </div>
  )
}
