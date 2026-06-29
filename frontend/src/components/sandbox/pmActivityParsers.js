const SYMBOL_BLOCKLIST = new Set([
  'AI', 'BOT', 'SIM', 'IB', 'PM', 'MKT', 'LMT', 'DAY', 'GTC', 'EOD',
])

function isLikelySymbol(token) {
  const sym = String(token ?? '').trim().toUpperCase()
  if (!sym) return false
  if (!/^[A-Z]{1,6}$/.test(sym)) return false
  return !SYMBOL_BLOCKLIST.has(sym)
}

function extractPrimarySymbol(message) {
  const text = String(message ?? '')

  const explicit = [
    /\b(?:BUY|SELL|HOLD|CANCEL)\s+([A-Z]{1,6})\b/i,
    /\b([A-Z]{1,6})\s*x\d+(?:\.\d+)?\b/i,
    /\b([A-Z]{1,6}):(?:buy|sell|hold)\b/i,
  ]
  for (const rx of explicit) {
    const m = text.match(rx)
    if (m?.[1] && isLikelySymbol(m[1])) return m[1].toUpperCase()
  }

  const fallback = text.match(/\b[A-Z]{1,6}\b/g) ?? []
  for (const token of fallback) {
    if (isLikelySymbol(token)) return token.toUpperCase()
  }
  return null
}

export function isAiBotPmMessage(msg) {
  return /^AI bot:\s*/i.test(String(msg ?? ''))
}

export function toAiBotPmEntries(rows = []) {
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? {}
    const message = String(row.msg ?? '').trim()
    if (!isAiBotPmMessage(message)) continue
    out.push({
      id: `pm-ai-${row.at ?? i}-${i}`,
      kind: 'pm_ai',
      at: row.at ?? null,
      date: row.at ?? null,
      msg: message,
      message: message.replace(/^AI bot:\s*/i, '').trim(),
      symbol: extractPrimarySymbol(message),
      side: /\bBUY\b/i.test(message) ? 'BUY' : /\bSELL\b/i.test(message) ? 'SELL' : /\bCANCEL\b/i.test(message) ? 'CANCEL' : null,
    })
  }
  return out
}
