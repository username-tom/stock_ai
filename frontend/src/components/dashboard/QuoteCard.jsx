import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpIcon, ArrowDownIcon } from '@heroicons/react/24/solid'
import MiniSparkline from './MiniSparkline'

function fmtVol(v) {
  if (!v) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  return `${(v / 1e3).toFixed(0)}K`
}

function Tooltip({ data, price, changePct, changeAbs, positive, style }) {
  return createPortal(
    <div
      className="fixed z-[9999] w-56 rounded-lg bg-dark-600 border border-dark-400 shadow-2xl pointer-events-none transition-opacity duration-150"
      style={style}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-dark-500">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono font-bold text-sm text-slate-100">{data.symbol}</span>
          <span className={`text-xs font-semibold font-mono ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
            {positive ? '+' : ''}{changePct.toFixed(2)}%
          </span>
        </div>
        {data.company_name && (
          <p className="text-xs text-slate-400 mt-0.5 leading-snug">{data.company_name}</p>
        )}
        {data.sector && (
          <p className="text-[11px] text-sky-300/80 mt-0.5 leading-snug">{data.sector}</p>
        )}
      </div>
      {/* Stats */}
      <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <div className="text-slate-500">Price</div>
          <div className="font-mono text-slate-200">${price.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-slate-500">Change</div>
          <div className={`font-mono ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
            {positive ? '+' : ''}{changeAbs.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-slate-500">High</div>
          <div className="font-mono text-slate-200">{data.day_high != null ? `$${data.day_high.toFixed(2)}` : '—'}</div>
        </div>
        <div>
          <div className="text-slate-500">Low</div>
          <div className="font-mono text-slate-200">{data.day_low != null ? `$${data.day_low.toFixed(2)}` : '—'}</div>
        </div>
        <div>
          <div className="text-slate-500">Prev Close</div>
          <div className="font-mono text-slate-200">{data.previous_close != null ? `$${data.previous_close.toFixed(2)}` : '—'}</div>
        </div>
        <div>
          <div className="text-slate-500">Volume</div>
          <div className="font-mono text-slate-200">{fmtVol(data.volume)}</div>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function QuoteCard({ data, isLoading, symbol, isActive }) {
  const [tooltipStyle, setTooltipStyle] = useState(null)
  const cardRef = useRef(null)

  function handleMouseEnter() {
    if (!cardRef.current) return
    const rect = cardRef.current.getBoundingClientRect()
    setTooltipStyle({
      top: rect.top + rect.height / 2,
      left: rect.right + 8,
      transform: 'translateY(-50%)',
      opacity: 1,
    })
  }

  function handleMouseLeave() {
    setTooltipStyle(null)
  }
  if (isLoading)
    return (
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all ${isActive ? 'bg-dark-700 border-dark-500' : 'border-transparent hover:bg-dark-800/60'}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-10 bg-dark-500 rounded animate-pulse flex-shrink-0" />
            <div className="w-16 h-[22px] bg-dark-700 rounded animate-pulse" />
          </div>
          <div className="h-2.5 w-24 bg-dark-700 rounded animate-pulse mt-1" />
          <div className="h-2.5 w-20 bg-dark-700 rounded animate-pulse mt-0.5" />
        </div>
        <div className="text-right flex-shrink-0 w-16">
          <div className="h-4 w-14 bg-dark-600 rounded animate-pulse ml-auto" />
          <div className="h-4 w-10 bg-dark-700 rounded animate-pulse mt-1 ml-auto" />
        </div>
      </div>
    )

  if (!data)
    return (
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all ${isActive ? 'bg-dark-700 border-dark-500' : 'border-transparent hover:bg-dark-800/60'}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-slate-300 flex-shrink-0">{symbol}</div>
            <div className="w-16 h-[22px] bg-dark-700/50 rounded" />
          </div>
          <div className="h-2.5 w-20 bg-dark-700 rounded animate-pulse mt-1" />
        </div>
        <div className="w-16 text-right flex-shrink-0" />
      </div>
    )

  const price = data.last_price ?? data.previous_close ?? 0
  const prev = data.previous_close ?? price
  const changePct = data.change_pct ?? (prev ? ((price - prev) / prev) * 100 : 0)
  const changeAbs = data.change ?? (price - prev)
  const positive = changePct >= 0

  return (
    <div
      ref={cardRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`relative flex items-center gap-2 px-3 py-2 rounded-lg border transition-all cursor-pointer ${isActive ? 'bg-dark-700 border-emerald-600/50' : 'border-transparent hover:bg-dark-800/60 hover:border-dark-600'}`}
    >
      {/* Left: symbol + sparkline row, H/L row, company name row */}
      <div className="flex-1 min-w-0">
        {/* Row 1: symbol ticker + sparkline side by side */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-slate-200 font-mono leading-tight flex-shrink-0">{data.symbol}</span>
          <div className="flex-shrink-0">
            <MiniSparkline symbol={data.symbol} positive={positive} />
          </div>
        </div>
        {/* Row 2: H / L */}
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-slate-500 leading-tight">H <span className="text-slate-400 font-mono">{data.day_high != null ? `$${data.day_high.toFixed(2)}` : '—'}</span></span>
          <span className="text-[10px] text-slate-500 leading-tight">L <span className="text-slate-400 font-mono">{data.day_low != null ? `$${data.day_low.toFixed(2)}` : '—'}</span></span>
        </div>
        {/* Row 3: company name */}
        {data.company_name && (
          <div className="text-[10px] text-slate-500 mt-0.5 leading-tight truncate">{data.company_name}</div>
        )}
        {data.sector && (
          <div className="text-[10px] text-sky-300/70 mt-0.5 leading-tight truncate">{data.sector}</div>
        )}
      </div>

      {/* Right: price + badge */}
      <div className="text-right flex-shrink-0 w-16">
        <div className="text-sm font-bold font-mono text-slate-100 leading-tight">${price.toFixed(2)}</div>
        <div className="flex items-center justify-end gap-0.5 mt-0.5">
          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-semibold ${positive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
            {positive ? <ArrowUpIcon className="h-2.5 w-2.5" /> : <ArrowDownIcon className="h-2.5 w-2.5" />}
            {Math.abs(changePct).toFixed(2)}%
          </span>
        </div>
      </div>

      {/* Hover tooltip */}
      {tooltipStyle && <Tooltip
        data={data}
        price={price}
        changePct={changePct}
        changeAbs={changeAbs}
        positive={positive}
        style={tooltipStyle}
      />}
    </div>
  )
}
