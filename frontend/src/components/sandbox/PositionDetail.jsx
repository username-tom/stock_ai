import {
  TrashIcon, PencilSquareIcon, CheckIcon, XMarkIcon,
  ArrowUpIcon, ArrowDownIcon, BoltIcon, PlayIcon, StopCircleIcon,
  ClockIcon, SignalIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { useQuery } from '@tanstack/react-query'
import { getScripts } from '../../api/client'
import { fmt, fmtMoney, stratLabel } from './sandboxHelpers'
import StrategySelector from './StrategySelector'
import TradeRow from './TradeRow'

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
}) {
  const { data: scriptsData } = useQuery({ queryKey: ['scripts'], queryFn: getScripts, staleTime: 60000 })
  const scripts = scriptsData?.scripts ?? []

  function getScriptName(strategyName) {
    if (!strategyName?.startsWith('custom:')) return null
    const scriptId = parseInt(strategyName.split(':')[1], 10)
    return scripts.find(s => s.id === scriptId)?.name ?? null
  }
  return (
    <>
      {/* Header */}
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
        </div>
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">Shares Held</div>
          <div className="text-xl font-bold text-slate-100">{selectedPos.shares > 0 ? selectedPos.shares.toFixed(4) : '—'}</div>
          {selectedPos.shares > 0 && <div className="text-xs text-slate-500 mt-0.5">Avg ${selectedPos.avg_cost?.toFixed(2)}</div>}
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
          <StrategySelector value={editStratType} scriptId={editScriptId} onStrategyChange={handleEditStratChange}
            onScriptChange={setEditScriptId} stratParams={editStratParams}
            onParamChange={(k, v) => setEditStratParams(p => ({ ...p, [k]: v }))} />
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
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
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
            )}
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
            <input className="input w-28" type="number" min="0.0001" step="0.0001" placeholder="Shares"
              value={tradeForm.quantity} onChange={e => setTradeForm(f => ({ ...f, quantity: e.target.value }))} required />
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

      {/* Trade history */}
      <div className="card">
        <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-4">
          Trade History — {selectedSymbol}
          {trades.length > 0 && <span className="ml-2 text-slate-500 font-normal normal-case">({trades.length})</span>}
        </h3>
        {trades.length === 0 ? (
          <div className="text-center text-slate-600 text-sm py-8">No trades recorded yet.</div>
        ) : (
          <div className="table-container">
            <table>
              <thead><tr><th>Date</th><th>Side</th><th>Qty</th><th>Price</th><th>Total</th><th>P&amp;L</th><th>Reason</th><th>Strategy</th></tr></thead>
              <tbody>{trades.map(t => <TradeRow key={t.id} trade={t} />)}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
