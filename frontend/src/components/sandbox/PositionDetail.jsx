import {
  TrashIcon, PencilSquareIcon, CheckIcon, XMarkIcon,
  ArrowUpIcon, ArrowDownIcon, BoltIcon, PlayIcon, StopCircleIcon,
  ClockIcon, SignalIcon, ExclamationTriangleIcon, ArrowTopRightOnSquareIcon,
  BanknotesIcon, ArrowsRightLeftIcon,
} from '@heroicons/react/24/outline'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getScripts, getHistory, getSandboxFundEvents } from '../../api/client'
import { useAppSettings } from '../../hooks/useAppSettings'
import { fmt, fmtMoney, stratLabel } from './sandboxHelpers'
import StrategySelector from './StrategySelector'
import TradeRow from './TradeRow'
import CandlestickChart from '../charts/CandlestickChart'
import SymbolDetailPanel from '../dashboard/SymbolDetailPanel'

export default function PositionDetail({
  selectedSymbol,
  selectedPos,
  selectedPrice,
  selectedMarketValue,
  selectedUnrealised,
  quotes,
  trades,
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
  removeSymbolMut,
  toggleEngineMut,
  tradeForm,
  setTradeForm,
  tradeMsg,
  setTradeMsg,
  handleTrade,
  tradeMut,
  accountData,
}) {
  const navigate = useNavigate()
  const appSettings = useAppSettings()
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

  const { data: fundEventsData } = useQuery({
    queryKey: ['sandbox-fund-events'],
    queryFn: getSandboxFundEvents,
    refetchInterval: appSettings.portfolio_detail_ms,
  })
  const fundEvents = fundEventsData?.events ?? []

  // Auto-update trade price when live quote changes
  useEffect(() => {
    if (selectedPrice > 0) {
      setTradeForm(f => ({ ...f, price: selectedPrice.toFixed(2) }))
    }
  }, [selectedPrice])

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

  function getScriptName(strategyName) {
    if (!strategyName?.startsWith('custom:')) return null
    const scriptId = parseInt(strategyName.split(':')[1], 10)
    return scripts.find(s => s.id === scriptId)?.name ?? null
  }
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
              onClick={() => { if (window.confirm(`Remove ${selectedSymbol} from sandbox?`)) removeSymbolMut.mutate(selectedSymbol) }}>
              <TrashIcon className="h-3.5 w-3.5" />Remove
            </button>
          </div>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
            <div className="card">
          <div className="text-xs text-slate-500 mb-1">Allocated Funds</div>
          {editingAlloc ? (
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
          <div className="text-xs text-slate-500 mt-1">
            Cash left: <span className={`font-semibold ${positionCashRemaining > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{fmtMoney(positionCashRemaining)}</span>
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">Shares Held</div>
          <div className="text-xl font-bold text-slate-100">{selectedPos.shares > 0 ? selectedPos.shares.toFixed(4) : '—'}</div>
          {selectedPos.shares > 0 && <div className="text-xs text-slate-500 mt-0.5">Avg ${selectedPos.avg_cost?.toFixed(2)}</div>}
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
          <div className="text-xs text-slate-500 mb-1">Market Value</div>
          <div className="text-xl font-bold text-slate-100">{fmtMoney(selectedMarketValue)}</div>
          <div className={`text-xs mt-0.5 font-semibold ${selectedUnrealised >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(selectedUnrealised)} unrealised</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">Total P&amp;L</div>
          <div className={`text-xl font-bold ${(selectedPos.realized_pnl + selectedUnrealised) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(selectedPos.realized_pnl + selectedUnrealised)}</div>
          <div className="text-xs text-slate-500 mt-0.5">Realised: {fmt(selectedPos.realized_pnl)}</div>
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
              />
            </div>
          </div>
          {/* Right side: chart, strategy, trade */}
          <div className="flex-1 flex flex-col gap-6 min-h-0">
            {/* 1D Price Chart - flex-grow to fill available space */}
            <div className="card flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">Today — 1D</h3>
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
            {selectedPos.strategy_name && !editingStrategy && (
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
        <form onSubmit={handleTrade} className="flex flex-wrap gap-3 items-end">
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
            <input className="input w-28" type="number" step="0.01" placeholder={selectedPrice?.toFixed(2)}
              value={tradeForm.price} onChange={e => setTradeForm(f => ({ ...f, price: e.target.value }))} />
          </div>
          <div className="flex-1 min-w-48">
            <label className="label">Reason (optional)</label>
            <input className="input w-full" placeholder="e.g. RSI oversold, MACD cross…"
              value={tradeForm.reason} onChange={e => setTradeForm(f => ({ ...f, reason: e.target.value }))} />
          </div>
          <button type="submit" disabled={tradeMut.isPending || !tradeForm.quantity}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 ${tradeForm.side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'}`}>
            {tradeForm.side === 'BUY' ? <ArrowUpIcon className="h-4 w-4" /> : <ArrowDownIcon className="h-4 w-4" />}
            {tradeMut.isPending ? 'Placing…' : `${tradeForm.side} ${tradeForm.quantity || ''} ${selectedSymbol}`}
          </button>
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
      {/* Bottom section: Activity Log */}
      <div className="card mt-6">
        <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-4">
          Activity Log — {selectedSymbol}
        </h3>
        {(() => {
          // Merge trades + fund events + allocation events into a single timeline, filtered by selectedSymbol
          const tradeEntries = trades
            .filter(t => t.symbol === selectedSymbol)
            .map(t => ({
              id: `t-${t.id}`,
              kind: 'trade',
              side: t.side,
              date: t.created_at,
              label: `${t.side} ${t.quantity} ${t.symbol} @ $${t.price?.toFixed(2)}`,
              sub: t.strategy_name ? `${t.strategy_name.split(':')[0]}${t.reason ? ' — ' + t.reason : ''}` : t.reason || null,
              pnl: t.pnl ?? null,
              total: t.total,
            }))
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
          return (
            <div className="space-y-1">
              {all.map(entry => (
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
                      {entry.pnl != null && (
                        <span className={`text-xs font-medium ${entry.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {entry.pnl >= 0 ? '+' : ''}{entry.pnl.toFixed(2)} PnL
                        </span>
                      )}
                    </div>
                    {entry.sub && <div className="text-xs text-slate-500 mt-0.5 truncate">{entry.sub}</div>}
                  </div>
                  <span className="text-xs text-slate-600 whitespace-nowrap flex-shrink-0 mt-0.5">
                    {entry.date ? new Date(entry.date).toLocaleString() : ''}
                  </span>
                </div>
              ))}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
