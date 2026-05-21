import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpIcon, ArrowDownIcon } from '@heroicons/react/24/solid'
import {
  quotesentiment, quotesignal,
  SENTIMENT_COLORS, SENTIMENT_LABELS,
  SIGNAL_COLORS, SIGNAL_LABELS,
} from '../../utils/sentiment'
import { getQuote } from '../../api/client'
import { isMarketHours } from '../../utils/marketHours'

const QUOTE_CACHE_KEY = 'dashboard_quote_cache_v1'
const QUOTE_CACHE_TTL_MS = 15 * 60_000

function readCachedQuote(symbol) {
  if (!symbol) return null
  try {
    const raw = localStorage.getItem(QUOTE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const entry = parsed?.[symbol]
    if (!entry?.quote || !entry?.ts) return null
    if (Date.now() - entry.ts > QUOTE_CACHE_TTL_MS) return null
    return entry.quote
  } catch {
    return null
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(n, d = 2) { return n != null ? n.toFixed(d) : '—' }
function fmtVol(v) {
  if (!v) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  return `${(v / 1e3).toFixed(0)}K`
}

const MARKET_STATE_LABEL = {
  REGULAR: { label: 'Market Open',   cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-500/30' },
  PRE:     { label: 'Pre-Market',    cls: 'text-amber-400  bg-amber-400/10  border-amber-500/30'  },
  POST:    { label: 'After-Hours',   cls: 'text-sky-400    bg-sky-400/10    border-sky-500/30'    },
  CLOSED:  { label: 'Market Closed', cls: 'text-slate-400  bg-slate-400/10  border-slate-500/30'  },
}

/**
 * Yahoo Finance's marketState field is unreliable — it frequently returns
 * "CLOSED" during live sessions.  Treat any "CLOSED" signal from Yahoo as
 * untrustworthy and fall back to the local clock-based check instead.
 */
function resolveMarketState(rawState) {
  if (rawState === 'REGULAR') return 'REGULAR'
  if (rawState === 'PRE')     return 'PRE'
  if (rawState === 'POST')    return 'POST'
  // "CLOSED" from Yahoo is unreliable — trust the clock instead
  return isMarketHours() ? 'REGULAR' : 'CLOSED'
}

// ─── sub-components ──────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-2 mt-4 first:mt-0">
      {children}
    </div>
  )
}

function StatRow({ label, value, valueClass = 'text-slate-200' }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs font-mono font-medium ${valueClass}`}>{value}</span>
    </div>
  )
}

/** Horizontal gauge showing where price sits in the day range */
function DayRangeBar({ low, high, price }) {
  if (low == null || high == null || price == null || high === low) return null
  const pct = Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100))
  return (
    <div className="mt-1 mb-1">
      <div className="relative h-1.5 w-full bg-dark-600 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-red-500 via-amber-400 to-emerald-500"
          style={{ width: '100%' }}
        />
        {/* Thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full bg-white border-2 border-dark-800 shadow"
          style={{ left: `calc(${pct}% - 5px)` }}
        />
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-slate-600 font-mono">
        <span>${fmt(low)}</span>
        <span>${fmt(high)}</span>
      </div>
    </div>
  )
}

/** One scored signal indicator row */
function SignalIndicator({ label, detail, score }) {
  // score: +1 (bullish), -1 (bearish), 0 (neutral)
  const dot =
    score > 0 ? 'bg-emerald-400' :
    score < 0 ? 'bg-red-400'     :
                'bg-slate-500'
  const text =
    score > 0 ? 'text-emerald-400' :
    score < 0 ? 'text-red-400'     :
                'text-slate-500'
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`flex-shrink-0 h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="text-xs text-slate-400 truncate">{label}</span>
      </div>
      <span className={`text-xs font-mono ml-2 flex-shrink-0 ${text}`}>{detail}</span>
    </div>
  )
}

// ─── sentiment score breakdown ────────────────────────────────────────────────

function getSentimentBreakdown(q) {
  if (!q) return []
  const price = q.last_price
  const hi = q.day_high, lo = q.day_low, prev = q.previous_close

  const s1 = q.change_pct != null
    ? (q.change_pct > 0.15 ? 1 : q.change_pct < -0.15 ? -1 : 0)
    : null

  let s2 = null
  if (price != null && hi != null && lo != null && hi !== lo) {
    const r = (price - lo) / (hi - lo)
    s2 = r >= 0.6 ? 1 : r <= 0.4 ? -1 : 0
  }

  const s3 = (price != null && prev != null && prev !== 0)
    ? (price > prev ? 1 : price < prev ? -1 : 0)
    : null

  const rangePct = (price != null && hi != null && lo != null && hi !== lo)
    ? ((price - lo) / (hi - lo) * 100).toFixed(0)
    : null

  return [
    { label: 'Day Change',   detail: q.change_pct != null ? `${q.change_pct > 0 ? '+' : ''}${fmt(q.change_pct)}%` : '—', score: s1 ?? 0 },
    { label: 'Range Pos.',   detail: rangePct != null ? `${rangePct}% of range` : '—',                                    score: s2 ?? 0 },
    { label: 'vs Prev Close',detail: (price != null && prev != null) ? `${price >= prev ? '▲' : '▼'} $${fmt(Math.abs(price - prev))}` : '—', score: s3 ?? 0 },
  ]
}

function getSignalBreakdown(q) {
  if (!q) return []
  const price = q.last_price
  const hi = q.day_high, lo = q.day_low, prev = q.previous_close
  const chg = q.change_pct

  const s1 = chg != null
    ? (chg > 1 ? 1 : chg > 0.2 ? 1 : chg < -1 ? -1 : chg < -0.2 ? -1 : 0)
    : null

  let s2 = null
  if (price != null && hi != null && lo != null && hi !== lo) {
    const r = (price - lo) / (hi - lo)
    s2 = r >= 0.75 ? 1 : r <= 0.25 ? -1 : 0
  }

  let s3 = null
  if (price != null && prev != null && prev !== 0) {
    const mom = ((price - prev) / prev) * 100
    s3 = mom > 0.5 ? 1 : mom < -0.5 ? -1 : 0
  }

  const rangePct = (price != null && hi != null && lo != null && hi !== lo)
    ? ((price - lo) / (hi - lo) * 100).toFixed(0)
    : null

  return [
    { label: 'Momentum',    detail: chg != null ? `${chg > 0 ? '+' : ''}${fmt(chg)}%` : '—',                         score: s1 ?? 0 },
    { label: 'Price Pos.',  detail: rangePct != null ? `${rangePct}% of range` : '—',                                  score: s2 ?? 0 },
    { label: 'vs Prev',     detail: (price != null && prev != null) ? `${price >= prev ? '+' : ''}${fmt(((price - prev) / prev) * 100)}%` : '—', score: s3 ?? 0 },
  ]
}

// ─── loading skeleton ────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-5 w-16 bg-dark-600 rounded" />
      <div className="h-3 w-28 bg-dark-700 rounded" />
      <div className="h-8 w-24 bg-dark-600 rounded mt-2" />
      <div className="h-3 w-20 bg-dark-700 rounded" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex justify-between">
            <div className="h-3 w-16 bg-dark-700 rounded" />
            <div className="h-3 w-12 bg-dark-600 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── main component ───────────────────────────────────────────────────────────

export default function SymbolDetailPanel({ symbol, quoteData, isLoading, ownedShares = null, averagePrice = null }) {
  const cachedQuote = useMemo(() => readCachedQuote(symbol), [symbol])

  // Fallback: if the selected symbol isn't in the watchlist quotesMap
  // (e.g. a preset list symbol), fetch it individually
  const needsFetch = !isLoading && !quoteData && !cachedQuote && !!symbol
  const { data: fetchedQuote, isLoading: fetchLoading } = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => getQuote(symbol),
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: needsFetch,
  })

  const q = quoteData ?? cachedQuote ?? fetchedQuote ?? null
  const loading = !q && (isLoading || (needsFetch && fetchLoading))
  if (loading) return <div className="card h-full p-4"><Skeleton /></div>

  if (!q) {
    return (
      <div className="card h-full flex items-center justify-center">
        <p className="text-xs text-slate-600">Select a symbol</p>
      </div>
    )
  }

  const price = q.last_price ?? q.previous_close ?? 0
  const prev  = q.previous_close ?? price
  const changePct = q.change_pct ?? (prev ? ((price - prev) / prev) * 100 : 0)
  const changeAbs = q.change ?? (price - prev)
  const positive  = changePct >= 0

  const sentiment = quotesentiment(q)
  const signal    = quotesignal(q)
  const sentBreakdown = getSentimentBreakdown(q)
  const sigBreakdown  = getSignalBreakdown(q)

  const stateInfo = MARKET_STATE_LABEL[resolveMarketState(q.market_state)] ?? MARKET_STATE_LABEL.CLOSED

  // Derived range position
  const rangePct = (price != null && q.day_high != null && q.day_low != null && q.day_high !== q.day_low)
    ? ((price - q.day_low) / (q.day_high - q.day_low) * 100).toFixed(1)
    : null
  const hasOwnershipData = ownedShares != null || averagePrice != null

  return (
    <div
      className="card flex flex-col gap-0 overflow-y-auto"
      style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 transparent' }}
    >
      {/* ── Header ── */}
      <div className="pb-3 border-b border-dark-700">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xlg font-bold font-mono text-slate-100 leading-tight">{q.symbol}</div>
            {q.company_name && (
              <div className="text-xs text-slate-500 mt-0.5 leading-snug">{q.company_name}</div>
            )}
          </div>
          <span className={`flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border ${stateInfo.cls}`}>
            {stateInfo.label}
          </span>
        </div>

        {/* Price */}
        <div className="mt-2.5 flex items-end gap-2">
          <span className="text-2xl font-bold font-mono text-slate-100">${fmt(price)}</span>
        </div>
        <div className={`flex items-center gap-1.5 mt-0.5 text-sm font-semibold font-mono ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
          {positive ? <ArrowUpIcon className="h-3.5 w-3.5" /> : <ArrowDownIcon className="h-3.5 w-3.5" />}
          {positive ? '+' : ''}{fmt(changeAbs)} ({positive ? '+' : ''}{fmt(changePct)}%)
        </div>
      </div>

      {/* ── Price Details ── */}
      <div className="py-3 border-b border-dark-700">
        <SectionLabel>Price Details</SectionLabel>
        <StatRow label="Open"       value={q.open           != null ? `$${fmt(q.open)}`           : '—'} />
        <StatRow label="Day High"   value={q.day_high       != null ? `$${fmt(q.day_high)}`       : '—'} valueClass="text-emerald-400" />
        <StatRow label="Day Low"    value={q.day_low        != null ? `$${fmt(q.day_low)}`        : '—'} valueClass="text-red-400" />
        <StatRow label="Prev Close" value={q.previous_close != null ? `$${fmt(q.previous_close)}` : '—'} />
        <StatRow label="Volume"     value={fmtVol(q.volume)} />
      </div>

      {/* ── Day Range ── */}
      <div className="py-3 border-b border-dark-700">
        <SectionLabel>Day Range</SectionLabel>
        {rangePct != null && (
          <div className="text-xs text-slate-500 mb-1.5 text-right">{rangePct}% from low</div>
        )}
        <DayRangeBar low={q.day_low} high={q.day_high} price={price} />
      </div>

      {/* ── Sentiment ── */}
      <div className="py-3 border-b border-dark-700">
        <SectionLabel>Sentiment</SectionLabel>
        <div className="flex gap-2 mb-3">
          {sentiment && (
            <span className={`inline-flex items-center px-2 py-1 rounded border text-xs font-semibold ${SENTIMENT_COLORS[sentiment]}`}>
              {SENTIMENT_LABELS[sentiment]}
            </span>
          )}
          {signal && (
            <span className={`inline-flex items-center px-2 py-1 rounded border text-xs font-semibold ${SIGNAL_COLORS[signal]}`}>
              {SIGNAL_LABELS[signal]}
            </span>
          )}
        </div>
        <div className="space-y-0.5">
          {sentBreakdown.map(item => (
            <SignalIndicator key={item.label} {...item} />
          ))}
        </div>
      </div>

      {/* ── Trade Signals ── */}
      <div className="py-3">
        <SectionLabel>Trade Signals</SectionLabel>
        <div className="space-y-0.5">
          {sigBreakdown.map(item => (
            <SignalIndicator key={item.label} {...item} />
          ))}
        </div>
        {/* Overall signal score bar */}
        {(() => {
          const total = sigBreakdown.reduce((a, b) => a + b.score, 0)
          const maxScore = 3
          const pct = ((total + maxScore) / (maxScore * 2)) * 100
          const color = total >= 2 ? 'bg-emerald-500' : total <= -2 ? 'bg-red-500' : 'bg-amber-400'
          return (
            <div className="mt-3">
              <div className="flex justify-between text-[10px] text-slate-600 mb-1">
                <span>Bearish</span>
                <span>Score: {total > 0 ? '+' : ''}{total}/{maxScore}</span>
                <span>Bullish</span>
              </div>
              <div className="h-1.5 w-full bg-dark-600 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })()}
      </div>

      {hasOwnershipData && (
        <div className="py-3 border-t border-dark-700">
          <SectionLabel>Position</SectionLabel>
          <StatRow label="Owned Shares" value={ownedShares != null ? fmt(ownedShares, 4) : '—'} />
          <StatRow label="Average Price" value={averagePrice != null ? `$${fmt(averagePrice)}` : '—'} />
        </div>
      )}
    </div>
  )
}
