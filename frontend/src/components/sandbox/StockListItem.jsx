import { useQuery } from '@tanstack/react-query'
import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { getScripts } from '../../api/client'
import { quotesentiment, SENTIMENT_COLORS, SENTIMENT_LABELS, quotesignal, SIGNAL_COLORS, SIGNAL_LABELS } from '../../utils/sentiment'
import { fmt, fmtMoney } from './sandboxHelpers'
import { CUSTOM_SCRIPT_KEY } from './sandboxConstants'

export default function StockListItem({ pos, quote, isSelected, onClick }) {
  const { data: scriptsData } = useQuery({ queryKey: ['scripts'], queryFn: getScripts, staleTime: 60000 })
  const scripts = scriptsData?.scripts ?? []
  const [tooltipPos, setTooltipPos] = useState(null)
  const wrapperRef = useRef(null)

  const handleMouseEnter = useCallback(() => {
    if (!wrapperRef.current) return
    const rect = wrapperRef.current.getBoundingClientRect()
    setTooltipPos({ top: rect.top, left: rect.right + 8 })
  }, [])

  const handleMouseLeave = useCallback(() => setTooltipPos(null), [])

  const mp = quote?.last_price ?? pos.avg_cost
  const equity = mp * pos.shares
  const unrealised = equity - pos.avg_cost * pos.shares
  const totalPnl = pos.realized_pnl + unrealised
  const changePct = quote?.change_pct
  const positive = changePct == null ? null : changePct >= 0

  return (
    <div ref={wrapperRef} className="relative" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <button onClick={onClick} className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'bg-emerald-600/20 border-emerald-600/40' : 'border-transparent hover:bg-dark-700'}`}>
        <div className="flex items-center justify-between mb-0.5">
          <span className="font-bold text-slate-100 text-sm">{pos.symbol}</span>
          <div className="flex items-center gap-1.5">
            {changePct != null && (
              <span className={`text-xs font-medium ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
                {positive ? '+' : ''}{changePct.toFixed(2)}%
              </span>
            )}
            {pos.shares > 0 && <span className={`text-xs font-semibold ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalPnl)}</span>}
          </div>
        </div>
        {quote?.company_name && (
          <div className="text-xs text-slate-500 truncate mb-0.5">{quote.company_name}</div>
        )}
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{pos.shares > 0 ? `${pos.shares.toFixed(4)} sh` : 'Watchlist'}</span>
          <span className="font-mono text-slate-400">
            {quote?.last_price != null ? `$${quote.last_price.toFixed(2)}` : pos.shares > 0 ? fmtMoney(equity) : '—'}
          </span>
        </div>
        {pos.pending_shares > 0 && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
            <span className="text-xs text-amber-400/80">{pos.pending_shares.toFixed(4)} sh pending</span>
          </div>
        )}
        {pos.shares > 0 && (
          <div className="flex items-center justify-between text-xs mt-0.5">
            <span className="text-slate-600">Equity {fmtMoney(equity)}</span>
            <span className={`font-semibold ${unrealised >= 0 ? 'text-emerald-500/80' : 'text-red-500/80'}`}>{fmt(unrealised)}</span>
          </div>
        )}
        {pos.strategy_name && (
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${pos.strategy_enabled ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            <span className="text-xs text-blue-400/80 truncate">
              {pos.strategy_name.split(':')[0]}
              {pos.strategy_name.startsWith(CUSTOM_SCRIPT_KEY + ':') || pos.strategy_name.startsWith('custom:') ? (() => {
                const scriptId = parseInt(pos.strategy_name.split(':')[1], 10)
                const sc = scripts.find(s => s.id === scriptId)
                return sc ? <span className="text-slate-400"> · {sc.name}</span> : null
              })() : null}
            </span>
            <span className={`ml-auto text-[10px] font-semibold ${pos.strategy_enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
              {pos.strategy_enabled ? 'ON' : 'OFF'}
            </span>
          </div>
        )}
        {(() => {
          const s = quotesentiment(quote)
          // If the engine has run for this position, use its script signal for
          // the BUY/SELL/HOLD badge — it reflects what the strategy actually
          // decided rather than a generic quote heuristic.
          const engineRan = pos.strategy_name && pos.last_run_at != null
          const scriptSig = engineRan
            ? (pos.last_signal === 1 ? 'buy' : pos.last_signal === -1 ? 'sell' : 'hold')
            : null
          const sig = scriptSig ?? quotesignal(quote)
          if (!s && !sig) return null
          return (
            <div className="mt-1 flex flex-wrap gap-1">
              {s && <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SENTIMENT_COLORS[s]}`}>{SENTIMENT_LABELS[s]}</div>}
              {sig && (
                <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SIGNAL_COLORS[sig]}`}>
                  {scriptSig ? '⚡ ' : ''}{SIGNAL_LABELS[sig]}
                </div>
              )}
            </div>
          )
        })()}
      </button>

      {/* Hover tooltip */}
      {quote && tooltipPos && createPortal(<div
          className="pointer-events-none fixed z-[9999] w-52 rounded-lg bg-dark-600 border border-dark-400 p-3 shadow-xl text-xs space-y-1.5"
          style={{ top: tooltipPos.top, left: tooltipPos.left }}
        >
          <div className="font-bold text-slate-100 text-sm">{quote.symbol}</div>
          {quote.company_name && <div className="text-slate-400">{quote.company_name}</div>}
          {(() => {
            const s = quotesentiment(quote)
            const engineRan = pos.strategy_name && pos.last_run_at != null
            const scriptSig = engineRan
              ? (pos.last_signal === 1 ? 'buy' : pos.last_signal === -1 ? 'sell' : 'hold')
              : null
            const sig = scriptSig ?? quotesignal(quote)
            if (!s && !sig) return null
            return (
              <div className="flex flex-wrap gap-1">
                {s && <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SENTIMENT_COLORS[s]}`}>{SENTIMENT_LABELS[s]}</div>}
                {sig && (
                  <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SIGNAL_COLORS[sig]}`}>
                    {scriptSig ? '⚡ ' : ''}{SIGNAL_LABELS[sig]}
                  </div>
                )}
              </div>
            )
          })()}
          <div className="border-t border-dark-500 pt-1.5 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-500">Price</span>
              <span className="text-slate-200 font-mono">${quote.last_price?.toFixed(2) ?? '—'}</span>
            </div>
            {changePct != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Day Change</span>
                <span className={`font-semibold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
                  {positive ? '+' : ''}{changePct.toFixed(2)}%
                </span>
              </div>
            )}
            {quote.day_high != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Day H / L</span>
                <span className="text-slate-300 font-mono">${quote.day_high.toFixed(2)} / ${quote.day_low?.toFixed(2)}</span>
              </div>
            )}
            {quote.open != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Open</span>
                <span className="text-slate-300 font-mono">${quote.open.toFixed(2)}</span>
              </div>
            )}
            {quote.previous_close != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Prev Close</span>
                <span className="text-slate-300 font-mono">${quote.previous_close.toFixed(2)}</span>
              </div>
            )}
            {quote.volume != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Volume</span>
                <span className="text-slate-300">{(quote.volume / 1e6).toFixed(2)}M</span>
              </div>
            )}
          </div>
          {pos.shares > 0 && (
            <div className="border-t border-dark-500 pt-1.5 space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500">Avg Cost</span>
                <span className="text-slate-300 font-mono">${pos.avg_cost?.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Unrealised</span>
                <span className={`font-semibold ${unrealised >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(unrealised)}</span>
              </div>
            </div>
          )}
          {pos.pending_shares > 0 && (
            <div className="border-t border-dark-500 pt-1.5 space-y-1">
              <div className="flex items-center gap-1 text-amber-400 font-semibold">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Pending Order
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Qty</span>
                <span className="text-amber-300 font-mono">{pos.pending_shares.toFixed(4)} sh</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Avg Cost</span>
                <span className="text-amber-300 font-mono">${pos.pending_avg_cost?.toFixed(2)}</span>
              </div>
            </div>
          )}
          {quote.market_state && (
            <div className="text-slate-600 text-xs pt-0.5">Market: {quote.market_state}</div>
          )}
        </div>, document.body)}
    </div>
  )
}
