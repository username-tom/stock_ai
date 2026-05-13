import { useState, useEffect, useRef } from 'react'
import { SignalIcon, ExclamationTriangleIcon } from '@heroicons/react/24/solid'
import { getBulkQuotes } from '../api/client'
import { isMarketHours } from '../utils/marketHours'
import { useAppSettings } from '../hooks/useAppSettings'

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']
const STORAGE_KEY = 'dashboard_watchlist'

function readWatchlist() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return DEFAULT_WATCHLIST
}

export default function LivePriceTicker() {
  const appSettings = useAppSettings()
  const [symbols, setSymbols] = useState(readWatchlist)
  const [prices, setPrices] = useState({})
  const [wsOk, setWsOk] = useState(true)
  const wsRef = useRef(null)

  // Re-sync symbols from localStorage whenever the window gains focus
  // (covers the case where the user edits the watchlist on the Dashboard tab)
  useEffect(() => {
    const sync = () => setSymbols(readWatchlist())
    window.addEventListener('focus', sync)
    window.addEventListener('watchlist-updated', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('watchlist-updated', sync)
    }
  }, [])

  // WebSocket feed
  useEffect(() => {
    if (!symbols.length) return
    let cancelled = false

    const ws = new WebSocket(
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/prices`
    )
    wsRef.current = ws

    ws.onopen = () => {
      if (cancelled) { ws.close(); return }
      setWsOk(true)
      const wsIntervalSec = Math.max(1, Math.round((appSettings.quotes_refresh_ms || 5000) / 1000))
      ws.send(JSON.stringify({ symbols, interval: wsIntervalSec }))
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'prices') {
        const normalized = {}
        Object.entries(msg.data).forEach(([sym, q]) => {
          normalized[sym] = { ...q, price: q.price ?? q.last_price }
        })
        setPrices(prev => {
          const next = {}
          symbols.forEach(s => { if (normalized[s] || prev[s]) next[s] = normalized[s] ?? prev[s] })
          return next
        })
      }
    }
    ws.onerror = () => setWsOk(false)
    ws.onclose = () => { if (!cancelled) setWsOk(false) }

    return () => { cancelled = true; ws.close() }
  }, [symbols.join(','), appSettings.quotes_refresh_ms])

  // Prune removed symbols from prices map
  useEffect(() => {
    setPrices(prev => {
      const next = {}
      symbols.forEach(s => { if (prev[s]) next[s] = prev[s] })
      return next
    })
  }, [symbols.join(',')])

  // REST fallback when WebSocket is unavailable
  useEffect(() => {
    if (wsOk || !symbols.length) return
    const load = () =>
      getBulkQuotes(symbols).then(data => {
        const normalized = {}
        symbols.forEach(s => {
          if (data[s]) normalized[s] = { ...data[s], price: data[s].last_price }
        })
        setPrices(normalized)
      }).catch(() => {})
    load()
    const id = setInterval(load, appSettings.quotes_refresh_ms)
    return () => clearInterval(id)
  }, [wsOk, symbols.join(','), appSettings.quotes_refresh_ms])

  const items = symbols.map(s => prices[s]).filter(Boolean)
  const marketState = items[0]?.market_state ?? 'CLOSED'
  // Yahoo's daily-chart endpoint often returns 'CLOSED' even during the
  // session. Trust REGULAR/PRE/POST explicitly; fall back to the clock
  // for the CLOSED case so the ticker reflects real market hours.
  const isLive = marketState === 'REGULAR' ||
    (marketState === 'CLOSED' && isMarketHours())

  if (!items.length) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-dark-900/95 border-t border-dark-600 flex items-center h-8 overflow-hidden">
      <div className="flex-shrink-0 flex items-center gap-1.5 px-3 border-r border-dark-600 h-full">
        {wsOk && isLive ? (
          <>
            <SignalIcon className="h-3.5 w-3.5 text-emerald-500 animate-pulse" />
            <span className="text-xs font-semibold text-emerald-500 uppercase tracking-wider">Live</span>
          </>
        ) : !wsOk ? (
          <>
            <ExclamationTriangleIcon className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Delayed</span>
          </>
        ) : (
          <>
            <span className="h-2 w-2 rounded-full bg-slate-500 inline-block" />
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Closed</span>
          </>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        <div
          className="flex gap-6 whitespace-nowrap animate-marquee"
          style={{ width: 'max-content', animationDuration: `${appSettings.ticker_scroll_speed_s}s` }}
        >
          {[...items, ...items].map((p, i) => (
            <span key={i} className="text-xs font-mono whitespace-nowrap text-slate-300">
              <span className="text-slate-400 font-semibold">{p.symbol} </span>
              <span className="font-semibold">${p.price?.toFixed(2) ?? '—'}</span>
              {p.change_pct != null && (
                <span className={p.change_pct >= 0 ? ' text-emerald-400' : ' text-red-400'}>
                  {' '}{p.change_pct >= 0 ? '+' : ''}{p.change_pct.toFixed(2)}%
                </span>
              )}
              {!isLive && <span className="text-slate-600"> ·close</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
