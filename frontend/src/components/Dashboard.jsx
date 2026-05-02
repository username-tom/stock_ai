import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getQuote, getHistory } from '../api/client'
import SubplotChart from './charts/SubplotChart'
import { ArrowUpIcon, ArrowDownIcon, SignalIcon } from '@heroicons/react/24/solid'

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']

function QuoteCard({ symbol }) {
  const { data, isLoading } = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => getQuote(symbol),
    refetchInterval: 30_000,
  })

  if (isLoading)
    return (
      <div className="card animate-pulse">
        <div className="h-5 w-16 bg-dark-500 rounded mb-2" />
        <div className="h-8 w-24 bg-dark-500 rounded" />
      </div>
    )

  const price = data?.last_price ?? data?.previous_close ?? 0
  const prev = data?.previous_close ?? price
  const changePct = prev ? ((price - prev) / prev) * 100 : 0
  const positive = changePct >= 0

  return (
    <div className="card hover:border-dark-500/80 transition-all cursor-default">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-300">{symbol}</div>
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
        <span>H: ${data?.day_high?.toFixed(2) ?? '—'}</span>
        <span>L: ${data?.day_low?.toFixed(2) ?? '—'}</span>
      </div>
    </div>
  )
}

function LivePriceTicker({ symbols }) {
  const [prices, setPrices] = useState({})
  const wsRef = useRef(null)

  useEffect(() => {
    if (!symbols.length) return
    const ws = new WebSocket(
        `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/prices`
      )
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ symbols, interval: 15 }))
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'prices') setPrices(prev => ({ ...prev, ...msg.data }))
    }
    return () => ws.close()
  }, [symbols.join(',')])

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      <SignalIcon className="h-4 w-4 text-emerald-500 flex-shrink-0 animate-pulse" />
      {Object.values(prices).map(p => (
        <span
          key={p.symbol}
          className="text-xs font-mono whitespace-nowrap text-slate-300 bg-dark-700 px-2 py-1 rounded-md"
        >
          <span className="text-slate-400">{p.symbol} </span>
          <span className="font-semibold">${p.price?.toFixed(2) ?? '—'}</span>
          {p.change_pct != null && (
            <span className={p.change_pct >= 0 ? ' text-emerald-400' : ' text-red-400'}>
              {' '}{p.change_pct >= 0 ? '+' : ''}{p.change_pct.toFixed(2)}%
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const [chartSymbol, setChartSymbol] = useState('AAPL')
  const [chartPeriod, setChartPeriod] = useState('1y')

  const { data: histData, isLoading: histLoading } = useQuery({
    queryKey: ['history', chartSymbol, chartPeriod],
    queryFn: () => getHistory(chartSymbol, chartPeriod),
  })

  return (
    <div className="p-6 space-y-6">
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

      {/* Live ticker */}
      <LivePriceTicker symbols={DEFAULT_WATCHLIST} />

      {/* Watchlist quotes */}
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Watchlist
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          {DEFAULT_WATCHLIST.map(sym => (
            <div key={sym} onClick={() => setChartSymbol(sym)} className="cursor-pointer">
              <QuoteCard symbol={sym} />
            </div>
          ))}
        </div>
      </div>

      {/* Price chart */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
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
        {histLoading ? (
          <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
            Loading chart…
          </div>
        ) : (
          <SubplotChart data={histData?.data ?? []} height={220} />
        )}
      </div>
    </div>
  )
}
