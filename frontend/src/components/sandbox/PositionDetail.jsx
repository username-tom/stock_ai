import {
  TrashIcon, PencilSquareIcon, CheckIcon, XMarkIcon,
  ArrowUpIcon, ArrowDownIcon, BoltIcon, PlayIcon, StopCircleIcon,
  ClockIcon, SignalIcon, ExclamationTriangleIcon, ArrowTopRightOnSquareIcon,
  BanknotesIcon, ArrowsRightLeftIcon, ArrowPathIcon, ChevronDownIcon,
} from '@heroicons/react/24/outline'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getScripts, getHistory, getSandboxFundEvents } from '../../api/client'
import { useAppSettings } from '../../hooks/useAppSettings'
import { backfillTradeAvgPrice, fmt, fmtMoney, stratLabel } from './sandboxHelpers'
import StrategySelector from './StrategySelector'
import TradeRow from './TradeRow'
import CandlestickChart from '../charts/CandlestickChart'
import SymbolDetailPanel from '../dashboard/SymbolDetailPanel'

export default function PositionDetail({
  ibMode,
  ibOrders = [],
  selectedSymbol,
  selectedPos,
  selectedPrice,
  selectedMarketValue,
  selectedUnrealised,
  quotes,
  trades,
  activities = [],
  engineState,
  editingStrategy,
  setEditingStrategy,
  editStratType,
  editScriptId,
  setEditScriptId,
  editTemplateFilename,
  setEditTemplateFilename,
  editStratParams,
  setEditStratParams,
  handleEditStratOpen,
  handleEditStratChange,
  handleEditStratSave,
  editingAlloc,
  setEditingAlloc,
  allocInput,
  setAllocInput,
  updatePosMut,
  bulkCapMut,
  positionsCount = 0,
  removeSymbolMut,
  toggleEngineMut,
  tradeForm,
  setTradeForm,
  tradeMsg,
  setTradeMsg,
  handleTrade,
  tradeMut,
  cancelOrderMut,
  accountData,
  managerSettings = null,
}) {
  const navigate = useNavigate()
  const appSettings = useAppSettings()
  const openOrdersPanelEnabled = appSettings.open_orders_panel_enabled !== false
  const openOrdersCountdownEnabled = appSettings.open_orders_countdown_enabled !== false
  const openOrdersPriceHelperEnabled = appSettings.open_orders_price_helper_enabled !== false
  const openOrdersExpiringSoonMin = Math.max(1, Number(appSettings.open_orders_expiring_soon_min ?? 30))
  const isSimulated = !ibMode
  const { data: scriptsData } = useQuery({ queryKey: ['scripts'], queryFn: getScripts, staleTime: 60000 })
  const scripts = scriptsData?.scripts ?? []

  const { data: histData } = useQuery({
    queryKey: ['history', selectedSymbol, '1d'],
    queryFn: () => getHistory(selectedSymbol, '1d'),
    staleTime: 60000,
    refetchInterval: appSettings.portfolio_detail_ms,
    enabled: !!selectedSymbol,
  })
  const chartData = histData?.data ?? []
  const prevClose = quotes?.[selectedSymbol]?.previous_close ?? histData?.prev_close ?? null
  const selectedShares = Number(selectedPos?.shares ?? 0)
  const hasPosition = Math.abs(selectedShares) > 0
  const isLongPosition = selectedShares > 0
  const marketEdgePct = hasPosition && Number(selectedPos?.avg_cost) > 0 && Number(selectedPrice) > 0
    ? (((Number(selectedPrice) - Number(selectedPos.avg_cost)) / Number(selectedPos.avg_cost)) * 100) * (isLongPosition ? 1 : -1)
    : null

  const { data: fundEventsData } = useQuery({
    queryKey: ['sandbox-fund-events'],
    queryFn: getSandboxFundEvents,
    refetchInterval: appSettings.portfolio_detail_ms,
    enabled: isSimulated,
  })
  const fundEvents = isSimulated ? (fundEventsData?.events ?? []) : []
  const dayLow = quotes?.[selectedSymbol]?.day_low ?? null
  const dayHigh = quotes?.[selectedSymbol]?.day_high ?? null
  const hasDayRange = dayLow != null && dayHigh != null && dayHigh > dayLow
  const typedPrice = Number.parseFloat(tradeForm.price)
  const fallbackPrice = Number.isFinite(selectedPrice) ? selectedPrice : dayLow
  const resolvedTradePrice = Number.isFinite(typedPrice) ? typedPrice : fallbackPrice
  const priceInputValue = tradeForm.price || (Number.isFinite(selectedPrice) && selectedPrice > 0 ? selectedPrice.toFixed(2) : '')
  const sliderPrice = hasDayRange
    ? Math.min(dayHigh, Math.max(dayLow, resolvedTradePrice ?? dayLow))
    : null
  const openOrdersForSymbol = useMemo(
    () => {
      const symbol = String(selectedSymbol ?? '').toUpperCase()

      const liveOrders = (ibOrders ?? [])
        .filter(o => String(o?.symbol ?? '').toUpperCase() === symbol)
        .map(o => ({
          ...o,
          _source: 'ib-orders',
        }))

      const knownOrderIds = new Set(
        liveOrders
          .map(o => Number(o?.ib_order_id))
          .filter(Number.isFinite),
      )

      const historyPending = (trades ?? [])
        .filter(t => String(t?.symbol ?? '').toUpperCase() === symbol)
        .filter(t => String(t?.status ?? '').toUpperCase() === 'PENDING')
        .filter(t => Number.isFinite(Number(t?.ib_order_id)))
        .filter(t => !knownOrderIds.has(Number(t.ib_order_id)))
        .map(t => ({
          ib_order_id: Number(t.ib_order_id),
          symbol,
          side: String(t?.side ?? '').toUpperCase() || 'BUY',
          quantity: Number(t?.quantity ?? 0),
          remaining: Number(t?.quantity ?? 0),
          status: 'PENDING',
          order_type: Number.isFinite(Number(t?.price)) && Number(t.price) > 0 ? 'LMT' : 'MKT',
          limit_price: Number.isFinite(Number(t?.price)) && Number(t.price) > 0 ? Number(t.price) : null,
          tif: 'DAY',
          created_at: t?.created_at ?? null,
          _source: 'trade-history',
        }))

      return [...liveOrders, ...historyPending]
    },
    [ibOrders, trades, selectedSymbol],
  )
  const openOrderPriceLevels = useMemo(() => {
    const levels = openOrdersForSymbol
      .filter(o => Number.isFinite(Number(o.limit_price)) && Number(o.limit_price) > 0)
      .map(o => ({
        ib_order_id: o.ib_order_id,
        price: Number(o.limit_price),
        remaining: Number(o.remaining ?? o.quantity ?? 0),
        quantity: Number(o.quantity ?? 0),
        side: o.side,
      }))
    const unique = []
    const seen = new Set()
    for (const row of levels) {
      const key = `${row.side}:${row.price.toFixed(2)}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(row)
    }
    return unique.sort((a, b) => a.price - b.price)
  }, [openOrdersForSymbol])
  const [priceLevelIdx, setPriceLevelIdx] = useState(-1)

  const [posSettingsOpen, setPosSettingsOpen] = useState(false)
  const [maxAllocMode, setMaxAllocMode] = useState(selectedPos?.max_allocation_mode ?? 'dollar')
  const [maxAllocValue, setMaxAllocValue] = useState(
    selectedPos?.max_allocation_value != null
      ? String(selectedPos.max_allocation_value)
      : '',
  )
  const [capNotice, setCapNotice] = useState(null)
  const [activityPage, setActivityPage] = useState(0)
  const [sentimentMode, setSentimentMode] = useState(selectedPos?.sentiment_mode ?? 'none')
  const minFundsMode = managerSettings?.min_position_funds_mode ?? 'dollar'
  const minFundsDollar = minFundsMode === 'percent'
    ? ((Number(accountData?.total_funds) || 0) * (Number(managerSettings?.min_position_funds_pct ?? 1) / 100))
    : Number(managerSettings?.min_position_funds ?? 0)

  // Auto-update trade price when live quote changes
  useEffect(() => {
    if (selectedPrice > 0) {
      setTradeForm(f => ({ ...f, price: selectedPrice.toFixed(2) }))
    }
  }, [selectedPrice])

  useEffect(() => {
    setMaxAllocMode(selectedPos?.max_allocation_mode ?? 'dollar')
    setMaxAllocValue(selectedPos?.max_allocation_value != null ? String(selectedPos.max_allocation_value) : '')
    setSentimentMode(selectedPos?.sentiment_mode ?? 'none')
    setCapNotice(null)
  }, [selectedPos?.symbol, selectedPos?.max_allocation_mode, selectedPos?.max_allocation_value, selectedPos?.sentiment_mode])

  // Cash available within this position's own allocation (idle, not tied up in shares)
  const positionCashRemaining = selectedPos
    ? Math.max(0, selectedPos.allocated_funds - selectedPos.avg_cost * selectedPos.shares)
    : 0

  // Total buyable cash = position's own idle cash + account-level unallocated available funds
  const accountAvailable = Math.max(0, accountData?.available_funds ?? 0)
  const totalBuyableCash = positionCashRemaining + accountAvailable

  // Fill quantity field with max shares buyable from all available cash
  function fillMaxShares() {
    const price = parseFloat(tradeForm.price) || selectedPrice
    if (price > 0 && totalBuyableCash > 0) {
      const maxShares = Math.floor((totalBuyableCash / price) * 10000) / 10000
      setTradeForm(f => ({ ...f, quantity: maxShares.toFixed(4) }))
    }
  }

  // Fill quantity field with all shares currently held (max sell)
  function fillMaxSellShares() {
    if (selectedPos?.shares > 0) {
      setTradeForm(f => ({ ...f, quantity: selectedPos.shares.toFixed(4) }))
    }
  }

  function resetTradePrice() {
    if (Number.isFinite(selectedPrice) && selectedPrice > 0) {
      setTradeForm(f => ({ ...f, price: selectedPrice.toFixed(2) }))
    }
  }

  function getOpenOrderTiming(order) {
    if ((order?.tif ?? '').toUpperCase() !== 'DAY' || !order?.created_at) {
      return { status: 'No expiry data', remainingLabel: 'n/a', progress: null }
    }
    const created = new Date(order.created_at)
    if (Number.isNaN(created.getTime())) {
      return { status: 'No expiry data', remainingLabel: 'n/a', progress: null }
    }
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(created)
    const y = parts.find(p => p.type === 'year')?.value
    const m = parts.find(p => p.type === 'month')?.value
    const d = parts.find(p => p.type === 'day')?.value
    if (!y || !m || !d) {
      return { status: 'No expiry data', remainingLabel: 'n/a', progress: null }
    }

    const close = new Date(`${y}-${m}-${d}T16:00:00-04:00`)
    const totalMs = Math.max(close.getTime() - created.getTime(), 1)
    const remainingMs = close.getTime() - Date.now()
    const progress = Math.max(0, Math.min(1, remainingMs / totalMs))
    if (remainingMs <= 0) return { status: 'Expired window', remainingLabel: '0m', progress: 0 }
    const mins = Math.floor(remainingMs / 60000)
    const status = mins <= openOrdersExpiringSoonMin ? 'Expiring soon' : 'Active'
    const remainingLabel = mins >= 60
      ? `${Math.floor(mins / 60)}h ${mins % 60}m`
      : `${mins}m`
    return { status, remainingLabel, progress }
  }

  function pickOpenOrderPrice(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return
    setTradeForm(f => ({ ...f, price: n.toFixed(2) }))
  }

  function stepOpenOrderPrice(direction) {
    if (!openOrderPriceLevels.length) return
    const sorted = openOrderPriceLevels
    const current = Number.parseFloat(tradeForm.price)
    let nextIdx = priceLevelIdx
    if (nextIdx < 0 || nextIdx >= sorted.length) {
      if (Number.isFinite(current)) {
        const nearest = sorted.reduce((best, row, idx) => {
          if (best < 0) return idx
          return Math.abs(row.price - current) < Math.abs(sorted[best].price - current) ? idx : best
        }, -1)
        nextIdx = nearest < 0 ? 0 : nearest
      } else {
        nextIdx = 0
      }
    }
    nextIdx = direction > 0
      ? Math.min(sorted.length - 1, nextIdx + 1)
      : Math.max(0, nextIdx - 1)
    setPriceLevelIdx(nextIdx)
    pickOpenOrderPrice(sorted[nextIdx].price)
  }

  function getScriptName(strategyName) {
    if (!strategyName?.startsWith('custom:')) return null
    const scriptId = parseInt(strategyName.split(':')[1], 10)
    return scripts.find(s => s.id === scriptId)?.name ?? null
  }

  function handleSaveCapToAll() {
    const parsedValue = maxAllocValue === '' ? 0 : parseFloat(maxAllocValue)
    if (Number.isNaN(parsedValue)) return
    const ok = window.confirm(
      `Apply this cap (${maxAllocMode === 'percent' ? `${parsedValue}%` : `$${parsedValue}`}) to all ${positionsCount} position${positionsCount !== 1 ? 's' : ''}?`,
    )
    if (!ok) return
    setCapNotice(null)
    bulkCapMut.mutate({
      max_allocation_mode: maxAllocMode,
      max_allocation_value: parsedValue,
    }, {
      onSuccess: (data) => {
        setCapNotice({
          type: 'success',
          text: `Applied cap to ${data?.updated ?? positionsCount} position${(data?.updated ?? positionsCount) === 1 ? '' : 's'}.`,
        })
      },
      onError: (err) => {
        const msg = err?.response?.data?.detail || err?.message || 'Failed to apply cap to all positions.'
        setCapNotice({ type: 'error', text: msg })
      },
    })
  }

  function handleSaveCap() {
    const parsedValue = maxAllocValue === '' ? 0 : parseFloat(maxAllocValue)
    if (Number.isNaN(parsedValue)) return
    setCapNotice(null)
    updatePosMut.mutate({
      symbol: selectedSymbol,
      payload: {
        max_allocation_mode: maxAllocMode,
        max_allocation_value: parsedValue,
      },
    }, {
      onSuccess: () => {
        setCapNotice({ type: 'success', text: `Saved cap for ${selectedSymbol}.` })
      },
      onError: (err) => {
        const msg = err?.response?.data?.detail || err?.message || 'Failed to save cap.'
        setCapNotice({ type: 'error', text: msg })
      },
    })
  }

  const parsedCapValue = maxAllocValue === '' ? 0 : parseFloat(maxAllocValue)
  const capValueInvalid = Number.isNaN(parsedCapValue)
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Top section */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Header and summary */}
        <div className="mb-4">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-bold text-slate-100">{selectedSymbol}</h1>
                {quotes[selectedSymbol]?.change_pct != null && (
                  <span className={`text-base font-semibold ${quotes[selectedSymbol].change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {quotes[selectedSymbol].change_pct >= 0 ? '+' : ''}{quotes[selectedSymbol].change_pct.toFixed(2)}%
                  </span>
                )}
              </div>
              {quotes[selectedSymbol]?.company_name && (
                <div className="text-sm text-slate-400 mt-0.5">{quotes[selectedSymbol].company_name}</div>
              )}
              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                <span className="text-sm text-slate-500">Market: <span className="text-slate-200 font-semibold">${selectedPrice?.toFixed(2)}</span></span>
                {quotes[selectedSymbol]?.day_high != null && (
                  <span className="text-xs text-slate-500">
                    H: <span className="text-slate-300">${quotes[selectedSymbol].day_high.toFixed(2)}</span>
                    {' '}L: <span className="text-slate-300">${quotes[selectedSymbol].day_low?.toFixed(2)}</span>
                  </span>
                )}
                {quotes[selectedSymbol]?.volume != null && (
                  <span className="text-xs text-slate-500">Vol: <span className="text-slate-300">{(quotes[selectedSymbol].volume / 1e6).toFixed(2)}M</span></span>
                )}
                {selectedPos.strategy_name && !editingStrategy && (
                  <span className="text-sm text-blue-400 bg-blue-900/20 border border-blue-800/30 px-2 py-0.5 rounded">
                    {selectedPos.strategy_name.split(':')[0]}
                    {getScriptName(selectedPos.strategy_name) && (
                      <span className="text-slate-400"> · {getScriptName(selectedPos.strategy_name)}</span>
                    )}
                  </span>
                )}
              </div>
            </div>
            <button className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 border border-red-800/40 rounded-lg px-2.5 py-1.5 hover:bg-red-900/20 transition-colors"
              onClick={() => {
                const msg = ibMode
                  ? `Remove ${selectedSymbol} from watchlist?`
                  : `Remove ${selectedSymbol} from sandbox?`
                if (window.confirm(msg)) removeSymbolMut.mutate(selectedSymbol)
              }}>
              <TrashIcon className="h-3.5 w-3.5" />{ibMode ? 'Remove Watchlist' : 'Remove'}
            </button>
          </div>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mt-4">
            <div className="card">
              <div className="text-xs text-slate-500 mb-1">{ibMode ? 'IB Position Value' : 'Allocated Funds'}</div>
              {ibMode ? (
                <div>
                  <div className="text-xl font-bold text-slate-100">{fmtMoney(selectedMarketValue)}</div>
                  <div className="text-xs text-slate-500 mt-1">Managed by Interactive Brokers</div>
                </div>
              ) : editingAlloc ? (
            <div className="flex items-center gap-1 mt-1">
              <input className="input text-sm py-1 px-2 w-24" type="number" value={allocInput} onChange={e => setAllocInput(e.target.value)} />
              <button className="text-emerald-400 hover:text-emerald-300" onClick={() => { updatePosMut.mutate({ symbol: selectedSymbol, payload: { allocated_funds: parseFloat(allocInput) } }); setEditingAlloc(false) }}>
                <CheckIcon className="h-4 w-4" />
              </button>
              <button className="text-slate-500 hover:text-slate-300" onClick={() => setEditingAlloc(false)}>
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold text-slate-100">{fmtMoney(selectedPos.allocated_funds)}</span>
              <button onClick={() => { setAllocInput(selectedPos.allocated_funds?.toFixed(2)); setEditingAlloc(true) }}>
                <PencilSquareIcon className="h-3.5 w-3.5 text-slate-500 hover:text-slate-300" />
              </button>
            </div>
          )}
          {!ibMode && (
            <div className="text-xs text-slate-500 mt-1">
              Cash left: <span className={`font-semibold ${positionCashRemaining > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{fmtMoney(positionCashRemaining)}</span>
            </div>
          )}
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">Shares Held</div>
          <div className="text-xl font-bold text-slate-100">{hasPosition ? selectedShares.toFixed(4) : '—'}</div>
          {selectedPos.pending_shares > 0 && (
            <div className="flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded-md bg-amber-900/20 border border-amber-700/30">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
              <span className="text-xs text-amber-400 font-medium">
                {selectedPos.pending_shares.toFixed(4)} sh pending @ ${selectedPos.pending_avg_cost?.toFixed(2)}
              </span>
            </div>
          )}
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">Average Share Price</div>
          <div className="text-xl font-bold text-slate-100">{hasPosition ? `$${selectedPos.avg_cost?.toFixed(2)}` : '—'}</div>
          {marketEdgePct != null && (
            <div className={`text-xs mt-0.5 font-semibold ${marketEdgePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {marketEdgePct >= 0 ? '+' : ''}{marketEdgePct.toFixed(2)}% vs market
            </div>
          )}
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">Market Value</div>
          <div className="text-xl font-bold text-slate-100">{fmtMoney(selectedMarketValue)}</div>
          <div className={`text-xs mt-0.5 font-semibold ${selectedUnrealised >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {fmt(selectedUnrealised)}
            {hasPosition && selectedPos.avg_cost > 0 && (
              <span> ({((selectedUnrealised / (selectedPos.avg_cost * Math.abs(selectedShares))) * 100).toFixed(2)}%)</span>
            )}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">Total P&amp;L</div>
          <div className={`text-xl font-bold ${(selectedPos.realized_pnl + selectedUnrealised) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(selectedPos.realized_pnl + selectedUnrealised)}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {ibMode
              ? 'Realised: — (not provided per-position by IB endpoint)'
              : (
                <>
                  Realised: {fmt(selectedPos.realized_pnl)}
                  {selectedPos.allocated_funds > 0 && (
                    <span className={selectedPos.realized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {' '}({((selectedPos.realized_pnl / selectedPos.allocated_funds) * 100).toFixed(2)}%)
                    </span>
                  )}
                </>
              )}
          </div>
        </div>
      </div>

        </div>

        {/* Main content row: SymbolDetailPanel left, rest right */}
        <div className="flex flex-row gap-6 mt-6 min-h-0">
          {/* Symbol detail left - fill vertical space */}
          <div className="w-full max-w-xs flex-shrink-0 flex flex-col min-h-0">
            <div className="flex-1 min-h-0">
              <SymbolDetailPanel
                symbol={selectedSymbol}
                quoteData={quotes[selectedSymbol] ?? null}
                isLoading={false}
                ownedShares={selectedPos?.shares ?? null}
                averagePrice={selectedPos?.avg_cost ?? null}
              />
            </div>
          </div>
          {/* Right side: chart, strategy, trade */}
          <div className="flex-1 flex flex-col gap-6 min-h-0">
            {/* 1D Price Chart - flex-grow to fill available space */}
            <div className="card flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">Today — 1D</h3>
                  <div className="text-[11px] text-slate-500 mt-0.5">Scroll to zoom, drag to pan, Reset to full view</div>
                </div>
                <button
                  title={`Open ${selectedSymbol} in dashboard`}
                  onClick={() => navigate(`/?symbol=${selectedSymbol}`)}
                  className="flex items-center gap-1 text-xs text-slate-500 hover:text-amber-400 transition-colors"
                >
                  <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                  Dashboard
                </button>
              </div>
              <div className="flex-1 min-h-0">
                {chartData.length > 0
                  ? <CandlestickChart data={chartData} prevClose={prevClose} height={undefined} className="h-full w-full" />
                  : <div className="flex items-center justify-center h-full text-slate-500 text-sm">Loading chart…</div>
                }
              </div>
            </div>
            {/* Strategy card */}
            <div className="card">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">Strategy</h3>
            {selectedPos.strategy_name && (
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                selectedPos.strategy_enabled
                  ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700/40'
                  : 'bg-slate-800 text-slate-500 border border-dark-500'
              }`}>
                <BoltIcon className="h-3 w-3" />
                {selectedPos.strategy_enabled ? 'Engine ON' : 'Engine OFF'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selectedPos.strategy_name && (
              <button
                className={`flex items-center gap-1.5 text-xs rounded-lg px-3 py-1.5 font-semibold transition-colors disabled:opacity-50 ${
                  selectedPos.strategy_enabled
                    ? 'bg-red-900/30 text-red-400 border border-red-700/40 hover:bg-red-900/50'
                    : 'bg-emerald-900/30 text-emerald-400 border border-emerald-700/40 hover:bg-emerald-900/50'
                }`}
                onClick={() => toggleEngineMut.mutate(selectedSymbol)}
                disabled={toggleEngineMut.isPending}
              >
                {selectedPos.strategy_enabled
                  ? <><StopCircleIcon className="h-3.5 w-3.5" />Stop Engine</>
                  : <><PlayIcon className="h-3.5 w-3.5" />Start Engine</>
                }
              </button>
            )}
            {!editingStrategy ? (
              <button className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors" onClick={handleEditStratOpen}>
                <PencilSquareIcon className="h-3.5 w-3.5" />{selectedPos.strategy_name ? 'Change' : 'Assign Strategy'}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300" onClick={handleEditStratSave}><CheckIcon className="h-3.5 w-3.5" />Save</button>
                <button className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300" onClick={() => setEditingStrategy(false)}><XMarkIcon className="h-3.5 w-3.5" />Cancel</button>
              </div>
            )}
          </div>
        </div>

        {editingStrategy ? (
          <StrategySelector value={editStratType} scriptId={editScriptId} templateFilename={editTemplateFilename}
            onStrategyChange={handleEditStratChange} onScriptChange={setEditScriptId}
            onTemplateChange={setEditTemplateFilename}
            stratParams={editStratParams}
            onParamChange={(k, v) => setEditStratParams(p => ({ ...p, [k]: v }))}
            symbol={selectedPos?.symbol} />
        ) : (
          <div className="space-y-3">
            <div className="text-sm">
              {selectedPos.strategy_name
                ? <span className="text-blue-400 font-medium">
                    {stratLabel(selectedPos.strategy_name.split(':')[0])}
                    {getScriptName(selectedPos.strategy_name) && (
                      <span className="text-slate-400 font-normal"> · {getScriptName(selectedPos.strategy_name)}</span>
                    )}
                  </span>
                : <span className="text-slate-600 italic">No strategy assigned</span>}
            </div>
            {selectedPos.strategy_name && (
              <><div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="bg-dark-900/60 rounded-lg p-2.5 border border-dark-600">
                  <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                    <BoltIcon className="h-3 w-3" />Last Signal
                  </div>
                  <div className={`text-sm font-bold ${
                    selectedPos.last_signal === 1 ? 'text-emerald-400'
                      : selectedPos.last_signal === -1 ? 'text-red-400'
                      : 'text-slate-500'
                  }`}>
                    {selectedPos.last_signal === 1 ? '▲ BUY'
                      : selectedPos.last_signal === -1 ? '▼ SELL'
                      : selectedPos.last_signal === 0 ? '— HOLD'
                      : '— None'}
                  </div>
                </div>
                <div className="bg-dark-900/60 rounded-lg p-2.5 border border-dark-600">
                  <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                    <ClockIcon className="h-3 w-3" />Last Run
                  </div>
                  <div className="text-xs text-slate-400">
                    {selectedPos.last_run_at ? new Date(selectedPos.last_run_at).toLocaleTimeString() : '—'}
                  </div>
                </div>
                <div className="bg-dark-900/60 rounded-lg p-2.5 border border-dark-600">
                  <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                    <SignalIcon className="h-3 w-3" />Engine Tick
                  </div>
                  <div className="text-xs text-slate-400">
                    {engineState?.last_tick ? new Date(engineState.last_tick).toLocaleTimeString() : '—'}
                  </div>
                </div>
              </div>
              {selectedPos.pending_shares > 0 && (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-amber-900/20 border border-amber-700/30">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-amber-400 font-semibold">Pending Order — awaiting fill</span>
                    <div className="text-xs text-amber-300/70 mt-0.5">
                      {selectedPos.pending_shares.toFixed(4)} sh @ ${selectedPos.pending_avg_cost?.toFixed(2)} avg cost
                      {selectedPos.pending_since && (
                        <span className="text-amber-400/50"> · placed {new Date(selectedPos.pending_since).toLocaleTimeString()}</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>)}
            {selectedPos.engine_error && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-900/20 border border-amber-700/30 text-xs text-amber-400">
                <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{selectedPos.engine_error}</span>
              </div>
            )}
            {selectedPos.strategy_enabled && (
              <div className="flex items-center gap-2 text-xs">
                {engineState?.market_active ? (
                  <>
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-emerald-400/80">Automated trading active — scans every 60 seconds</span>
                  </>
                ) : (
                  <>
                    <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />
                    <span className="text-slate-500">Engine paused — market closed (active 09:20–16:00 ET, Mon–Fri)</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Trade form */}
      <div className="card">
        <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-4">Place Trade</h3>
        <form onSubmit={handleTrade} className="space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="label">Side</label>
              <div className="flex rounded-lg overflow-hidden border border-dark-500">
                {['BUY', 'SELL'].map(s => (
                  <button key={s} type="button" onClick={() => setTradeForm(f => ({ ...f, side: s }))}
                    className={`px-4 py-2 text-sm font-semibold transition-colors ${tradeForm.side === s ? (s === 'BUY' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white') : 'bg-dark-800 text-slate-400 hover:text-slate-200'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Quantity</label>
              <div className="flex items-center gap-1">
                <input className="input w-28" type="number" min="0.0001" step="0.0001" placeholder="Shares"
                  value={tradeForm.quantity} onChange={e => setTradeForm(f => ({ ...f, quantity: e.target.value }))} required />
                {tradeForm.side === 'BUY' && totalBuyableCash > 0 && (
                  <button type="button" title={`Max shares from ${fmtMoney(totalBuyableCash)} (position: ${fmtMoney(positionCashRemaining)} + available: ${fmtMoney(accountAvailable)})`}
                    className="text-xs text-emerald-400 hover:text-emerald-300 border border-emerald-800/40 rounded px-1.5 py-1 whitespace-nowrap"
                    onClick={fillMaxShares}>Max</button>
                )}
                {tradeForm.side === 'SELL' && selectedPos?.shares > 0 && (
                  <button type="button" title={`Sell all ${selectedPos.shares} shares`}
                    className="text-xs text-red-400 hover:text-red-300 border border-red-800/40 rounded px-1.5 py-1 whitespace-nowrap"
                    onClick={fillMaxSellShares}>Max</button>
                )}
              </div>
            </div>
            <div>
              <label className="label">Price ($)</label>
              <div className="flex items-center gap-2">
                <input className="input w-28 shrink-0" type="number" step="0.01"
                  value={priceInputValue} onChange={e => setTradeForm(f => ({ ...f, price: e.target.value }))} />
                {openOrdersPriceHelperEnabled && !!openOrderPriceLevels.length && (
                  <div className="flex items-center rounded-lg border border-dark-500 overflow-hidden">
                    <button
                      type="button"
                      className="px-2 py-2 text-slate-400 hover:text-slate-200 hover:bg-dark-700"
                      onClick={() => stepOpenOrderPrice(1)}
                      title="Step up through open-order prices"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="px-2 py-2 border-l border-dark-500 text-slate-400 hover:text-slate-200 hover:bg-dark-700"
                      onClick={() => stepOpenOrderPrice(-1)}
                      title="Step down through open-order prices"
                    >
                      ▼
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={resetTradePrice}
                  className="inline-flex items-center justify-center rounded-lg border border-dark-500 bg-dark-800 px-2 py-2 text-slate-400 transition-colors hover:text-slate-200 hover:border-dark-400"
                  title="Reset to current price"
                  aria-label="Reset price to current value"
                >
                  <ArrowPathIcon className="h-4 w-4" />
                </button>
              </div>
              {openOrdersPriceHelperEnabled && !!openOrderPriceLevels.length && (
                <div className="mt-1">
                  <select
                    className="input text-xs py-1.5 w-56"
                    value=""
                    onChange={e => {
                      const v = e.target.value
                      if (v) pickOpenOrderPrice(v)
                      e.target.value = ''
                    }}
                  >
                    <option value="">Select from open order levels…</option>
                    {openOrderPriceLevels.map(row => (
                      <option key={`${row.side}-${row.price.toFixed(2)}`} value={row.price.toFixed(2)}>
                        {row.side} ${row.price.toFixed(2)} · rem {row.remaining.toFixed(2)} / {row.quantity.toFixed(2)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div>
              <div>
                {hasDayRange && (
                  <input
                    className="h-2 w-40 cursor-pointer accent-sky-500"
                    type="range"
                    min={dayLow}
                    max={dayHigh}
                    step="0.01"
                    value={sliderPrice ?? dayLow}
                    onChange={e => setTradeForm(f => ({ ...f, price: Number.parseFloat(e.target.value).toFixed(2) }))}
                    aria-label="Price within day range"
                  />
                )}
              </div>
              {hasDayRange && (
                <div className="mt-1 flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>${dayLow.toFixed(2)}</span>
                  <span>${dayHigh.toFixed(2)}</span>
                </div>
              )}
            </div>
            <button type="submit" disabled={tradeMut.isPending || !tradeForm.quantity}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 ${tradeForm.side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'}`}>
              {tradeForm.side === 'BUY' ? <ArrowUpIcon className="h-4 w-4" /> : <ArrowDownIcon className="h-4 w-4" />}
              {tradeMut.isPending ? 'Placing…' : `${tradeForm.side} ${tradeForm.quantity || ''} ${selectedSymbol}`}
            </button>
          </div>
          <div className="w-full">
            <label className="label">Reason</label>
            <input className="input w-full" placeholder="manual"
              value={tradeForm.reason} onChange={e => setTradeForm(f => ({ ...f, reason: e.target.value }))} />
          </div>
        </form>
        {tradeMsg && (
          <div className={`mt-3 flex items-start justify-between gap-2 p-3 rounded-lg text-sm border ${tradeMsg.type === 'success' ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400' : 'bg-red-900/20 border-red-700/30 text-red-400'}`}>
            <span>{tradeMsg.text}</span>
            <button onClick={() => setTradeMsg(null)} className="text-slate-500 hover:text-slate-300 flex-shrink-0"><XMarkIcon className="h-4 w-4" /></button>
          </div>
        )}
      </div>

    </div>
  </div>
  </div>
      {/* Position Settings (collapsible) */}
      <div className="card mt-6">
        <div
          role="button"
          tabIndex={0}
          className="flex items-center justify-between cursor-pointer select-none"
          onClick={() => setPosSettingsOpen(o => !o)}
          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setPosSettingsOpen(o => !o)}
        >
          <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">Position Settings</h3>
          <div className="flex items-center gap-2">
            {!posSettingsOpen && selectedPos?.sentiment_mode && selectedPos.sentiment_mode !== 'none' && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold bg-violet-900/30 text-violet-300 border border-violet-700/40 uppercase tracking-wide">
                {selectedPos.sentiment_mode === 'market' ? 'Market Sentiment' : 'Symbol Sentiment'}
              </span>
            )}
            <ChevronDownIcon className={`h-4 w-4 text-slate-400 transition-transform ${posSettingsOpen ? 'rotate-180' : ''}`} />
          </div>
        </div>

        {posSettingsOpen && (
          <div className="mt-4 space-y-4">
            {/* Allocation Guardrails */}
            <div>
              <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                <h4 className="font-semibold text-slate-300 text-xs uppercase tracking-wider">Allocation Guardrails</h4>
                <span className="text-xs text-slate-500">Maximum Allocation</span>
              </div>
              <div className="text-xs text-slate-500 mb-2">
                Minimum Funds per Position:{' '}
                <span className="text-slate-300 font-semibold">
                  {minFundsMode === 'percent'
                    ? `${Number(managerSettings?.min_position_funds_pct ?? 1).toFixed(2)}% (${fmtMoney(minFundsDollar)})`
                    : fmtMoney(minFundsDollar)}
                </span>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Cap how much this symbol can hold when the portfolio manager deploys or reallocates funds.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">Mode</span>
                  <select
                    className="input text-sm py-1.5 w-44"
                    value={maxAllocMode}
                    onChange={e => setMaxAllocMode(e.target.value)}
                  >
                    <option value="dollar">Dollar amount</option>
                    <option value="percent">Percent of total funds</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-400">Maximum</span>
                  <div className="flex items-center gap-1">
                    {maxAllocMode === 'dollar' ? <span className="text-slate-400 text-sm">$</span> : null}
                    <input
                      type="number"
                      min={0}
                      max={maxAllocMode === 'percent' ? 100 : undefined}
                      step={maxAllocMode === 'percent' ? 0.1 : 10}
                      className="input text-sm py-1.5 w-32"
                      value={maxAllocValue}
                      onChange={e => setMaxAllocValue(e.target.value)}
                      placeholder={maxAllocMode === 'percent' ? 'e.g. 12.5' : 'e.g. 5000'}
                    />
                    {maxAllocMode === 'percent' ? <span className="text-slate-400 text-sm">%</span> : null}
                  </div>
                </label>
                <button
                  className="text-xs bg-sky-700 hover:bg-sky-600 text-white rounded-lg px-3 py-2 font-semibold transition-colors disabled:opacity-50"
                  onClick={handleSaveCap}
                  disabled={updatePosMut.isPending || bulkCapMut?.isPending || capValueInvalid}
                >
                  {updatePosMut.isPending ? 'Saving…' : 'Save Cap'}
                </button>
                <button
                  className="text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded-lg px-3 py-2 font-semibold transition-colors disabled:opacity-50"
                  onClick={handleSaveCapToAll}
                  disabled={updatePosMut.isPending || bulkCapMut?.isPending || capValueInvalid || positionsCount <= 0}
                >
                  {bulkCapMut?.isPending ? 'Applying…' : 'Save to All'}
                </button>
              </div>
              {capNotice && (
                <div className={`mt-2 text-xs rounded-md border px-2.5 py-1.5 ${
                  capNotice.type === 'success'
                    ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400'
                    : 'bg-red-900/20 border-red-700/30 text-red-400'
                }`}>
                  {capNotice.text}
                </div>
              )}
              <p className="text-[11px] text-slate-600 mt-2">Set to 0 for no cap.</p>
            </div>

            {/* Sentiment Strategy Mode */}
            <div className="border-t border-dark-700 pt-4">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <h4 className="font-semibold text-slate-300 text-xs uppercase tracking-wider">Sentiment Strategy Mode</h4>
                  {selectedPos?.sentiment_mode && selectedPos.sentiment_mode !== 'none' && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold bg-violet-900/30 text-violet-300 border border-violet-700/40 uppercase tracking-wide">
                      {selectedPos.sentiment_mode === 'market' ? 'Market Sentiment' : 'Symbol Sentiment'}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mb-3">
                  Let the portfolio manager automatically switch strategy based on sentiment signals.
                  Requires the manager to be running with sentiment strategy switching enabled.
                </p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {[
                    { value: 'none', label: 'Manual', desc: 'Strategy is set manually, no auto-switching' },
                    { value: 'market', label: 'Market Sentiment', desc: 'Strategy follows overall market sentiment (avg of all symbols)' },
                    { value: 'symbol', label: 'Symbol Sentiment', desc: `Strategy follows ${selectedSymbol}'s own sentiment score` },
                  ].map(opt => (
                    <label key={opt.value} className={`flex items-start gap-2 cursor-pointer rounded-lg border px-3 py-2 transition-colors ${sentimentMode === opt.value ? 'border-violet-600 bg-violet-900/20' : 'border-dark-600 bg-dark-800 hover:border-dark-500'}`}>
                      <input
                        type="radio"
                        name={`sentiment_mode_${selectedSymbol}`}
                        value={opt.value}
                        checked={sentimentMode === opt.value}
                        onChange={() => setSentimentMode(opt.value)}
                        className="mt-0.5 accent-violet-500"
                      />
                      <span>
                        <span className="text-xs font-medium text-slate-200">{opt.label}</span>
                        <span className="block text-[11px] text-slate-500 mt-0.5">{opt.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  className="text-xs bg-violet-700 hover:bg-violet-600 text-white rounded-lg px-3 py-2 font-semibold transition-colors disabled:opacity-50"
                  onClick={() => updatePosMut.mutate({
                    symbol: selectedSymbol,
                    payload: { sentiment_mode: sentimentMode },
                  })}
                  disabled={updatePosMut.isPending || sentimentMode === (selectedPos?.sentiment_mode ?? 'none')}
                >
                  {updatePosMut.isPending ? 'Saving…' : 'Save Mode'}
                </button>
              </div>
          </div>
        )}
      </div>

      {/* Bottom section: Activity Log */}
      <div className="card mt-6">
        <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-4">
          Activity Log — {selectedSymbol}
        </h3>
        {openOrdersPanelEnabled && !!openOrdersForSymbol.length && (
          <div className="mb-4 rounded-lg border border-amber-700/30 bg-amber-900/10 p-3">
            <div className="text-xs font-semibold text-amber-300 mb-2 uppercase tracking-wider">Open Order Status</div>
            <div className="space-y-2">
              {openOrdersForSymbol.map(o => {
                const timing = getOpenOrderTiming(o)
                const progress = timing.progress ?? 1
                const r = 12
                const c = 2 * Math.PI * r
                const offset = c * (1 - progress)
                return (
                  <div key={o.ib_order_id} className="flex items-center justify-between rounded-md border border-dark-600 bg-dark-900/60 px-2.5 py-2">
                    <div className="min-w-0">
                      <div className="text-xs text-slate-200">
                        #{o.ib_order_id} {o.side} {Number(o.remaining ?? o.quantity ?? 0).toFixed(2)} / {Number(o.quantity ?? 0).toFixed(2)}
                        {o.limit_price != null ? ` @ $${Number(o.limit_price).toFixed(2)}` : ' (MKT)'}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {timing.status} · remaining {timing.remainingLabel}
                        {o._source === 'trade-history' && (
                          <span className="text-slate-600"> · from history</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {cancelOrderMut && (
                        <button
                          type="button"
                          className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-50"
                          disabled={cancelOrderMut.isPending}
                          onClick={() => cancelOrderMut.mutate(o.ib_order_id)}
                        >
                          Cancel
                        </button>
                      )}
                      {openOrdersCountdownEnabled ? (
                        <svg width="30" height="30" viewBox="0 0 30 30" className="shrink-0">
                          <circle cx="15" cy="15" r={r} fill="none" stroke="#334155" strokeWidth="3" />
                          <circle
                            cx="15"
                            cy="15"
                            r={r}
                            fill="none"
                            stroke={progress < 0.2 ? '#f87171' : progress < 0.4 ? '#fbbf24' : '#34d399'}
                            strokeWidth="3"
                            strokeDasharray={c}
                            strokeDashoffset={offset}
                            transform="rotate(-90 15 15)"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : (
                        <span className="text-[11px] text-slate-500">{timing.remainingLabel}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        <div className="overflow-y-auto max-h-80">
        {(() => {
          // Merge trades + fund events + allocation events into a single timeline, filtered by selectedSymbol
          const rawTradeEntries = activities
            .filter(a => a.type === 'trade' && a.symbol === selectedSymbol)
            .map((a, i) => ({
            id: a.tradeId != null ? `t-${a.tradeId}` : `ta-${a.ts ?? 0}-${a.symbol ?? ''}-${a.side ?? ''}-${i}`,
            kind: 'trade',
            side: a.side,
            syncFromIb: a.syncFromIb === true,
            symbol: a.symbol,
            shares: a.shares,
            price: a.price,
            marketValue: a.marketValue,
            ts: a.ts,
            date: a.ts != null ? new Date(a.ts).toISOString() : null,
            label: a.label,
            sub: a.sub,
            pnl: a.pnl,
            total: (a.shares ?? 0) * (a.price ?? 0),
          }))
          const tradeEntries = backfillTradeAvgPrice(rawTradeEntries).map((entry) => {
            const explicit = entry.pnl != null ? Number(entry.pnl) : Number.NaN
            if (Number.isFinite(explicit)) {
              return { ...entry, displayPnl: explicit }
            }

            const isIbSnapshot = entry.syncFromIb === true && String(entry.sub ?? '').startsWith('Market Value:')
            if (isIbSnapshot) {
              return { ...entry, displayPnl: null }
            }

            if (entry.side === 'SELL') {
              const avg = Number(entry.avgPrice)
              const qty = Number(entry.shares)
              const mv = Number(entry.marketValue)
              const px = Number(entry.price)
              if (Number.isFinite(avg) && avg > 0 && Number.isFinite(qty) && qty !== 0) {
                if (Number.isFinite(mv) && mv !== 0) {
                  return { ...entry, displayPnl: mv - (avg * qty) }
                }
                if (Number.isFinite(px) && px > 0) {
                  return { ...entry, displayPnl: (px - avg) * qty }
                }
              }
            }

            return { ...entry, displayPnl: null }
          })
          // Only show fund events that are not allocations and are not tied to a symbol (global deposits/withdrawals)
          const fundEntries = fundEvents
            .filter(e => !e.from_symbol && !e.to_symbol)
            .map(e => ({
              id: `f-${e.id}`,
              kind: e.event_type,
              date: e.created_at,
              label: `${e.event_type === 'deposit' ? 'Deposit' : 'Withdrawal'} $${Math.abs(e.amount).toFixed(2)}`,
              sub: e.note || null,
              pnl: null,
              total: e.amount,
            }))
          // Only show allocation events where this symbol is involved
          const allocEntries = fundEvents
            .filter(e => (e.from_symbol === selectedSymbol || e.to_symbol === selectedSymbol))
            .map(e => {
              let label = ''
              if (e.event_type === 'allocate' || e.event_type === 'deploy') {
                label = `Allocated $${e.amount.toFixed(2)} → ${e.to_symbol}`
              } else if (e.event_type === 'deallocate') {
                label = `Deallocated $${e.amount.toFixed(2)} ← ${e.from_symbol}`
              } else if (e.event_type === 'reallocate') {
                label = `Reallocated $${e.amount.toFixed(2)}: ${e.from_symbol} → ${e.to_symbol}`
              } else {
                label = `${e.event_type} $${e.amount.toFixed(2)}`
              }
              return {
                id: `a-${e.id}`,
                kind: 'allocation',
                event_type: e.event_type,
                date: e.created_at,
                label,
                sub: e.note || null,
                pnl: null,
                total: e.amount,
              }
            })
          const all = [...tradeEntries, ...fundEntries, ...allocEntries].sort((a, b) =>
            new Date(b.date) - new Date(a.date)
          )
          if (all.length === 0) return (
            <div className="text-center text-slate-600 text-sm py-8">No activity recorded yet.</div>
          )
          const ACT_PAGE_SIZE = 25
          const totalPages = Math.max(1, Math.ceil(all.length / ACT_PAGE_SIZE))
          const safePage = Math.min(activityPage, totalPages - 1)
          const pageItems = all.slice(safePage * ACT_PAGE_SIZE, (safePage + 1) * ACT_PAGE_SIZE)
          return (
            <>
            <div className="space-y-1">
              {pageItems.map(entry => (
                <div key={entry.id} className="flex items-start gap-3 py-2 border-b border-dark-700 last:border-0">
                  <div className="mt-0.5 flex-shrink-0">
                    {entry.kind === 'trade' ? (
                      entry.side === 'BUY'
                        ? <ArrowUpIcon className="h-3.5 w-3.5 text-emerald-400" />
                        : <ArrowDownIcon className="h-3.5 w-3.5 text-red-400" />
                    ) : entry.kind === 'allocation' ? (
                      <ArrowsRightLeftIcon className="h-3.5 w-3.5 text-purple-400" />
                    ) : (
                      <BanknotesIcon className={`h-3.5 w-3.5 ${entry.kind === 'deposit' ? 'text-blue-400' : 'text-amber-400'}`} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm text-slate-200">{entry.label}</span>
                      {entry.displayPnl != null && (
                        <span className={`text-xs font-medium ${entry.displayPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {entry.displayPnl >= 0 ? '+' : ''}{entry.displayPnl.toFixed(2)} PnL
                        </span>
                      )}
                    </div>
                    {entry.sub && <div className="text-xs text-slate-500 mt-0.5 truncate">{entry.sub}</div>}
                    {entry.kind === 'trade' && entry.side === 'SELL' && !(entry.syncFromIb === true && String(entry.sub ?? '').startsWith('Market Value:')) && Number.isFinite(Number(entry.avgPrice)) && Number(entry.avgPrice) > 0 && (
                      <div className="text-xs text-slate-500 mt-0.5">Avg sell cost basis: ${Number(entry.avgPrice).toFixed(2)}</div>
                    )}
                  </div>
                  <span className="text-xs text-slate-600 whitespace-nowrap flex-shrink-0 mt-0.5">
                    {entry.date ? new Date(entry.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-1 pt-3 border-t border-dark-700 mt-2">
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
    </div>
  )
}
