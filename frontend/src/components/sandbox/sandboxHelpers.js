import { CUSTOM_SCRIPT_KEY, STRATEGY_PARAM_UI, TEMPLATE_SCRIPT_KEY } from './sandboxConstants'

export const pct = (v, t) => (!t ? '0.0' : ((v / t) * 100).toFixed(1))
export const fmt = n => n == null ? '—' : n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`
export const fmtMoney = n => n == null ? '—' : `$${Number(n).toFixed(2)}`
export const stratLabel = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
export const defaultParams = type => Object.fromEntries((STRATEGY_PARAM_UI[type] || []).map(f => [f.key, f.default]))
export function getVisibleTradePnl(tradeLike) {
  // A missing/null pnl means the broker did not report a realized result for
  // this fill — it is NOT a $0 breakeven trade. Coercing null→0 here previously
  // counted hundreds of unreported IB SELL fills as breakeven, collapsing the
  // win rate. Treat null/undefined/'' as "no realized pnl" (return null).
  const raw = tradeLike?.pnl
  if (raw == null || raw === '') return null
  const pnl = Number(raw)
  if (!Number.isFinite(pnl)) return null
  const side = String(tradeLike?.side ?? '').trim().toUpperCase()
  if (side !== 'SELL') return null
  const status = String(tradeLike?.status ?? '').trim().toUpperCase()
  if (status && status !== 'FILLED') return null
  return pnl
}

export function encodeStrategy(type, params, scriptId, templateFilename) {
  if (type === TEMPLATE_SCRIPT_KEY) return templateFilename ? `template:${templateFilename}` : null
  if (type === CUSTOM_SCRIPT_KEY) return scriptId ? `custom:${scriptId}` : null
  const p = Object.keys(params).length ? ':' + JSON.stringify(params) : ''
  return `${type}${p}`
}

export function decodeStrategy(raw) {
  if (!raw) return { type: 'sma_crossover', params: defaultParams('sma_crossover'), scriptId: null, templateFilename: null }
  if (raw.startsWith('template:')) return { type: TEMPLATE_SCRIPT_KEY, params: {}, scriptId: null, templateFilename: raw.slice(9) }
  if (raw.startsWith('custom:')) return { type: CUSTOM_SCRIPT_KEY, params: {}, scriptId: parseInt(raw.slice(7), 10) || null, templateFilename: null }
  const i = raw.indexOf(':')
  if (i === -1) return { type: raw, params: defaultParams(raw), scriptId: null, templateFilename: null }
  const type = raw.slice(0, i)
  try { return { type, params: JSON.parse(raw.slice(i + 1)), scriptId: null, templateFilename: null } }
  catch { return { type, params: defaultParams(type), scriptId: null, templateFilename: null } }
}

// Reconstruct running average cost per symbol from activity rows so older log
// entries can be backfilled even if avg price was not persisted originally.
export function backfillTradeAvgPrice(trades) {
  const rows = Array.isArray(trades) ? trades : []
  const avgByIndex = new Map()
  const stateBySymbol = new Map()
  const lastBuyPriceBySymbol = new Map()

  const withMeta = rows.map((row, index) => {
    const rawTs = Number(row?.ts)
    const parsedTs = Number.isFinite(rawTs)
      ? rawTs
      : Number(new Date(row?.date ?? 0).getTime())
    return {
      row,
      index,
      ts: Number.isFinite(parsedTs) ? parsedTs : 0,
    }
  })

  withMeta.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts
    return a.index - b.index
  })

  for (const item of withMeta) {
    const row = item.row ?? {}
    const symbol = String(row.symbol ?? '').trim().toUpperCase()
    const side = String(row.side ?? '').toUpperCase()
    const qty = Math.abs(Number(row.shares ?? 0))
    const px = Number(row.price ?? 0)

    if (!symbol || !Number.isFinite(qty) || qty <= 0) {
      avgByIndex.set(item.index, null)
      continue
    }

    const st = stateBySymbol.get(symbol) ?? { qty: 0, avg: 0 }
    let avgForTrade = null

    if (side === 'SELL') {
      const prevBuy = Number(lastBuyPriceBySymbol.get(symbol))
      if (Number.isFinite(prevBuy) && prevBuy > 0) avgForTrade = prevBuy
      else if (st.qty > 0 && Number.isFinite(st.avg) && st.avg > 0) avgForTrade = st.avg

      if (st.qty > 0) {
        if (st.qty > qty) {
          st.qty -= qty
        } else if (st.qty === qty) {
          st.qty = 0
          st.avg = 0
        } else {
          // Crossed from long to short; remaining shares open a short at sell price.
          const rem = qty - st.qty
          st.qty = -rem
          st.avg = Number.isFinite(px) && px > 0 ? px : 0
        }
      } else {
        // Opening/adding short inventory.
        if (Number.isFinite(px) && px > 0) {
          const curShort = Math.abs(st.qty)
          const nextShort = curShort + qty
          st.avg = nextShort > 0 ? ((st.avg * curShort) + (px * qty)) / nextShort : 0
          st.qty = -nextShort
        }
      }
    } else if (side === 'BUY') {
      if (Number.isFinite(px) && px > 0) {
        lastBuyPriceBySymbol.set(symbol, px)
      }
      if (st.qty < 0) {
        // Covering short inventory.
        const curShort = Math.abs(st.qty)
        if (curShort > qty) {
          st.qty += qty
        } else if (curShort === qty) {
          st.qty = 0
          st.avg = 0
        } else {
          // Crossed from short to long; remaining shares open a long at buy price.
          const rem = qty - curShort
          st.qty = rem
          st.avg = Number.isFinite(px) && px > 0 ? px : 0
        }
      } else {
        if (Number.isFinite(px) && px > 0) {
          const nextQty = st.qty + qty
          st.avg = nextQty > 0 ? ((st.avg * st.qty) + (px * qty)) / nextQty : 0
          st.qty = nextQty
        }
      }
    }

    stateBySymbol.set(symbol, st)
    avgByIndex.set(item.index, avgForTrade)
  }

  return rows.map((row, index) => ({
    ...row,
    avgPrice: avgByIndex.has(index) ? avgByIndex.get(index) : null,
  }))
}
