import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PlusIcon, MinusCircleIcon, CurrencyDollarIcon, SignalIcon, QueueListIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline'

import { addSandboxFunds, withdrawSandboxFunds, addSandboxSymbol, repairSandboxFunds } from '../../api/client'
import SymbolAutocomplete from '../shared/SymbolAutocomplete'
import StrategySelector from './StrategySelector'
import StockListItem from './StockListItem'
import { CUSTOM_SCRIPT_KEY } from './sandboxConstants'
import { encodeStrategy, fmtMoney, fmt, defaultParams } from './sandboxHelpers'

export default function SandboxSidebar({
  ibMode,
  accountData,
  engineState,
  totalEquity,
  totalUnrealizedPnl,
  totalRealizedPnl,
  managerSettings = null,
  positions,
  quotes,
  sectors,
  selectedSymbol,
  pmScores = {},
  toggleEngineMut,
  onSelectSymbol,
  onShowOverview,
  onAddIbWatchlistSymbol,
}) {
  const qc = useQueryClient()
  // In IB mode the account-level UnrealizedPnL from IB is authoritative (it uses
  // IB's own marks); the quote-derived position sum can drift and mismatch the
  // main overview card. Realized stays on the trade-ledger sum, the only
  // cumulative source IB does not expose.
  const ibAcctUnrealized = Number(accountData?.unrealized_pnl)
  const ibUnrealizedPnl = (ibMode && Number.isFinite(ibAcctUnrealized)) ? ibAcctUnrealized : totalUnrealizedPnl
  const ibRealizedPnl = totalRealizedPnl
  const totalFundsSource = String(accountData?.total_funds_source ?? '').toLowerCase()
  const fundsLabel = ibMode
    ? ((ibMode === 'paper' && totalFundsSource === 'paper_max_allocation_sum') ? 'Allocation Cap (Paper)' : 'Net Liquidation')
    : 'Total Funds'
  const [phaseNow, setPhaseNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setPhaseNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const marketPhase = useMemo(() => {
    const backendPhase = engineState?.market_phase
    if (backendPhase && typeof backendPhase.code === 'string') {
      const code = backendPhase.code
      const classByCode = {
        closed: 'bg-slate-800 text-slate-400 border border-dark-500',
        frenzy: 'bg-orange-900/25 text-orange-300 border border-orange-700/40',
        follow_up: 'bg-cyan-900/25 text-cyan-300 border border-cyan-700/40',
        settling: 'bg-lime-900/25 text-lime-300 border border-lime-700/40',
        shut_off: 'bg-amber-900/25 text-amber-300 border border-amber-700/40',
        sell_period: 'bg-red-900/25 text-red-300 border border-red-700/40',
      }
      return {
        label: backendPhase.label || code.replaceAll('_', ' ').toUpperCase(),
        className: classByCode[code] || classByCode.closed,
      }
    }

    const holdOvernight = managerSettings?.hold_positions_overnight !== false
    const sellWindow = Math.max(1, Number(managerSettings?.eod_sell_window_minutes ?? 30))
    const shutoffWindow = Math.max(1, Number(managerSettings?.eod_engine_shutoff_minutes_before_sell ?? 120))
    const marketOpen = 570 // 09:30 ET
    const marketClose = 960 // 16:00 ET
    const frenzyMinutes = 180 // first few hours after open
    const settlingMinutes = 60 // final hour before shutdown boundary

    let weekday = null
    let hour = 0
    let minute = 0
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(phaseNow))
      const wd = parts.find(p => p.type === 'weekday')?.value
      const hh = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
      const mm = Number(parts.find(p => p.type === 'minute')?.value ?? 0)
      weekday = wd
      hour = Number.isFinite(hh) ? hh : 0
      minute = Number.isFinite(mm) ? mm : 0
    } catch {
      // Fall back to local time parsing if Intl timezone parsing fails.
      const now = new Date(phaseNow)
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      weekday = days[now.getDay()]
      hour = now.getHours()
      minute = now.getMinutes()
    }

    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)
    const minutesNow = hour * 60 + minute
    const tradingOpenFromClock = isWeekday && minutesNow >= marketOpen && minutesNow < marketClose // 09:30-16:00 ET
    const tradingOpen = typeof engineState?.trading_open === 'boolean'
      ? engineState.trading_open
      : tradingOpenFromClock

    if (!tradingOpen) {
      return { label: 'CLOSED', className: 'bg-slate-800 text-slate-400 border border-dark-500' }
    }

    const sellStart = Math.max(0, marketClose - sellWindow)
    const shutoffStart = Math.max(0, sellStart - shutoffWindow)
    const normalEnd = holdOvernight ? marketClose : shutoffStart
    const frenzyEnd = Math.min(normalEnd, marketOpen + frenzyMinutes)
    const settlingStart = Math.max(frenzyEnd, normalEnd - settlingMinutes)

    if (!holdOvernight && minutesNow >= sellStart) {
      return { label: 'SELL PERIOD', className: 'bg-red-900/25 text-red-300 border border-red-700/40' }
    }
    if (!holdOvernight && minutesNow >= shutoffStart) {
      return { label: 'SHUT OFF', className: 'bg-amber-900/25 text-amber-300 border border-amber-700/40' }
    }

    if (minutesNow < frenzyEnd) {
      return { label: 'FRENZY', className: 'bg-orange-900/25 text-orange-300 border border-orange-700/40' }
    }
    if (minutesNow < settlingStart) {
      return { label: 'FOLLOW UP', className: 'bg-cyan-900/25 text-cyan-300 border border-cyan-700/40' }
    }
    return { label: 'SETTLING', className: 'bg-lime-900/25 text-lime-300 border border-lime-700/40' }
  }, [managerSettings, engineState?.trading_open, engineState?.market_phase, phaseNow])

  const [showAddFunds, setShowAddFunds] = useState(false)
  const [fundsInput, setFundsInput] = useState('')
  const [showWithdraw, setShowWithdraw] = useState(false)
  const [withdrawInput, setWithdrawInput] = useState('')
  const [repairMsg, setRepairMsg] = useState(null)
  const [showAddSymbol, setShowAddSymbol] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [newAlloc, setNewAlloc] = useState('')
  const [addSymbolErr, setAddSymbolErr] = useState('')
  const [newStratType, setNewStratType] = useState('sma_crossover')
  const [newScriptId, setNewScriptId] = useState(null)
  const [newStratParams, setNewStratParams] = useState(defaultParams('sma_crossover'))

  const addFundsMut = useMutation({
    mutationFn: a => addSandboxFunds(a),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sandbox-account'] }); qc.invalidateQueries({ queryKey: ['sandbox-fund-events'] }); setShowAddFunds(false); setFundsInput('') },
  })

  const withdrawMut = useMutation({
    mutationFn: a => withdrawSandboxFunds(a),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sandbox-account'] }); qc.invalidateQueries({ queryKey: ['sandbox-fund-events'] }); setShowWithdraw(false); setWithdrawInput('') },
    onError: (e) => { setRepairMsg(`Error: ${e.response?.data?.detail || e.message}`); setTimeout(() => setRepairMsg(null), 4000) },
  })

  const repairFundsMut = useMutation({
    mutationFn: repairSandboxFunds,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      const diff = data.correction ?? (data.total_funds_after - data.total_funds_before)
      const sign = diff >= 0 ? '+' : ''
      setRepairMsg(`Repaired: ${sign}$${diff.toFixed(2)} · Deposits: $${(data.net_deposits ?? 0).toFixed(2)} · PnL: $${(data.total_realized_pnl ?? 0).toFixed(2)}`)
      setTimeout(() => setRepairMsg(null), 8000)
    },
    onError: (e) => { setRepairMsg(`Error: ${e.response?.data?.detail || e.message}`); setTimeout(() => setRepairMsg(null), 4000) },
  })

  const addSymbolMut = useMutation({
    mutationFn: p => addSandboxSymbol(p),
    onSuccess: d => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      if (!ibMode) {
        onAddIbWatchlistSymbol?.(d.symbol)
      }
      setShowAddSymbol(false); setNewSymbol(''); setNewAlloc(''); setAddSymbolErr('')
      onSelectSymbol(d.symbol)
    },
    onError: e => setAddSymbolErr(e.response?.data?.detail || e.message),
  })

  function handleNewStratChange(type) {
    setNewStratType(type)
    if (type !== CUSTOM_SCRIPT_KEY) setNewStratParams(defaultParams(type))
  }

  function handleAddSymbol() {
    if (!newSymbol.trim()) return
    if (ibMode) {
      const result = onAddIbWatchlistSymbol?.(newSymbol)
      if (result?.added) {
        addSymbolMut.mutate({
          symbol: newSymbol.trim().toUpperCase(),
          strategy_name: encodeStrategy(newStratType, newStratParams, newScriptId),
          allocated_funds: 0,
        })
        if (result?.downgraded) {
          setAddSymbolErr('Added and reduced refresh to 15s due to watchlist limit.')
        }
      } else if (!result?.cancelled) {
        setAddSymbolErr(result?.error || 'Unable to add symbol.')
      }
      return
    }

    addSymbolMut.mutate({
      symbol: newSymbol.trim().toUpperCase(),
      strategy_name: encodeStrategy(newStratType, newStratParams, newScriptId),
      allocated_funds: parseFloat(newAlloc) || 0,
    })
  }

  const [addingWatchlist, setAddingWatchlist] = useState(false)
  async function handleAddFromWatchlist() {
    const stored = localStorage.getItem('dashboard_watchlist')
    const watchlist = stored ? JSON.parse(stored) : ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']
    const existingSymbols = new Set(positions.map(p => p.symbol))
    const toAdd = watchlist.filter(s => !existingSymbols.has(s))
    if (!toAdd.length) return
    setAddingWatchlist(true)
    for (const symbol of toAdd) {
      await addSandboxSymbol({ symbol, strategy_name: null, allocated_funds: 0 }).catch(() => {})
    }
    qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
    qc.invalidateQueries({ queryKey: ['sandbox-account'] })
    setAddingWatchlist(false)
  }

  return (
    <aside className="w-72 flex-shrink-0 bg-dark-800 border-r border-dark-500 flex flex-col">

      {/* Account summary — click to show portfolio overview */}
      <button
        onClick={onShowOverview}
        className={`w-full text-left px-4 py-4 border-b border-dark-500 transition-colors hover:bg-dark-700/40 ${
          selectedSymbol === null ? 'bg-dark-700/30 ring-1 ring-inset ring-emerald-600/30' : ''
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              {ibMode === 'live' ? 'Live Trading' : ibMode === 'paper' ? 'Paper Trading' : 'Portfolio'}
            </h2>
            {ibMode ? (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-bold ${
                ibMode === 'live' ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700/40'
                  : 'bg-blue-900/40 text-blue-400 border border-blue-700/40'
              }`}>
                <SignalIcon className="h-3 w-3" />
                {ibMode === 'live' ? 'LIVE' : 'PAPER'}
              </span>
            ) : null}
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${marketPhase.className}`} title="Current engine market phase">
              {marketPhase.label}
            </span>
          </div>
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            {!ibMode && (
              <>
                <button
                  onClick={e => { e.stopPropagation(); setShowAddFunds(v => !v); setShowWithdraw(false) }}
                  title="Add Funds"
                  className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${showAddFunds ? 'bg-emerald-700/30 text-emerald-300' : 'text-emerald-400 hover:bg-emerald-900/30'}`}
                >
                  <CurrencyDollarIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); setShowWithdraw(v => !v); setShowAddFunds(false) }}
                  title="Withdraw Funds"
                  className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${showWithdraw ? 'bg-amber-700/30 text-amber-300' : 'text-slate-400 hover:bg-dark-600'}`}
                >
                  <MinusCircleIcon className="h-4 w-4" />
                </button>
              </>
            )}
            {!ibMode && (
              <button
                onClick={e => { e.stopPropagation(); repairFundsMut.mutate() }}
                disabled={repairFundsMut.isPending}
                title="Repair Funds"
                className="flex items-center justify-center rounded-md p-1.5 text-amber-400 hover:bg-amber-900/30 disabled:opacity-50 transition-colors"
              >
                <WrenchScrewdriverIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {!ibMode && showAddFunds && (
          <div className="flex gap-2 mb-3" onClick={e => e.stopPropagation()}>
            <input className="input flex-1 py-1.5 text-sm" type="number" min="1" placeholder="Amount $"
              value={fundsInput} onChange={e => setFundsInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fundsInput && addFundsMut.mutate(parseFloat(fundsInput))} />
            <button className="btn-primary py-1.5 px-3 text-xs" disabled={!fundsInput || addFundsMut.isPending}
              onClick={() => addFundsMut.mutate(parseFloat(fundsInput))}>Add</button>
          </div>
        )}
        {!ibMode && showWithdraw && (
          <div className="mb-3 space-y-1.5" onClick={e => e.stopPropagation()}>
            <div className="flex gap-2">
              <input className="input flex-1 py-1.5 text-sm" type="number" min="1" placeholder="Amount $"
                value={withdrawInput} onChange={e => setWithdrawInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && withdrawInput) {
                    const amt = parseFloat(withdrawInput)
                    const avail = accountData?.available_funds ?? 0
                    if (amt <= avail) withdrawMut.mutate(amt)
                  }
                }} />
              <button className="btn-secondary py-1.5 px-3 text-xs"
                disabled={!withdrawInput || withdrawMut.isPending || parseFloat(withdrawInput) > (accountData?.available_funds ?? 0)}
                onClick={() => withdrawMut.mutate(parseFloat(withdrawInput))}>Withdraw</button>
            </div>
            {withdrawInput && parseFloat(withdrawInput) > (accountData?.available_funds ?? 0) && (
              <div className="text-xs text-amber-400 px-1">
                ⚠ Exceeds available funds ({fmtMoney(accountData?.available_funds ?? 0)}). Allocated funds cannot be withdrawn.
              </div>
            )}
          </div>
        )}
        {repairMsg && (
          <div className="mb-2 text-xs px-2 py-1.5 rounded bg-blue-900/30 border border-blue-700/40 text-blue-300" onClick={e => e.stopPropagation()}>
            {repairMsg}
          </div>
        )}

        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">{fundsLabel}</span><span className="text-slate-200 font-semibold">{fmtMoney(accountData?.total_funds)}</span></div>
          <div className="flex justify-between items-center">
            <span className="text-slate-500">{ibMode ? 'Available Funds' : 'Available'}</span>
            <span className={`font-semibold ${(accountData?.available_funds ?? 0) < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmtMoney(accountData?.available_funds)}</span>
          </div>
          <div className="flex justify-between"><span className="text-slate-500">{ibMode ? 'Gross Position Value' : 'Portfolio Equity'}</span><span className="text-slate-200 font-semibold">{fmtMoney(totalEquity)}</span></div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className={`rounded-lg p-2 text-center ${ibUnrealizedPnl >= 0 ? 'bg-emerald-900/20' : 'bg-red-900/20'}`}>
            <div className="text-xs text-slate-500 mb-0.5">Unrealised</div>
            <div className={`text-sm font-semibold ${ibUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(ibUnrealizedPnl)}</div>
          </div>
          <div className={`rounded-lg p-2 text-center ${ibRealizedPnl >= 0 ? 'bg-emerald-900/20' : 'bg-red-900/20'}`}>
            <div className="text-xs text-slate-500 mb-0.5">Realised</div>
            <div className={`text-sm font-semibold ${ibRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(ibRealizedPnl)}</div>
          </div>
        </div>
      </button>

      {/* Stock list */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Stocks</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAddFromWatchlist}
              disabled={addingWatchlist}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              title="Add all watchlist symbols not already in sidebar list">
              <QueueListIcon className="h-3.5 w-3.5" />{addingWatchlist ? 'Adding…' : 'Watchlist'}
            </button>
            <button onClick={() => setShowAddSymbol(v => !v)} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
              <PlusIcon className="h-3.5 w-3.5" />Add
            </button>
          </div>
        </div>

        {showAddSymbol && (
          <div className="mb-3 space-y-2 border border-dark-500 rounded-lg p-3 bg-dark-900/40">
            <SymbolAutocomplete
              value={newSymbol}
              onChange={v => setNewSymbol(v)}
              onSelect={hit => setNewSymbol(hit.symbol)}
              placeholder="Search symbol or name…"
            />
            <StrategySelector value={newStratType} scriptId={newScriptId} onStrategyChange={handleNewStratChange}
              onScriptChange={setNewScriptId} stratParams={newStratParams}
              onParamChange={(k, v) => setNewStratParams(p => ({ ...p, [k]: v }))} />
            {!ibMode && (
              <input className="input text-sm py-1.5 w-full" type="number" placeholder="Allocate funds $"
                value={newAlloc} onChange={e => setNewAlloc(e.target.value)} />
            )}
            {addSymbolErr && <div className="text-xs text-red-400">{addSymbolErr}</div>}
            <div className="flex gap-2">
              <button className="btn-primary flex-1 text-xs py-1.5" disabled={!newSymbol || addSymbolMut.isPending} onClick={handleAddSymbol}>Add Symbol</button>
              <button className="btn-secondary text-xs py-1.5 px-2" onClick={() => { setShowAddSymbol(false); setAddSymbolErr(''); setNewSymbol('') }}>Cancel</button>
            </div>
          </div>
        )}

        <div className="space-y-1">
          {positions.map(pos => (
            <StockListItem key={pos.symbol} pos={pos} quote={quotes[pos.symbol]} ibMode={ibMode}
              sector={sectors?.[pos.symbol]}
              pmScore={pmScores[pos.symbol]}
              managerSettings={managerSettings}
              accountTotalFunds={accountData?.total_funds ?? 0}
              isSelected={selectedSymbol === pos.symbol}
              toggleEngineMut={toggleEngineMut}
              onClick={() => onSelectSymbol(pos.symbol)} />
          ))}
          {positions.length === 0 && (
            <div className="text-center text-slate-600 text-xs py-6">No stocks yet.<br />Add a symbol above.</div>
          )}
        </div>
      </div>
    </aside>
  )
}

