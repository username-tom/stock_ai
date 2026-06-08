import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Cell, Tooltip, ResponsiveContainer, Treemap,
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'
import {
  HomeIcon, ChartPieIcon, TableCellsIcon, ClockIcon,
  ArrowUpIcon, ArrowDownIcon, BanknotesIcon,
  ChevronLeftIcon, ChevronRightIcon, ChevronDoubleLeftIcon, ChevronDoubleRightIcon,
} from '@heroicons/react/24/outline'
import { useQuery } from '@tanstack/react-query'
import { getSandboxFundEvents } from '../../api/client'
import { useAppSettings } from '../../hooks/useAppSettings'
import { usePriceChangeTracking } from '../../hooks/usePriceChangeTracking'
import { PIE_COLORS } from './sandboxConstants'
import { backfillTradeAvgPrice, fmt, fmtMoney, getVisibleTradePnl } from './sandboxHelpers'
import MiniSparkline from '../dashboard/MiniSparkline'

const BULL_COLOR = '#10b981'
const BEAR_COLOR = '#ef4444'
const NEUTRAL_COLOR = '#64748b'
const EUPHORIC_COLOR = '#a855f7'
const CRASH_COLOR = '#f97316'
const AI_TAG_CELL_STYLES = {
  'STRONG LONG': 'text-emerald-300',
  LONG: 'text-emerald-400',
  'STRONG SHORT': 'text-red-300',
  SHORT: 'text-red-400',
  WATCH: 'text-slate-400',
  NEUTRAL: 'text-slate-400',
}

function scoreToClassification(score) {
  if (score >= 0.5) return 'euphoric'
  if (score >= 0.1) return 'bullish'
  if (score > -0.1) return 'neutral'
  if (score > -0.5) return 'bearish'
  return 'crash'
}

function classColor(cls) {
  if (cls === 'euphoric') return EUPHORIC_COLOR
  if (cls === 'crash') return CRASH_COLOR
  if (cls === 'bullish') return BULL_COLOR
  if (cls === 'bearish') return BEAR_COLOR
  return NEUTRAL_COLOR
}

function classLabel(cls) {
  if (cls === 'bullish') return '▲ Bullish'
  if (cls === 'bearish') return '▼ Bearish'
  if (cls === 'euphoric') return '▲▲ Euphoric'
  if (cls === 'crash') return '▼▼ Crash'
  return '— Neutral'
}

function stratLabel(strategy_name) {
  if (!strategy_name) return '—'
  if (strategy_name.startsWith('template:')) {
    return strategy_name.slice(9).replace(/\.py$/, '').split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }
  if (strategy_name.startsWith('custom:')) return 'Custom Script'
  return strategy_name.split(':')[0]
}

function strategyDisplayLabel(pos, managerSettings, aiTag) {
  const aiDirectMode =
    Boolean(managerSettings?.ai_tag_strategy_enabled)
    && String(managerSettings?.ai_tag_action_mode ?? 'strategy_override') === 'direct'
  const longTag = aiTag === 'LONG' || aiTag === 'STRONG LONG'
  if (aiDirectMode && (longTag || Boolean(pos?.pm_managed))) return 'PM Direct Action'
  return stratLabel(pos?.strategy_name)
}

function fmtUpperLimit(pos) {
  const mode = pos?.max_allocation_mode ?? 'dollar'
  const value = Number(pos?.max_allocation_value)
  if (!Number.isFinite(value) || value <= 0) return 'No cap'
  return mode === 'percent' ? `${value.toFixed(2)}%` : fmtMoney(value)
}

function fmtLowerLimit(managerSettings, totalFunds) {
  if (!managerSettings) return '—'
  const mode = managerSettings.min_position_funds_mode ?? 'dollar'
  if (mode === 'percent') {
    const pct = Number(managerSettings.min_position_funds_pct ?? 1)
    const dollar = (Number(totalFunds) || 0) * (pct / 100)
    return `${pct.toFixed(2)}% (${fmtMoney(dollar)})`
  }
  return fmtMoney(Number(managerSettings.min_position_funds ?? 0))
}

function fitTreemapLabel(symbol, width, height) {
  const text = String(symbol ?? '')
  if (!text) return { text: '?', fontSize: 10 }

  // Approximate monospace width: ~0.62em per character.
  const maxByWidth = Math.floor((Math.max(0, width - 10)) / Math.max(1, text.length * 0.62))
  const maxByHeight = Math.floor(Math.max(0, height - 6) * 0.75)
  const fontSize = Math.max(9, Math.min(14, maxByWidth, maxByHeight || 14))

  let fitted = text
  const minReadable = 9
  if (fontSize <= minReadable && text.length > 6) {
    fitted = `${text.slice(0, 5)}…`
  }

  return { text: fitted, fontSize }
}

