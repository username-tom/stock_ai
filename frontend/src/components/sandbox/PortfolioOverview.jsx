import { useState } from 'react'
import {
  Cell, Tooltip, ResponsiveContainer, Treemap,
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'
import {
  HomeIcon, ChartPieIcon, TableCellsIcon, ClockIcon,
  ArrowUpIcon, ArrowDownIcon, BanknotesIcon,
} from '@heroicons/react/24/outline'
import { useQuery } from '@tanstack/react-query'
import { getSandboxFundEvents } from '../../api/client'
import { useAppSettings } from '../../hooks/useAppSettings'
import { usePriceChangeTracking } from '../../hooks/usePriceChangeTracking'
import { PIE_COLORS } from './sandboxConstants'
import { fmt, fmtMoney } from './sandboxHelpers'
import MiniSparkline from '../dashboard/MiniSparkline'

const BULL_COLOR = '#10b981'
const BEAR_COLOR = '#ef4444'
const NEUTRAL_COLOR = '#64748b'
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
  if (cls === 'bullish' || cls === 'euphoric') return BULL_COLOR
  if (cls === 'bearish' || cls === 'crash') return BEAR_COLOR
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

export default function PortfolioOverview({
  ibMode,
  accountData,
  positions,
  quotes,
  totalEquity,
  totalUnrealizedPnl,
  totalRealizedPnl,
  pieData,
  analytics,
  realizedMetrics,
  allTrades = [],
  activities = [],
  pmScores = {},
  managerSettings = null,
  onOpenManager = null,
  onSelectSymbol,
}) {
  const appSettings = useAppSettings()
  const isSimulated = !ibMode
  const priceColors = usePriceChangeTracking(quotes)
  const { data: fundEventsData } = useQuery({
    queryKey: ['sandbox-fund-events'],
    queryFn: getSandboxFundEvents,
    refetchInterval: appSettings.portfolio_detail_ms,
    enabled: isSimulated,
  })
  const fundEvents = isSimulated ? (fundEventsData?.events ?? []) : []
  const [activityPage, setActivityPage] = useState(0)
  const netDepositedFromEvents = fundEvents.reduce((sum, event) => {
    if (event.event_type === 'deposit') return sum + (event.amount ?? 0)
    if (event.event_type === 'withdrawal') return sum - (event.amount ?? 0)
    return sum
  }, 0)
  const totalDeposited = isSimulated
    ? (accountData?.total_deposited ?? netDepositedFromEvents)
    : null
  const realizedPnlPct = totalDeposited > 0 ? (totalRealizedPnl / totalDeposited) * 100 : null

  const cumulativeSeries = analytics?.cumulative_pnl ?? []
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
  const headlineUnrealized = isSimulated ? totalUnrealizedPnl : (ibUnrealizedPnl ?? totalUnrealizedPnl)
  const headlineRealized = isSimulated ? totalRealizedPnl : ibRealizedPnl

  // Fallback period metrics from cumulative curve if backend metrics are temporarily unavailable.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() === 0 ? 6 : weekStart.getDay() - 1))
  const monthStart = new Date(todayStart); monthStart.setDate(1)
  const dailyPnlFallback = latestCumulative - cumulativeBefore(new Date(todayStart.getTime() - 1))
  const weeklyPnlFallback = latestCumulative - cumulativeBefore(new Date(weekStart.getTime() - 1))
  const monthlyPnlFallback = latestCumulative - cumulativeBefore(new Date(monthStart.getTime() - 1))

  const dailyPnl = numOrNull(realizedMetrics?.daily_realized_pnl) ?? (cumulativeSeries.length > 0 ? dailyPnlFallback : null)
  const dailyPnlPct = numOrNull(realizedMetrics?.daily_realized_pnl_pct)
    ?? ((totalDeposited > 0 && dailyPnl != null) ? (dailyPnl / totalDeposited) * 100 : null)
  const weeklyPnl = numOrNull(realizedMetrics?.weekly_realized_pnl) ?? (cumulativeSeries.length > 0 ? weeklyPnlFallback : null)
  const weeklyPnlPct = numOrNull(realizedMetrics?.weekly_realized_pnl_pct)
    ?? ((totalDeposited > 0 && weeklyPnl != null) ? (weeklyPnl / totalDeposited) * 100 : null)
  const monthlyPnl = numOrNull(realizedMetrics?.monthly_realized_pnl) ?? (cumulativeSeries.length > 0 ? monthlyPnlFallback : null)
  const monthlyPnlPct = numOrNull(realizedMetrics?.monthly_realized_pnl_pct)
    ?? ((totalDeposited > 0 && monthlyPnl != null) ? (monthlyPnl / totalDeposited) * 100 : null)

  const annualizedReturnPctServer = numOrNull(realizedMetrics?.annualized_return_pct)
  const avgDailyRealizedPnlServer = numOrNull(realizedMetrics?.avg_daily_realized_pnl)
  const realizedTradeDaysServer = numOrNull(realizedMetrics?.realized_trade_days)
  const elapsedDaysServer = numOrNull(realizedMetrics?.elapsed_days)

  const realizedTradeLog = allTrades
    .map(t => ({ pnl: numOrNull(t.pnl), date: parsePointDate(t.created_at) }))
    .filter(t => t.pnl != null && t.date)
    .sort((a, b) => a.date - b.date)
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
  const annualizedReturnPctFallback = (
    elapsedTradingDaysFallback != null
    && totalDeposited > 0
    && (realizedPnlSumFallback / totalDeposited) > -1
  )
    ? ((Math.pow(1 + (realizedPnlSumFallback / totalDeposited), 252 / elapsedTradingDaysFallback) - 1) * 100)
    : null
  const avgDailyRealizedPnlFallback = realizedTradeDaysFallback > 0 ? (realizedPnlSumFallback / realizedTradeDaysFallback) : null

  const annualizedReturnPct = annualizedReturnPctServer ?? annualizedReturnPctFallback
  const avgDailyRealizedPnl = avgDailyRealizedPnlServer ?? avgDailyRealizedPnlFallback
  const realizedTradeDays = realizedTradeDaysServer ?? realizedTradeDaysFallback
  const elapsedDays = elapsedDaysServer ?? elapsedTradingDaysFallback

  // Max gain & max drawdown from cumulative P&L curve
  let maxGain = 0
  let maxDrawdown = 0
  if (analytics?.cumulative_pnl?.length > 0) {
    let peak = analytics.cumulative_pnl[0].value
    for (const pt of analytics.cumulative_pnl) {
      if (pt.value > maxGain) maxGain = pt.value
      if (pt.value > peak) peak = pt.value
      const dd = peak - pt.value
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }
  const maxGainPct = totalDeposited > 0 ? (maxGain / totalDeposited) * 100 : null
  const maxDrawdownPct = totalDeposited > 0 ? (maxDrawdown / totalDeposited) * 100 : null

  const marketShareData = pieData.map((entry, i) => ({
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
          <div className="text-xs text-slate-500 mb-1">{isSimulated ? 'Total Funds' : 'Net Liquidation'}</div>
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
          <div className="text-xl font-bold text-slate-100">{fmtMoney(totalEquity)}</div>
          <div className="text-xs text-slate-500 mt-0.5">{positions.filter(p => p.shares > 0).length} positions held</div>
        </div>
        <div className={`card ${headlineUnrealized >= 0 ? 'border-emerald-700/20' : 'border-red-700/20'}`}>
          <div className="text-xs text-slate-500 mb-1">Unrealised P&amp;L</div>
          <div className={`text-xl font-bold ${headlineUnrealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(headlineUnrealized)}</div>
          {totalEquity > 0 && (
            <div className="text-xs text-slate-500 mt-0.5">{((headlineUnrealized / totalEquity) * 100).toFixed(2)}% of equity</div>
          )}
        </div>
        <div className={`card ${headlineRealized != null && headlineRealized >= 0 ? 'border-emerald-700/20' : headlineRealized != null ? 'border-red-700/20' : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Realised P&amp;L</div>
          <div className={`text-xl font-bold ${headlineRealized == null ? 'text-slate-400' : headlineRealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{headlineRealized == null ? '—' : fmt(headlineRealized)}</div>
          <div className="text-xs text-slate-500 mt-0.5">{isSimulated ? (realizedPnlPct == null ? '—' : `${realizedPnlPct.toFixed(2)}% of deposited funds`) : (headlineRealized == null ? 'Not provided by IB summary' : 'From IB account summary')}</div>
        </div>
      </div>

      {/* Secondary stat cards: performance metrics */}
      {isSimulated && (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`card ${maxGain > 0 ? 'border-emerald-700/20' : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Max Gain</div>
          <div className={`text-xl font-bold ${maxGain > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{maxGain > 0 ? fmt(maxGain) : '—'}</div>
          <div className="text-xs text-slate-500 mt-0.5">{maxGainPct != null && maxGain > 0 ? `${maxGainPct.toFixed(2)}% of deposited` : 'No closed trades yet'}</div>
        </div>
        <div className={`card ${maxDrawdown > 0 ? 'border-red-700/20' : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Max Drawdown</div>
          <div className={`text-xl font-bold ${maxDrawdown > 0 ? 'text-red-400' : 'text-slate-400'}`}>{maxDrawdown > 0 ? fmt(-maxDrawdown) : '—'}</div>
          <div className="text-xs text-slate-500 mt-0.5">{maxDrawdownPct != null && maxDrawdown > 0 ? `${maxDrawdownPct.toFixed(2)}% peak-to-trough` : 'No drawdown recorded'}</div>
        </div>
        <div className={`card ${dailyPnl != null && dailyPnl !== 0 ? (dailyPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Today&apos;s P&amp;L</div>
          <div className={`text-xl font-bold ${dailyPnl == null ? 'text-slate-400' : dailyPnl > 0 ? 'text-emerald-400' : dailyPnl < 0 ? 'text-red-400' : 'text-slate-400'}`}>
            {dailyPnl == null ? '—' : fmt(dailyPnl)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {dailyPnlPct != null ? `${dailyPnlPct >= 0 ? '+' : ''}${dailyPnlPct.toFixed(2)}% of deposited` : 'No realised trades yet'}
          </div>
        </div>
        <div className={`card ${weeklyPnl != null && weeklyPnl !== 0 ? (weeklyPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">This Week&apos;s P&amp;L</div>
          <div className={`text-xl font-bold ${weeklyPnl == null ? 'text-slate-400' : weeklyPnl > 0 ? 'text-emerald-400' : weeklyPnl < 0 ? 'text-red-400' : 'text-slate-400'}`}>
            {weeklyPnl == null ? '—' : fmt(weeklyPnl)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {weeklyPnlPct != null ? `${weeklyPnlPct >= 0 ? '+' : ''}${weeklyPnlPct.toFixed(2)}% of deposited` : 'No realised trades yet'}
          </div>
        </div>
      </div>
      )}

      {/* Tertiary stat cards: long-horizon performance */}
      {isSimulated && (
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">

        <div className={`card ${monthlyPnl != null && monthlyPnl !== 0 ? (monthlyPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Month-to-Date P&amp;L</div>
          <div className={`text-xl font-bold ${monthlyPnl == null ? 'text-slate-400' : monthlyPnl > 0 ? 'text-emerald-400' : monthlyPnl < 0 ? 'text-red-400' : 'text-slate-400'}`}>
            {monthlyPnl == null ? '—' : fmt(monthlyPnl)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {monthlyPnlPct != null ? `${monthlyPnlPct >= 0 ? '+' : ''}${monthlyPnlPct.toFixed(2)}% of deposited` : 'No realised trades yet'}
          </div>
        </div>

        <div className={`card ${annualizedReturnPct != null ? (annualizedReturnPct >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Annualized Return</div>
          <div className={`text-xl font-bold ${annualizedReturnPct == null ? 'text-slate-400' : annualizedReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {annualizedReturnPct == null ? '—' : `${annualizedReturnPct >= 0 ? '+' : ''}${annualizedReturnPct.toFixed(2)}%`}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {elapsedDays == null ? 'No realised history yet' : `${elapsedDays} trading day${elapsedDays !== 1 ? 's' : ''} from trade log`}
          </div>
        </div>

        <div className={`card ${avgDailyRealizedPnl != null ? (avgDailyRealizedPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20') : ''}`}>
          <div className="text-xs text-slate-500 mb-1">Avg Daily Realised</div>
          <div className={`text-xl font-bold ${avgDailyRealizedPnl == null ? 'text-slate-400' : avgDailyRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {avgDailyRealizedPnl == null ? '—' : fmt(avgDailyRealizedPnl)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {realizedTradeDays > 0 ? `${realizedTradeDays} realised trade day${realizedTradeDays !== 1 ? 's' : ''}` : 'No realised history yet'}
          </div>
        </div>
      </div>
      )}

      {/* Per-position breakdown table */}
      {positions.length > 0 ? (
        <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <TableCellsIcon className="h-4 w-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Position Breakdown</h2>
            </div>
            <div className="max-h-100 overflow-y-auto pr-1">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-dark-600">
                    <th className="text-left pb-2 font-medium">Symbol</th>
                    <th className="text-left pb-2 font-medium">PM Sentiment</th>
                    <th className="text-left pb-2 font-medium">AI Sentiment</th>
                    <th className="text-left pb-2 font-medium">Strategy</th>
                    <th className="text-right pb-2 font-medium">Limits</th>
                    <th className="text-right pb-2 font-medium">Shares</th>
                    <th className="text-right pb-2 font-medium">Avg Price</th>
                    <th className="text-right pb-2 font-medium">Current</th>
                    <th className="text-right pb-2 font-medium">Mkt Value</th>
                    <th className="text-right pb-2 font-medium">Cash</th>
                    <th className="text-right pb-2 font-medium">Alloc</th>
                    <th className="text-right pb-2 font-medium">Unrealised</th>
                    <th className="text-right pb-2 font-medium">Unrealised %</th>
                    <th className="text-right pb-2 font-medium">Realised</th>
                    <th className="text-right pb-2 font-medium">Realised %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-700">
                  {positions.map((pos, i) => {
                    const q = quotes[pos.symbol]
                    const mp = q?.last_price ?? pos.avg_cost
                    const mv = mp * pos.shares
                    const costBasis = pos.avg_cost * pos.shares
                    const cashRemaining = Math.max(0, pos.allocated_funds - pos.avg_cost * pos.shares)
                    const unreal = mv - costBasis
                    const unrealPct = costBasis > 0 ? (unreal / costBasis) * 100 : null
                    const realizedPct = pos.total_invested > 0.01 ? ((pos.realized_pnl ?? 0) / pos.total_invested) * 100 : null
                    const pd = pieData.find(d => d.symbol === pos.symbol)
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
                          {pmScores[pos.symbol] ? (
                            <div title={`Score: ${pmScores[pos.symbol].score} — Updated: ${pmScores[pos.symbol].updated_at ? new Date(pmScores[pos.symbol].updated_at).toLocaleTimeString() : '?'}`}>
                              <span className="text-xs font-semibold" style={{ color: classColor(pmScores[pos.symbol].classification) }}>
                                {classLabel(pmScores[pos.symbol].classification)}
                              </span>
                              <div className="text-xs text-slate-500 mt-0.5">
                                ({pmScores[pos.symbol].score > 0 ? '+' : ''}{pmScores[pos.symbol].score})
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-600">—</span>
                          )}
                        </td>
                        <td className="py-2 pl-2">
                          <span className={`text-xs font-semibold ${aiStyle}`}>{aiTag}</span>
                        </td>
                        <td className="py-2 pl-2">
                          {pos.strategy_name ? (
                            <span className="text-xs text-blue-400/80">{stratLabel(pos.strategy_name)}</span>
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
                        <td className="text-right text-slate-300 font-mono">{pos.shares > 0 ? pos.shares.toFixed(3) : '—'}</td>
                        <td className="text-right text-slate-300 font-mono">{pos.shares > 0 ? fmtMoney(pos.avg_cost) : '—'}</td>
                        <td className={`text-right py-2 px-3 font-mono rounded transition-colors ${priceColor?.bgColor || ''} ${priceColor?.textColor || 'text-slate-200'}`}>
                          {fmtMoney(mp)}
                        </td>
                        <td className="text-right text-slate-200 font-mono">{pos.shares > 0 ? fmtMoney(mv) : '—'}</td>
                        <td className="text-right text-blue-300 font-mono">{cashRemaining > 0 ? fmtMoney(cashRemaining) : '—'}</td>
                        <td className="text-right text-slate-400">{pd ? `${pd.pct}%` : '—'}</td>
                        <td className={`text-right font-semibold font-mono ${unreal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {pos.shares > 0 ? fmt(unreal) : '—'}
                        </td>
                        <td className={`text-right font-semibold font-mono ${unrealPct == null ? 'text-slate-600' : unrealPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {unrealPct == null ? '—' : `${unrealPct >= 0 ? '+' : ''}${unrealPct.toFixed(2)}%`}
                        </td>
                        <td className={`text-right font-semibold font-mono ${pos.realized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {fmt(pos.realized_pnl)}
                        </td>
                        <td className={`text-right font-semibold font-mono ${realizedPct == null ? 'text-slate-600' : realizedPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {realizedPct == null ? '—' : `${realizedPct >= 0 ? '+' : ''}${realizedPct.toFixed(2)}%`}
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
                    <td />
                    <td className="text-right pt-2 font-mono text-slate-200">{fmtMoney(totalEquity)}</td>
                    <td />
                    <td className="text-right pt-2">100%</td>
                    <td className={`text-right pt-2 font-mono ${totalUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalUnrealizedPnl)}</td>
                    <td className={`text-right pt-2 font-mono ${totalUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {totalEquity > 0 ? `${totalUnrealizedPnl >= 0 ? '+' : ''}${((totalUnrealizedPnl / totalEquity) * 100).toFixed(2)}%` : '—'}
                    </td>
                    <td className={`text-right pt-2 font-mono ${totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalRealizedPnl)}</td>
                    <td className={`text-right pt-2 font-mono ${realizedPnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {totalDeposited > 0 && realizedPnlPct != null ? `${realizedPnlPct >= 0 ? '+' : ''}${realizedPnlPct.toFixed(2)}%` : '—'}
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
          <div className="flex items-start justify-between gap-3">
            <div>
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
          </div>
        </div>
      )}

      {/* Allocation + Unrealised row */}
      {(pieData.length > 0 || positions.some(p => p.shares > 0)) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {pieData.length > 0 && (
            <div className="card">
              <div className="flex items-center gap-2 mb-4">
                <ChartPieIcon className="h-4 w-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Allocation by Market Value</h2>
              </div>
              <div className="h-80">
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
                      const symbol = payload?.symbol ?? name ?? ''
                      const pct = payload?.pct
                      const showSymbol = width > 68 && height > 28
                      const showPct = width > 100 && height > 48
                      return (
                        <g>
                          <rect x={x} y={y} width={width} height={height} style={{ fill: bg, stroke: '#0f172a', strokeWidth: 1 }} />
                          {showSymbol && (
                            <text x={x + 8} y={y + 16} fill="#f8fafc" fontSize={11} fontWeight={700}>
                              {symbol}
                            </text>
                          )}
                          {showPct && pct != null && (
                            <text x={x + 8} y={y + 32} fill="#e2e8f0" fontSize={10}>
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

          {positions.some(p => p.shares > 0) && (() => {
            const unrealData = positions
              .filter(p => p.shares > 0)
              .map(p => {
                const mp = quotes[p.symbol]?.last_price ?? p.avg_cost
                const unreal = (mp - p.avg_cost) * p.shares
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
      {analytics && analytics.total_trades > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Portfolio Performance Over Time</h2>

          {analytics.cumulative_pnl.length > 1 && (
            <div className="card">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Cumulative Realised P&amp;L</div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics.cumulative_pnl} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={latestCumulative >= 0 ? '#10b981' : '#ef4444'} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={latestCumulative >= 0 ? '#10b981' : '#ef4444'} stopOpacity={0} />
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
                    <Area type="monotone" dataKey="value" stroke={latestCumulative >= 0 ? '#10b981' : '#ef4444'} strokeWidth={2} fill="url(#pnlGrad)" dot={false} activeDot={{ r: 4, fill: latestCumulative >= 0 ? '#10b981' : '#ef4444' }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {(analytics.daily_volume.length > 0 || analytics.cumulative_pnl.length > 1) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {analytics.daily_volume.length > 0 && (
                <div className="card">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Daily Trade Volume</div>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={analytics.daily_volume} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
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

              {analytics.cumulative_pnl.length > 1 && (() => {
                const dailyPnl = []
                for (let i = 1; i < analytics.cumulative_pnl.length; i++) {
                  const current = analytics.cumulative_pnl[i]
                  const previous = analytics.cumulative_pnl[i - 1]
                  dailyPnl.push({
                    date: current.date,
                    value: current.value - previous.value,
                  })
                }
                return (
                  <div className="card">
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Daily Gain / Loss</div>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={dailyPnl} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                          <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                            tickFormatter={v => v.slice(5)} />
                          <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                            tickFormatter={v => `$${v >= 0 ? '+' : ''}${v >= 1000 || v <= -1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)}`} width={54} />
                          <Tooltip
                            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                            labelStyle={{ color: '#94a3b8' }}
                            formatter={(v) => [`$${v >= 0 ? '+' : ''}${v.toFixed(2)}`, 'Daily P&L']}
                          />
                          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                            {dailyPnl.map((entry, idx) => (
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
            {analytics.symbol_pnl.length > 0 && (
              <div className="card">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Realised P&amp;L by Symbol</div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.symbol_pnl} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                      <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false}
                        tickFormatter={v => `$${v.toFixed(0)}`} />
                      <YAxis type="category" dataKey="symbol" tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 600 }} tickLine={false} axisLine={false} width={46} />
                      <Tooltip
                        contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11, color: '#94a3b8' }}
                        formatter={(v) => [`$${v.toFixed(2)}`, 'Realised P&L']}
                      />
                      <Bar dataKey="realized_pnl" name="Realised P&L" radius={[0, 3, 3, 0]}>
                        {analytics.symbol_pnl.map((entry) => (
                          <Cell key={entry.symbol} fill={entry.realized_pnl >= 0 ? '#10b981' : '#ef4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {analytics.win_loss && (analytics.win_loss.wins + analytics.win_loss.losses + analytics.win_loss.breakeven) > 0 && (() => {
              const wl = analytics.win_loss
              const total = wl.wins + wl.losses + wl.breakeven
              const winRate = ((wl.wins / total) * 100).toFixed(1)
              const winLossData = [{
                bucket: 'Trades',
                Wins: wl.wins,
                Losses: wl.losses,
                Breakeven: wl.breakeven,
              }]
              const segments = [
                { name: 'Wins', value: wl.wins, color: '#10b981' },
                { name: 'Losses', value: wl.losses, color: '#ef4444' },
                ...(wl.breakeven > 0 ? [{ name: 'Breakeven', value: wl.breakeven, color: '#64748b' }] : []),
              ]
              return (
                <div className="card flex flex-col">
                  <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Win / Loss Ratio</div>
                  <div className="flex-1 flex items-center gap-4">
                    <div className="h-28 flex-1">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={winLossData} layout="vertical" margin={{ top: 6, right: 8, left: 8, bottom: 6 }}>
                          <XAxis type="number" hide domain={[0, total]} />
                          <YAxis type="category" dataKey="bucket" hide />
                          <Tooltip
                            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                            labelStyle={{ color: '#94a3b8' }}
                            itemStyle={{ color: '#cbd5e1' }}
                            formatter={(v, name) => {
                              const pct = total > 0 ? ((Number(v ?? 0) / total) * 100).toFixed(1) : '0.0'
                              return [`${v} (${pct}%)`, name]
                            }}
                          />
                          <Bar dataKey="Wins" stackId="wl" fill="#10b981" radius={[4, 0, 0, 4]} />
                          <Bar dataKey="Losses" stackId="wl" fill="#ef4444" radius={[0, 0, 0, 0]} />
                          {wl.breakeven > 0 && <Bar dataKey="Breakeven" stackId="wl" fill="#64748b" radius={[0, 4, 4, 0]} />}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="space-y-2 text-xs shrink-0">
                      <div>
                        <div className="text-slate-500">Win Rate</div>
                        <div className="text-xl font-bold text-emerald-400">{winRate}%</div>
                      </div>
                      {segments.map(d => (
                        <div key={d.name} className="flex items-center gap-2">
                          <span className="inline-block w-2 h-2 rounded-full" style={{ background: d.color }} />
                          <span className="text-slate-400">{d.name}</span>
                          <span className="font-bold text-slate-200 ml-auto">{d.value}</span>
                        </div>
                      ))}
                      <div className="border-t border-dark-600 pt-1 text-slate-500">
                        {total} total trades
                      </div>
                    </div>
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
            const total = activities.filter(a => a.type === 'trade' && a.tradeId).length + fundEvents.length
            return total > 0 && <span className="ml-auto text-xs text-slate-500">{total} event{total !== 1 ? 's' : ''}</span>
          })()}
        </div>
        {(() => {
          const tradeEntries = activities.filter(a => a.type === 'trade' && a.tradeId).map(a => ({
            id: `t-${a.tradeId}`,
            kind: 'trade',
            side: a.side,
            date: new Date(a.ts).toISOString(),
            symbol: a.symbol,
            shares: a.shares,
            price: a.price,
            label: a.label,
            total: (a.shares ?? 0) * (a.price ?? 0),
            pnl: a.pnl,
            reason: a.reason,
          }))
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
                    <th className="text-left pb-2 font-medium">Time</th>
                    <th className="text-left pb-2 font-medium">Type</th>
                    <th className="text-left pb-2 font-medium">Details</th>
                    <th className="text-right pb-2 font-medium">Shares</th>
                    <th className="text-right pb-2 font-medium">Price</th>
                    <th className="text-right pb-2 font-medium">Amount</th>
                    <th className="text-right pb-2 font-medium">P&amp;L</th>
                    <th className="text-left pb-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-700">
                  {pageItems.map(entry => {
                    const ts = entry.date ? new Date(entry.date) : null
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
                          {entry.shares != null ? entry.shares.toFixed(3) : '—'}
                        </td>
                        <td className="py-1.5 text-right font-mono text-slate-300">
                          {entry.price != null ? `$${entry.price.toFixed(2)}` : '—'}
                        </td>
                        <td className="py-1.5 text-right font-mono text-slate-200">${entry.total.toFixed(2)}</td>
                        <td className="py-1.5 text-right font-mono">
                          {entry.pnl != null
                            ? <span className={entry.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{entry.pnl >= 0 ? '+' : ''}{entry.pnl.toFixed(2)}</span>
                            : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="py-1.5 text-slate-400 max-w-[200px] truncate">
                          {entry.reason
                            ? <span className="px-1.5 py-0.5 rounded border text-[10px] bg-slate-700/50 text-slate-300 border-slate-600/40 font-mono">{entry.reason}</span>
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
                <button
                  onClick={() => setActivityPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="text-xs px-2.5 py-1 rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >← Prev</button>
                <span className="text-xs text-slate-500">{safePage + 1} / {totalPages} · {all.length} total</span>
                <button
                  onClick={() => setActivityPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage === totalPages - 1}
                  className="text-xs px-2.5 py-1 rounded border border-dark-600 text-slate-400 hover:text-slate-200 hover:border-dark-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >Next →</button>
              </div>
            )}
            </>
          )
        })()}
      </div>
    </div>
  )
}
