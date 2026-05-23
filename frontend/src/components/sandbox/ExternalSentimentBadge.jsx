import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { getExternalSentiment } from '../../api/client'
import { SENTIMENT_COLORS, SENTIMENT_LABELS } from '../../utils/sentiment'

/**
 * Compact pill that displays aggregated *internet* sentiment for a symbol.
 *
 * Combines Yahoo Finance news, StockTwits retail buzz, and SEC EDGAR
 * recent material filings via `/api/market-data/sentiment/{symbol}`.
 *
 * Hover the pill to reveal a popover listing the headlines that drove
 * the score, grouped by source.
 *
 * Props:
 *   symbol       — required ticker, e.g. "AAPL"
 *   enabled      — when false, query is skipped (default true)
 *   refetchMs    — auto-refresh interval (default 5 minutes; matches backend TTL)
 *   compact      — narrower display, hides confidence digits
 */
export default function ExternalSentimentBadge({
  symbol,
  enabled = true,
  refetchMs = 5 * 60 * 1000,
  compact = false,
}) {
  const [open, setOpen] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['external-sentiment', symbol],
    queryFn: () => getExternalSentiment(symbol),
    enabled: enabled && !!symbol,
    staleTime: refetchMs,
    refetchInterval: refetchMs,
    refetchOnWindowFocus: false,
    retry: 1,
  })

  if (!symbol || !enabled) return null

  const bucket = data?.bucket || 'neutral'
  const conf = Number.isFinite(data?.confidence) ? data.confidence : 0
  const eventFlag = !!data?.event_flag
  const colorCls = SENTIMENT_COLORS[bucket] || SENTIMENT_COLORS.neutral
  const label = SENTIMENT_LABELS[bucket] || SENTIMENT_LABELS.neutral

  const title = isLoading
    ? 'Fetching internet sentiment…'
    : isError
      ? 'Internet sentiment unavailable'
      : `Internet sentiment: ${label.replace(/^[^ ]+ /, '')}  (confidence ${(conf * 100).toFixed(0)}%)`

  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide ${colorCls}`}
        title={title}
      >
        <span className="opacity-60">NET</span>
        <span>{compact ? label.split(' ')[0] : label}</span>
        {!compact && conf > 0 && (
          <span className="opacity-60 normal-case font-normal">{Math.round(conf * 100)}%</span>
        )}
        {eventFlag && <span className="text-amber-300" title="Recent SEC filing">●</span>}
      </span>

      {open && data && (
        <div className="absolute z-50 top-full right-0 mt-1 w-80 max-h-96 overflow-y-auto rounded-md border border-slate-700 bg-slate-900/95 backdrop-blur-sm shadow-xl p-3 text-xs text-slate-200">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-slate-100">{symbol} · Internet Sentiment</span>
            <span className={`px-1.5 py-0.5 rounded border ${colorCls}`}>{label}</span>
          </div>
          <div className="grid grid-cols-3 gap-1 mb-2 text-[10px] uppercase tracking-wide text-slate-400">
            {Object.entries(data.by_source || {}).map(([src, meta]) => (
              <div key={src} className="rounded bg-slate-800/60 px-1.5 py-1">
                <div className="text-slate-300 font-semibold">{src}</div>
                <div className="text-slate-400">
                  {meta.error ? <span className="text-rose-400">err</span> : `${meta.n_items} items`}
                </div>
                <div className="text-slate-500">
                  score {Number(meta.score).toFixed(2)} · w{meta.weight}
                </div>
              </div>
            ))}
          </div>
          {(data.headlines || []).length === 0 ? (
            <div className="text-slate-500 italic">No headlines in window.</div>
          ) : (
            <ul className="space-y-1.5">
              {data.headlines.slice(0, 10).map((h, i) => (
                <li key={`${h.url || ''}-${i}`} className="leading-snug">
                  {h.url ? (
                    <a
                      href={h.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-300 hover:underline"
                    >
                      {h.title}
                    </a>
                  ) : (
                    <span>{h.title}</span>
                  )}
                  <div className="text-[10px] text-slate-500">
                    {h.publisher || '—'}
                    {Number.isFinite(h.score) && (
                      <span className={h.score > 0 ? 'text-emerald-400 ml-1' : h.score < 0 ? 'text-rose-400 ml-1' : 'ml-1'}>
                        {h.score > 0 ? '+' : ''}{Number(h.score).toFixed(2)}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  )
}
