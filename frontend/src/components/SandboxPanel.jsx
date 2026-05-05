import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  SignalIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, ArrowPathIcon, XMarkIcon,
  CpuChipIcon, RectangleGroupIcon,
} from '@heroicons/react/24/outline'
import {
  getSandboxAccount, getSandboxPositions,
  updateSandboxPosition, removeSandboxSymbol,
  getSandboxTrades, placeSandboxTrade,
  exportSandbox, importSandbox, resetSandbox, resetSandboxSoft,
  getBulkQuotes, getIBStatus,
  getSandboxEngineState, toggleSandboxEngine, toggleAllSandboxEngines,
  getSandboxAnalytics,
  getPortfolioManagerState, togglePortfolioManager,
  bulkUpdateSandboxStrategy,
} from '../api/client'
import { pct, fmt, fmtMoney, defaultParams, encodeStrategy, decodeStrategy } from './sandbox/sandboxHelpers'
import { CUSTOM_SCRIPT_KEY, TEMPLATE_SCRIPT_KEY } from './sandbox/sandboxConstants'
import { useAppSettings } from '../hooks/useAppSettings'
import SandboxSidebar from './sandbox/SandboxSidebar'
import PortfolioOverview from './sandbox/PortfolioOverview'
import PositionDetail from './sandbox/PositionDetail'
import TradeNotificationBanner from './sandbox/TradeNotificationBanner'
import ActivityLog from './sandbox/ActivityLog'
import StrategySelector from './sandbox/StrategySelector'

