import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BellAlertIcon, ArrowTopRightOnSquareIcon, CalendarDaysIcon, StarIcon } from '@heroicons/react/24/solid'
import { getEarnings } from '../../api/client'
import { useAppSettings } from '../../hooks/useAppSettings'

function EarningsCard({ item }) {
  const urgency =
    item.days_until === 0 ? 'today'
    : item.days_until === 1 ? 'tomorrow'
    : item.days_until <= 7 ? 'week'
    : 'later'

  const urgencyStyles = {
    today:    'bg-red-400/10 border-red-400/40 hover:border-red-400/70 hover:bg-red-400/15',
    tomorrow: 'bg-amber-400/10 border-amber-400/30 hover:border-amber-400/60 hover:bg-amber-400/15',
    week:     'bg-amber-400/5 border-amber-400/20 hover:border-amber-400/50 hover:bg-amber-400/10',
    later:    'bg-dark-800 border-dark-600 hover:border-dark-400 hover:bg-dark-700',
  }

  const iconStyles = {
    today:    'text-red-400',
    tomorrow: 'text-amber-400',
    week:     'text-amber-400/80',
    later:    'text-slate-500',
  }

  const dayLabel =
    item.days_until === 0 ? 'Today'
    : item.days_until === 1 ? 'Tomorrow'
    : `In ${item.days_until} days`

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all group ${urgencyStyles[urgency]}`}
    >
      <BellAlertIcon className={`h-5 w-5 shrink-0 ${iconStyles[urgency]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-sm font-semibold text-slate-200 group-hover:text-amber-300 transition-colors leading-snug">
            {item.title}
          </p>
          {item.watchlist_match && (
            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-emerald-400 bg-emerald-900/30 border border-emerald-700/30 px-1.5 py-0.5 rounded-full shrink-0">
              <StarIcon className="h-2.5 w-2.5" />Watchlist
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className={`text-xs font-medium ${urgency === 'today' ? 'text-red-400' : 'text-amber-400/80'}`}>
            {dayLabel}
          </span>
          {item.related?.slice(0, 4).map(ticker => (
            <span key={ticker} className="text-xs font-mono bg-dark-600 text-slate-400 px-1.5 py-0.5 rounded">
              {ticker}
            </span>
          ))}
          {item.source && (
            <span className="text-xs text-slate-600">{item.source}</span>
          )}
        </div>
      </div>
      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-slate-600 group-hover:text-amber-400 shrink-0 transition-colors" />
    </a>
  )
}

function SkeletonCard() {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-dark-700 bg-dark-800">
      <div className="h-5 w-5 bg-dark-600 rounded animate-pulse shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-dark-600 rounded animate-pulse w-4/5" />
        <div className="flex gap-2">
          <div className="h-3 w-14 bg-dark-700 rounded animate-pulse" />
          <div className="h-3 w-10 bg-dark-700 rounded animate-pulse" />
        </div>
      </div>
    </div>
  )
}

export default function EarningsTab({ watchlist }) {
  const appSettings = useAppSettings()
  const queryClient = useQueryClient()
  const [forceLoading, setForceLoading] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['earnings', watchlist],
    queryFn: () => getEarnings(watchlist),
    staleTime: 0,
    refetchInterval: appSettings.earnings_refresh_ms,
    refetchIntervalInBackground: true,
  })

  const handleRefresh = async () => {
    setForceLoading(true)
    try {
      const fresh = await getEarnings(watchlist, true)
      queryClient.setQueryData(['earnings', watchlist], fresh)
    } catch {
      refetch()
    } finally {
      setForceLoading(false)
    }
  }

  const all      = data?.items ?? []
  const today    = all.filter(i => i.days_until === 0)
  const upcoming = all.filter(i => i.days_until > 0)

  const asOf = data?.as_of ? new Date(data.as_of).toLocaleTimeString() : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {asOf ? `As of ${asOf}` : 'Refreshes every 15 min'}
          {all.length > 0 && <span className="ml-2 text-slate-600">· {all.length} companies</span>}
        </p>
        <button
          onClick={handleRefresh}
          disabled={forceLoading}
          className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 px-2 py-0.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {forceLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {isError && (
        <p className="text-sm text-slate-500 text-center py-10">Failed to load earnings data.</p>
      )}

      {data && all.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <CalendarDaysIcon className="h-10 w-10 text-slate-700" />
          <p className="text-sm text-slate-500">No upcoming earnings found.</p>
        </div>
      )}

      {data && all.length > 0 && (
        <>
          {today.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <BellAlertIcon className="h-3.5 w-3.5" /> Reporting Today
                <span className="ml-auto text-slate-600 normal-case font-normal">{today.length} companies</span>
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {today.map(item => <EarningsCard key={item.id} item={item} />)}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <CalendarDaysIcon className="h-3.5 w-3.5" /> Upcoming Earnings
                <span className="ml-auto text-slate-600 normal-case font-normal">{upcoming.length} events</span>
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {upcoming.map(item => <EarningsCard key={item.id} item={item} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
