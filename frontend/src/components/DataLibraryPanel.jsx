import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CircleStackIcon, ShieldCheckIcon, GlobeAltIcon,
  MagnifyingGlassIcon, ArrowPathIcon,
} from '@heroicons/react/24/outline'
import { getDataLibrarySymbols, getDataLibraryHistory } from '../api/client'
import TradingDayRangePicker from './dataLibrary/TradingDayRangePicker'
import DataLibraryChartPanel from './dataLibrary/DataLibraryChartPanel'

const CHART_TYPE_KEY = 'data_library_chart_type_v1'

function readChartType() {
  try {
    return localStorage.getItem(CHART_TYPE_KEY) === 'candles' ? 'candles' : 'line'
  } catch {
    return 'line'
  }
}

function dateOnly(ts) {
  if (!ts || typeof ts !== 'string') return '—'
  return ts.slice(0, 10)
}

function spanDays(start, end) {
  if (!start || !end) return 0
  const a = new Date(`${start}T00:00:00`)
  const b = new Date(`${end}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0
  return Math.round((b - a) / 86400000) + 1
}

export default function DataLibraryPanel() {
  const [selectedSymbol, setSelectedSymbol] = useState(null)
  const [dateRange, setDateRange] = useState({ start: null, end: null })
  const [chartType, setChartType] = useState(readChartType)
  const [filter, setFilter] = useState('')
  const [indicators, setIndicators] = useState({
    bb: false, ma9: false, ma20: false, ma50: false,
    ma100: false, ma200: false, rsi: false, macd: false,
  })

  useEffect(() => {
    try { localStorage.setItem(CHART_TYPE_KEY, chartType) } catch {}
  }, [chartType])

  function toggleIndicator(key) {
    setIndicators(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const { data: symbolsData, isLoading: symbolsLoading, refetch, isFetching } = useQuery({
    queryKey: ['data-library-symbols'],
    queryFn: getDataLibrarySymbols,
    staleTime: 60_000,
  })

  const symbols = symbolsData?.symbols ?? []

  const selectedEntry = useMemo(
    () => symbols.find(s => s.symbol === selectedSymbol) ?? null,
    [symbols, selectedSymbol],
  )

  // Auto-select the first symbol and default to its most recent stored day.
  useEffect(() => {
    if (selectedSymbol || symbols.length === 0) return
    const first = symbols[0]
    setSelectedSymbol(first.symbol)
    const newest = dateOnly(first.newest)
    if (newest && newest !== '—') setDateRange({ start: newest, end: newest })
  }, [symbols, selectedSymbol])

  // When switching symbols, snap the range to the symbol's newest day if the
  // current range falls entirely outside its coverage (keeps charts populated).
  function handleSelectSymbol(entry) {
    setSelectedSymbol(entry.symbol)
    const newest = dateOnly(entry.newest)
    const oldest = dateOnly(entry.oldest)
    const { start, end } = dateRange
    const outOfRange = !start || !end || end < oldest || start > newest
    if (outOfRange && newest !== '—') {
      setDateRange({ start: newest, end: newest })
    }
  }

  const rangeReady = Boolean(dateRange.start && dateRange.end)
  const span = spanDays(dateRange.start, dateRange.end)
  const displayPeriod = span === 1 ? '1d' : span === 2 ? '2d' : '1mo'

  const { data: histData, isLoading: histLoading, isFetching: histFetching } = useQuery({
    queryKey: ['data-library-history', selectedSymbol, dateRange.start, dateRange.end],
    queryFn: () => getDataLibraryHistory(selectedSymbol, dateRange.start, dateRange.end),
    enabled: Boolean(selectedSymbol) && rangeReady,
  })

  const filteredSymbols = useMemo(() => {
    const q = filter.trim().toUpperCase()
    if (!q) return symbols
    return symbols.filter(s => s.symbol.includes(q))
  }, [symbols, filter])

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CircleStackIcon className="h-7 w-7 text-emerald-400" />
          <div>
            <h1 className="text-xl font-bold text-slate-100">Historical Data Library</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Browse locally stored 1-minute data, verify its source, and chart any date range.
            </p>
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-md px-2.5 py-1.5 disabled:opacity-50"
          title="Refresh cached symbols"
        >
          <ArrowPathIcon className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        {/* Left column: date picker + detail panel */}
        <div className="space-y-4 xl:col-span-1">
          <TradingDayRangePicker value={dateRange} onChange={setDateRange} />

          <div className="bg-dark-800 border border-dark-500 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-200">Stored Symbols</h2>
              <span className="text-[10px] text-slate-500">{symbols.length} cached</span>
            </div>

            <div className="relative mb-3">
              <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter symbols…"
                className="w-full bg-dark-700 border border-dark-500 rounded-md pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-600"
              />
            </div>

            {symbolsLoading ? (
              <div className="text-xs text-slate-500 py-6 text-center">Loading…</div>
            ) : filteredSymbols.length === 0 ? (
              <div className="text-xs text-slate-500 py-6 text-center">
                No locally stored 1-minute data found yet.
              </div>
            ) : (
              <div className="space-y-1 max-h-[480px] overflow-auto pr-1">
                {filteredSymbols.map(entry => {
                  const isActive = entry.symbol === selectedSymbol
                  return (
                    <button
                      key={entry.symbol}
                      onClick={() => handleSelectSymbol(entry)}
                      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                        isActive
                          ? 'bg-emerald-600/15 border-emerald-600/40'
                          : 'bg-dark-900/40 border-dark-600 hover:border-dark-400'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-semibold text-sm text-slate-100">
                          {entry.symbol}
                        </span>
                        <span
                          title={entry.ib_verified ? 'IB verified' : 'Free source (e.g. Yahoo)'}
                          className="flex items-center"
                        >
                          {entry.ib_verified ? (
                            <ShieldCheckIcon className="h-4 w-4 text-emerald-400" />
                          ) : (
                            <GlobeAltIcon className="h-4 w-4 text-slate-500" />
                          )}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                        <span className="font-mono">
                          {dateOnly(entry.oldest)} → {dateOnly(entry.newest)}
                        </span>
                        <span>{Number(entry.rows ?? 0).toLocaleString()} bars</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(entry.sources ?? []).map(s => (
                          <span
                            key={s.source}
                            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold border ${
                              s.ib_verified
                                ? 'border-emerald-700/40 bg-emerald-900/20 text-emerald-300'
                                : 'border-slate-700 bg-dark-800 text-slate-400'
                            }`}
                          >
                            {s.source === 'yfinance' ? 'yahoo' : s.source}
                          </span>
                        ))}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Detail summary for the selected symbol */}
          {selectedEntry && (
            <div className="bg-dark-800 border border-dark-500 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-slate-200 mb-3">Details</h2>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Symbol</dt>
                  <dd className="font-mono text-slate-200">{selectedEntry.symbol}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Verification</dt>
                  <dd className={selectedEntry.ib_verified ? 'text-emerald-400' : 'text-slate-300'}>
                    {selectedEntry.ib_verified ? 'IB verified' : 'Free source'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Coverage</dt>
                  <dd className="font-mono text-slate-200">
                    {dateOnly(selectedEntry.oldest)} → {dateOnly(selectedEntry.newest)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Total bars</dt>
                  <dd className="text-slate-200">{Number(selectedEntry.rows ?? 0).toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Selected range</dt>
                  <dd className="font-mono text-slate-200">
                    {rangeReady ? `${dateRange.start} → ${dateRange.end}` : '—'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Bar interval</dt>
                  <dd className="text-slate-200">{histData?.interval ?? '—'}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        {/* Right column: charts */}
        <div className="xl:col-span-2">
          {!selectedSymbol ? (
            <div className="card flex items-center justify-center h-80 text-slate-500 text-sm">
              Select a symbol to view its historical data.
            </div>
          ) : !rangeReady ? (
            <div className="card flex items-center justify-center h-80 text-slate-500 text-sm">
              Pick a start and end date to chart {selectedSymbol}.
            </div>
          ) : (
            <DataLibraryChartPanel
              symbol={selectedSymbol}
              chartType={chartType}
              setChartType={setChartType}
              displayPeriod={displayPeriod}
              interval={histData?.interval}
              indicators={indicators}
              toggleIndicator={toggleIndicator}
              histData={histData}
              histLoading={histLoading || histFetching}
              prevClose={histData?.prev_close}
              ibVerified={Boolean(histData?.ib_verified)}
              source={histData?.source}
            />
          )}
        </div>
      </div>
    </div>
  )
}
