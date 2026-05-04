import { useState, useMemo, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  SignalIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, ArrowPathIcon, XMarkIcon,
} from '@heroicons/react/24/outline'
import {
  getSandboxAccount, getSandboxPositions,
  updateSandboxPosition, removeSandboxSymbol,
  getSandboxTrades, placeSandboxTrade,
  exportSandbox, importSandbox, resetSandbox,
  getBulkQuotes, getIBStatus,
  getSandboxEngineState, toggleSandboxEngine,
  getSandboxAnalytics,
} from '../api/client'
import { pct, fmt, fmtMoney, defaultParams, encodeStrategy, decodeStrategy } from './sandbox/sandboxHelpers'
import { CUSTOM_SCRIPT_KEY } from './sandbox/sandboxConstants'
import SandboxSidebar from './sandbox/SandboxSidebar'
import PortfolioOverview from './sandbox/PortfolioOverview'
import PositionDetail from './sandbox/PositionDetail'

export default function SandboxPanel() {
  const qc = useQueryClient()
  const importInputRef = useRef(null)

  const [selectedSymbol, setSelectedSymbol] = useState(null)
  const [editingStrategy, setEditingStrategy] = useState(false)
  const [editStratType, setEditStratType] = useState('sma_crossover')
  const [editScriptId, setEditScriptId] = useState(null)
  const [editStratParams, setEditStratParams] = useState({})
  const [editingAlloc, setEditingAlloc] = useState(false)
  const [allocInput, setAllocInput] = useState('')
  const [tradeForm, setTradeForm] = useState({ side: 'BUY', quantity: '', price: '', reason: '' })
  const [tradeMsg, setTradeMsg] = useState(null)
  const [exportLoading, setExportLoading] = useState(false)
  const [importMsg, setImportMsg] = useState(null)
  const [resetConfirm, setResetConfirm] = useState(false)

  // IB status
  const { data: ibStatus } = useQuery({ queryKey: ['ib-status'], queryFn: getIBStatus, refetchInterval: 5000 })
  const ibConnected = ibStatus?.connected === true
  const ibMode = ibConnected ? (ibStatus?.mode ?? 'paper') : null

  // queries
  const { data: accountData } = useQuery({ queryKey: ['sandbox-account'], queryFn: getSandboxAccount, refetchInterval: 10000 })
  const { data: posData } = useQuery({ queryKey: ['sandbox-positions'], queryFn: getSandboxPositions, refetchInterval: 10000 })
  const positions = posData?.positions ?? []
  const symbols = positions.map(p => p.symbol)
  const { data: quotesData } = useQuery({
    queryKey: ['sandbox-quotes', symbols.join(',')],
    queryFn: () => symbols.length ? getBulkQuotes(symbols) : Promise.resolve({}),
    enabled: symbols.length > 0,
    refetchInterval: 30000,
  })
  const quotes = quotesData ?? {}
  const { data: tradesData } = useQuery({
    queryKey: ['sandbox-trades', selectedSymbol],
    queryFn: () => getSandboxTrades(selectedSymbol),
    enabled: !!selectedSymbol,
    refetchInterval: 15000,
  })
  const trades = tradesData?.trades ?? []
  const selectedPos = positions.find(p => p.symbol === selectedSymbol)
  const selectedPrice = quotes[selectedSymbol]?.last_price ?? selectedPos?.avg_cost ?? 0

  // portfolio calcs
  const totalEquity = useMemo(() => positions.reduce((s, p) => s + (quotes[p.symbol]?.last_price ?? p.avg_cost) * p.shares, 0), [positions, quotes])
  const totalRealizedPnl = positions.reduce((s, p) => s + (p.realized_pnl ?? 0), 0)
  const totalUnrealizedPnl = positions.reduce((s, p) => s + ((quotes[p.symbol]?.last_price ?? p.avg_cost) - p.avg_cost) * p.shares, 0)
  const pieData = useMemo(() => {
    const active = positions.filter(p => p.shares > 0 || p.allocated_funds > 0)
    const total = active.reduce((s, p) => {
      const mv = (quotes[p.symbol]?.last_price ?? p.avg_cost) * p.shares
      const cashRemaining = Math.max(0, p.allocated_funds - p.avg_cost * p.shares)
      return s + mv + cashRemaining
    }, 0)
    if (total === 0) return []
    return active.map(p => {
      const mv = (quotes[p.symbol]?.last_price ?? p.avg_cost) * p.shares
      const cashRemaining = Math.max(0, p.allocated_funds - p.avg_cost * p.shares)
      const sliceValue = mv + cashRemaining
      return { symbol: p.symbol, shares: p.shares, market_value: sliceValue, mv, cash: cashRemaining, pct: pct(sliceValue, total) }
    })
  }, [positions, quotes])
  const selectedMarketValue = selectedPos ? selectedPrice * selectedPos.shares : 0
  const selectedUnrealised = selectedPos ? selectedMarketValue - selectedPos.avg_cost * selectedPos.shares : 0

  // engine state & analytics
  const { data: engineState } = useQuery({ queryKey: ['sandbox-engine-state'], queryFn: getSandboxEngineState, refetchInterval: 10000 })
  const { data: analytics } = useQuery({ queryKey: ['sandbox-analytics'], queryFn: getSandboxAnalytics, refetchInterval: 30000 })

  // mutations
  const removeSymbolMut = useMutation({
    mutationFn: s => removeSandboxSymbol(s),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sandbox-positions'] }); setSelectedSymbol(null) },
  })
  const updatePosMut = useMutation({
    mutationFn: ({ symbol, payload }) => updateSandboxPosition(symbol, payload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sandbox-positions'] }); qc.invalidateQueries({ queryKey: ['sandbox-account'] }) },
  })
  const tradeMut = useMutation({
    mutationFn: p => placeSandboxTrade(p),
    onSuccess: d => {
      setTradeMsg({ type: 'success', text: `${d.side} ${d.quantity} ${d.symbol} @ $${d.price.toFixed(2)}${d.pnl != null ? ` — PnL: ${fmt(d.pnl)}` : ''}` })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades', selectedSymbol] })
      setTradeForm(f => ({ ...f, quantity: '', reason: '' }))
    },
    onError: e => setTradeMsg({ type: 'error', text: e.response?.data?.detail || e.message }),
  })
  const resetMut = useMutation({
    mutationFn: resetSandbox,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades'] })
      setSelectedSymbol(null); setResetConfirm(false)
    },
  })
  const toggleEngineMut = useMutation({
    mutationFn: s => toggleSandboxEngine(s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sandbox-positions'] }),
  })

  // handlers
  function handleEditStratOpen() {
    const d = decodeStrategy(selectedPos?.strategy_name)
    setEditStratType(d.type); setEditStratParams(d.params); setEditScriptId(d.scriptId); setEditingStrategy(true)
  }
  function handleEditStratChange(type) {
    setEditStratType(type)
    if (type !== CUSTOM_SCRIPT_KEY) setEditStratParams(defaultParams(type))
  }
  function handleEditStratSave() {
    updatePosMut.mutate({ symbol: selectedSymbol, payload: { strategy_name: encodeStrategy(editStratType, editStratParams, editScriptId) } })
    setEditingStrategy(false)
  }
  function handleTrade(e) {
    e.preventDefault(); setTradeMsg(null)
    tradeMut.mutate({ symbol: selectedSymbol, side: tradeForm.side, quantity: parseFloat(tradeForm.quantity), price: parseFloat(tradeForm.price) || selectedPrice, strategy_name: selectedPos?.strategy_name, reason: tradeForm.reason || undefined })
  }
  async function handleExport() {
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
    setSelectedSymbol(symbol)
    setTradeMsg(null)
    setEditingStrategy(false)
  }

  return (
    <div className="flex h-screen max-h-screen overflow-hidden">

      <SandboxSidebar
        ibMode={ibMode}
        accountData={accountData}
        totalEquity={totalEquity}
        totalUnrealizedPnl={totalUnrealizedPnl}
        totalRealizedPnl={totalRealizedPnl}
        positions={positions}
        quotes={quotes}
        selectedSymbol={selectedSymbol}
        onSelectSymbol={handleSelectSymbol}
        onShowOverview={() => handleSelectSymbol(null)}
      />

      {/* Right panel */}
      <main className="flex-1 overflow-y-auto bg-dark-900 min-h-0">

        {/* Toolbar */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-dark-700 bg-dark-800/60">
          <div className="flex items-center gap-2">
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
          <div className="flex items-center gap-2 flex-wrap">
            <button className="flex items-center gap-1.5 text-xs border border-dark-500 text-slate-400 hover:text-slate-200 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
              onClick={handleExport} disabled={exportLoading} title="Export sandbox as JSON">
              <ArrowDownTrayIcon className="h-3.5 w-3.5" />{exportLoading ? 'Exporting…' : 'Export'}
            </button>
            <button className="flex items-center gap-1.5 text-xs border border-dark-500 text-slate-400 hover:text-slate-200 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors"
              onClick={() => importInputRef.current?.click()} title="Import sandbox from JSON">
              <ArrowUpTrayIcon className="h-3.5 w-3.5" />Import
            </button>
            <input ref={importInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
            {resetConfirm ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-red-400">Confirm reset?</span>
                <button className="text-xs bg-red-700 hover:bg-red-600 text-white rounded-lg px-2.5 py-1.5 font-semibold transition-colors disabled:opacity-50"
                  onClick={() => resetMut.mutate()} disabled={resetMut.isPending}>
                  {resetMut.isPending ? 'Resetting…' : 'Yes, Reset'}
                </button>
                <button className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-lg px-2.5 py-1.5 transition-colors"
                  onClick={() => setResetConfirm(false)}>Cancel</button>
              </div>
            ) : (
              <button className="flex items-center gap-1.5 text-xs border border-red-900/40 text-red-400/70 hover:text-red-400 hover:border-red-700/50 rounded-lg px-3 py-1.5 transition-colors"
                onClick={() => setResetConfirm(true)} title="Reset all sandbox data">
                <ArrowPathIcon className="h-3.5 w-3.5" />Reset Portfolio
              </button>
            )}
          </div>
        </div>

        {importMsg && (
          <div className={`mx-6 mt-4 flex items-center justify-between gap-3 p-3 rounded-lg text-sm border ${importMsg.type === 'success' ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400' : 'bg-red-900/20 border-red-700/30 text-red-400'}`}>
            <span>{importMsg.text}</span>
            <button onClick={() => setImportMsg(null)} className="text-slate-500 hover:text-slate-300 flex-shrink-0"><XMarkIcon className="h-4 w-4" /></button>
          </div>
        )}

        <div className="p-6 space-y-6">
          {!selectedSymbol ? (
            <PortfolioOverview
              ibMode={ibMode}
              accountData={accountData}
              positions={positions}
              quotes={quotes}
              totalEquity={totalEquity}
              totalUnrealizedPnl={totalUnrealizedPnl}
              totalRealizedPnl={totalRealizedPnl}
              pieData={pieData}
              analytics={analytics}
              onSelectSymbol={handleSelectSymbol}
            />
          ) : !selectedPos ? (
            <div className="text-slate-500 text-sm">Loading…</div>
          ) : (
            <PositionDetail
              selectedSymbol={selectedSymbol}
              selectedPos={selectedPos}
              selectedPrice={selectedPrice}
              selectedMarketValue={selectedMarketValue}
              selectedUnrealised={selectedUnrealised}
              quotes={quotes}
              trades={trades}
              engineState={engineState}
              editingStrategy={editingStrategy}
              setEditingStrategy={setEditingStrategy}
              editStratType={editStratType}
              editScriptId={editScriptId}
              setEditScriptId={setEditScriptId}
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
              removeSymbolMut={removeSymbolMut}
              toggleEngineMut={toggleEngineMut}
              tradeForm={tradeForm}
              setTradeForm={setTradeForm}
              tradeMsg={tradeMsg}
              setTradeMsg={setTradeMsg}
              handleTrade={handleTrade}
              tradeMut={tradeMut}
            />
          )}
        </div>
      </main>
    </div>
  )
}
