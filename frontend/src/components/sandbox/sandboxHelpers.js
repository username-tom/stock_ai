import { CUSTOM_SCRIPT_KEY, STRATEGY_PARAM_UI } from './sandboxConstants'

export const pct = (v, t) => (!t ? '0.0' : ((v / t) * 100).toFixed(1))
export const fmt = n => n == null ? '—' : n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`
export const fmtMoney = n => n == null ? '—' : `$${Number(n).toFixed(2)}`
export const stratLabel = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
export const defaultParams = type => Object.fromEntries((STRATEGY_PARAM_UI[type] || []).map(f => [f.key, f.default]))

export function encodeStrategy(type, params, scriptId) {
  if (type === CUSTOM_SCRIPT_KEY) return scriptId ? `custom:${scriptId}` : null
  const p = Object.keys(params).length ? ':' + JSON.stringify(params) : ''
  return `${type}${p}`
}

export function decodeStrategy(raw) {
  if (!raw) return { type: 'sma_crossover', params: defaultParams('sma_crossover'), scriptId: null }
  if (raw.startsWith('custom:')) return { type: CUSTOM_SCRIPT_KEY, params: {}, scriptId: parseInt(raw.slice(7), 10) || null }
  const i = raw.indexOf(':')
  if (i === -1) return { type: raw, params: defaultParams(raw), scriptId: null }
  const type = raw.slice(0, i)
  try { return { type, params: JSON.parse(raw.slice(i + 1)), scriptId: null } }
  catch { return { type, params: defaultParams(type), scriptId: null } }
}
