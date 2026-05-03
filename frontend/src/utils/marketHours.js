/**
 * Returns true when the US equity market is likely open.
 * Uses market_state from a quotes map when available; otherwise falls back
 * to a clock-based check (Mon–Fri 09:30–16:00 America/New_York).
 */
export function deriveMarketOpen(quotesMap) {
  if (quotesMap) {
    const states = Object.values(quotesMap).map(q => q?.market_state)
    if (states.some(s => s === 'REGULAR')) return true
    if (states.some(s => s === 'PRE' || s === 'POST' || s === 'CLOSED')) return false
  }
  return isMarketHours()
}

export function isMarketHours() {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()          // 0 Sun … 6 Sat
  if (day === 0 || day === 6) return false
  const mins = et.getHours() * 60 + et.getMinutes()
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}