export default function PortfolioOverview({
  ibMode,
  accountData,
  positions,
  positionsRefreshing = false,
  ibPositions = [],
  quotes,
  totalEquity,
  totalUnrealizedPnl,
  totalRealizedPnl,
  pieData,
  analytics,
  realizedMetrics,
  allTrades = [],
  activities = [],
  managerActivities = [],
  pmScores = {},
  managerSettings = null,
  onOpenManager = null,
  onSelectSymbol,
}) {
  const appSettings = useAppSettings()
  const isSimulated = !ibMode
  const activeProfile = isSimulated ? 'simulated' : String(ibMode).toLowerCase()
  const priceColors = usePriceChangeTracking(quotes)
  const recentPmActivities = useMemo(
    () => (Array.isArray(managerActivities) ? managerActivities : []).slice(0, 8),
    [managerActivities],
  )
  const { data: fundEventsData } = useQuery({
    queryKey: ['sandbox-fund-events'],
    queryFn: getSandboxFundEvents,
    refetchInterval: appSettings.portfolio_detail_ms,
    enabled: isSimulated,
  })
  const fundEvents = isSimulated ? (fundEventsData?.events ?? []) : []
  const [activityPage, setActivityPage] = useState(0)
  const gainLossChartRef = useRef(null)
  const [gainLossChartWidth, setGainLossChartWidth] = useState(0)
  const netDepositedFromEvents = fundEvents.reduce((sum, event) => {
    if (event.event_type === 'deposit') return sum + (event.amount ?? 0)
    if (event.event_type === 'withdrawal') return sum - (event.amount ?? 0)
    return sum
  }, 0)
  const totalDeposited = isSimulated
    ? (accountData?.total_deposited ?? netDepositedFromEvents)
    : null

  const cumulativeSeries = analytics?.cumulative_pnl ?? []
  const ibPositionsBySymbol = useMemo(() => {
    const map = new Map()
    for (const row of ibPositions ?? []) {
      const symbol = String(row?.symbol ?? '').trim().toUpperCase()
      if (!symbol) continue
      map.set(symbol, {
        quantity: Number(row?.quantity ?? 0),
        avg_cost: Number(row?.avg_cost ?? 0),
      })
    }
    return map
  }, [ibPositions])
  const effectivePositions = useMemo(() => {
    return (positions ?? []).map((pos) => {
      const symbol = String(pos?.symbol ?? '').trim().toUpperCase()
      if (isSimulated) {
        return {
          ...pos,
          _effShares: Number(pos?.shares ?? 0),
          _effAvgCost: Number(pos?.avg_cost ?? 0),
          _effSymbol: symbol,
        }
      }
      const ibRow = ibPositionsBySymbol.get(symbol)
      return {
        ...pos,
        _effShares: Number(ibRow?.quantity ?? 0),
        _effAvgCost: Number(ibRow?.avg_cost ?? 0),
        _effSymbol: symbol,
      }
    })
  }, [positions, isSimulated, ibPositionsBySymbol])
  const resolveMarketPrice = (pos, fallbackQuote = quotes?.[pos.symbol]) => {
    const storedMarketPrice = Number(pos.market_price ?? pos.last_price)
    const marketValuePrice = Math.abs(Number(pos?.shares ?? 0)) > 0 && Number.isFinite(Number(pos.market_value)) && Math.abs(Number(pos.market_value)) > 0
      ? Math.abs(Number(pos.market_value) / Number(pos.shares ?? 1))
      : null
    const ibMarketPrice = Number.isFinite(storedMarketPrice) && storedMarketPrice > 0 ? storedMarketPrice : null
    if (!isSimulated) {
      return ibMarketPrice ?? fallbackQuote?.last_price ?? marketValuePrice ?? null
    }
    return fallbackQuote?.last_price ?? ibMarketPrice ?? marketValuePrice ?? Number(pos.avg_cost ?? 0)
  }
  const effectivePieData = useMemo(() => {
    if (isSimulated) return pieData

    const held = effectivePositions
      .filter(p => Math.abs(Number(p._effShares ?? 0)) > 0)
      .map((p) => {
        const shares = Math.abs(Number(p._effShares ?? 0))
        const mp = Number(resolveMarketPrice(p))
        if (!Number.isFinite(mp) || mp <= 0) return null
        const mv = shares * mp
        return {
          symbol: p.symbol,
          shares,
          market_value: mv,
          mv,
          cash: 0,
        }
      })
      .filter(Boolean)

    const total = held.reduce((sum, row) => sum + Number(row.market_value ?? 0), 0)
    if (total <= 0) return []
    return held.map((row) => ({
      ...row,
      pct: Number(((row.market_value / total) * 100).toFixed(2)),
    }))
  }, [isSimulated, pieData, effectivePositions, quotes])
  const breakdownPositions = useMemo(() => {
    if (isSimulated) {
      return [...effectivePositions].sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)))
    }

    // IB mode: keep all watchlist rows, merge IB shares/cost per symbol,
    // then sort by owned position size (largest first).
    return [...effectivePositions].sort((a, b) => {
      const aQty = Math.abs(Number(a._effShares ?? 0))
      const bQty = Math.abs(Number(b._effShares ?? 0))
      if (bQty !== aQty) return bQty - aQty
      return String(a.symbol).localeCompare(String(b.symbol))
    })
  }, [isSimulated, effectivePositions])
  const parsePointDate = (value) => {
    if (!value || typeof value !== 'string') return null
    const normalized = value.includes('T') ? value : value.replace(' ', 'T')
    const dt = new Date(normalized)
    return Number.isNaN(dt.getTime()) ? null : dt
  }
  const cumulativeBefore = (cutoff) => {
    let value = 0
    for (const pt of cumulativeSeries) {
      const dt = parsePointDate(pt.date)
      if (!dt) continue
      if (dt <= cutoff) value = Number(pt.value ?? 0)
      else break
    }
    return value
  }
  const latestCumulative = cumulativeSeries.length > 0
    ? Number(cumulativeSeries[cumulativeSeries.length - 1]?.value ?? 0)
    : 0
  const numOrNull = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  const ibBuyingPower = numOrNull(accountData?.buying_power)
  const ibCashValue = numOrNull(accountData?.cash_value)
  const ibUnrealizedPnl = numOrNull(accountData?.unrealized_pnl)
  const ibRealizedPnl = numOrNull(accountData?.realized_pnl)
  const ibRealizedPnlFromMetrics = numOrNull(realizedMetrics?.realized_pnl_sum)
  const totalFundsSource = String(accountData?.total_funds_source ?? '').toLowerCase()
  const usingPaperCapBase = !isSimulated && activeProfile === 'paper' && totalFundsSource === 'paper_max_allocation_sum'
  const performanceBase = (() => {
    if (isSimulated) {
      const deposited = numOrNull(totalDeposited)
      if (deposited != null && deposited > 0) return deposited
      const funds = numOrNull(accountData?.total_funds)
      return (funds != null && funds > 0) ? funds : null
    }
    const netLiq = numOrNull(accountData?.total_funds)
    if (netLiq != null && netLiq > 0) return netLiq
    const cash = numOrNull(ibCashValue)
    return (cash != null && cash > 0) ? cash : null
  })()
  const performanceBaseLabel = isSimulated ? 'deposited' : (usingPaperCapBase ? 'alloc cap' : 'net liq')
  const realizedPnlPct = performanceBase > 0 && totalRealizedPnl != null
    ? (totalRealizedPnl / performanceBase) * 100
    : null
  const breakdownUnrealizedPnl = useMemo(() => {
    let sum = 0
    let hasAny = false
    for (const pos of breakdownPositions) {
      const shares = Number(pos._effShares ?? 0)
      if (shares === 0) continue
      const avgCost = Number(pos._effAvgCost ?? 0)
      const mp = resolveMarketPrice(pos, quotes[pos.symbol])
      if (!Number.isFinite(Number(mp))) continue
      const unreal = (mp - avgCost) * shares
      if (Number.isFinite(unreal)) {
        sum += unreal
        hasAny = true
      }
    }
    return hasAny ? sum : null
  }, [breakdownPositions, quotes])
  // For IB mode, IB's own UnrealizedPnL (from account summary) is authoritative.
  // The frontend recalculation (breakdownUnrealizedPnl) is only a fallback when
  // IB hasn't reported a value yet, to avoid showing a stale or mismatched total.
  const headlineUnrealized = isSimulated
    ? (breakdownUnrealizedPnl ?? totalUnrealizedPnl)
    : (ibUnrealizedPnl ?? breakdownUnrealizedPnl ?? totalUnrealizedPnl)
  const headlineRealized = isSimulated ? totalRealizedPnl : (ibRealizedPnlFromMetrics ?? ibRealizedPnl)

  // Fallback period metrics from cumulative curve if backend metrics are temporarily unavailable.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() === 0 ? 6 : weekStart.getDay() - 1))
  const monthStart = new Date(todayStart); monthStart.setDate(1)
  const dailyPnlFallback = latestCumulative - cumulativeBefore(new Date(todayStart.getTime() - 1))
  const weeklyPnlFallback = latestCumulative - cumulativeBefore(new Date(weekStart.getTime() - 1))
  const monthlyPnlFallback = latestCumulative - cumulativeBefore(new Date(monthStart.getTime() - 1))

  const dailyPnl = numOrNull(realizedMetrics?.daily_realized_pnl) ?? (cumulativeSeries.length > 0 ? dailyPnlFallback : null)
  const dailyPnlPct = numOrNull(realizedMetrics?.daily_realized_pnl_pct)
    ?? ((performanceBase > 0 && dailyPnl != null) ? (dailyPnl / performanceBase) * 100 : null)
  const weeklyPnl = numOrNull(realizedMetrics?.weekly_realized_pnl) ?? (cumulativeSeries.length > 0 ? weeklyPnlFallback : null)
  const weeklyPnlPct = numOrNull(realizedMetrics?.weekly_realized_pnl_pct)
    ?? ((performanceBase > 0 && weeklyPnl != null) ? (weeklyPnl / performanceBase) * 100 : null)
  const monthlyPnl = numOrNull(realizedMetrics?.monthly_realized_pnl) ?? (cumulativeSeries.length > 0 ? monthlyPnlFallback : null)
  const monthlyPnlPct = numOrNull(realizedMetrics?.monthly_realized_pnl_pct)
    ?? ((performanceBase > 0 && monthlyPnl != null) ? (monthlyPnl / performanceBase) * 100 : null)

  const annualizePnlForPeriod = (pnlValue, periodTradingDays) => {
    if (performanceBase == null || performanceBase <= 0) return null
    if (pnlValue == null || !Number.isFinite(Number(pnlValue))) return null
    const r = Number(pnlValue) / performanceBase
    if (r <= -1 || periodTradingDays <= 0) return null
    return (Math.pow(1 + r, 252 / periodTradingDays) - 1) * 100
  }
  const dailyAnnualizedPct = annualizePnlForPeriod(dailyPnl, 1)
  const weeklyAnnualizedPct = annualizePnlForPeriod(weeklyPnl, 5)
  const monthlyAnnualizedPct = annualizePnlForPeriod(monthlyPnl, 21)

  const annualizedReturnPctServer = numOrNull(realizedMetrics?.annualized_return_pct)
  const avgDailyRealizedPnlServer = numOrNull(realizedMetrics?.avg_daily_realized_pnl)
  const realizedTradeDaysServer = numOrNull(realizedMetrics?.realized_trade_days)
  const elapsedDaysServer = numOrNull(realizedMetrics?.elapsed_days)
  const realizedPnlSumServer = numOrNull(realizedMetrics?.realized_pnl_sum)
  const totalDepositedServer = numOrNull(realizedMetrics?.total_deposited)
  const elapsedTradingDaysServer = numOrNull(realizedMetrics?.elapsed_trading_days) ?? elapsedDaysServer

  const realizedTradeLog = useMemo(() => {
    const ordered = [...(allTrades ?? [])]
      .map((t, i) => {
        const ts = parsePointDate(t.created_at)
        return { t, i, ts }
      })
      .filter(row => row.ts)
      .sort((a, b) => {
        const diff = a.ts - b.ts
        return diff !== 0 ? diff : a.i - b.i
      })

    const rawRows = ordered.map(({ t, i, ts }) => ({
      id: t.id ?? `ov-${i}`,
      symbol: t.symbol,
      side: t.side,
      status: t.status,
      shares: t.quantity,
      price: t.price,
      pnl: t.pnl,
      date: ts.toISOString(),
      ts: ts.getTime(),
    }))

    return backfillTradeAvgPrice(rawRows)
      .map((row) => {
        const symbol = String(row.symbol ?? '').trim().toUpperCase()
        const status = String(row.status ?? '').toUpperCase()
        const side = String(row.side ?? '').toUpperCase()
        const explicit = getVisibleTradePnl(row)
        let derived = null
        if (status === 'FILLED' && side === 'SELL') {
          const avg = Number(row.avgPrice)
          const qty = Number(row.shares)
          const px = Number(row.price)
          if (Number.isFinite(avg) && avg > 0 && Number.isFinite(qty) && qty > 0 && Number.isFinite(px) && px > 0) {
            derived = (px - avg) * qty
          }
        }
        if (!isSimulated && Number.isFinite(explicit) && Math.abs(explicit) < 1e-9 && Number.isFinite(derived)) {
          return { symbol, pnl: derived, date: parsePointDate(row.date) }
        }
        if (Number.isFinite(explicit)) {
          return { symbol, pnl: explicit, date: parsePointDate(row.date) }
        }
        if (Number.isFinite(derived)) {
          return { symbol, pnl: derived, date: parsePointDate(row.date) }
        }
        return null
      })
      .filter(v => v && v.date)
  }, [allTrades, isSimulated])
  const ibChartDerived = useMemo(() => {
    if (isSimulated) {
      return {
        cumulative: [],
        dailyVolume: [],
        symbolPnl: [],
        winLoss: null,
        totalTrades: 0,
        dailyPnl: null,
        weeklyPnl: null,
        monthlyPnl: null,
        maxGain: 0,
        maxDrawdown: 0,
      }
    }

    const toKey = (dt) => {
      const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate())
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const dayPnlMap = new Map()
    const symbolPnlMap = new Map()
    let wins = 0
    let losses = 0
    let breakeven = 0

    for (const row of realizedTradeLog) {
      const key = toKey(row.date)
      dayPnlMap.set(key, (dayPnlMap.get(key) ?? 0) + Number(row.pnl ?? 0))
      const symbol = String(row.symbol ?? '').trim().toUpperCase()
      if (symbol) symbolPnlMap.set(symbol, (symbolPnlMap.get(symbol) ?? 0) + Number(row.pnl ?? 0))
      if (row.pnl > 0) wins += 1
      else if (row.pnl < 0) losses += 1
      else breakeven += 1
    }

    const realizedBySymbolFromPositions = new Map()
    for (const pos of breakdownPositions ?? []) {
      const symbol = String(pos?.symbol ?? '').trim().toUpperCase()
      const realized = Number(pos?.realized_pnl ?? 0)
      if (!symbol || !Number.isFinite(realized)) continue
      realizedBySymbolFromPositions.set(symbol, (realizedBySymbolFromPositions.get(symbol) ?? 0) + realized)
    }
    const realizedTotalFromPositions = Array.from(realizedBySymbolFromPositions.values())
      .reduce((sum, value) => sum + Number(value ?? 0), 0)

    const cumulativeRaw = Array.from(dayPnlMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .reduce((acc, [key, pnl]) => {
        const prev = acc.length > 0 ? Number(acc[acc.length - 1].value ?? 0) : 0
        acc.push({ date: key, value: prev + Number(pnl ?? 0) })
        return acc
      }, [])
    const cumulative = (() => {
      if (cumulativeRaw.length === 0) return []
      const last = Number(cumulativeRaw[cumulativeRaw.length - 1]?.value ?? 0)
      const delta = Number(realizedTotalFromPositions ?? 0) - last
      if (!Number.isFinite(delta) || Math.abs(delta) <= 1e-9) return cumulativeRaw
      return cumulativeRaw.map((pt) => ({
        ...pt,
        value: Number((Number(pt.value ?? 0) + delta).toFixed(4)),
      }))
    })()

    const dailyVolumeMap = new Map()
    for (const trade of allTrades ?? []) {
      const status = String(trade?.status ?? '').toUpperCase()
      if (status !== 'FILLED') continue
      const side = String(trade?.side ?? '').toLowerCase()
      if (side !== 'buy' && side !== 'sell') continue
      const ts = parsePointDate(trade?.created_at)
      if (!ts) continue
      const total = Number(trade?.total)
      const qty = Number(trade?.quantity)
      const price = Number(trade?.price)
      const amount = Number.isFinite(total) && total > 0
        ? total
        : ((Number.isFinite(qty) && Number.isFinite(price) && qty > 0 && price > 0) ? qty * price : 0)
      if (amount <= 0) continue
      const key = toKey(ts)
      if (!dailyVolumeMap.has(key)) dailyVolumeMap.set(key, { date: key, buy: 0, sell: 0 })
      dailyVolumeMap.get(key)[side] += amount
    }
    const dailyVolume = Array.from(dailyVolumeMap.values()).sort((a, b) => a.date.localeCompare(b.date))

    const symbolPnl = Array.from(realizedBySymbolFromPositions.entries())
      .map(([symbol, value]) => ({ symbol, realized_pnl: Number(value ?? 0) }))
      .sort((a, b) => b.realized_pnl - a.realized_pnl)

    const todayKey = toKey(todayStart)
    const weekStartKey = toKey(weekStart)
    const monthStartKey = toKey(monthStart)
    let dailyPnlValue = null
    let weeklyPnlValue = null
    let monthlyPnlValue = null
    if (dayPnlMap.size > 0) {
      dailyPnlValue = Number(dayPnlMap.get(todayKey) ?? 0)
      weeklyPnlValue = 0
      monthlyPnlValue = 0
      for (const [key, pnl] of dayPnlMap.entries()) {
        if (key >= weekStartKey) weeklyPnlValue += Number(pnl ?? 0)
        if (key >= monthStartKey) monthlyPnlValue += Number(pnl ?? 0)
      }
    }

    let maxGainValue = 0
    let maxDrawdownValue = 0
    if (cumulative.length > 0) {
      let peak = Number(cumulative[0].value ?? 0)
      for (const pt of cumulative) {
        const value = Number(pt.value ?? 0)
        if (value > maxGainValue) maxGainValue = value
        if (value > peak) peak = value
        const drawdown = peak - value
        if (drawdown > maxDrawdownValue) maxDrawdownValue = drawdown
      }
    }

    return {
      cumulative,
      dailyVolume,
      symbolPnl,
      winLoss: { wins, losses, breakeven },
      totalTrades: realizedTradeLog.length,
      dailyPnl: dailyPnlValue,
      weeklyPnl: weeklyPnlValue,
      monthlyPnl: monthlyPnlValue,
      maxGain: maxGainValue,
      maxDrawdown: maxDrawdownValue,
    }
  }, [isSimulated, realizedTradeLog, allTrades, parsePointDate, todayStart, weekStart, monthStart, breakdownPositions])
  const realizedTradeDaysFallback = new Set(realizedTradeLog.map(t => t.date.toISOString().slice(0, 10))).size
  const realizedPnlSumFallback = realizedTradeLog.reduce((sum, t) => sum + t.pnl, 0)
  const firstRealizedDateFallback = realizedTradeLog.length > 0 ? realizedTradeLog[0].date : null
  const nthWeekdayOfMonth = (year, month, weekday, n) => {
    const d = new Date(year, month - 1, 1)
    while (d.getDay() !== weekday) d.setDate(d.getDate() + 1)
    d.setDate(d.getDate() + (n - 1) * 7)
    return d
  }
  const lastWeekdayOfMonth = (year, month, weekday) => {
    const d = new Date(year, month, 0)
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
    return d
  }
  const observedHoliday = (d) => {
    const x = new Date(d)
    const day = x.getDay()
    if (day === 6) x.setDate(x.getDate() - 1)
    else if (day === 0) x.setDate(x.getDate() + 1)
    return x
  }
  const easterSunday = (year) => {
    const a = year % 19
    const b = Math.floor(year / 100)
    const c = year % 100
    const d = Math.floor(b / 4)
    const e = b % 4
    const f = Math.floor((b + 8) / 25)
    const g = Math.floor((b - f + 1) / 3)
    const h = (19 * a + b - d - g + 15) % 30
    const i = Math.floor(c / 4)
    const k = c % 4
    const l = (32 + 2 * e + 2 * i - h - k) % 7
    const m = Math.floor((a + 11 * h + 22 * l) / 451)
    const month = Math.floor((h + l - 7 * m + 114) / 31)
    const day = ((h + l - 7 * m + 114) % 31) + 1
    return new Date(year, month - 1, day)
  }
  const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const nyseHolidays = (year) => {
    const set = new Set()
    const addObserved = (d) => {
      const o = observedHoliday(d)
      if (o.getFullYear() === year) set.add(dateKey(o))
    }
    addObserved(new Date(year, 0, 1))
    addObserved(new Date(year + 1, 0, 1))
    set.add(dateKey(nthWeekdayOfMonth(year, 1, 1, 3)))
    set.add(dateKey(nthWeekdayOfMonth(year, 2, 1, 3)))
    const goodFriday = easterSunday(year)
    goodFriday.setDate(goodFriday.getDate() - 2)
    set.add(dateKey(goodFriday))
    set.add(dateKey(lastWeekdayOfMonth(year, 5, 1)))
    if (year >= 2022) addObserved(new Date(year, 5, 19))
    addObserved(new Date(year, 6, 4))
    set.add(dateKey(nthWeekdayOfMonth(year, 9, 1, 1)))
    set.add(dateKey(nthWeekdayOfMonth(year, 11, 4, 4)))
    addObserved(new Date(year, 11, 25))
    return set
  }
  const isNyseTradingDay = (d) => {
    const day = d.getDay()
    if (day === 0 || day === 6) return false
    return !nyseHolidays(d.getFullYear()).has(dateKey(d))
  }
  const countNyseTradingDays = (startDate, endDate) => {
    if (!startDate || !endDate) return 0
    const start = new Date(startDate)
    const end = new Date(endDate)
    start.setHours(0, 0, 0, 0)
    end.setHours(0, 0, 0, 0)
    if (end < start) return 0
    let days = 0
    const cursor = new Date(start)
    while (cursor <= end) {
      if (isNyseTradingDay(cursor)) days += 1
      cursor.setDate(cursor.getDate() + 1)
    }
    return days
  }
  const elapsedTradingDaysFallback = firstRealizedDateFallback
    ? Math.max(1, countNyseTradingDays(firstRealizedDateFallback, new Date()))
    : null
  const annualizationCapitalBase = (() => {
    const candidates = [
      totalDepositedServer,
      performanceBase,
    ]
    for (const v of candidates) {
      if (v != null && v > 0) return v
    }
    return null
  })()

  const annualizedReturnPctFromMetrics = (
    annualizedReturnPctServer == null
    && elapsedTradingDaysServer != null
    && annualizationCapitalBase != null
    && realizedPnlSumServer != null
    && (realizedPnlSumServer / annualizationCapitalBase) > -1
  )
    ? ((Math.pow(1 + (realizedPnlSumServer / annualizationCapitalBase), 252 / elapsedTradingDaysServer) - 1) * 100)
    : null

  const annualizedReturnPctFallback = (
    elapsedTradingDaysFallback != null
    && annualizationCapitalBase != null
    && (realizedPnlSumFallback / annualizationCapitalBase) > -1
  )
    ? ((Math.pow(1 + (realizedPnlSumFallback / annualizationCapitalBase), 252 / elapsedTradingDaysFallback) - 1) * 100)
    : null
  const avgDailyRealizedPnlFallback = realizedTradeDaysFallback > 0 ? (realizedPnlSumFallback / realizedTradeDaysFallback) : null

  const annualizedReturnPct = annualizedReturnPctServer ?? annualizedReturnPctFromMetrics ?? annualizedReturnPctFallback
  const annualizedReturnSource = annualizedReturnPctServer != null
    ? 'server'
    : annualizedReturnPctFromMetrics != null
    ? 'server-recomputed'
    : annualizedReturnPctFallback != null
    ? 'trade-log-fallback'
    : 'unavailable'
  const avgDailyRealizedPnl = avgDailyRealizedPnlServer ?? avgDailyRealizedPnlFallback
  const realizedTradeDays = realizedTradeDaysServer ?? realizedTradeDaysFallback
  const elapsedDays = elapsedTradingDaysServer ?? elapsedTradingDaysFallback
  let breakdownRealizedTotal = 0
  let breakdownMarketValueTotal = 0
  let breakdownUnrealizedTotal = 0
  for (const pos of breakdownPositions) {
    const symbol = String(pos.symbol ?? '').trim().toUpperCase()
    const stored = Number(pos.realized_pnl ?? 0)
    const realized = stored
    if (Number.isFinite(realized)) breakdownRealizedTotal += realized

    const shares = Number(pos._effShares ?? 0)
    const avgCost = Number(pos._effAvgCost ?? 0)
    const mp = Number(resolveMarketPrice(pos, quotes[pos.symbol]))
    if (!Number.isFinite(shares) || shares === 0 || !Number.isFinite(mp)) continue
    const mv = shares * mp
    if (Number.isFinite(mv)) breakdownMarketValueTotal += mv
    const unreal = (mp - avgCost) * shares
    if (Number.isFinite(unreal)) breakdownUnrealizedTotal += unreal
  }
  const footerRealizedValue = isSimulated
    ? totalRealizedPnl
    : breakdownRealizedTotal
  const footerMarketValue = isSimulated ? totalEquity : breakdownMarketValueTotal
  const footerUnrealizedValue = isSimulated
    ? headlineUnrealized
    : breakdownUnrealizedTotal
  const footerRealizedPct = isSimulated
    ? realizedPnlPct
    : (footerMarketValue > 0 ? (footerRealizedValue / footerMarketValue) * 100 : null)
  const footerUnrealizedPct = footerMarketValue > 0 ? (footerUnrealizedValue / footerMarketValue) * 100 : null
  const topEquityValue = isSimulated ? totalEquity : footerMarketValue
  const topUnrealizedValue = isSimulated ? headlineUnrealized : footerUnrealizedValue
  const topRealizedValue = isSimulated ? headlineRealized : footerRealizedValue
  const topUnrealizedPct = topEquityValue > 0 ? (topUnrealizedValue / topEquityValue) * 100 : null
  const topRealizedPct = isSimulated
    ? realizedPnlPct
    : (topEquityValue > 0 ? (topRealizedValue / topEquityValue) * 100 : null)
  const simulatedCurveExtremes = useMemo(() => {
    let maxGainValue = 0
    let maxDrawdownValue = 0
    if (analytics?.cumulative_pnl?.length > 0) {
      let peak = Number(analytics.cumulative_pnl[0]?.value ?? 0)
      for (const pt of analytics.cumulative_pnl) {
        const value = Number(pt?.value ?? 0)
        if (value > maxGainValue) maxGainValue = value
        if (value > peak) peak = value
        const drawdown = peak - value
        if (drawdown > maxDrawdownValue) maxDrawdownValue = drawdown
      }
    }
    return { maxGain: maxGainValue, maxDrawdown: maxDrawdownValue }
  }, [analytics?.cumulative_pnl])

  const displayEquity = isSimulated ? totalEquity : footerMarketValue
  const displayUnrealized = isSimulated ? headlineUnrealized : footerUnrealizedValue
  const displayRealized = isSimulated ? headlineRealized : footerRealizedValue
  // Keep period cards on one coherent source: realized-metrics first, then chart fallback.
  const effectiveDailyPnl = dailyPnl ?? (isSimulated ? null : ibChartDerived.dailyPnl)
  const effectiveWeeklyPnl = weeklyPnl ?? (isSimulated ? null : ibChartDerived.weeklyPnl)
  const effectiveMonthlyPnl = monthlyPnl ?? (isSimulated ? null : ibChartDerived.monthlyPnl)
  const effectiveDailyPnlPct = (performanceBase > 0 && effectiveDailyPnl != null) ? (effectiveDailyPnl / performanceBase) * 100 : null
  const effectiveWeeklyPnlPct = (performanceBase > 0 && effectiveWeeklyPnl != null) ? (effectiveWeeklyPnl / performanceBase) * 100 : null
  const effectiveMonthlyPnlPct = (performanceBase > 0 && effectiveMonthlyPnl != null) ? (effectiveMonthlyPnl / performanceBase) * 100 : null
  const effectiveDailyAnnualizedPct = annualizePnlForPeriod(effectiveDailyPnl, 1)
  const effectiveWeeklyAnnualizedPct = annualizePnlForPeriod(effectiveWeeklyPnl, 5)
  const effectiveMonthlyAnnualizedPct = annualizePnlForPeriod(effectiveMonthlyPnl, 21)
  const displayAvgDailyRealizedPnl = avgDailyRealizedPnl
  const displayRealizedTradeDays = realizedTradeDays
  const displayAnnualizedReturnSource = annualizedReturnSource
  const displayElapsedDays = elapsedDays
  const displayAnnualizedReturnPct = (
    displayElapsedDays != null
    && displayElapsedDays >= 5
    && annualizedReturnPct != null
  )
    ? annualizedReturnPct
    : null
  const effectiveMaxGain = isSimulated ? simulatedCurveExtremes.maxGain : ibChartDerived.maxGain
  const effectiveMaxDrawdown = isSimulated ? simulatedCurveExtremes.maxDrawdown : ibChartDerived.maxDrawdown
  const effectiveMaxGainPct = performanceBase > 0 ? (effectiveMaxGain / performanceBase) * 100 : null
  const effectiveMaxDrawdownPct = performanceBase > 0 ? (effectiveMaxDrawdown / performanceBase) * 100 : null
  const chartCumulative = isSimulated ? (analytics?.cumulative_pnl ?? []) : ibChartDerived.cumulative
  const chartDailyVolume = isSimulated ? (analytics?.daily_volume ?? []) : ibChartDerived.dailyVolume
  const chartSymbolPnl = isSimulated ? (analytics?.symbol_pnl ?? []) : ibChartDerived.symbolPnl
  const winLossByPeriod = useMemo(() => {
    const mk = () => ({ wins: 0, losses: 0, breakeven: 0 })
    const buckets = {
      daily: mk(),
      weekly: mk(),
      monthly: mk(),
      overall: mk(),
    }

    for (const row of realizedTradeLog ?? []) {
      if (!(row?.date instanceof Date) || Number.isNaN(row.date.getTime())) continue
      const pnl = Number(row?.pnl)
      if (!Number.isFinite(pnl)) continue

      const bump = (bucket) => {
        if (pnl > 0) bucket.wins += 1
        else if (pnl < 0) bucket.losses += 1
        else bucket.breakeven += 1
      }

      bump(buckets.overall)
      if (row.date >= todayStart) bump(buckets.daily)
      if (row.date >= weekStart) bump(buckets.weekly)
      if (row.date >= monthStart) bump(buckets.monthly)
    }

    return buckets
  }, [realizedTradeLog, todayStart, weekStart, monthStart])
  const chartTotalTrades = isSimulated ? Number(analytics?.total_trades ?? 0) : Number(ibChartDerived.totalTrades ?? 0)
  const chartLatestCumulative = chartCumulative.length > 0 ? Number(chartCumulative[chartCumulative.length - 1]?.value ?? 0) : 0

  useEffect(() => {
    if (!gainLossChartRef.current) return undefined

    const updateWidth = () => {
      const next = Math.floor(gainLossChartRef.current?.clientWidth ?? 0)
      setGainLossChartWidth(prev => (prev !== next ? next : prev))
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(gainLossChartRef.current)
    window.addEventListener('resize', updateWidth)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [analytics?.total_trades, analytics?.cumulative_pnl?.length])

  const gainLossSeries = useMemo(() => {
    const dailyMap = new Map()

    for (const trade of realizedTradeLog) {
      const key = dateKey(trade.date)
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + trade.pnl)
    }

    if (dailyMap.size === 0 && isSimulated && analytics?.cumulative_pnl?.length > 1) {
      for (let i = 1; i < analytics.cumulative_pnl.length; i++) {
        const current = analytics.cumulative_pnl[i]
        const previous = analytics.cumulative_pnl[i - 1]
        const dt = parsePointDate(current.date)
        if (!dt) continue
        const key = dateKey(dt)
        const diff = Number(current.value ?? 0) - Number(previous.value ?? 0)
        dailyMap.set(key, (dailyMap.get(key) ?? 0) + diff)
      }
    }

    const baseDaily = Array.from(dailyMap.entries())
      .map(([key, value]) => ({
        key,
        start: new Date(`${key}T00:00:00`),
        end: new Date(`${key}T00:00:00`),
        value,
      }))
      .sort((a, b) => a.start - b.start)

    if (baseDaily.length === 0) {
      return { granularity: 'day', data: [] }
    }

    const startOfWeek = (date) => {
      const d = new Date(date)
      d.setHours(0, 0, 0, 0)
      const day = d.getDay()
      const shift = day === 0 ? -6 : 1 - day
      d.setDate(d.getDate() + shift)
      return d
    }

    const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1)
    const startOfQuarter = (date) => new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1)
    const startOfYear = (date) => new Date(date.getFullYear(), 0, 1)

    const formatDate = (date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

    const buildBuckets = (unit) => {
      const buckets = new Map()
      for (const row of baseDaily) {
        let bucketStart = row.start
        if (unit === 'week') bucketStart = startOfWeek(row.start)
        else if (unit === 'month') bucketStart = startOfMonth(row.start)
        else if (unit === 'quarter') bucketStart = startOfQuarter(row.start)
        else if (unit === 'year') bucketStart = startOfYear(row.start)

        const bucketKey = dateKey(bucketStart)
        const existing = buckets.get(bucketKey)
        if (existing) {
          existing.value += row.value
          if (row.start > existing.end) existing.end = row.start
        } else {
          buckets.set(bucketKey, {
            key: bucketKey,
            start: bucketStart,
            end: row.start,
            value: row.value,
          })
        }
      }

      return Array.from(buckets.values())
        .sort((a, b) => a.start - b.start)
        .map((bucket) => {
          let label = formatDate(bucket.start)
          if (unit === 'week') label = `Wk ${formatDate(bucket.start)}`
          else if (unit === 'month') label = bucket.start.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
          else if (unit === 'quarter') label = `Q${Math.floor(bucket.start.getMonth() / 3) + 1} ${bucket.start.getFullYear()}`
          else if (unit === 'year') label = String(bucket.start.getFullYear())

          return {
            ...bucket,
            label,
            tooltipLabel: unit === 'day'
              ? formatDate(bucket.start)
              : `${formatDate(bucket.start)} - ${formatDate(bucket.end)}`,
          }
        })
    }

    const units = ['day', 'week', 'month', 'quarter', 'year']
    const fallbackWidth = 640
    const usableWidth = Math.max(1, (gainLossChartWidth > 0 ? gainLossChartWidth : fallbackWidth) - 24)
    const minBarWidth = 5

    let chosen = units[units.length - 1]
    let chosenData = buildBuckets(chosen)
    for (const unit of units) {
      const data = buildBuckets(unit)
      const estimatedBarWidth = data.length > 0 ? usableWidth / data.length : usableWidth
      chosen = unit
      chosenData = data
      if (estimatedBarWidth >= minBarWidth || unit === units[units.length - 1]) break
    }

    return { granularity: chosen, data: chosenData }
  }, [analytics?.cumulative_pnl, dateKey, gainLossChartWidth, parsePointDate, realizedTradeLog, isSimulated])

  const marketShareData = effectivePieData.map((entry, i) => ({
    ...entry,
    fill: PIE_COLORS[i % PIE_COLORS.length],
  }))

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <HomeIcon className="h-6 w-6 text-slate-400" />
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Portfolio Overview</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {ibMode === 'live' ? 'Live IB account' : ibMode === 'paper' ? 'Paper IB account' : 'Simulated portfolio'}
          </p>
        </div>
      </div>

      {/* Top stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">{isSimulated ? 'Total Funds' : (usingPaperCapBase ? 'Allocation Cap (Paper)' : 'Net Liquidation')}</div>
          <div className="text-xl font-bold text-slate-100">{fmtMoney(accountData?.total_funds)}</div>
          <div className="text-xs text-slate-500 mt-0.5">Available: <span className="text-emerald-400">{fmtMoney(accountData?.available_funds)}</span></div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">{isSimulated ? 'Total Deposited' : 'Buying Power'}</div>
          <div className="text-xl font-bold text-slate-100">{fmtMoney(isSimulated ? totalDeposited : ibBuyingPower)}</div>
          <div className="text-xs text-slate-500 mt-0.5">{isSimulated ? 'Net deposits less withdrawals' : `Cash Value: ${fmtMoney(ibCashValue)}`}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">{isSimulated ? 'Portfolio Equity' : 'Gross Position Value'}</div>
          <div className="text-xl font-bold text-slate-100">{fmtMoney(displayEquity)}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {isSimulated
              ? effectivePositions.filter(p => Number(p._effShares) > 0).length
              : (ibPositions ?? []).filter(p => Math.abs(Number(p?.quantity ?? 0)) > 0).length
            } positions held
          </div>
        </div>
        <div className={`card ${displayUnrealized >= 0 ? 'border-emerald-700/20' : 'border-red-700/20'}`}>
          <div className="text-xs text-slate-500 mb-1">Unrealised P&amp;L</div>
          <div className={`text-xl font-bold ${displayUnrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(displayUnrealized)}</div>
          {displayEquity > 0 && (
            <div className="text-xs text-slate-500 mt-0.5">{((displayUnrealized / displayEquity) * 100).toFixed(2)}% of equity</div>
          )}
        </div>
        <div className={`card ${displayRealized != null && displayRealized >= 0 ? 'border-emerald-700/20' : displayRealized != null ? 'border-red-700/20' : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Realised P&amp;L (Cumulative)</div>
          <div className={`text-xl font-bold ${displayRealized == null ? 'text-slate-400' : displayRealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{displayRealized == null ? '—' : fmt(displayRealized)}</div>
          <div className="text-xs text-slate-500 mt-0.5">{topRealizedPct == null ? '—' : `${topRealizedPct.toFixed(2)}% of ${performanceBaseLabel}`}</div>
        </div>
      </div>

      {/* Secondary stat cards: performance metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div className={`card ${effectiveMaxGain > 0 ? 'border-emerald-700/20' : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Max Gain</div>
          <div className={`text-xl font-bold ${effectiveMaxGain > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{effectiveMaxGain > 0 ? fmt(effectiveMaxGain) : '—'}</div>
          <div className="text-xs text-slate-500 mt-0.5">{effectiveMaxGainPct != null && effectiveMaxGain > 0 ? `${effectiveMaxGainPct.toFixed(2)}% of ${performanceBaseLabel}` : 'No realised trades yet'}</div>
        </div>
        <div className={`card ${effectiveMaxDrawdown > 0 ? 'border-red-700/20' : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Max Drawdown</div>
          <div className={`text-xl font-bold ${effectiveMaxDrawdown > 0 ? 'text-red-400' : 'text-slate-400'}`}>{effectiveMaxDrawdown > 0 ? fmt(-effectiveMaxDrawdown) : '—'}</div>
          <div className="text-xs text-slate-500 mt-0.5">{effectiveMaxDrawdownPct != null && effectiveMaxDrawdown > 0 ? `${effectiveMaxDrawdownPct.toFixed(2)}% of ${performanceBaseLabel}` : 'No drawdown recorded'}</div>
        </div>
        <div className={`card ${displayAvgDailyRealizedPnl != null ? (displayAvgDailyRealizedPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Avg Daily Realised</div>
          <div className={`text-xl font-bold ${displayAvgDailyRealizedPnl == null ? 'text-slate-400' : displayAvgDailyRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {displayAvgDailyRealizedPnl == null ? '—' : fmt(displayAvgDailyRealizedPnl)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {displayRealizedTradeDays > 0 ? `${displayRealizedTradeDays} realised trade day${displayRealizedTradeDays !== 1 ? 's' : ''}` : 'No realised history yet'}
          </div>
        </div>
      </div>

      {/* Tertiary stat cards: period and long-horizon performance */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`card ${effectiveDailyPnl != null && effectiveDailyPnl !== 0 ? (effectiveDailyPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Today&apos;s Realised P&amp;L</div>
          <div className="flex items-baseline justify-between gap-3">
            <div className={`text-xl font-bold ${effectiveDailyPnl == null ? 'text-slate-400' : effectiveDailyPnl > 0 ? 'text-emerald-400' : effectiveDailyPnl < 0 ? 'text-red-400' : 'text-slate-400'}`}>
              {effectiveDailyPnl == null ? '—' : fmt(effectiveDailyPnl)}
            </div>
            <div className={`text-sm font-semibold ${effectiveDailyAnnualizedPct == null ? 'text-slate-500' : effectiveDailyAnnualizedPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {effectiveDailyAnnualizedPct == null ? '—' : `${effectiveDailyAnnualizedPct >= 0 ? '+' : ''}${effectiveDailyAnnualizedPct.toFixed(2)}%`}
            </div>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {effectiveDailyPnlPct != null ? `${effectiveDailyPnlPct >= 0 ? '+' : ''}${effectiveDailyPnlPct.toFixed(2)}% of ${performanceBaseLabel} · ann.` : 'No realised trades yet'}
          </div>
        </div>

        <div className={`card ${effectiveWeeklyPnl != null && effectiveWeeklyPnl !== 0 ? (effectiveWeeklyPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">This Week&apos;s P&amp;L</div>
          <div className="flex items-baseline justify-between gap-3">
            <div className={`text-xl font-bold ${effectiveWeeklyPnl == null ? 'text-slate-400' : effectiveWeeklyPnl > 0 ? 'text-emerald-400' : effectiveWeeklyPnl < 0 ? 'text-red-400' : 'text-slate-400'}`}>
              {effectiveWeeklyPnl == null ? '—' : fmt(effectiveWeeklyPnl)}
            </div>
            <div className={`text-sm font-semibold ${effectiveWeeklyAnnualizedPct == null ? 'text-slate-500' : effectiveWeeklyAnnualizedPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {effectiveWeeklyAnnualizedPct == null ? '—' : `${effectiveWeeklyAnnualizedPct >= 0 ? '+' : ''}${effectiveWeeklyAnnualizedPct.toFixed(2)}%`}
            </div>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {effectiveWeeklyPnlPct != null ? `${effectiveWeeklyPnlPct >= 0 ? '+' : ''}${effectiveWeeklyPnlPct.toFixed(2)}% of ${performanceBaseLabel} · ann.` : 'No realised trades yet'}
          </div>
        </div>

        <div className={`card ${effectiveMonthlyPnl != null && effectiveMonthlyPnl !== 0 ? (effectiveMonthlyPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Month-to-Date P&amp;L</div>
          <div className="flex items-baseline justify-between gap-3">
            <div className={`text-xl font-bold ${effectiveMonthlyPnl == null ? 'text-slate-400' : effectiveMonthlyPnl > 0 ? 'text-emerald-400' : effectiveMonthlyPnl < 0 ? 'text-red-400' : 'text-slate-400'}`}>
              {effectiveMonthlyPnl == null ? '—' : fmt(effectiveMonthlyPnl)}
            </div>
            <div className={`text-sm font-semibold ${effectiveMonthlyAnnualizedPct == null ? 'text-slate-500' : effectiveMonthlyAnnualizedPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {effectiveMonthlyAnnualizedPct == null ? '—' : `${effectiveMonthlyAnnualizedPct >= 0 ? '+' : ''}${effectiveMonthlyAnnualizedPct.toFixed(2)}%`}
            </div>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {effectiveMonthlyPnlPct != null ? `${effectiveMonthlyPnlPct >= 0 ? '+' : ''}${effectiveMonthlyPnlPct.toFixed(2)}% of ${performanceBaseLabel} · ann.` : 'No realised trades yet'}
          </div>
        </div>

        <div
          className={`card ${displayAnnualizedReturnPct != null ? (displayAnnualizedReturnPct >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}
          title={`Annualized return source: ${displayAnnualizedReturnSource}`}
        >
          <div className="text-xs text-slate-500 mb-1">Annualized Return</div>
          <div className={`text-xl font-bold ${displayAnnualizedReturnPct == null ? 'text-slate-400' : displayAnnualizedReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {displayAnnualizedReturnPct == null ? '—' : `${displayAnnualizedReturnPct >= 0 ? '+' : ''}${displayAnnualizedReturnPct.toFixed(2)}%`}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {displayElapsedDays == null
              ? 'No realised history yet'
              : displayElapsedDays < 5
              ? `${displayElapsedDays} trading day${displayElapsedDays !== 1 ? 's' : ''} (need 5+ for annualization)`
              : `${displayElapsedDays} trading day${displayElapsedDays !== 1 ? 's' : ''} from trade log`
            }
            {displayAnnualizedReturnPct != null && displayAnnualizedReturnSource !== 'unavailable' ? ` · ${displayAnnualizedReturnSource}` : ''}
          </div>
        </div>
      </div>

      {/* Per-position breakdown table */}
      {breakdownPositions.length > 0 ? (
        <div className="card">
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2">
              <TableCellsIcon className="h-4 w-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Position Breakdown</h2>
              </div>
              {positionsRefreshing && (
                <span className="text-[11px] text-slate-500 animate-pulse">Updating values...</span>
              )}
            </div>
            <div className="max-h-100 overflow-y-auto pr-1">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-dark-600">
                    <th className="text-left pb-2 font-medium">Symbol</th>
                    <th className="text-left pb-2 font-medium">Sentiment</th>
                    <th className="text-left pb-2 font-medium">Strategy</th>
                    <th className="text-right pb-2 font-medium">Limits</th>
                    <th className="text-right pb-2 font-medium">Shares</th>
                    <th className="text-right pb-2 font-medium">Avg Price</th>
                    <th className="text-right pb-2 font-medium">Current</th>
                    <th className="text-right pb-2 font-medium">Mkt Value</th>
                    <th className="text-right pb-2 font-medium">Cash</th>
                    <th className="text-right pb-2 font-medium">Alloc</th>
                    <th className="text-right pb-2 font-medium">Unrealised Gain</th>
                    <th className="text-right pb-2 font-medium">Realised Gain</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-700">
                  {breakdownPositions.map((pos, i) => {
                    const shares = Number(pos._effShares ?? 0)
                    const avgCost = Number(pos._effAvgCost ?? 0)
                    const q = quotes[pos.symbol]
                    const mp = resolveMarketPrice(pos, q)
                    const hasMarketPrice = Number.isFinite(Number(mp))
                    const mv = hasMarketPrice ? (Number(mp) * shares) : null
                    const costBasis = avgCost * shares
                    const pendingCost = Number(pos.pending_avg_cost ?? 0) * Number(pos.pending_shares ?? 0)
                    const cashRemaining = isSimulated
                      ? Math.max(0, Number(pos.allocated_funds ?? 0) - (avgCost * shares + pendingCost))
                      : null
                    const unreal = hasMarketPrice ? ((mv ?? 0) - costBasis) : null
                    const unrealPct = (unreal != null && Math.abs(costBasis) > 0) ? (unreal / Math.abs(costBasis)) * 100 : null
                    const storedRealized = Number(pos.realized_pnl ?? 0)
                    const realizedValue = storedRealized
                    const realizedPctBase = isSimulated ? Number(pos.total_invested ?? 0) : Math.abs(costBasis)
                    const realizedPct = realizedPctBase > 0.01 ? (realizedValue / realizedPctBase) * 100 : null
                    const pd = effectivePieData.find(d => d.symbol === pos.symbol)
                    const priceColor = priceColors[pos.symbol]
                    const aiTag = (pos.learner_tag || '—').toUpperCase()
                    const aiStyle = AI_TAG_CELL_STYLES[aiTag] ?? 'text-slate-500'
                    const upperLimit = fmtUpperLimit(pos)
                    const lowerLimit = fmtLowerLimit(managerSettings, accountData?.total_funds)
                    return (
                      <tr
                        key={pos.symbol}
                        className="hover:bg-dark-700/40 cursor-pointer transition-colors"
                        onClick={() => onSelectSymbol(pos.symbol)}
                      >
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                            <span className="font-bold text-slate-200 font-mono">{pos.symbol}</span>
                            <MiniSparkline symbol={pos.symbol} />
                          </div>
                          {q?.company_name && <div className="text-slate-600 truncate max-w-[100px] pl-4">{q.company_name}</div>}
                        </td>
                        <td className="py-2 pl-2">
                          <div className="leading-tight" title={pmScores[pos.symbol] ? `Score: ${pmScores[pos.symbol].score} — Updated: ${pmScores[pos.symbol].updated_at ? new Date(pmScores[pos.symbol].updated_at).toLocaleTimeString() : '?'}` : undefined}>
                            <div>
                              <span className="text-[11px] text-slate-500">PM: </span>
                              {pmScores[pos.symbol] ? (
                                <span className="text-xs font-semibold" style={{ color: classColor(pmScores[pos.symbol].classification) }}>
                                  {classLabel(pmScores[pos.symbol].classification)}
                                </span>
                              ) : managerSettings?.enabled ? (
                                <span className="inline-flex items-center gap-1 animate-pulse">
                                  <span className="inline-block w-10 h-2 rounded bg-slate-700" />
                                </span>
                              ) : (
                                <span className="text-xs text-slate-600">—</span>
                              )}
                            </div>
                            <div className="mt-0.5">
                              <span className="text-[11px] text-slate-500">AI: </span>
                              <span className={`text-xs font-semibold ${aiStyle}`}>{aiTag}</span>
                            </div>
                          </div>
                        </td>
                        <td className="py-2 pl-2">
                          {strategyDisplayLabel(pos, managerSettings, aiTag) !== '—' ? (
                            <span className="text-xs text-blue-400/80">{strategyDisplayLabel(pos, managerSettings, aiTag)}</span>
                          ) : (
                            <span className="text-xs text-slate-600">—</span>
                          )}
                        </td>
                        <td className="text-right py-2 pr-2">
                          <div className="font-mono text-[11px] leading-tight">
                            <div className="text-emerald-400">{upperLimit}</div>
                            <div className="text-amber-300">{lowerLimit}</div>
                          </div>
                        </td>
                        <td className="text-right text-slate-300 font-mono">{shares !== 0 ? shares.toFixed(3) : '—'}</td>
                        <td className="text-right text-slate-300 font-mono">{Math.abs(shares) > 0 ? fmtMoney(avgCost) : '—'}</td>
                        <td className={`text-right py-2 px-3 font-mono rounded transition-colors ${priceColor?.bgColor || ''} ${priceColor?.textColor || 'text-slate-200'}`}>
                          {hasMarketPrice ? fmtMoney(mp) : '—'}
                        </td>
                        <td className="text-right text-slate-200 font-mono">{shares !== 0 && mv != null ? fmtMoney(mv) : '—'}</td>
                        <td className="text-right text-blue-300 font-mono">{cashRemaining != null && cashRemaining > 0 ? fmtMoney(cashRemaining) : '—'}</td>
                        <td className="text-right text-slate-400">{pd ? `${pd.pct}%` : '—'}</td>
                        <td className={`text-right font-semibold font-mono ${(unreal ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {shares !== 0 && unreal != null
                            ? `${fmt(unreal)} (${unrealPct == null ? '—' : `${unrealPct >= 0 ? '+' : ''}${unrealPct.toFixed(2)}%`})`
                            : '—'}
                        </td>
                        <td className={`text-right font-semibold font-mono ${realizedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {`${fmt(realizedValue)} (${realizedPct == null ? '—' : `${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(2)}%`})`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-dark-500 text-slate-400 font-semibold">
                    <td className="pt-2">Total</td>
                    <td />
                    <td />
                    <td />
                    <td />
                    <td />
                    <td />
                    <td className="text-right pt-2 font-mono text-slate-200">{fmtMoney(footerMarketValue)}</td>
                    <td />
                    <td className="text-right pt-2">100%</td>
                    <td className={`text-right pt-2 font-mono ${footerUnrealizedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {`${fmt(footerUnrealizedValue)} (${footerUnrealizedPct != null ? `${footerUnrealizedPct >= 0 ? '+' : ''}${footerUnrealizedPct.toFixed(2)}%` : '—'})`}
                    </td>
                    <td className={`text-right pt-2 font-mono ${footerRealizedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {`${fmt(footerRealizedValue)} (${footerRealizedPct != null ? `${footerRealizedPct >= 0 ? '+' : ''}${footerRealizedPct.toFixed(2)}%` : '—'})`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-48 text-slate-600 text-sm gap-2">
          <ChartPieIcon className="h-10 w-10 text-slate-700" />
          Add stocks and purchase shares to see your portfolio breakdown.
        </div>
      )}

      {/* Portfolio Manager Summary */}
      {managerSettings && (
        <div className="card border border-violet-800/30 bg-violet-950/10">
          <div className="flex items-start justify-between gap-4 flex-wrap xl:flex-nowrap">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-violet-300">Portfolio Manager Summary</h3>
              <p className="text-xs text-slate-400 mt-1">
                Automatically rebalances idle capital, refreshes sentiment scores, and can deploy available cash based on your manager rules.
              </p>
              <div className="flex flex-wrap gap-2 mt-3 text-[11px] text-slate-300">
                <span className="px-2 py-0.5 rounded-md bg-dark-700 border border-dark-600">
                  Status: {(managerSettings.enabled ?? false) ? 'Enabled' : 'Disabled'}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-dark-700 border border-dark-600">
                  Reallocation: {(managerSettings.reallocation_enabled ?? true) ? 'On' : 'Off'}
                </span>
                <span className="px-2 py-0.5 rounded-md bg-dark-700 border border-dark-600">
                  Interval: {managerSettings.transfer_interval_s ?? 300}s
                </span>
              </div>
            </div>
            {onOpenManager && (
              <button
                className="text-xs border border-violet-700/50 text-violet-300 hover:bg-violet-900/20 rounded-lg px-3 py-1.5 transition-colors shrink-0"
                onClick={onOpenManager}
              >
                Open Manager
              </button>
            )}
            <div className="w-full xl:w-[54%] min-w-0 rounded-xl border border-violet-800/30 bg-dark-950/60 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-violet-200">Recent Activities</h4>
                <span className="text-[10px] text-slate-500">PM feed</span>
              </div>
              <div className="max-h-28 overflow-y-auto pr-1 space-y-1.5">
                {recentPmActivities.length > 0 ? (
                  recentPmActivities.map((entry, index) => (
                    <div key={`${entry?.at ?? 'activity'}-${index}`} className="rounded-lg border border-dark-700 bg-dark-900/70 px-2.5 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs text-slate-200 leading-snug break-words">{entry?.msg ?? '—'}</p>
                      </div>
                      <div className="mt-1 text-[10px] text-slate-500">
                        {entry?.at ? new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-dark-700 bg-dark-900/40 px-2.5 py-4 text-center text-xs text-slate-500">
                    No PM activity yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Allocation + Unrealised row */}
      {(effectivePieData.length > 0 || effectivePositions.some(p => p._effShares > 0)) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {effectivePieData.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-4">
                <ChartPieIcon className="h-4 w-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Allocation by Market Value</h2>
              </div>
              <div className="h-80 px-2 py-2">
                <ResponsiveContainer width="100%" height="100%">
                  <Treemap
                    data={marketShareData}
                    dataKey="market_value"
                    nameKey="symbol"
                    stroke="#0f172a"
                    fill="#334155"
                    content={({ x, y, width, height, index = 0, depth = 0, name, payload }) => {
                      if (depth === 0 || width <= 0 || height <= 0) return null
                      const bg = payload?.fill ?? PIE_COLORS[index % PIE_COLORS.length]
                      const fallbackByIndex = marketShareData[index]?.symbol
                      const symbol = String(
                        payload?.symbol
                        ?? payload?.name
                        ?? payload?.payload?.symbol
                        ?? payload?.payload?.name
                        ?? fallbackByIndex
                        ?? name
                        ?? ''
                      ).trim()
                      const pct = payload?.pct
                      const { text: labelText, fontSize } = fitTreemapLabel(symbol, width, height)
                      const showPct = width > 84 && height > 34
                      return (
                        <g>
                          <rect x={x} y={y} width={width} height={height} style={{ fill: bg, stroke: '#0f172a', strokeWidth: 1 }} />
                          {(width > 26 && height > 16) && (
                            <text
                              x={x + width / 2}
                              y={showPct ? y + (height * 0.42) : y + (height * 0.52)}
                              fill="#f8fafc"
                              fontSize={fontSize}
                              fontWeight={700}
                              textAnchor="middle"
                              dominantBaseline="middle"
                              style={{ paintOrder: 'stroke', stroke: 'rgba(15,23,42,0.75)', strokeWidth: 2 }}
                            >
                              {labelText}
                            </text>
                          )}
                          {showPct && pct != null && (
                            <text
                              x={x + width / 2}
                              y={y + (height * 0.68)}
                              fill="#e2e8f0"
                              fontSize={Math.max(9, Math.min(11, fontSize - 1))}
                              textAnchor="middle"
                              dominantBaseline="middle"
                              style={{ paintOrder: 'stroke', stroke: 'rgba(15,23,42,0.75)', strokeWidth: 1.5 }}
                            >
                              {pct}%
                            </text>
                          )}
                        </g>
                      )
                    }}
                  >
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                      labelStyle={{ color: '#94a3b8' }}
                      itemStyle={{ color: '#cbd5e1' }}
                      formatter={(value, _name, item) => [fmtMoney(Number(value ?? 0)), `${item?.payload?.symbol ?? item?.name ?? 'Position'} market value`]}
                    />
                  </Treemap>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {effectivePositions.some(p => p._effShares > 0) && (() => {
            const unrealData = effectivePositions
              .filter(p => Number(p._effShares ?? 0) > 0)
              .map(p => {
                const avgCost = Number(p._effAvgCost ?? 0)
                const shares = Number(p._effShares ?? 0)
                const mp = resolveMarketPrice(p, quotes[p.symbol])
                const unreal = (mp - avgCost) * shares
                return { symbol: p.symbol, value: parseFloat(unreal.toFixed(2)) }
              })
              .sort((a, b) => b.value - a.value)
            return (
              <div className="card">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Unrealised Gain / Loss by Position</div>
                <div style={{ height: Math.max(160, unrealData.length * 40 + 24) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={unrealData} layout="vertical" margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                      <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                        tickFormatter={v => `$${v >= 0 ? '+' : ''}${v.toFixed(0)}`} />
                      <YAxis type="category" dataKey="symbol" tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 600 }} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                        labelStyle={{ color: '#94a3b8' }}
                        formatter={(v) => [`$${v >= 0 ? '+' : ''}${v.toFixed(2)}`, 'Unrealised P&L']}
                      />
                      <Bar dataKey="value" name="Unrealised P&L" radius={[0, 3, 3, 0]} height="100%">
                        {unrealData.map(entry => (
                          <Cell key={entry.symbol} fill={entry.value >= 0 ? '#10b981' : '#ef4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Analytics Charts */}
      {chartTotalTrades > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Portfolio Performance Over Time</h2>

          {chartCumulative.length > 1 && (
            <div className="card">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Cumulative Realised P&amp;L</div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartCumulative} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartLatestCumulative >= 0 ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={chartLatestCumulative >= 0 ? '#10b981' : '#ef4444'} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                      interval="preserveStartEnd"
                      tickFormatter={v => v.length > 10 ? v.slice(5, 10) : v} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                      tickFormatter={v => `$${v >= 0 ? '+' : ''}${v.toFixed(0)}`} width={60} />
                    <Tooltip
                      contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                      labelStyle={{ color: '#94a3b8' }}
                      formatter={(v) => [`$${v >= 0 ? '+' : ''}${v.toFixed(2)}`, 'Cumulative P&L']}
                    />
                    <Area type="monotone" dataKey="value" stroke={chartLatestCumulative >= 0 ? '#10b981' : '#ef4444'} strokeWidth={2} fill="url(#pnlGrad)" dot={false} activeDot={{ r: 4, fill: chartLatestCumulative >= 0 ? '#10b981' : '#ef4444' }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {(chartDailyVolume.length > 0 || chartCumulative.length > 1) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {chartDailyVolume.length > 0 && (
                <div className="card">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Daily Trade Volume</div>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartDailyVolume} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                        <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                          tickFormatter={v => v.slice(5)} />
                        <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                          tickFormatter={v => `$${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)}`} width={54} />
                        <Tooltip
                          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                          labelStyle={{ color: '#94a3b8' }}
                          formatter={(v, name) => [`$${v.toFixed(2)}`, name.charAt(0).toUpperCase() + name.slice(1)]}
                        />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                        <Bar dataKey="buy" name="Buy" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="sell" name="Sell" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {gainLossSeries.data.length > 0 && (() => {
                const granularityTitle = {
                  day: 'Daily Gain / Loss',
                  week: 'Weekly Gain / Loss',
                  month: 'Monthly Gain / Loss',
                  quarter: 'Quarterly Gain / Loss',
                  year: 'Yearly Gain / Loss',
                }[gainLossSeries.granularity] ?? 'Gain / Loss'
                return (
                  <div className="card">
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">{granularityTitle}</div>
                    <div className="h-48" ref={gainLossChartRef}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={gainLossSeries.data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                          <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                            interval="preserveStartEnd" />
                          <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                            tickFormatter={v => `$${v >= 0 ? '+' : ''}${v >= 1000 || v <= -1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)}`} width={54} />
                          <Tooltip
                            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                            labelStyle={{ color: '#94a3b8' }}
                            labelFormatter={(_label, payload) => payload?.[0]?.payload?.tooltipLabel ?? _label}
                            formatter={(v) => [`$${v >= 0 ? '+' : ''}${v.toFixed(2)}`, `${gainLossSeries.granularity.charAt(0).toUpperCase()}${gainLossSeries.granularity.slice(1)} P&L`]}
                          />
                          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                            {gainLossSeries.data.map((entry, idx) => (
                              <Cell key={idx} fill={entry.value >= 0 ? '#10b981' : '#ef4444'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {chartSymbolPnl.length > 0 && (
              <div className="card">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Realised P&amp;L by Symbol</div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartSymbolPnl} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                      <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                        tickFormatter={v => `$${v.toFixed(0)}`} />
                      <YAxis type="category" dataKey="symbol" tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 600 }} tickLine={false} axisLine={false} width={46} />
                      <Tooltip
                        contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11, color: '#94a3b8' }}
                        formatter={(v) => [`$${v.toFixed(2)}`, 'Realised P&L']}
                      />
                      <Bar dataKey="realized_pnl" name="Realised P&L" radius={[0, 3, 3, 0]}>
                        {chartSymbolPnl.map((entry) => (
                          <Cell key={entry.symbol} fill={entry.realized_pnl >= 0 ? '#10b981' : '#ef4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {(() => {
              const periodRows = [
                { key: 'daily', label: 'Daily', data: winLossByPeriod.daily },
                { key: 'weekly', label: 'Weekly', data: winLossByPeriod.weekly },
                { key: 'monthly', label: 'Monthly', data: winLossByPeriod.monthly },
                { key: 'overall', label: 'Overall', data: winLossByPeriod.overall },
              ]
                .map((row) => {
                  const wl = row.data ?? { wins: 0, losses: 0, breakeven: 0 }
                  const total = Number(wl.wins || 0) + Number(wl.losses || 0) + Number(wl.breakeven || 0)
                  const winsPct = total > 0 ? (Number(wl.wins || 0) / total) * 100 : 0
                  const lossesPct = total > 0 ? (Number(wl.losses || 0) / total) * 100 : 0
                  const breakevenPct = total > 0 ? (Number(wl.breakeven || 0) / total) * 100 : 0
                  return {
                    ...row,
                    total,
                    winRate: total > 0 ? ((Number(wl.wins || 0) / total) * 100) : 0,
                    winsPct,
                    lossesPct,
                    breakevenPct,
                  }
                })

              if (!periodRows.some(row => row.total > 0)) return null

              return (
                <div className="card flex flex-col">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Win / Loss Ratio</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                    {periodRows.map((row) => (
                      <div key={row.key} className="rounded-xl border border-dark-600 bg-slate-950/40 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">{row.label}</div>
                          <div className="text-right">
                            <div className={`text-base font-bold ${row.winRate >= 50 ? 'text-emerald-400' : 'text-amber-300'}`}>{row.winRate.toFixed(1)}%</div>
                            <div className="text-[10px] text-slate-500">Win Rate</div>
                          </div>
                        </div>
                        <div className="mt-2 h-2.5 w-full overflow-hidden rounded bg-slate-800 border border-dark-600 flex">
                          {row.winsPct > 0 && <div className="h-full bg-emerald-500" style={{ width: `${row.winsPct}%` }} />}
                          {row.lossesPct > 0 && <div className="h-full bg-red-500" style={{ width: `${row.lossesPct}%` }} />}
                          {row.breakevenPct > 0 && <div className="h-full bg-slate-500" style={{ width: `${row.breakevenPct}%` }} />}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-400 grid grid-cols-3 gap-2">
                          <div>W <span className="text-emerald-400 font-semibold">{row.data.wins}</span></div>
                          <div>L <span className="text-red-400 font-semibold">{row.data.losses}</span></div>
                          <div>BE <span className="text-slate-300 font-semibold">{row.data.breakeven}</span></div>
                        </div>
                        <div className="mt-1 text-[10px] text-slate-500">{row.total} trade{row.total !== 1 ? 's' : ''}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* Activity Log */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <ClockIcon className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Activity Log</h2>
          {(() => {
            const total = activities
              .filter(a => a.type === 'trade' && (String(a.profile ?? 'simulated').toLowerCase() === activeProfile))
              .length + fundEvents.length
            return total > 0 && <span className="ml-auto text-xs text-slate-500">{total} event{total !== 1 ? 's' : ''}</span>
          })()}
        </div>
        {(() => {
          const rawTradeEntries = activities
            .filter(a => a.type === 'trade' && (String(a.profile ?? 'simulated').toLowerCase() === activeProfile))
            .map((a, i) => ({
            id: a.tradeId != null ? `t-${a.tradeId}` : `ta-${a.ts ?? 0}-${a.symbol ?? ''}-${a.side ?? ''}-${i}`,
            kind: 'trade',
            side: a.side,
            status: a.status,
            syncFromIb: a.syncFromIb === true,
            ts: a.ts,
            date: new Date(a.ts).toISOString(),
            symbol: a.symbol,
            shares: a.shares,
            price: a.price,
            marketValue: a.marketValue,
            label: a.label,
            strategy_name: a.strategy_name ?? null,
            total: (a.shares ?? 0) * (a.price ?? 0),
            pnl: a.pnl,
            reason: a.reason ?? a.sub ?? null,
          }))
          const tradeEntries = backfillTradeAvgPrice(rawTradeEntries).map((entry) => {
            const explicit = getVisibleTradePnl(entry)
            const isIbSnapshot = entry.syncFromIb === true && String(entry.reason ?? '').startsWith('Market Value:')
            if (isIbSnapshot) {
              return { ...entry, displayPnl: null }
            }

            const status = String(entry.status ?? '').toUpperCase()
            let derivedSellPnl = null
            if (entry.side === 'SELL' && status === 'FILLED') {
              const avg = Number(entry.avgPrice)
              const qty = Number(entry.shares)
              const mv = Number(entry.marketValue)
              const px = Number(entry.price)
              if (Number.isFinite(avg) && avg > 0 && Number.isFinite(qty) && qty !== 0) {
                if (Number.isFinite(mv) && mv !== 0) {
                  derivedSellPnl = mv - (avg * qty)
                } else if (Number.isFinite(px) && px > 0) {
                  derivedSellPnl = (px - avg) * qty
                }
              }
            }

            // IB endpoints can report explicit pnl=0 for a SELL even when the
            // realized value is available from trade price vs reconstructed avg.
            if (Number.isFinite(derivedSellPnl) && activeProfile !== 'simulated' && Number.isFinite(explicit) && Math.abs(explicit) < 1e-9) {
              return { ...entry, displayPnl: derivedSellPnl }
            }
            if (Number.isFinite(explicit)) {
              return { ...entry, displayPnl: explicit }
            }
            if (Number.isFinite(derivedSellPnl)) {
              return { ...entry, displayPnl: derivedSellPnl }
            }

            return { ...entry, displayPnl: null }
          })
          const fundEntries = fundEvents.map(e => ({
            id: `f-${e.id}`,
            kind: e.event_type,
            side: null,
            date: e.created_at,
            symbol: null,
            shares: null,
            price: null,
            label: `${e.event_type === 'deposit' ? 'Deposit' : 'Withdrawal'} $${Math.abs(e.amount).toFixed(2)}`,
            total: e.amount,
            pnl: null,
            reason: e.note ?? null,
          }))
          const all = [...tradeEntries, ...fundEntries].sort((a, b) => new Date(b.date) - new Date(a.date))
          if (all.length === 0) return (
            <div className="text-center text-slate-600 text-sm py-8">No activity yet</div>
          )
          const ACT_PAGE_SIZE = 25
          const totalPages = Math.max(1, Math.ceil(all.length / ACT_PAGE_SIZE))
          const safePage = Math.min(activityPage, totalPages - 1)
          const pageItems = all.slice(safePage * ACT_PAGE_SIZE, (safePage + 1) * ACT_PAGE_SIZE)
          return (
            <>
            <div className="overflow-x-auto pr-1">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-dark-800">
                  <tr className="text-slate-500 border-b border-dark-600">
                    <th className="w-36 text-left pb-2 font-medium">Time</th>
                    <th className="w-20 text-left pb-2 font-medium">Type</th>
                    <th className="w-20 text-left pb-2 font-medium">Details</th>
                    <th className="w-16 text-right pb-2 font-medium">Shares</th>
                    <th className="w-20 text-right pb-2 font-medium">Avg Price</th>
                    <th className="w-24 text-right pb-2 font-medium">Price</th>
                    <th className="w-20 text-right pb-2 font-medium">Amount</th>
                    <th className="w-16 text-right pb-2 font-medium">P&amp;L</th>
                    <th className="min-w-[360px] text-left pb-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-700">
                  {pageItems.map(entry => {
                    const ts = entry.date ? new Date(entry.date) : null
                    const tradeStatus = String(entry.status ?? '').toUpperCase()
                    const isFilledTrade = entry.kind === 'trade' && tradeStatus === 'FILLED'
                    const hasOrderPrice = entry.kind === 'trade' && Number.isFinite(Number(entry.price))
                    const rawReason = String(entry.reason ?? '').trim()
                    const noteText = (() => {
                      if (entry.kind !== 'trade') return rawReason || ''

                      const summary = []
                      if (tradeStatus) summary.push(tradeStatus)
                      if (entry.shares != null && entry.symbol) {
                        summary.push(`${Number(entry.shares).toFixed(3)} ${entry.symbol}`)
                      } else if (entry.symbol) {
                        summary.push(entry.symbol)
                      }
                      if (hasOrderPrice) {
                        summary.push(`${isFilledTrade ? 'fill' : 'order'} $${Number(entry.price).toFixed(2)}`)
                      }

                      const summaryText = summary.join(' · ')
                      if (!rawReason) return summaryText
                      if (!summaryText) return rawReason

                      const normalize = (text) => String(text ?? '')
                        .toLowerCase()
                        .replace(/[^a-z0-9.\s]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                      const normalizedReason = normalize(rawReason)
                      const dedupedSummary = summary.filter(part => {
                        const normalizedPart = normalize(part)
                        return normalizedPart && !normalizedReason.includes(normalizedPart)
                      })
                      if (dedupedSummary.length === 0) return rawReason
                      return `${dedupedSummary.join(' · ')} · ${rawReason}`
                    })()
                    // Use system/browser timezone (no timeZone option specified)
                    const timeStr = ts ? ts.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
                    return (
                      <tr key={entry.id} className="hover:bg-dark-700/40 transition-colors">
                        <td className="py-1.5 text-slate-500 whitespace-nowrap">{timeStr}</td>
                        <td className="py-1.5">
                          <div className="flex items-center gap-1">
                            {entry.kind === 'trade' ? (
                              entry.side === 'BUY'
                                ? <ArrowUpIcon className="h-3 w-3 text-emerald-400" />
                                : <ArrowDownIcon className="h-3 w-3 text-red-400" />
                            ) : (
                              <BanknotesIcon className={`h-3 w-3 ${entry.kind === 'deposit' ? 'text-blue-400' : 'text-amber-400'}`} />
                            )}
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              entry.kind === 'trade'
                                ? entry.side === 'BUY' ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/50 text-red-300'
                                : entry.kind === 'deposit' ? 'bg-blue-900/50 text-blue-300' : 'bg-amber-900/50 text-amber-300'
                            }`}>{entry.kind === 'trade' ? entry.side : entry.kind}</span>
                          </div>
                        </td>
                        <td className="py-1.5">
                          {entry.symbol ? (
                            <span
                              className="font-bold text-blue-400 font-mono cursor-pointer hover:text-blue-300"
                              onClick={() => onSelectSymbol(entry.symbol)}
                            >{entry.symbol}</span>
                          ) : (
                            <span className="text-slate-400">{entry.label}</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right font-mono text-slate-300">
                          {entry.shares != null ? Number(entry.shares).toFixed(3) : '—'}
                        </td>
                        <td className="py-1.5 text-right font-mono text-slate-300">
                          {entry.kind === 'trade' && entry.side === 'SELL' && !(entry.syncFromIb === true && String(entry.reason ?? '').startsWith('Market Value:')) && Number.isFinite(Number(entry.avgPrice)) && Number(entry.avgPrice) > 0
                            ? `$${Number(entry.avgPrice).toFixed(2)}`
                            : '—'}
                        </td>
                        <td className="py-1.5 text-right font-mono text-slate-300">
                          {isFilledTrade && hasOrderPrice
                            ? `$${Number(entry.price).toFixed(2)}`
                            : hasOrderPrice
                              ? <span className="text-slate-500" title="Order price (not filled)"> ${Number(entry.price).toFixed(2)} (order)</span>
                              : '—'}
                        </td>
                        <td className="py-1.5 text-right font-mono text-slate-200">
                          {entry.kind === 'trade' && !isFilledTrade
                            ? <span className="text-slate-600">—</span>
                            : `$${entry.total.toFixed(2)}`}
                        </td>
                        <td className="py-1.5 text-right font-mono">
                          {entry.displayPnl != null
                            ? <span className={entry.displayPnl > 0 ? 'text-emerald-400' : entry.displayPnl < 0 ? 'text-red-400' : 'text-slate-400'}>{entry.displayPnl > 0 ? '+' : ''}{entry.displayPnl.toFixed(2)}</span>
                            : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="py-1.5 text-slate-400 min-w-[360px] whitespace-normal break-words" title={noteText || ''}>
                          {noteText
                            ? <span className="inline-block w-full px-1.5 py-0.5 rounded border text-[10px] leading-5 whitespace-normal break-words bg-slate-700/50 text-slate-300 border-slate-600/40 font-mono">{noteText}</span>
                            : <span className="text-slate-600">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-1 pt-3 border-t border-dark-600 mt-2">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setActivityPage(0)}
                    disabled={safePage === 0}
                    title="Go to first page"
                    aria-label="Go to first page"
                    className="h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronDoubleLeftIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setActivityPage(p => Math.max(0, p - 10))}
                    disabled={safePage === 0}
                    title="Jump back 10 pages"
                    aria-label="Jump back 10 pages"
                    className="relative h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronDoubleLeftIcon className="h-4 w-4" />
                    <span className="absolute -right-1 -top-1 text-[9px] leading-none text-slate-300">10</span>
                  </button>
                  <button
                    onClick={() => setActivityPage(p => Math.max(0, p - 5))}
                    disabled={safePage === 0}
                    title="Jump back 5 pages"
                    aria-label="Jump back 5 pages"
                    className="relative h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                    <span className="absolute -right-1 -top-1 text-[9px] leading-none text-slate-300">5</span>
                  </button>
                  <button
                    onClick={() => setActivityPage(p => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    title="Previous page"
                    aria-label="Previous page"
                    className="h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeftIcon className="h-4 w-4" />
                  </button>
                </div>
                <span className="text-xs text-slate-500">{safePage + 1} / {totalPages} · {all.length} total</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setActivityPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage === totalPages - 1}
                    title="Next page"
                    aria-label="Next page"
                    className="h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRightIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setActivityPage(p => Math.min(totalPages - 1, p + 5))}
                    disabled={safePage === totalPages - 1}
                    title="Jump forward 5 pages"
                    aria-label="Jump forward 5 pages"
                    className="relative h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRightIcon className="h-4 w-4" />
                    <span className="absolute -left-1 -top-1 text-[9px] leading-none text-slate-300">5</span>
                  </button>
                  <button
                    onClick={() => setActivityPage(p => Math.min(totalPages - 1, p + 10))}
                    disabled={safePage === totalPages - 1}
                    title="Jump forward 10 pages"
                    aria-label="Jump forward 10 pages"
                    className="relative h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronDoubleRightIcon className="h-4 w-4" />
                    <span className="absolute -left-1 -top-1 text-[9px] leading-none text-slate-300">10</span>
                  </button>
                  <button
                    onClick={() => setActivityPage(totalPages - 1)}
                    disabled={safePage === totalPages - 1}
                    title="Go to last page"
                    aria-label="Go to last page"
                    className="h-7 w-7 inline-flex items-center justify-center rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronDoubleRightIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
            </>
          )
        })()}
      </div>
    </div>
  )
}
