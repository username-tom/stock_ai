/**
 * Derive a simple bullish / bearish / neutral market sentiment score
 * from a quote object already present on the client.
 *
 * Signals used (each ±1 point):
 *  1. Day change %            – positive → +1, negative → -1
 *  2. Price vs day range      – upper half → +1, lower half → -1
 *  3. Price vs prev close     – above → +1, below → -1
 *
 * Result:
 *  score =  3 and change > +2% → "Euphoric"
 *  score = -3 and change < -2% → "Crash"
 *  score ≥  2                → "Bullish"
 *  score ≤ -2                → "Bearish"
 *  otherwise                 → "Neutral"
 */
export function quotesentiment(quote) {
  if (!quote) return null

  let score = 0

  // 1. Day change direction
  if (quote.change_pct != null) {
    if (quote.change_pct > 0.15)       score += 1
    else if (quote.change_pct < -0.15) score -= 1
  }

  // 2. Price position within day range
  const price = quote.last_price
  const hi    = quote.day_high
  const lo    = quote.day_low
  if (price != null && hi != null && lo != null && hi !== lo) {
    const rangePct = (price - lo) / (hi - lo)
    if (rangePct >= 0.6)      score += 1
    else if (rangePct <= 0.4) score -= 1
  }

  // 3. Price vs previous close
  const prev = quote.previous_close
  if (price != null && prev != null && prev !== 0) {
    if (price > prev)      score += 1
    else if (price < prev) score -= 1
  }

  if (score >= 3 && (quote.change_pct ?? 0) > 2) return 'euphoric'
  if (score <= -3 && (quote.change_pct ?? 0) < -2) return 'crash'
  if (score >= 2)  return 'bullish'
  if (score <= -2) return 'bearish'
  return 'neutral'
}

/**
 * Derive a simple BUY / HOLD / SELL action signal from a quote.
 *
 * Uses a separate set of signals weighted slightly differently:
 *  1. Day change magnitude   – >+1% → +2, >+0.2% → +1, <-1% → -2, <-0.2% → -1
 *  2. Price vs day range     – top 25% → +1, bottom 25% → -1
 *  3. Volume spike           – uses change_pct as a proxy when volume unavailable
 *
 * Result:
 *  score ≥  2 → "BUY"
 *  score ≤ -2 → "SELL"
 *  otherwise  → "HOLD"
 */
export function quotesignal(quote) {
  if (!quote) return null

  let score = 0

  // 1. Day change magnitude
  const chg = quote.change_pct
  if (chg != null) {
    if (chg > 1)          score += 2
    else if (chg > 0.2)   score += 1
    else if (chg < -1)    score -= 2
    else if (chg < -0.2)  score -= 1
  }

  // 2. Price position within day range (stronger conviction near extremes)
  const price = quote.last_price
  const hi    = quote.day_high
  const lo    = quote.day_low
  if (price != null && hi != null && lo != null && hi !== lo) {
    const rangePct = (price - lo) / (hi - lo)
    if (rangePct >= 0.75)      score += 1
    else if (rangePct <= 0.25) score -= 1
  }

  // 3. Price momentum vs previous close (confirmation)
  const prev = quote.previous_close
  if (price != null && prev != null && prev !== 0) {
    const momPct = ((price - prev) / prev) * 100
    if (momPct > 0.5)       score += 1
    else if (momPct < -0.5) score -= 1
  }

  if (score >= 2)  return 'buy'
  if (score <= -2) return 'sell'
  return 'hold'
}

/** Tailwind colour classes for each sentiment value */
export const SENTIMENT_COLORS = {
  euphoric: 'text-fuchsia-300 bg-fuchsia-500/15 border-fuchsia-500/40',
  bullish: 'text-emerald-400 bg-emerald-400/10 border-emerald-500/30',
  bearish: 'text-red-400 bg-red-400/10 border-red-500/30',
  crash: 'text-rose-300 bg-rose-600/20 border-rose-500/50',
  neutral: 'text-slate-400 bg-slate-400/10 border-slate-500/30',
}

/** Short display label */
export const SENTIMENT_LABELS = {
  euphoric: '⬈ Euphoric',
  bullish: '▲ Bullish',
  bearish: '▼ Bearish',
  crash: '⤋ Crash',
  neutral: '◆ Neutral',
}

/** Tailwind colour classes for each signal value */
export const SIGNAL_COLORS = {
  buy:  'text-emerald-300 bg-emerald-500/15 border-emerald-500/40',
  sell: 'text-red-300 bg-red-500/15 border-red-500/40',
  hold: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
}

/** Short display label */
export const SIGNAL_LABELS = {
  buy:  '● BUY',
  sell: '● SELL',
  hold: '● HOLD',
}
