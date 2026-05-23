import { useState, useMemo, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  SignalIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, ArrowPathIcon, XMarkIcon,
  CpuChipIcon, RectangleGroupIcon,
} from '@heroicons/react/24/outline'
import {
  getSandboxAccount, getSandboxPositions,
  getSandboxLearnerInsights,
  updateSandboxPosition, removeSandboxSymbol,
  getSandboxTrades, placeSandboxTrade,
  exportSandbox, importSandbox, resetSandbox, resetSandboxSoft,
  getBulkQuotes, getIBStatus, connectIB, disconnectIB, setIBMode,
  placeOrder, getTradeHistory,
  getSymbolSectors,
  resetIBPaperPortfolio,
  getIBPositions, getIBOrders,
  getSandboxEngineState, toggleSandboxEngine, toggleAllSandboxEngines,
  getSandboxAnalytics, getSandboxRealizedMetrics,
  getPortfolioManagerState, togglePortfolioManager,
  bulkUpdateSandboxStrategy,
  bulkUpdateSandboxAllocationCap,
  cancelOrder,
} from '../api/client'
import { pct, fmt, fmtMoney, defaultParams, encodeStrategy, decodeStrategy } from './sandbox/sandboxHelpers'
import { CUSTOM_SCRIPT_KEY, TEMPLATE_SCRIPT_KEY } from './sandbox/sandboxConstants'
import { useAppSettings } from '../hooks/useAppSettings'
import { WATCHLIST_SYMBOL_LIMIT } from '../hooks/useWatchlist'
import { setSetting } from '../hooks/useAppSettings'
import SandboxSidebar from './sandbox/SandboxSidebar'
import PortfolioOverview from './sandbox/PortfolioOverview'
import PositionDetail from './sandbox/PositionDetail'
import TradeNotificationBanner from './sandbox/TradeNotificationBanner'
import ActivityLog from './sandbox/ActivityLog'
import PortfolioManagerPanel from './sandbox/PortfolioManagerPanel'
import BulkStrategyModal from './sandbox/BulkStrategyModal'

const WATCHLIST_STORAGE_KEY = 'dashboard_watchlist'
const WATCHLIST_DEFAULT = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']

function normalizeSymbolList(symbols) {
  if (!Array.isArray(symbols)) return []
  const out = []
  const seen = new Set()
  for (const raw of symbols) {
    const sym = String(raw ?? '').trim().toUpperCase()
    if (!sym || seen.has(sym)) continue
    seen.add(sym)
    out.push(sym)
  }
  return out
}

function mergePinnedWatchlist(currentSymbols, pinnedSymbols) {
  const pinned = normalizeSymbolList(pinnedSymbols)
  const current = normalizeSymbolList(currentSymbols)
  const merged = [...new Set([...pinned, ...current])]
  return merged.slice(0, WATCHLIST_SYMBOL_LIMIT)
}

function readDashboardWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return normalizeSymbolList(parsed).slice(0, WATCHLIST_SYMBOL_LIMIT)
    }
  } catch {}
  return normalizeSymbolList(WATCHLIST_DEFAULT)
}

function writeDashboardWatchlist(symbols) {
  const next = normalizeSymbolList(symbols).slice(0, WATCHLIST_SYMBOL_LIMIT)
  try { localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next)) } catch {}
  window.dispatchEvent(new Event('watchlist-updated'))
}

function getIbOrderExpiryLabel(order) {
  if ((order?.tif ?? '').toUpperCase() !== 'DAY' || !order?.created_at) return 'Expiry: n/a'
  const created = new Date(order.created_at)
  if (Number.isNaN(created.getTime())) return 'Expiry: n/a'

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(created)
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const d = parts.find(p => p.type === 'day')?.value
  if (!y || !m || !d) return 'Expiry: n/a'

  const close = new Date(`${y}-${m}-${d}T16:00:00-04:00`)
  const now = new Date()
  const remainingMs = close.getTime() - now.getTime()
  if (remainingMs <= 0) return 'Expiry: market close passed'
  const mins = Math.floor(remainingMs / 60000)
  if (mins <= 30) return `Expiry: ${mins}m remaining`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return `Expiry: ${hours}h ${remMins}m remaining`
}

function compactStrategyLabel(strategyName) {
  const raw = String(strategyName ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('template:')) {
    return raw.slice(9).replace(/\.py$/i, '')
  }
  if (raw.startsWith('custom:')) {
    const id = raw.slice(7)
    return id ? `custom#${id}` : 'custom'
  }
  return raw.split(':')[0]
}

function buildIbTradeNote(tradeLike) {
  const status = String(tradeLike?.status ?? '').trim().toUpperCase() || 'SUBMITTED'
  const orderId = tradeLike?.ib_order_id
  const strategy = compactStrategyLabel(tradeLike?.strategy_name)
  const reason = String(tradeLike?.reason ?? '').trim()
  const noteParts = []
  if (orderId != null) noteParts.push(`IB #${orderId}`)
  noteParts.push(status)
  if (tradeLike?.order_type) {
    const orderType = String(tradeLike.order_type).trim().toUpperCase()
    if (orderType) noteParts.push(orderType)
  }
  if (tradeLike?.limit_price != null && Number.isFinite(Number(tradeLike.limit_price))) {
    noteParts.push(`LMT $${Number(tradeLike.limit_price).toFixed(2)}`)
  }
  if (strategy) noteParts.push(`via ${strategy}`)
  if (reason) noteParts.push(reason)
  return noteParts.join(' · ')
}

