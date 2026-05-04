import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NewspaperIcon, ArrowTopRightOnSquareIcon, BellAlertIcon } from '@heroicons/react/24/solid'
import { getNews } from '../../api/client'

const INITIAL_VISIBLE = 50
const PAGE_SIZE = 25

// Client-side safety net — catches anything that slipped through a stale cache
const BLOCKED_TERMS = ['cramer', 'mad money']
const isBlocked = (item) => {
  const text = ((item.title ?? '') + ' ' + (item.source ?? '')).toLowerCase()
  return BLOCKED_TERMS.some(t => text.includes(t))
}

function NewsCard({ item }) {
  const timeAgo = useMemo(() => {
    if (!item.published_at) return null
    const diff = Math.floor(Date.now() / 1000 - item.published_at)
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
  }, [item.published_at])

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-4 p-3 rounded-xl border border-dark-600 hover:border-dark-400 bg-dark-800 hover:bg-dark-700 transition-all group"
    >
      {item.thumbnail && (
        <img
          src={item.thumbnail}
          alt=""
          className="h-14 w-20 object-cover rounded-lg shrink-0 bg-dark-700"
          onError={e => { e.target.style.display = 'none' }}
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-200 group-hover:text-emerald-300 transition-colors leading-snug line-clamp-2">
          {item.title}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {item.source && (
            <span className="text-xs text-slate-500 font-medium">{item.source}</span>
          )}
          {timeAgo && (
            <span className="text-xs text-slate-600">{timeAgo}</span>
          )}
          {item.related?.slice(0, 4).map(ticker => (
            <span key={ticker} className="text-xs font-mono bg-dark-600 text-slate-400 px-1.5 py-0.5 rounded">
              {ticker}
            </span>
          ))}
        </div>
      </div>
      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-slate-600 group-hover:text-emerald-400 shrink-0 mt-0.5 transition-colors" />
    </a>
  )
}

/** Animated stretching arrow shown when more news is available below. */
function LoadMoreArrow({ onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label="Load more news"
      className="w-full flex flex-col items-center gap-1 py-4 group"
    >
      <span className="text-xs text-slate-500 group-hover:text-slate-300 transition-colors">
        More news below
      </span>
      {/* Three stacked chevrons that animate in a cascading stretch */}
      <span className="flex flex-col items-center gap-0.5">
        {[0, 1, 2].map(i => (
          <svg
            key={i}
            viewBox="0 0 24 12"
            className="w-6 text-slate-600 group-hover:text-emerald-500 transition-colors"
            style={{
              animation: `news-arrow-bounce 1.2s ease-in-out ${i * 0.18}s infinite`,
              opacity: 1 - i * 0.25,
            }}
            aria-hidden="true"
          >
            <polyline
              points="2,2 12,10 22,2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ))}
      </span>
      <style>{`
        @keyframes news-arrow-bounce {
          0%, 100% { transform: translateY(0) scaleY(1); }
          40%       { transform: translateY(3px) scaleY(1.15); }
          60%       { transform: translateY(5px) scaleY(0.9); }
        }
      `}</style>
    </button>
  )
}

export default function NewsTab({ watchlist }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['news', watchlist],
    queryFn: () => getNews(watchlist),
    refetchInterval: 15 * 60_000,
    refetchIntervalInBackground: true,
    enabled: watchlist.length > 0,
  })

  const [visibleWatchlist, setVisibleWatchlist] = useState(INITIAL_VISIBLE)
  const [visibleMarket, setVisibleMarket] = useState(INITIAL_VISIBLE)
  const watchlistSentinelRef = useRef(null)
  const marketSentinelRef = useRef(null)

  // Reset pagination when fresh data arrives
  useEffect(() => { setVisibleWatchlist(INITIAL_VISIBLE); setVisibleMarket(INITIAL_VISIBLE) }, [data])

  const loadMoreWatchlist = useCallback(() => setVisibleWatchlist(n => n + PAGE_SIZE), [])
  const loadMoreMarket    = useCallback(() => setVisibleMarket(n => n + PAGE_SIZE), [])

  // Auto-load sentinels
  useEffect(() => {
    const el = watchlistSentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMoreWatchlist() },
      { rootMargin: '120px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMoreWatchlist, data])

  useEffect(() => {
    const el = marketSentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMoreMarket() },
      { rootMargin: '120px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMoreMarket, data])

  const asOf = data?.as_of ? new Date(data.as_of).toLocaleTimeString() : null

  const earnings         = data?.items?.filter(i => i.type === 'earnings') ?? []
  const allNewsItems     = data?.items?.filter(i => i.type === 'news' && !isBlocked(i)) ?? []
  const watchlistNews    = allNewsItems.filter(i => i.watchlist_match)
  const marketNews       = allNewsItems.filter(i => !i.watchlist_match)

  const visibleWatchlistItems = watchlistNews.slice(0, visibleWatchlist)
  const visibleMarketItems    = marketNews.slice(0, visibleMarket)
  const hasMoreWatchlist      = visibleWatchlist < watchlistNews.length
  const hasMoreMarket         = visibleMarket < marketNews.length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{asOf ? `As of ${asOf}` : 'Refreshes every 15 min'}</p>
        <button
          onClick={() => refetch()}
          className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 px-2 py-0.5 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {(isLoading || isError) && (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-start gap-4 p-3 rounded-xl border border-dark-700 bg-dark-800">
              <div className="h-16 w-24 bg-dark-700 rounded-lg shrink-0 animate-pulse" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-4 bg-dark-600 rounded animate-pulse w-5/6" />
                <div className="h-4 bg-dark-600 rounded animate-pulse w-4/6" />
                <div className="flex gap-2 mt-1">
                  <div className="h-3 w-16 bg-dark-700 rounded animate-pulse" />
                  <div className="h-3 w-10 bg-dark-700 rounded animate-pulse" />
                  <div className="h-3 w-12 bg-dark-700 rounded animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <>
          {earnings.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <BellAlertIcon className="h-3.5 w-3.5" /> Upcoming Earnings
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {earnings.map(item => (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 p-3 rounded-xl bg-amber-400/5 border border-amber-400/20 hover:border-amber-400/50 hover:bg-amber-400/10 transition-all group"
                  >
                    <BellAlertIcon className="h-5 w-5 text-amber-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-200 group-hover:text-amber-300 transition-colors leading-snug">
                        {item.title}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {item.days_until === 0 ? 'Today' : item.days_until === 1 ? 'Tomorrow' : `In ${item.days_until} days`}
                      </p>
                    </div>
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-slate-600 group-hover:text-amber-400 shrink-0 transition-colors" />
                  </a>
                ))}
              </div>
            </section>
          )}

          {visibleWatchlistItems.length > 0 || visibleMarketItems.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              {/* Watchlist News column */}
              <section>
                <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <NewspaperIcon className="h-3.5 w-3.5" /> Watchlist News
                  <span className="ml-auto text-slate-600 normal-case font-normal">{watchlistNews.length} articles</span>
                </h3>
                {visibleWatchlistItems.length === 0 ? (
                  <p className="text-sm text-slate-600 py-4">No watchlist news.</p>
                ) : (
                  <div className="space-y-2">
                    {visibleWatchlistItems.map(item => <NewsCard key={item.id} item={item} />)}
                    {hasMoreWatchlist && (
                      <div>
                        <LoadMoreArrow onClick={loadMoreWatchlist} />
                        <div ref={watchlistSentinelRef} className="h-1" aria-hidden="true" />
                      </div>
                    )}
                    {!hasMoreWatchlist && watchlistNews.length > 0 && (
                      <p className="text-xs text-slate-600 text-center py-3">All {watchlistNews.length} articles shown</p>
                    )}
                  </div>
                )}
              </section>

              {/* Market News column */}
              <section>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <NewspaperIcon className="h-3.5 w-3.5" /> Market News
                  <span className="ml-auto text-slate-600 normal-case font-normal">{marketNews.length} articles</span>
                </h3>
                {visibleMarketItems.length === 0 ? (
                  <p className="text-sm text-slate-600 py-4">No market news.</p>
                ) : (
                  <div className="space-y-2">
                    {visibleMarketItems.map(item => <NewsCard key={item.id} item={item} />)}
                    {hasMoreMarket && (
                      <div>
                        <LoadMoreArrow onClick={loadMoreMarket} />
                        <div ref={marketSentinelRef} className="h-1" aria-hidden="true" />
                      </div>
                    )}
                    {!hasMoreMarket && marketNews.length > 0 && (
                      <p className="text-xs text-slate-600 text-center py-3">All {marketNews.length} articles shown</p>
                    )}
                  </div>
                )}
              </section>
            </div>
          ) : (
            earnings.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-10">No news available.</p>
            )
          )}
        </>
      )}
    </div>
  )
}
