import { useQuery } from '@tanstack/react-query'
import { ArrowUpIcon, ArrowDownIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/solid'
import { getMovers } from '../../api/client'
import { isMarketHours } from '../../utils/marketHours'

function MoverRow({ q, rank, inWatchlist, onToggleWatchlist }) {
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
        <button
          onClick={() => onToggleWatchlist(q.symbol)}
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
      </div>
    </div>
  )
}

export default function MoversTab({ watchlist = [], toggleSymbol }) {
  const marketOpen = isMarketHours()
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['movers'],
    queryFn: () => getMovers(10),
    refetchInterval: marketOpen ? 5 * 60_000 : false,
  })

  const asOf = data?.as_of ? new Date(data.as_of).toLocaleTimeString() : null

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-slate-500">
          {asOf ? `As of ${asOf}` : marketOpen ? 'Refreshes every 5 min' : 'Market closed'}
        </p>
        <button
          onClick={() => refetch()}
          className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 px-2 py-0.5 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>
      {(isLoading || isError) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[0, 1].map(col => (
            <div key={col} className="space-y-1">
              <div className="h-4 w-24 bg-dark-600 rounded animate-pulse mb-3" />
              {Array.from({ length: 8 }).map((_, i) => (
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
