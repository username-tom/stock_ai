/**
 * Returns true when the US equity market is likely open.
 * Uses market_state from a quotes map when available; otherwise falls back
 * to a clock-based check (Mon–Fri 09:30–16:00 America/New_York).
 */
export function deriveMarketOpen(quotesMap) {
  if (quotesMap) {
    const states = Object.values(quotesMap).map(q => q?.market_state)
    if (states.some(s => s === 'REGULAR')) return true
    // PRE / POST are definitive extended-hours states — trust them
    if (states.some(s => s === 'PRE' || s === 'POST')) return false
    if (states.some(s => s === 'CLOSED')) return false
  }
  return isMarketHours()
}

export function isMarketHours() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)

  const day    = parts.find(p => p.type === 'weekday')?.value   // 'Mon'…'Sun'
  const hour   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)

  if (day === 'Sat' || day === 'Sun') return false
  const mins = hour * 60 + minute
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

/**
 * Returns true during the open-order "warm-up + frenzy" window — the period
 * where 5-second bars are most useful for placing orders at the bell and
 * surviving the opening volatility burst.
 *
 * Window (America/New_York): 09:15 (15 min pre-open warmup) through 10:30
 * (first hour of regular trading). Weekends always return false.
 */
export function isOpeningFrenzyWindow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date())

  const day    = parts.find(p => p.type === 'weekday')?.value
  const hour   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)

  if (day === 'Sat' || day === 'Sun') return false
  const mins = hour * 60 + minute
  return mins >= 9 * 60 + 15 && mins <= 10 * 60 + 30
}
