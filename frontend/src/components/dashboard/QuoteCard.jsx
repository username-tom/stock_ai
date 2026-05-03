import { ArrowUpIcon, ArrowDownIcon } from '@heroicons/react/24/solid'

export default function QuoteCard({ data, isLoading, symbol }) {
  if (isLoading)
    return (
      <div className="card">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-300">{symbol ?? <span className="inline-block h-3.5 w-12 bg-dark-500 rounded animate-pulse" />}</div>
            <div className="h-7 w-24 bg-dark-500 rounded animate-pulse mt-1.5" />
          </div>
          <div className="h-5 w-14 bg-dark-600 rounded-full animate-pulse" />
        </div>
        <div className="flex gap-3 mt-2">
          <div className="h-3 w-16 bg-dark-700 rounded animate-pulse" />
          <div className="h-3 w-16 bg-dark-700 rounded animate-pulse" />
        </div>
      </div>
    )

  if (!data)
    return (
      <div className="card">
        <div className="text-sm font-semibold text-slate-300 mb-1">{symbol}</div>
        <div className="h-6 w-20 bg-dark-600 rounded animate-pulse mt-1" />
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
          {positive ? <ArrowUpIcon className="h-3 w-3" /> : <ArrowDownIcon className="h-3 w-3" />}
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