export default function SandboxPanel() {
  const qc = useQueryClient()
  const appSettings = useAppSettings()
  const importInputRef = useRef(null)

  const [selectedSymbol, setSelectedSymbol] = useState(null)
  const [editingStrategy, setEditingStrategy] = useState(false)
  const [editStratType, setEditStratType] = useState('sma_crossover')
  const [editScriptId, setEditScriptId] = useState(null)
  const [editTemplateFilename, setEditTemplateFilename] = useState(null)
  const [editStratParams, setEditStratParams] = useState({})
  const [editingAlloc, setEditingAlloc] = useState(false)
  const [allocInput, setAllocInput] = useState('')
  const [tradeForm, setTradeForm] = useState({ side: 'BUY', quantity: '', price: '', reason: '' })
  const [tradeMsg, setTradeMsg] = useState(null)

  // Reset per-trade fields when switching symbols so quantity doesn't bleed across positions
  useEffect(() => {
    setTradeForm(f => ({ ...f, quantity: '', price: '', reason: '' }))
    setTradeMsg(null)
  }, [selectedSymbol])
  const [exportLoading, setExportLoading] = useState(false)
  const [importMsg, setImportMsg] = useState(null)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [resetSoftConfirm, setResetSoftConfirm] = useState(false)
  const [showResetMenu, setShowResetMenu] = useState(false)
  const [activities, setActivities] = useState([])
  const prevTradeIdRef = useRef(null)

  // bulk-strategy modal state
  const [bulkStratOpen, setBulkStratOpen] = useState(false)
  const [bulkStratType, setBulkStratType] = useState('sma_crossover')
  const [bulkScriptId, setBulkScriptId] = useState(null)
  const [bulkTemplateFilename, setBulkTemplateFilename] = useState(null)
  const [bulkStratParams, setBulkStratParams] = useState({})

  // IB status
  const { data: ibStatus } = useQuery({ queryKey: ['ib-status'], queryFn: getIBStatus, refetchInterval: appSettings.trading_status_ms })
  const ibConnected = ibStatus?.connected === true
  const ibMode = ibConnected ? (ibStatus?.mode ?? 'paper') : null

  // queries
  const { data: accountData } = useQuery({ queryKey: ['sandbox-account'], queryFn: getSandboxAccount, refetchInterval: appSettings.sandbox_account_ms })
  const { data: posData } = useQuery({ queryKey: ['sandbox-positions'], queryFn: getSandboxPositions, refetchInterval: appSettings.sandbox_account_ms })
  const positions = posData?.positions ?? []
  const symbols = positions.map(p => p.symbol)
  const { data: quotesData } = useQuery({
    queryKey: ['sandbox-quotes', symbols.join(',')],
    queryFn: () => symbols.length ? getBulkQuotes(symbols) : Promise.resolve({}),
    enabled: symbols.length > 0,
    refetchInterval: appSettings.sandbox_quotes_ms,
  })
  const quotes = quotesData ?? {}
  const { data: tradesData } = useQuery({
    queryKey: ['sandbox-trades', selectedSymbol],
    queryFn: () => getSandboxTrades(selectedSymbol),
    enabled: !!selectedSymbol,
    refetchInterval: appSettings.sandbox_trades_ms,
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
  const { data: engineState } = useQuery({ queryKey: ['sandbox-engine-state'], queryFn: getSandboxEngineState, refetchInterval: appSettings.sandbox_engine_ms })
  const { data: analytics } = useQuery({ queryKey: ['sandbox-analytics'], queryFn: getSandboxAnalytics, refetchInterval: appSettings.sandbox_quotes_ms })
  const { data: managerState } = useQuery({ queryKey: ['portfolio-manager-state'], queryFn: getPortfolioManagerState, refetchInterval: appSettings.sandbox_engine_ms })

  // all recent trades (for notification + activity log)
  const { data: allTradesData } = useQuery({
    queryKey: ['sandbox-trades-all'],
    queryFn: () => getSandboxTrades(undefined, 50),
    refetchInterval: appSettings.sandbox_trades_ms,
  })
  const allTrades = allTradesData?.trades ?? []
  const engineTrades = allTrades.filter(t => t.strategy_name)
  const latestEngineTrade = engineTrades[0] ?? null

  // build activity log entries from trades + mutations
  useEffect(() => {
    if (!allTrades.length) return
    const newest = allTrades[0]
    if (newest.id === prevTradeIdRef.current) return
    prevTradeIdRef.current = newest.id
    // add new trades that aren't yet in activities
    setActivities(prev => {
      const existingIds = new Set(prev.filter(a => a.tradeId).map(a => a.tradeId))
      const newEntries = allTrades
        .filter(t => !existingIds.has(t.id))
        .map(t => ({
          type: 'trade',
          tradeId: t.id,
          side: t.side,
          label: `${t.side} ${t.quantity} ${t.symbol} @ $${t.price?.toFixed(2)}${
            t.pnl != null ? ` · PnL: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : ''
          }`,
          sub: t.strategy_name ? `via ${t.strategy_name.split(':')[0]}${t.reason ? ' — ' + t.reason : ''}` : t.reason || undefined,
          time: t.created_at ? new Date(t.created_at).toLocaleTimeString() : '',
        }))
      return [...newEntries, ...prev].slice(0, 100)
    })
  }, [allTrades])

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
  const resetSoftMut = useMutation({
    mutationFn: resetSandboxSoft,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox-account'] })
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-trades'] })
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
        label: `${symbol} engine ${nowEnabled ? 'started' : 'stopped'}`,
        sub: pos?.strategy_name?.split(':')[0],
        time: new Date().toLocaleTimeString(),
      }, ...prev].slice(0, 100))
    },
  })
  const toggleAllEnginesMut = useMutation({
    mutationFn: toggleAllSandboxEngines,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      qc.invalidateQueries({ queryKey: ['sandbox-engine-state'] })
      setActivities(prev => [{
        type: 'engine',
        label: 'All sandbox engines toggled',
        time: new Date().toLocaleTimeString(),
      }, ...prev].slice(0, 100))
    },
  })
  const toggleManagerMut = useMutation({
    mutationFn: togglePortfolioManager,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] })
      const enabled = data?.settings?.enabled ?? data?.enabled
      setActivities(prev => [{
        type: 'manager',
        label: `Portfolio Manager ${enabled ? 'enabled' : 'disabled'}`,
        time: new Date().toLocaleTimeString(),
      }, ...prev].slice(0, 100))
    },
  })
  const bulkStrategyMut = useMutation({
    mutationFn: (strategyName) => bulkUpdateSandboxStrategy(strategyName),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      setBulkStratOpen(false)
      setActivities(prev => [{
        type: 'engine',
        label: `Strategy updated for all ${data.updated} position${data.updated !== 1 ? 's' : ''}`,
        sub: data.strategy_name ?? 'none',
        time: new Date().toLocaleTimeString(),
      }, ...prev].slice(0, 100))
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
      <TradeNotificationBanner latestEngineTrade={latestEngineTrade} />
      <ActivityLog activities={activities} />

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
              allTrades={allTrades}
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
              accountData={accountData}
              quotes={quotes}
              trades={trades}
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

      {/* ── Bulk Strategy Modal ─────────────────────────────────────────── */}
      {bulkStratOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-dark-800 border border-dark-600 rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
              <div className="flex items-center gap-2">
                <RectangleGroupIcon className="h-5 w-5 text-sky-400" />
                <span className="font-semibold text-slate-100">Set Strategy for All Positions</span>
              </div>
              <button onClick={() => setBulkStratOpen(false)} className="text-slate-500 hover:text-slate-300 transition-colors">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-4">
              <p className="text-xs text-slate-400 leading-relaxed">
                Choose a strategy below. It will be applied to <span className="text-slate-200 font-medium">all {positions.length} position{positions.length !== 1 ? 's' : ''}</span> in the sandbox, replacing any existing strategy assignment.
              </p>
              <StrategySelector
                value={bulkStratType}
                scriptId={bulkScriptId}
                templateFilename={bulkTemplateFilename}
                onStrategyChange={type => { setBulkStratType(type); if (type !== CUSTOM_SCRIPT_KEY && type !== TEMPLATE_SCRIPT_KEY) setBulkStratParams(defaultParams(type)) }}
                onScriptChange={id => setBulkScriptId(id)}
                onTemplateChange={fn => setBulkTemplateFilename(fn)}
                stratParams={bulkStratParams}
                onParamChange={(k, v) => setBulkStratParams(p => ({ ...p, [k]: v }))}
              />
              {bulkStrategyMut.isError && (
                <p className="text-xs text-red-400">{bulkStrategyMut.error?.response?.data?.detail || bulkStrategyMut.error?.message}</p>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-dark-700">
              <button
                className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-lg px-4 py-2 transition-colors"
                onClick={() => setBulkStratOpen(false)}
              >
                Cancel
              </button>
              <button
                className="text-xs bg-sky-700 hover:bg-sky-600 text-white rounded-lg px-4 py-2 font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5"
                onClick={handleBulkStratApply}
                disabled={bulkStrategyMut.isPending || (bulkStratType === CUSTOM_SCRIPT_KEY && !bulkScriptId)}
              >
                <RectangleGroupIcon className="h-3.5 w-3.5" />
                {bulkStrategyMut.isPending ? 'Applying…' : `Apply to All ${positions.length} Position${positions.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
