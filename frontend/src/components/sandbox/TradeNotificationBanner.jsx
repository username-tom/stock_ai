import { useEffect, useRef, useState } from 'react'
import { XMarkIcon, ArrowTrendingUpIcon, ArrowTrendingDownIcon } from '@heroicons/react/24/outline'

const NOTIFICATION_TTL_MS = 5 * 60 * 1000
const MAX_BANNER_VISIBLE_MS = 8_000

/**
 * Shows a dismissible top banner whenever a new engine-triggered trade appears.
 * `latestEngineTrade` is the most recent trade object with strategy_name set.
 */
export default function TradeNotificationBanner({ latestEngineTrade }) {
  const [visible, setVisible] = useState(false)
  const [trade, setTrade] = useState(null)
  const prevIdRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => {
    if (!latestEngineTrade) return
    if (latestEngineTrade.id === prevIdRef.current) return

    const createdMs = latestEngineTrade.created_at ? Date.parse(latestEngineTrade.created_at) : NaN
    const hasCreatedMs = Number.isFinite(createdMs)
    const ageMs = hasCreatedMs ? (Date.now() - createdMs) : 0
    if (hasCreatedMs && ageMs >= NOTIFICATION_TTL_MS) {
      // Mark as seen so old events from a rebuild do not keep re-triggering.
      prevIdRef.current = latestEngineTrade.id
      setVisible(false)
      return
    }

    prevIdRef.current = latestEngineTrade.id
    setTrade(latestEngineTrade)
    setVisible(true)

    const remainingTtlMs = hasCreatedMs ? (NOTIFICATION_TTL_MS - ageMs) : MAX_BANNER_VISIBLE_MS
    const dismissAfterMs = Math.max(250, Math.min(MAX_BANNER_VISIBLE_MS, remainingTtlMs))
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setVisible(false), dismissAfterMs)
    return () => clearTimeout(timerRef.current)
  }, [latestEngineTrade])

  if (!visible || !trade) return null

  const isBuy = trade.side === 'BUY'
  const isGain = !isBuy && trade.pnl != null && trade.pnl >= 0
  const isLoss = !isBuy && trade.pnl != null && trade.pnl < 0
  const stratLabel = trade.strategy_name?.split(':')[0] ?? 'Engine'

  const bannerCls = isBuy
    ? 'bg-sky-900/95 border-b border-sky-700/60 text-sky-200'
    : isGain
    ? 'bg-emerald-900/95 border-b border-emerald-700/60 text-emerald-200'
    : isLoss
    ? 'bg-red-900/95 border-b border-red-700/60 text-red-200'
    : 'bg-slate-800/95 border-b border-slate-600/60 text-slate-200'

  const iconCls = isBuy
    ? 'text-sky-400'
    : isGain
    ? 'text-emerald-400'
    : isLoss
    ? 'text-red-400'
    : 'text-slate-400'

  const sideCls = isBuy
    ? 'text-sky-300'
    : isGain
    ? 'text-emerald-400'
    : isLoss
    ? 'text-red-400'
    : 'text-slate-300'

  return (
    <div className={`fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-4 px-6 py-2.5 text-sm font-medium shadow-lg ${bannerCls}`}>
      <div className="flex items-center gap-2.5">
        {isBuy
          ? <ArrowTrendingUpIcon className={`h-4 w-4 flex-shrink-0 ${iconCls}`} />
          : <ArrowTrendingDownIcon className={`h-4 w-4 flex-shrink-0 ${iconCls}`} />
        }
        <span>
          <span className={`font-bold ${sideCls}`}>{trade.side}</span>
          {' '}{trade.quantity} <span className="font-bold text-white">{trade.symbol}</span>
          {' '}@ <span className="font-mono">${trade.price?.toFixed(2)}</span>
          {trade.pnl != null && (
            <span className={`ml-2 ${trade.pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
              PnL: {trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}
            </span>
          )}
          <span className="ml-2 text-xs opacity-60">via {stratLabel}</span>
          {trade.reason && <span className="ml-2 text-xs opacity-50">— {trade.reason}</span>}
        </span>
      </div>
      <button
        onClick={() => setVisible(false)}
        className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  )
}
