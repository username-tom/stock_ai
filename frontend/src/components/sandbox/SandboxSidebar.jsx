import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PlusIcon, MinusCircleIcon, CurrencyDollarIcon, SignalIcon, BeakerIcon, QueueListIcon,
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
  totalEquity,
  totalUnrealizedPnl,
  totalRealizedPnl,
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
  const ibUnrealizedPnl = ibMode && Number.isFinite(Number(accountData?.unrealized_pnl))
    ? Number(accountData.unrealized_pnl)
    : totalUnrealizedPnl
  const ibRealizedPnl = ibMode && Number.isFinite(Number(accountData?.realized_pnl))
    ? Number(accountData.realized_pnl)
    : totalRealizedPnl

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
        setShowAddSymbol(false)
        setNewSymbol('')
        setNewAlloc('')
        setAddSymbolErr(result?.downgraded
          ? `Added and reduced refresh to 15s due to watchlist limit.`
          : '')
        onSelectSymbol(newSymbol.trim().toUpperCase())
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
    if (ibMode) {
      setAddSymbolErr('Paper/Live symbols are managed directly via watchlist add/remove.')
      return
    }

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
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-bold bg-slate-800 text-slate-500 border border-dark-500">
                <BeakerIcon className="h-3 w-3" />SIM
              </span>
            )}
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
          <div className="flex justify-between"><span className="text-slate-500">{ibMode ? 'Net Liquidation' : 'Total Funds'}</span><span className="text-slate-200 font-semibold">{fmtMoney(accountData?.total_funds)}</span></div>
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
            {!ibMode && (
              <button
                onClick={handleAddFromWatchlist}
                disabled={addingWatchlist}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
                title="Add all watchlist symbols not already in portfolio">
                <QueueListIcon className="h-3.5 w-3.5" />{addingWatchlist ? 'Adding…' : 'Watchlist'}
              </button>
            )}
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
            <StockListItem key={pos.symbol} pos={pos} quote={quotes[pos.symbol]}
              sector={sectors?.[pos.symbol]}
              pmScore={pmScores[pos.symbol]}
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