export default function SandboxPanel() {
  const qc = useQueryClient()
  const appSettings = useAppSettings()
  const importInputRef = useRef(null)

  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedSymbol, setSelectedSymbol] = useState(() => searchParams.get('symbol') || readDashboardWatchlist()[0] || null)
  const [editingStrategy, setEditingStrategy] = useState(false)
  const [editStratType, setEditStratType] = useState('sma_crossover')
  const [editScriptId, setEditScriptId] = useState(null)
  const [editTemplateFilename, setEditTemplateFilename] = useState(null)
  const [editStratParams, setEditStratParams] = useState({})
  const [editingAlloc, setEditingAlloc] = useState(false)
  const [allocInput, setAllocInput] = useState('')
  const [tradeForm, setTradeForm] = useState({ side: 'BUY', quantity: '', price: '', reason: 'manual' })
  const [tradeMsg, setTradeMsg] = useState(null)

  // Consume ?symbol= param on navigation from dashboard
  useEffect(() => {
    const sym = searchParams.get('symbol')
    if (sym) {
      setSelectedSymbol(sym)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams])

  // Reset per-trade fields when switching symbols so quantity doesn't bleed across positions
  useEffect(() => {
    setTradeForm(f => ({ ...f, quantity: '', price: '', reason: 'manual' }))
    setTradeMsg(null)
  }, [selectedSymbol])
  const [exportLoading, setExportLoading] = useState(false)
  const [importMsg, setImportMsg] = useState(null)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [resetSoftConfirm, setResetSoftConfirm] = useState(false)
  const [paperResetConfirm, setPaperResetConfirm] = useState(false)
  const [showResetMenu, setShowResetMenu] = useState(false)
  const [activities, setActivities] = useState([])
  const [ibWatchlistSymbols, setIbWatchlistSymbols] = useState(() => readDashboardWatchlist())
  const prevTradeIdRef = useRef(null)
  const tradeFirstSeenRef = useRef({})
  const ibSyncFirstSeenRef = useRef({})
  const prevIbSessionRef = useRef({ connected: false, mode: null })
  const prevProfileRef = useRef('simulated')
  const activeProfileRef = useRef('simulated')

  // bulk-strategy modal state
  const [bulkStratOpen, setBulkStratOpen] = useState(false)
  const [bulkStratType, setBulkStratType] = useState('sma_crossover')
  const [bulkScriptId, setBulkScriptId] = useState(null)
  const [bulkTemplateFilename, setBulkTemplateFilename] = useState(null)
  const [bulkStratParams, setBulkStratParams] = useState({})
  const [activeMainTab, setActiveMainTab] = useState('summary')

  // IB status
  const { data: ibStatus } = useQuery({ queryKey: ['ib-status'], queryFn: getIBStatus, refetchInterval: appSettings.trading_status_ms })
  const ibConnected = ibStatus?.connected === true
  const ibSelectedMode = ibStatus?.mode ?? 'paper'
  const ibMode = ibConnected ? (ibStatus?.mode ?? 'paper') : null
  const activeProfile = ibConnected ? (ibMode ?? 'paper') : 'simulated'
  useEffect(() => { activeProfileRef.current = activeProfile }, [activeProfile])
  const { data: ibPositionsData } = useQuery({
    queryKey: ['ib-positions', ibMode ?? 'disconnected'],
    queryFn: getIBPositions,
    enabled: ibConnected,
    refetchInterval: appSettings.trading_positions_ms,
  })
  const { data: ibOrdersData } = useQuery({
    queryKey: ['ib-orders'],
    queryFn: getIBOrders,
    enabled: ibConnected,
    refetchInterval: appSettings.trading_orders_ms,
  })

  // queries
  const { data: accountData, refetch: refetchAccount, isFetching: isAccountFetching } = useQuery({
    queryKey: ['sandbox-account', activeProfile],
    queryFn: getSandboxAccount,
    refetchInterval: appSettings.sandbox_account_ms,
    placeholderData: (prev) => prev,
  })
  const { data: posData, refetch: refetchPositions, isFetching: isPositionsFetching } = useQuery({
    queryKey: ['sandbox-positions', activeProfile],
    queryFn: getSandboxPositions,
    refetchInterval: appSettings.sandbox_account_ms,
    placeholderData: (prev) => prev,
  })
  const rawPositions = posData?.positions ?? []

  // Force-refresh table/account payloads immediately on profile transition
  // (simulated <-> paper/live and paper <-> live), rather than waiting for
  // polling intervals.
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
    qc.invalidateQueries({ queryKey: ['sandbox-account'] })
    qc.invalidateQueries({ queryKey: ['ib-positions'] })
    void refetchPositions()
    void refetchAccount()
  }, [activeProfile, qc, refetchPositions, refetchAccount])

  useEffect(() => {
    const sync = () => setIbWatchlistSymbols(readDashboardWatchlist())
    sync()
    window.addEventListener('watchlist-updated', sync)
    window.addEventListener('focus', sync)
    return () => {
      window.removeEventListener('watchlist-updated', sync)
      window.removeEventListener('focus', sync)
    }
  }, [])

  // Ensure every sidebar stock stays in dashboard watchlist, prioritizing
  // currently visible sidebar symbols when the list is at capacity.
  useEffect(() => {
    const sidebarSymbols = normalizeSymbolList((rawPositions ?? []).map(p => p?.symbol))
    if (!sidebarSymbols.length) return
    const current = readDashboardWatchlist()
    const next = mergePinnedWatchlist(current, sidebarSymbols)
    const changed = next.length !== current.length || next.some((sym, idx) => sym !== current[idx])
    if (!changed) return
    writeDashboardWatchlist(next)
    setIbWatchlistSymbols(next)
  }, [rawPositions])

  // Always include all IB position symbols in the symbols array for quote fetching
  const symbols = useMemo(() => {
    const baseSymbols = rawPositions.map(p => p.symbol)
    let ibSymbols = []
    if (ibConnected && ibPositionsData?.positions) {
      ibSymbols = ibPositionsData.positions.map(p => p.symbol)
    }
    const merged = [...baseSymbols, ...ibWatchlistSymbols, ...ibSymbols]
    return [...new Set(merged.filter(Boolean))]
  }, [ibConnected, rawPositions, ibWatchlistSymbols, ibPositionsData])

  const { data: learnerData } = useQuery({
    queryKey: ['sandbox-learner-insights', symbols.join(',')],
    queryFn: () => symbols.length ? getSandboxLearnerInsights(symbols) : Promise.resolve({ insights: {} }),
    enabled: symbols.length > 0,
    staleTime: 90_000,
  })

  const positions = useMemo(() => {
    const learnerBySymbol = learnerData?.insights ?? {}
    const applyLearner = pos => ({ ...pos, ...(learnerBySymbol[pos.symbol] ?? {}) })

    const bySymbol = new Map(rawPositions.map(p => [p.symbol, p]))
    const merged = rawPositions.map(applyLearner)
    for (const sym of ibWatchlistSymbols) {
      if (bySymbol.has(sym)) continue
      merged.push({
        id: null,
        symbol: sym,
        allocated_funds: 0,
        shares: 0,
        avg_cost: 0,
        strategy_name: null,
        strategy_enabled: false,
        last_signal: null,
        last_run_at: null,
        engine_error: null,
        realized_pnl: 0,
        total_invested: 0,
        unrealized_pnl: 0,
        market_value: 0,
        is_on_watchlist: true,
        created_at: null,
        pending_shares: 0,
        pending_avg_cost: 0,
        pending_since: null,
        ...(learnerBySymbol[sym] ?? {}),
      })
    }
    return merged
  }, [rawPositions, ibWatchlistSymbols, learnerData?.insights])
  const { data: quotesData } = useQuery({
    queryKey: ['sandbox-quotes', symbols.join(',')],
    queryFn: () => symbols.length ? getBulkQuotes(symbols) : Promise.resolve({}),
    enabled: symbols.length > 0,
    refetchInterval: appSettings.sandbox_quotes_ms,
  })
  const quotes = quotesData ?? {}
  const getOwnedMarketPrice = pos => {
    const quotePrice = quotes[pos.symbol]?.last_price
    if (quotePrice != null) return quotePrice
    const storedMarketPrice = pos.market_price ?? pos.last_price
    if (storedMarketPrice != null) return storedMarketPrice
    const shares = Number(pos.shares ?? 0)
    const marketValue = Number(pos.market_value ?? 0)
    if (shares > 0 && marketValue > 0) return marketValue / shares
    return pos.shares > 0 ? pos.avg_cost : null
  }
  const { data: sectorsData } = useQuery({
    queryKey: ['sandbox-sectors', symbols.join(',')],
    queryFn: () => symbols.length ? getSymbolSectors(symbols) : Promise.resolve({}),
    enabled: symbols.length > 0,
    staleTime: 3_600_000,
  })
  const sectors = sectorsData ?? {}
  const { data: tradesData } = useQuery({
    queryKey: ['sandbox-trades', selectedSymbol],
    queryFn: () => getSandboxTrades(selectedSymbol),
    enabled: !!selectedSymbol && !ibConnected,
    refetchInterval: appSettings.sandbox_trades_ms,
  })
  const selectedPos = positions.find(p => p.symbol === selectedSymbol)
  const selectedPrice = selectedPos ? (getOwnedMarketPrice(selectedPos) ?? 0) : 0

  // portfolio calcs
  const totalEquity = useMemo(() => {
    if (ibConnected && Number.isFinite(Number(accountData?.equity))) {
      return Number(accountData.equity)
    }
    return rawPositions.reduce((s, p) => s + (getOwnedMarketPrice(p) ?? p.avg_cost) * p.shares, 0)
  }, [ibConnected, accountData?.equity, rawPositions, quotesData])
  const totalRealizedPnl = useMemo(() => {
    if (ibConnected && Number.isFinite(Number(accountData?.realized_pnl))) {
      return Number(accountData.realized_pnl)
    }
    return rawPositions.reduce((s, p) => s + (p.realized_pnl ?? 0), 0)
  }, [ibConnected, accountData?.realized_pnl, rawPositions])

  const totalUnrealizedPnl = useMemo(() => {
    if (ibConnected && Number.isFinite(Number(accountData?.unrealized_pnl))) {
      return Number(accountData.unrealized_pnl)
    }
    return rawPositions.reduce((s, p) => s + ((getOwnedMarketPrice(p) ?? p.avg_cost) - p.avg_cost) * p.shares, 0)
  }, [ibConnected, accountData?.unrealized_pnl, rawPositions, quotesData])
  const pieData = useMemo(() => {
    const active = rawPositions.filter((p) => {
      const shares = Number(p.shares ?? 0)
      const alloc = Number(p.allocated_funds ?? 0)
      const pendingShares = Number(p.pending_shares ?? 0)
      // Keep true held positions. For pure pending buys (no settled shares),
      // exclude them from market-value allocation until they settle.
      if (shares > 0) return true
      return alloc > 0 && pendingShares <= 0
    })
    const total = active.reduce((s, p) => {
      const shares = Number(p.shares ?? 0)
      const avgCost = Number(p.avg_cost ?? 0)
      const pendingShares = Number(p.pending_shares ?? 0)
      const pendingAvgCost = Number(p.pending_avg_cost ?? 0)
      const mv = (getOwnedMarketPrice(p) ?? avgCost) * shares
      const committed = avgCost * shares + pendingAvgCost * pendingShares
      const cashRemaining = Math.max(0, Number(p.allocated_funds ?? 0) - committed)
      return s + mv + cashRemaining
    }, 0)
    if (total === 0) return []
    return active.map(p => {
      const shares = Number(p.shares ?? 0)
      const avgCost = Number(p.avg_cost ?? 0)
      const pendingShares = Number(p.pending_shares ?? 0)
      const pendingAvgCost = Number(p.pending_avg_cost ?? 0)
      const mv = (getOwnedMarketPrice(p) ?? avgCost) * shares
      const committed = avgCost * shares + pendingAvgCost * pendingShares
      const cashRemaining = Math.max(0, Number(p.allocated_funds ?? 0) - committed)
      const sliceValue = mv + cashRemaining
      return { symbol: p.symbol, shares, market_value: sliceValue, mv, cash: cashRemaining, pct: pct(sliceValue, total) }
    })
  }, [rawPositions, quotesData])
  const selectedMarketValue = selectedPos ? selectedPrice * selectedPos.shares : 0
  const selectedUnrealised = selectedPos ? selectedMarketValue - selectedPos.avg_cost * selectedPos.shares : 0

  // engine state & analytics
  const { data: engineState } = useQuery({ queryKey: ['sandbox-engine-state'], queryFn: getSandboxEngineState, refetchInterval: appSettings.sandbox_engine_ms })
  const { data: analytics } = useQuery({ queryKey: ['sandbox-analytics'], queryFn: getSandboxAnalytics, refetchInterval: appSettings.sandbox_quotes_ms })
  const { data: realizedMetrics } = useQuery({ queryKey: ['sandbox-realized-metrics'], queryFn: getSandboxRealizedMetrics, refetchInterval: appSettings.sandbox_trades_ms })
  const { data: managerState } = useQuery({ queryKey: ['portfolio-manager-state'], queryFn: getPortfolioManagerState, refetchInterval: appSettings.sandbox_engine_ms })

  // all recent trades (for notification + activity log)
  const { data: allTradesData } = useQuery({
    queryKey: ['sandbox-trades-all'],
    queryFn: () => getSandboxTrades(undefined, 200),
    refetchInterval: appSettings.sandbox_trades_ms,
  })
  const allTrades = allTradesData?.trades ?? []
  const engineTrades = allTrades.filter(t => t.strategy_name)

  // IB trade history – PAPER / LIVE orders persisted in the Trade table
  const { data: ibTradeHistoryData } = useQuery({
    queryKey: ['ib-trade-history', ibMode ?? 'paper'],
    queryFn: () => getTradeHistory(200, (ibMode ?? 'paper').toUpperCase()),
    enabled: ibConnected,
    refetchInterval: appSettings.sandbox_trades_ms,
  })
  const ibTradeHistory = ibTradeHistoryData?.trades ?? []

  const latestNotifiableTrade = useMemo(() => {
    if (ibConnected) {
      const recentIbTrade = ibTradeHistory.find(t => String(t?.status ?? '').toUpperCase() !== 'CANCELLED')
      return recentIbTrade ?? ibTradeHistory[0] ?? null
    }
    return engineTrades[0] ?? null
  }, [ibConnected, ibTradeHistory, engineTrades])

  // Use IB history when connected, sandbox trades when simulated
  const activeTrades = ibConnected ? ibTradeHistory : allTrades
  // Per-symbol trades: IB history filtered by symbol, or sandbox trades
  const trades = ibConnected
    ? ibTradeHistory.filter(t => t.symbol === selectedSymbol)
    : (tradesData?.trades ?? [])

  // On first IB connect (or paper/live mode switch), clear sandbox activity state.
  useEffect(() => {
    const prev = prevIbSessionRef.current
    const switchedIntoIb = ibConnected && !prev.connected
    const switchedIbMode = ibConnected && prev.connected && ibMode !== prev.mode
    if (switchedIntoIb || switchedIbMode) {
      setActivities([])
      prevTradeIdRef.current = null
      tradeFirstSeenRef.current = {}
      ibSyncFirstSeenRef.current = {}
      setTradeMsg(null)
    }
    prevIbSessionRef.current = { connected: ibConnected, mode: ibMode }
  }, [ibConnected, ibMode])

  // Hard reset activity state whenever profile changes: simulated <-> paper/live or paper <-> live.
  useEffect(() => {
    if (prevProfileRef.current !== activeProfile) {
      setActivities([])
      prevTradeIdRef.current = null
      tradeFirstSeenRef.current = {}
      ibSyncFirstSeenRef.current = {}
      setTradeMsg(null)
      prevProfileRef.current = activeProfile
    }
  }, [activeProfile])

  // In IB profiles, avoid synthetic open-order/position snapshot entries.
  // Keep the log focused on persisted trade history + explicit user actions.
  useEffect(() => {
    if (!ibConnected) return
    setActivities(prev => prev.filter(a => a.syncFromIb !== true))
  }, [ibConnected, ibMode, ibOrdersData, ibPositionsData])

  // build activity log entries from trades + mutations
  useEffect(() => {
    if (!activeTrades.length) return
    const newest = activeTrades[0]
    if (newest.id === prevTradeIdRef.current) return
    prevTradeIdRef.current = newest.id
    // Rebuild trade entries for the active profile so status transitions
    // (e.g. PENDING -> FILLED/CANCELLED) are reflected in-place.
    setActivities(prev => {
      const firstSeen = tradeFirstSeenRef.current
      const tradeEntries = activeTrades
        .map(t => {
          const profile = ibConnected ? (t.mode ?? 'PAPER').toLowerCase() : activeProfile
          const status = String(t.status ?? '').toUpperCase()
          const isCancelled = status === 'CANCELLED'
          const createdTs = t.created_at ? new Date(t.created_at).getTime() : Number.NaN
          const fallbackKey = t.id != null
            ? `trade:${t.id}`
            : `order:${t.ib_order_id ?? `${t.symbol}:${t.side}:${t.quantity}:${t.price ?? ''}`}`
          if (firstSeen[fallbackKey] == null) {
            firstSeen[fallbackKey] = Date.now()
          }
          const ts = Number.isFinite(createdTs) && createdTs > 0 ? createdTs : firstSeen[fallbackKey]
          const sub = ibConnected
            ? buildIbTradeNote(t)
            : (t.strategy_name ? `via ${t.strategy_name.split(':')[0]}${t.reason ? ' — ' + t.reason : ''}` : t.reason || undefined)
          return {
            type: 'trade',
            profile,
            tradeId: t.id,
            side: t.side,
            symbol: t.symbol,
            shares: t.quantity ?? null,
            price: t.price ?? null,
            pnl: t.pnl ?? null,
            reason: t.reason ?? null,
            label: `${isCancelled ? 'CANCEL' : t.side} ${t.quantity} ${t.symbol}${
              t.price != null ? ` @ $${Number(t.price).toFixed(2)}` : ''}${
              t.pnl != null ? ` · PnL: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : ''
            }`,
            sub,
            time: new Date(ts).toLocaleTimeString(),
            ts,
          }
        })

      const retained = prev.filter(a => {
        const sameProfile = String(a.profile ?? 'simulated').toLowerCase() === String(activeProfile).toLowerCase()
        // Keep IB sync snapshots (open orders/positions) so inline symbol logs
        // can show activity even when there is no persisted trade record yet.
        if (a.type === 'trade' && sameProfile && !a.syncFromIb) return false
        return true
      })
      return [...tradeEntries, ...retained]
        .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
        .slice(0, 500)
    })
  }, [activeTrades, activeProfile, ibConnected])

  // mutations
  const removeSymbolMut = useMutation({
    mutationFn: async (s) => {
      if (!ibConnected) {
        return removeSandboxSymbol(s)
      }

      // Remove from backend watchlist metadata (and release any idle allocation).
      await removeSandboxSymbol(s)
      return { symbol: s }
    },
    onSuccess: (_, symbol) => {
      const current = readDashboardWatchlist()
      const next = current.filter(sym => sym !== symbol)
      writeDashboardWatchlist(next)
      setIbWatchlistSymbols(next)
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      setSelectedSymbol(prev => (prev === symbol ? null : prev))
    },
  })
  const updatePosMut = useMutation({
    mutationFn: ({ symbol, payload }) => updateSandboxPosition(symbol, payload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sandbox-positions'] }); qc.invalidateQueries({ queryKey: ['sandbox-account'] }) },
  })
  const tradeMut = useMutation({
    mutationFn: async (p) => {
      if (p.mode === 'simulated') {
        return placeSandboxTrade(p)
      }

      if (!ibConnected) {
        throw new Error('Not connected to Interactive Brokers. Connect first.')
      }

      const limitPrice = Number.isFinite(p.price) && p.price > 0 ? p.price : null
      const orderType = limitPrice != null ? 'LMT' : 'MKT'

      return placeOrder({
        symbol: p.symbol,
        side: p.side,
        quantity: p.quantity,
        mode: p.mode.toUpperCase(),
        order_type: orderType,
        limit_price: limitPrice,
        strategy_name: p.strategy_name,
      })
    },
    onSuccess: d => {
      if (d.trade_id != null) {
        setTradeMsg({ type: 'success', text: `${d.side} ${d.quantity} ${d.symbol} @ $${d.price.toFixed(2)}${d.pnl != null ? ` — PnL: ${fmt(d.pnl)}` : ''}` })
      } else {
        const enteredReason = tradeForm.reason?.trim() || ''
        setTradeMsg({
          type: 'success',
          text: `${d.side} ${d.quantity} ${d.symbol} submitted to ${activeProfileRef.current.toUpperCase()} IB (${d.order_type ?? 'MKT'}${d.limit_price != null ? ` @ $${Number(d.limit_price).toFixed(2)}` : ''})${d.ib_order_id != null ? ` · Order #${d.ib_order_id}` : ''}`,
        })
        setActivities(prev => [{
          type: 'trade',
          profile: activeProfileRef.current,
          tradeId: d.id,
          side: d.side,
          label: `Order submitted ${d.side} ${d.quantity} ${d.symbol}`,
          reason: enteredReason || null,
          sub: buildIbTradeNote({
            ib_order_id: d.ib_order_id,
            status: d.status,
            order_type: d.order_type,
            limit_price: d.limit_price,
            strategy_name: selectedPos?.strategy_name,
            reason: enteredReason,
          }),
          time: new Date().toLocaleTimeString(),
          ts: Date.now(),
        }, ...prev].slice(0, 500))
      }
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['ib-orders'] })
      qc.invalidateQueries({ queryKey: ['ib-positions'] })
      qc.invalidateQueries({ queryKey: ['ib-trade-history'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades', selectedSymbol] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades-all'] })
      setTradeForm(f => ({ ...f, quantity: '', reason: 'manual' }))
    },
    onError: e => setTradeMsg({ type: 'error', text: e.response?.data?.detail || e.message }),
  })
  const resetMut = useMutation({
    mutationFn: resetSandbox,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades'] })
      setActivities(prev => prev.filter(a => (a.profile ?? 'simulated') !== 'simulated'))
      prevTradeIdRef.current = null
      tradeFirstSeenRef.current = {}
      setSelectedSymbol(null); setResetConfirm(false)
    },
  })
  const resetSoftMut = useMutation({
    mutationFn: resetSandboxSoft,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades'] })
      setActivities(prev => prev.filter(a => (a.profile ?? 'simulated') !== 'simulated'))
      prevTradeIdRef.current = null
      tradeFirstSeenRef.current = {}
      setSelectedSymbol(null); setResetSoftConfirm(false)
    },
  })
  const toggleEngineMut = useMutation({
    mutationFn: s => toggleSandboxEngine(s),
    onSuccess: (data, symbol) => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      const pos = positions.find(p => p.symbol === symbol)
      const nowEnabled = !pos?.strategy_enabled
      setActivities(prev => [{
        type: 'engine',
        profile: activeProfileRef.current,
        label: `${symbol} engine ${nowEnabled ? 'started' : 'stopped'}`,
        sub: pos?.strategy_name?.split(':')[0],
        time: new Date().toLocaleTimeString(),
        ts: Date.now(),
      }, ...prev].slice(0, 500))
    },
  })
  const toggleAllEnginesMut = useMutation({
    mutationFn: toggleAllSandboxEngines,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-engine-state'] })
      setActivities(prev => [{
        type: 'engine',
        profile: activeProfileRef.current,
        label: 'All sandbox engines toggled',
        time: new Date().toLocaleTimeString(),
        ts: Date.now(),
      }, ...prev].slice(0, 500))
    },
  })
  const toggleManagerMut = useMutation({
    mutationFn: togglePortfolioManager,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] })
      const enabled = data?.settings?.enabled ?? data?.enabled
      setActivities(prev => [{
        type: 'manager',
        profile: activeProfileRef.current,
        label: `Portfolio Manager ${enabled ? 'enabled' : 'disabled'}`,
        time: new Date().toLocaleTimeString(),
        ts: Date.now(),
      }, ...prev].slice(0, 500))
    },
  })
  const setIbModeMut = useMutation({
    mutationFn: mode => setIBMode(mode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ib-status'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-analytics'] })
    },
  })
  const ibConnectMut = useMutation({
    mutationFn: () => connectIB(),
    onMutate: () => {
      setActivities([])
      prevTradeIdRef.current = null
      tradeFirstSeenRef.current = {}
    },
    onSuccess: () => {
      setActivities([])
      prevTradeIdRef.current = null
      tradeFirstSeenRef.current = {}
      qc.invalidateQueries({ queryKey: ['ib-status'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades-all'] })
      qc.invalidateQueries({ queryKey: ['sandbox-analytics'] })
    },
  })
  const ibDisconnectMut = useMutation({
    mutationFn: () => disconnectIB(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ib-status'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades-all'] })
      qc.invalidateQueries({ queryKey: ['sandbox-analytics'] })
    },
  })
  const cancelOrderMut = useMutation({
    mutationFn: async (ibOrderId) => {
      const result = await cancelOrder(ibOrderId)
      if (result?.error) {
        throw new Error(result.error)
      }
      return result
    },
    onSuccess: (data) => {
      setTradeMsg({ type: 'success', text: `Cancel submitted for order #${data?.cancelled ?? 'unknown'}` })
      qc.invalidateQueries({ queryKey: ['ib-orders'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades-all'] })
    },
    onError: (err) => {
      setTradeMsg({ type: 'error', text: err.response?.data?.detail || err.message })
    },
  })
  const paperResetMut = useMutation({
    mutationFn: () => resetIBPaperPortfolio(),
    onSuccess: (data) => {
      setPaperResetConfirm(false)
      setActivities(prev => prev.filter(a => (a.profile ?? 'simulated') !== 'paper'))
      prevTradeIdRef.current = null
      tradeFirstSeenRef.current = {}
      // Drop cached IB history immediately so old rows can't repopulate activity.
      qc.removeQueries({ queryKey: ['ib-trade-history'] })
      qc.setQueryData(['ib-trade-history', 'paper'], { trades: [] })
      setImportMsg({
        type: 'success',
        text: `Paper reset submitted: ${data.cancelled_orders ?? 0} order(s) cancelled, ${data.flatten_orders ?? 0} flatten order(s) placed, ${data.deleted_trade_rows ?? 0} paper trade row(s) cleared.`,
      })
      qc.invalidateQueries({ queryKey: ['ib-status'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['ib-orders'] })
      qc.invalidateQueries({ queryKey: ['ib-positions'] })
      qc.invalidateQueries({ queryKey: ['ib-trade-history'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades-all'] })
      qc.invalidateQueries({ queryKey: ['sandbox-analytics'] })
    },
    onError: (err) => {
      setImportMsg({ type: 'error', text: err.response?.data?.detail || err.message })
      setPaperResetConfirm(false)
    },
  })
  const bulkStrategyMut = useMutation({
    mutationFn: (strategyName) => bulkUpdateSandboxStrategy(strategyName),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      setBulkStratOpen(false)
      setActivities(prev => [{
        type: 'engine',
        profile: activeProfileRef.current,
        label: `Strategy updated for all ${data.updated} position${data.updated !== 1 ? 's' : ''}`,
        sub: data.strategy_name ?? 'none',
        time: new Date().toLocaleTimeString(),
        ts: Date.now(),
      }, ...prev].slice(0, 500))
    },
  })
  const bulkCapMut = useMutation({
    mutationFn: (payload) => bulkUpdateSandboxAllocationCap(payload),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      setActivities(prev => [{
        type: 'engine',
        profile: activeProfileRef.current,
        label: `Allocation cap updated for all ${data.updated} position${data.updated !== 1 ? 's' : ''}`,
        sub: `${data.max_allocation_mode} ${data.max_allocation_mode === 'percent' ? `${Number(data.max_allocation_value).toFixed(2)}%` : `$${Number(data.max_allocation_value).toFixed(2)}`}`,
        time: new Date().toLocaleTimeString(),
        ts: Date.now(),
      }, ...prev].slice(0, 500))
    },
  })

  // handlers
  function handleEditStratOpen() {
    const d = decodeStrategy(selectedPos?.strategy_name)
    setEditStratType(d.type); setEditStratParams(d.params); setEditScriptId(d.scriptId); setEditTemplateFilename(d.templateFilename); setEditingStrategy(true)
  }
  function handleEditStratChange(type) {
    setEditStratType(type)
    if (type !== CUSTOM_SCRIPT_KEY && type !== TEMPLATE_SCRIPT_KEY) setEditStratParams(defaultParams(type))
  }
  function handleEditStratSave() {
    updatePosMut.mutate({ symbol: selectedSymbol, payload: { strategy_name: encodeStrategy(editStratType, editStratParams, editScriptId, editTemplateFilename) } })
    setEditingStrategy(false)
  }
  function handleBulkStratOpen() {
    setBulkStratType('sma_crossover')
    setBulkScriptId(null)
    setBulkTemplateFilename(null)
    setBulkStratParams(defaultParams('sma_crossover'))
    setBulkStratOpen(true)
  }
  function handleBulkStratApply() {
    const encoded = encodeStrategy(bulkStratType, bulkStratParams, bulkScriptId, bulkTemplateFilename)
    bulkStrategyMut.mutate(encoded)
  }
  function handleTrade(e) {
    e.preventDefault(); setTradeMsg(null)
    tradeMut.mutate({
      symbol: selectedSymbol,
      side: tradeForm.side,
      quantity: parseFloat(tradeForm.quantity),
      price: parseFloat(tradeForm.price) || selectedPrice,
      strategy_name: selectedPos?.strategy_name,
      reason: tradeForm.reason?.trim() || 'manual',
      mode: activeProfileRef.current,
    })
  }
  function handleIbWatchlistAdd(symbol) {
    const sym = (symbol || '').trim().toUpperCase()
    if (!sym) return { added: false, error: 'Symbol is required.' }

    const current = readDashboardWatchlist()
    if (current.includes(sym)) return { added: false, error: 'Already in watchlist.' }

    if (current.length < WATCHLIST_SYMBOL_LIMIT) {
      const next = normalizeSymbolList([...current, sym])
      writeDashboardWatchlist(next)
      setIbWatchlistSymbols(next)
      return { added: true, downgraded: false }
    }

    const oldest = current[0]
    const confirmed = window.confirm(
      `Watchlist limit is ${WATCHLIST_SYMBOL_LIMIT} symbols. Add ${sym} by replacing ${oldest} and reduce refresh to 15s?`
    )
    if (!confirmed) return { added: false, cancelled: true }

    setSetting('quotes_refresh_ms', 15_000)
    setSetting('sandbox_quotes_ms', 15_000)
    const next = normalizeSymbolList([...current.slice(1), sym])
    writeDashboardWatchlist(next)
    setIbWatchlistSymbols(next)
    return { added: true, downgraded: true, replaced: oldest }
  }
  async function handleExport() {
    // In IB mode (paper or live): export the in-memory activity log as CSV
    if (ibConnected) {
      const mode = ibMode ?? 'paper'
      const rows = activities.filter(a => String(a.profile ?? 'simulated').toLowerCase() === String(activeProfile).toLowerCase())
      const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`
      const header = 'Time,Type,Side,Label,Sub'
      const body = rows.map(a =>
        [escape(a.time), escape(a.type), escape(a.side ?? ''), escape(a.label), escape(a.sub ?? '')].join(',')
      ).join('\n')
      const csv = header + '\n' + body
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ib_${mode}_activity_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      return
    }

    // Simulated mode: export full sandbox JSON snapshot
    setExportLoading(true)
    try {
      const response = await exportSandbox()
      const url = URL.createObjectURL(response.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `sandbox_export_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) { console.error('Export failed', err) }
    finally { setExportLoading(false) }
  }
  async function handleImport(e) {
    const file = e.target.files?.[0]; if (!file) return
    setImportMsg(null)
    try {
      const result = await importSandbox(file)
      setImportMsg({ type: 'success', text: `Imported ${result.imported_positions} positions, ${result.imported_trades} trades. Funds: ${fmtMoney(result.total_funds)}` })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades'] })
      setSelectedSymbol(null)
    } catch (err) { setImportMsg({ type: 'error', text: err.response?.data?.detail || err.message }) }
    e.target.value = ''
  }

  function handleSelectSymbol(symbol) {
    setActiveMainTab('summary')
    setSelectedSymbol(symbol)
    setTradeMsg(null)
    setEditingStrategy(false)
  }

  const visibleActivities = useMemo(
    () => activities.filter(a => String(a.profile ?? 'simulated').toLowerCase() === String(activeProfile).toLowerCase()),
    [activities, activeProfile],
  )

  return (
    <div className="flex h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] overflow-hidden">
      <TradeNotificationBanner latestEngineTrade={latestNotifiableTrade} />
      <ActivityLog activities={visibleActivities} />

      <SandboxSidebar
        ibMode={ibMode}
        accountData={accountData}
        engineState={engineState}
        totalEquity={totalEquity}
        totalUnrealizedPnl={totalUnrealizedPnl}
        totalRealizedPnl={totalRealizedPnl}
        managerSettings={managerState?.settings ?? null}
        positions={positions}
        quotes={quotes}
        sectors={sectors}
        selectedSymbol={selectedSymbol}
        pmScores={managerState?.scores ?? {}}
        toggleEngineMut={toggleEngineMut}
        onSelectSymbol={handleSelectSymbol}
        onShowOverview={() => { setActiveMainTab('summary'); handleSelectSymbol(null) }}
        onAddIbWatchlistSymbol={handleIbWatchlistAdd}
      />

      {/* Right panel */}
      <main className="flex-1 overflow-y-auto bg-dark-900 min-h-0">
        <div className="sticky top-0 z-30 border-b border-dark-700 bg-dark-900/85 backdrop-blur-xl backdrop-saturate-150 shadow-[0_8px_24px_rgba(0,0,0,0.22)] supports-[backdrop-filter]:bg-dark-900/70">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-6 py-2.5 border-b border-dark-700/80 bg-dark-800/50">
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              <div className="inline-flex items-center rounded-lg border border-dark-600 overflow-hidden shrink-0">
                <button
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    activeMainTab === 'summary'
                      ? 'bg-emerald-900/30 text-emerald-300'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                  }`}
                  onClick={() => setActiveMainTab('summary')}
                >
                  Portfolio Summary
                </button>
                <button
                  className={`px-3 py-1.5 text-xs font-semibold border-l border-dark-600 transition-colors ${
                    activeMainTab === 'manager'
                      ? 'bg-violet-900/30 text-violet-300'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                  }`}
                  onClick={() => setActiveMainTab('manager')}
                >
                  Portfolio Manager
                </button>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">
                  {ibMode === 'live' ? 'Live Mode — IB Connected' : ibMode === 'paper' ? 'Paper Mode — IB Connected' : 'Portfolio Simulation'}
                </span>
                {ibMode && (
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                    ibMode === 'live'
                      ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700/40'
                      : 'bg-blue-900/40 text-blue-400 border border-blue-700/40'
                  }`}>
                    <SignalIcon className="h-3 w-3" />{ibMode === 'live' ? 'LIVE IB' : 'PAPER IB'}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 mr-1">
                <div className="inline-flex items-center rounded-md border border-dark-500 overflow-hidden">
                  <button
                    className={`text-[10px] px-2 py-1 font-semibold transition-colors ${
                      ibSelectedMode === 'paper'
                        ? 'bg-blue-900/35 text-blue-300'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                    }`}
                    onClick={() => setIbModeMut.mutate('paper')}
                    disabled={setIbModeMut.isPending || ibSelectedMode === 'paper'}
                    title="Switch IB mode to paper"
                  >
                    Paper
                  </button>
                  <button
                    className={`text-[10px] px-2 py-1 font-semibold transition-colors border-l border-dark-500 ${
                      ibSelectedMode === 'live'
                        ? 'bg-emerald-900/35 text-emerald-300'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                    }`}
                    onClick={() => setIbModeMut.mutate('live')}
                    disabled={setIbModeMut.isPending || ibSelectedMode === 'live'}
                    title="Switch IB mode to live"
                  >
                    Live
                  </button>
                </div>
                <button
                  className={`text-[10px] border rounded-md px-2.5 py-1 font-semibold transition-colors disabled:opacity-50 ${
                    ibConnected
                      ? 'border-red-700/50 text-red-300 hover:bg-red-900/20'
                      : 'border-emerald-700/50 text-emerald-300 hover:bg-emerald-900/20'
                  }`}
                  onClick={() => (ibConnected ? ibDisconnectMut.mutate() : ibConnectMut.mutate())}
                  disabled={ibConnectMut.isPending || ibDisconnectMut.isPending || setIbModeMut.isPending}
                  title={ibConnected ? 'Disconnect Interactive Brokers' : `Connect Interactive Brokers (${ibSelectedMode})`}
                >
                  {ibConnectMut.isPending || ibDisconnectMut.isPending
                    ? '…'
                    : ibConnected
                      ? 'Disconnect'
                      : 'Connect'}
                </button>
              </div>
              {(() => {
                const withStrat = positions.filter(p => p.strategy_name)
                const allRunning = withStrat.length > 0 && withStrat.every(p => p.strategy_enabled)
                return withStrat.length > 0 ? (
                  <button
                    className={`flex items-center gap-1.5 text-xs border rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 ${
                      allRunning
                        ? 'border-emerald-700/50 text-emerald-400 hover:bg-emerald-900/20'
                        : 'border-slate-600 text-slate-300 hover:bg-dark-700'
                    }`}
                    onClick={() => toggleAllEnginesMut.mutate()}
                    disabled={toggleAllEnginesMut.isPending}
                    title={allRunning ? 'Stop all strategy engines' : 'Start all strategy engines'}
                  >
                    <SignalIcon className="h-3.5 w-3.5" />
                    {toggleAllEnginesMut.isPending ? '…' : allRunning ? 'Stop All Engines' : 'Start All Engines'}
                  </button>
                ) : null
              })()}
              {positions.length > 0 && (
                <button
                  className="flex items-center gap-1.5 text-xs border border-sky-700/50 text-sky-400 hover:bg-sky-900/20 rounded-lg px-3 py-1.5 transition-colors"
                  onClick={handleBulkStratOpen}
                  title="Apply one strategy to all sandbox positions"
                >
                  <RectangleGroupIcon className="h-3.5 w-3.5" />
                  Set Strategy for All
                </button>
              )}
              {/* Portfolio Manager toggle */}
              {(() => {
                const pmEnabled = managerState?.settings?.enabled ?? false
                return (
                  <button
                    className={`flex items-center gap-1.5 text-xs border rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 ${
                      pmEnabled
                        ? 'border-violet-700/50 text-violet-400 hover:bg-violet-900/20'
                        : 'border-slate-600 text-slate-300 hover:bg-dark-700'
                    }`}
                    onClick={() => toggleManagerMut.mutate()}
                    disabled={toggleManagerMut.isPending}
                    title={pmEnabled ? 'Disable portfolio manager' : 'Enable portfolio manager'}
                  >
                    <CpuChipIcon className="h-3.5 w-3.5" />
                    {toggleManagerMut.isPending ? '…' : pmEnabled ? 'Manager On' : 'Manager Off'}
                  </button>
                )
              })()}
              <button className="flex items-center gap-1.5 text-xs border border-dark-500 text-slate-400 hover:text-slate-200 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
                onClick={handleExport} disabled={exportLoading}
                title={ibConnected ? `Export ${(ibMode ?? 'paper').toUpperCase()} activity log as CSV` : 'Export sandbox as JSON'}>
                <ArrowDownTrayIcon className="h-3.5 w-3.5" />{exportLoading ? 'Exporting…' : ibConnected ? 'Export Activity' : 'Export'}
              </button>
              <button className="flex items-center gap-1.5 text-xs border border-dark-500 text-slate-400 hover:text-slate-200 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors"
                onClick={() => importInputRef.current?.click()} title="Import sandbox from JSON">
                <ArrowUpTrayIcon className="h-3.5 w-3.5" />Import
              </button>
              <input ref={importInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
              {ibMode === 'live' ? null : ibMode === 'paper' ? (
                paperResetConfirm ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-amber-400">Reset paper portfolio on IB?</span>
                    <button
                      className="text-xs bg-amber-700 hover:bg-amber-600 text-white rounded-lg px-2.5 py-1.5 font-semibold transition-colors disabled:opacity-50"
                      onClick={() => paperResetMut.mutate()}
                      disabled={paperResetMut.isPending}
                    >
                      {paperResetMut.isPending ? 'Resetting…' : 'Yes, Reset Paper'}
                    </button>
                    <button
                      className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-lg px-2.5 py-1.5 transition-colors"
                      onClick={() => setPaperResetConfirm(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="flex items-center gap-1.5 text-xs border border-amber-900/40 text-amber-400/80 hover:text-amber-300 rounded-lg px-3 py-1.5 transition-colors hover:bg-amber-900/10 disabled:opacity-50"
                    onClick={() => setPaperResetConfirm(true)}
                    disabled={paperResetMut.isPending}
                    title="Cancel open orders and flatten all paper positions"
                  >
                    <ArrowPathIcon className="h-3.5 w-3.5" />Reset Paper Portfolio
                  </button>
                )
              ) : resetConfirm ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-red-400">Full reset — are you sure?</span>
                  <button className="text-xs bg-red-700 hover:bg-red-600 text-white rounded-lg px-2.5 py-1.5 font-semibold transition-colors disabled:opacity-50"
                    onClick={() => resetMut.mutate()} disabled={resetMut.isPending}>
                    {resetMut.isPending ? 'Resetting…' : 'Yes, Reset All'}
                  </button>
                  <button className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-lg px-2.5 py-1.5 transition-colors"
                    onClick={() => setResetConfirm(false)}>Cancel</button>
                </div>
              ) : resetSoftConfirm ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-amber-400">Keep symbols, reset data?</span>
                  <button className="text-xs bg-amber-700 hover:bg-amber-600 text-white rounded-lg px-2.5 py-1.5 font-semibold transition-colors disabled:opacity-50"
                    onClick={() => resetSoftMut.mutate()} disabled={resetSoftMut.isPending}>
                    {resetSoftMut.isPending ? 'Resetting…' : 'Yes, Soft Reset'}
                  </button>
                  <button className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-lg px-2.5 py-1.5 transition-colors"
                    onClick={() => setResetSoftConfirm(false)}>Cancel</button>
                </div>
              ) : (
                <div className="relative">
                  {showResetMenu && (
                    <div className="fixed inset-0 z-40" onClick={() => setShowResetMenu(false)} />
                  )}
                  <div className="flex items-center border border-red-900/40 rounded-lg overflow-visible">
                    <button
                      className="flex items-center gap-1.5 text-xs text-red-400/70 hover:text-red-400 px-3 py-1.5 transition-colors hover:bg-red-900/10"
                      onClick={() => setShowResetMenu(v => !v)}
                      title="Reset portfolio options">
                      <ArrowPathIcon className="h-3.5 w-3.5" />Reset Portfolio
                    </button>
                    <button
                      className="text-xs text-red-400/50 hover:text-red-400 px-1.5 py-1.5 border-l border-red-900/40 transition-colors hover:bg-red-900/10"
                      onClick={() => setShowResetMenu(v => !v)}
                      title="More reset options"
                    >▾</button>
                  </div>
                  {showResetMenu && (
                    <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-dark-800 border border-dark-500 rounded-lg shadow-xl overflow-hidden">
                      <button
                        className="w-full text-left flex items-start gap-2 px-3 py-2.5 text-xs hover:bg-dark-700 transition-colors"
                        onClick={() => { setShowResetMenu(false); setResetSoftConfirm(true) }}
                      >
                        <div>
                          <div className="text-amber-400 font-semibold mb-0.5">Soft Reset</div>
                          <div className="text-slate-500">Keep symbols &amp; allocations, clear shares, trades, and PnL</div>
                        </div>
                      </button>
                      <div className="border-t border-dark-600" />
                      <button
                        className="w-full text-left flex items-start gap-2 px-3 py-2.5 text-xs hover:bg-dark-700 transition-colors"
                        onClick={() => { setShowResetMenu(false); setResetConfirm(true) }}
                      >
                        <div>
                          <div className="text-red-400 font-semibold mb-0.5">Full Reset</div>
                          <div className="text-slate-500">Wipe everything — symbols, trades, funds</div>
                        </div>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

        </div>

        {importMsg && (
          <div className={`mx-6 mt-4 flex items-center justify-between gap-3 p-3 rounded-lg text-sm border ${importMsg.type === 'success' ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400' : 'bg-red-900/20 border-red-700/30 text-red-400'}`}>
            <span>{importMsg.text}</span>
            <button onClick={() => setImportMsg(null)} className="text-slate-500 hover:text-slate-300 flex-shrink-0"><XMarkIcon className="h-4 w-4" /></button>
          </div>
        )}

        <div className="p-6 pb-28 space-y-6">
          {activeMainTab === 'manager' ? (
            <PortfolioManagerPanel
              profile={activeProfile}
              onShowOverview={() => { setActiveMainTab('summary'); setSelectedSymbol(null) }}
              onSelectSymbol={(sym) => { setActiveMainTab('summary'); handleSelectSymbol(sym) }}
            />
          ) : !selectedSymbol ? (
            <PortfolioOverview
              ibMode={ibMode}
              accountData={accountData}
              positions={positions}
              positionsRefreshing={isAccountFetching || isPositionsFetching}
              ibPositions={ibConnected ? (ibPositionsData?.positions ?? []) : []}
              quotes={quotes}
              totalEquity={totalEquity}
              totalUnrealizedPnl={totalUnrealizedPnl}
              totalRealizedPnl={totalRealizedPnl}
              pieData={pieData}
              analytics={analytics}
              realizedMetrics={realizedMetrics}
              allTrades={activeTrades}
              activities={visibleActivities}
              pmScores={managerState?.scores ?? {}}
              managerSettings={managerState?.settings ?? null}
              onOpenManager={activeMainTab === 'summary' ? () => setActiveMainTab('manager') : null}
              onSelectSymbol={handleSelectSymbol}
            />
          ) : !selectedPos ? (
            <div className="text-slate-500 text-sm">Loading…</div>
          ) : (
            <PositionDetail
              ibMode={ibMode}
              ibOrders={ibConnected ? (ibOrdersData?.orders ?? []) : []}
              selectedSymbol={selectedSymbol}
              selectedPos={selectedPos}
              selectedPrice={selectedPrice}
              selectedMarketValue={selectedMarketValue}
              selectedUnrealised={selectedUnrealised}
              accountData={accountData}
              quotes={quotes}
              trades={trades}
              activities={visibleActivities}
              engineState={engineState}
              editingStrategy={editingStrategy}
              setEditingStrategy={setEditingStrategy}
              editStratType={editStratType}
              editScriptId={editScriptId}
              setEditScriptId={setEditScriptId}
              editTemplateFilename={editTemplateFilename}
              setEditTemplateFilename={setEditTemplateFilename}
              editStratParams={editStratParams}
              setEditStratParams={setEditStratParams}
              handleEditStratOpen={handleEditStratOpen}
              handleEditStratChange={handleEditStratChange}
              handleEditStratSave={handleEditStratSave}
              editingAlloc={editingAlloc}
              setEditingAlloc={setEditingAlloc}
              allocInput={allocInput}
              setAllocInput={setAllocInput}
              updatePosMut={updatePosMut}
              bulkCapMut={bulkCapMut}
              positionsCount={positions.length}
              removeSymbolMut={removeSymbolMut}
              toggleEngineMut={toggleEngineMut}
              tradeForm={tradeForm}
              setTradeForm={setTradeForm}
              tradeMsg={tradeMsg}
              setTradeMsg={setTradeMsg}
              handleTrade={handleTrade}
              tradeMut={tradeMut}
              cancelOrderMut={cancelOrderMut}
              managerSettings={managerState?.settings ?? null}
            />
          )}
        </div>
      </main>

      <BulkStrategyModal
        open={bulkStratOpen}
        positionsCount={positions.length}
        bulkStratType={bulkStratType}
        bulkScriptId={bulkScriptId}
        bulkTemplateFilename={bulkTemplateFilename}
        bulkStratParams={bulkStratParams}
        bulkStrategyMut={bulkStrategyMut}
        setBulkStratOpen={setBulkStratOpen}
        setBulkStratType={setBulkStratType}
        setBulkScriptId={setBulkScriptId}
        setBulkTemplateFilename={setBulkTemplateFilename}
        setBulkStratParams={setBulkStratParams}
        handleBulkStratApply={handleBulkStratApply}
      />
    </div>
  )
}
