import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend, LineChart, Line,
} from 'recharts'
import { quotesentiment, SENTIMENT_COLORS, SENTIMENT_LABELS, quotesignal, SIGNAL_COLORS, SIGNAL_LABELS } from '../utils/sentiment'
import SymbolAutocomplete from './shared/SymbolAutocomplete'
import {
  getSandboxAccount, addSandboxFunds, getSandboxPositions,
  addSandboxSymbol, updateSandboxPosition, removeSandboxSymbol,
  getSandboxTrades, placeSandboxTrade,
  exportSandbox, importSandbox, resetSandbox,
  getStrategies, getScripts, getBulkQuotes,
  getIBStatus,
  getSandboxEngineState, toggleSandboxEngine,
  getSandboxAnalytics,
} from '../api/client'
import {
  PlusIcon, TrashIcon, CurrencyDollarIcon, ChartPieIcon,
  ArrowUpIcon, ArrowDownIcon, PencilSquareIcon, CheckIcon, XMarkIcon,
  ArrowDownTrayIcon, ArrowUpTrayIcon, ArrowPathIcon, CodeBracketIcon,
  SignalIcon, BeakerIcon, PlayIcon, StopCircleIcon, ChevronDownIcon,
  ClockIcon, BoltIcon, ExclamationTriangleIcon, HomeIcon, TableCellsIcon,
} from '@heroicons/react/24/outline'

// ?? constants ?????????????????????????????????????????????????????????????? //
const PIE_COLORS = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6']
const CUSTOM_SCRIPT_KEY = '__custom_script__'
const STRATEGY_PARAM_UI = {
  sma_crossover: [
    { key: 'fast_period', label: 'Fast Period', type: 'number', default: 10 },
    { key: 'slow_period', label: 'Slow Period', type: 'number', default: 30 },
    { key: 'ma_type', label: 'MA Type', type: 'select', options: ['SMA', 'EMA'], default: 'SMA' },
  ],
  rsi: [
    { key: 'period', label: 'RSI Period', type: 'number', default: 14 },
    { key: 'oversold', label: 'Oversold Level', type: 'number', default: 30 },
    { key: 'overbought', label: 'Overbought Level', type: 'number', default: 70 },
  ],
  bollinger_bands: [
    { key: 'period', label: 'Period', type: 'number', default: 20 },
    { key: 'std_dev', label: 'Std Dev', type: 'number', default: 2.0, step: 0.1 },
  ],
}

// ?? helpers ???????????????????????????????????????????????????????????????? //
const pct = (v, t) => (!t ? '0.0' : ((v / t) * 100).toFixed(1))
const fmt = n => n == null ? '—' : n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`
const fmtMoney = n => n == null ? '—' : `$${Number(n).toFixed(2)}`
const stratLabel = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const defaultParams = type => Object.fromEntries((STRATEGY_PARAM_UI[type] || []).map(f => [f.key, f.default]))

function encodeStrategy(type, params, scriptId) {
  if (type === CUSTOM_SCRIPT_KEY) return scriptId ? `custom:${scriptId}` : null
  const p = Object.keys(params).length ? ':' + JSON.stringify(params) : ''
  return `${type}${p}`
}
function decodeStrategy(raw) {
  if (!raw) return { type: 'sma_crossover', params: defaultParams('sma_crossover'), scriptId: null }
  if (raw.startsWith('custom:')) return { type: CUSTOM_SCRIPT_KEY, params: {}, scriptId: parseInt(raw.slice(7), 10) || null }
  const i = raw.indexOf(':')
  if (i === -1) return { type: raw, params: defaultParams(raw), scriptId: null }
  const type = raw.slice(0, i)
  try { return { type, params: JSON.parse(raw.slice(i + 1)), scriptId: null } }
  catch { return { type, params: defaultParams(type), scriptId: null } }
}

// ?? StrategySelector ??????????????????????????????????????????????????????? //
function StrategySelector({ value, scriptId, onStrategyChange, onScriptChange, stratParams, onParamChange }) {
  const { data: stratData, isLoading: stratLoading } = useQuery({ queryKey: ['strategies'], queryFn: getStrategies })
  const { data: scriptsData, isLoading: scriptsLoading } = useQuery({ queryKey: ['scripts'], queryFn: getScripts })
  const [editorOpen, setEditorOpen] = useState(false)
  const [scriptText, setScriptText] = useState('')
  const isCustom = value === CUSTOM_SCRIPT_KEY
  const scripts = scriptsData?.scripts ?? []
  const paramFields = isCustom ? [] : (STRATEGY_PARAM_UI[value] || [])
  const strategies = stratData?.strategies ?? []
  const selectedStrategy = strategies.find(s => s.type === value)
  const selectedScript = isCustom ? scripts.find(s => s.id === scriptId) : null

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Strategy</label>
        {stratLoading
          ? <div className="input animate-pulse bg-dark-700 text-transparent">Loading</div>
          : <select className="input" value={value} onChange={e => onStrategyChange(e.target.value)}>
              {strategies.map(s => <option key={s.type} value={s.type}>{stratLabel(s.type)}</option>)}
              <option value={CUSTOM_SCRIPT_KEY}>? Custom Script</option>
            </select>
        }
        {/* Strategy description */}
        {selectedStrategy?.description && (
          <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">{selectedStrategy.description}</p>
        )}
      </div>

      {isCustom && (
        <div className="border border-dark-500 rounded-lg overflow-hidden bg-dark-900/30">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 uppercase tracking-wider border-b border-dark-600">
            <CodeBracketIcon className="h-3.5 w-3.5" />Custom Script
          </div>
          <div className="p-3 space-y-2">
            {scriptsLoading ? <div className="h-8 bg-dark-700 rounded animate-pulse" />
              : scripts.length === 0 ? <div className="text-xs text-amber-400/80">No scripts saved yet. Create one in the Scripts tab.</div>
              : <>
                  <select className="input" value={scriptId ?? ''} onChange={e => {
                    const id = e.target.value ? parseInt(e.target.value, 10) : null
                    onScriptChange(id)
                    const sc = scripts.find(s => s.id === id)
                    setScriptText(sc?.script_code || '')
                    setEditorOpen(false)
                  }}>
                    <option value="">— choose a script —</option>
                    {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {selectedScript && (
                    <>
                      {selectedScript.description && (
                        <p className="text-xs text-slate-500 leading-relaxed">{selectedScript.description}</p>
                      )}
                      {/* Collapsible script editor */}
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors w-full text-left"
                        onClick={() => { setEditorOpen(v => !v); if (!editorOpen) setScriptText(selectedScript.script_code || '') }}
                      >
                        <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${editorOpen ? 'rotate-180' : ''}`} />
                        {editorOpen ? 'Hide' : 'View / Edit'} script
                      </button>
                      {editorOpen && (
                        <textarea
                          className="w-full h-64 font-mono text-xs bg-dark-950 border border-dark-500 rounded-lg p-3 text-slate-300 resize-y focus:outline-none focus:ring-1 focus:ring-emerald-600/50"
                          value={scriptText}
                          onChange={e => setScriptText(e.target.value)}
                          spellCheck={false}
                        />
                      )}
                    </>
                  )}
                </>
            }
          </div>
        </div>
      )}

      {!isCustom && paramFields.length > 0 && (
        <div className="border border-dark-500 rounded-lg p-3 space-y-2 bg-dark-900/30">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Strategy Parameters</div>
          {paramFields.map(f => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {f.type === 'select'
                ? <select className="input" value={stratParams[f.key] ?? f.default} onChange={e => onParamChange(f.key, e.target.value)}>
                    {f.options.map(o => <option key={o}>{o}</option>)}
                  </select>
                : <input className="input" type="number" step={f.step ?? 1} value={stratParams[f.key] ?? f.default}
                    onChange={e => onParamChange(f.key, f.step ? parseFloat(e.target.value) : parseInt(e.target.value, 10))} />
              }
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ?? StockListItem ??????????????????????????????????????????????????????????? //
function StockListItem({ pos, quote, isSelected, onClick }) {
  const mp = quote?.last_price ?? pos.avg_cost
  const equity = mp * pos.shares
  const unrealised = equity - pos.avg_cost * pos.shares
  const totalPnl = pos.realized_pnl + unrealised
  const changePct = quote?.change_pct
  const positive = changePct == null ? null : changePct >= 0
  return (
    <div className="relative group">
      <button onClick={onClick} className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${isSelected ? 'bg-emerald-600/20 border-emerald-600/40' : 'border-transparent hover:bg-dark-700'}`}>
        <div className="flex items-center justify-between mb-0.5">
          <span className="font-bold text-slate-100 text-sm">{pos.symbol}</span>
          <div className="flex items-center gap-1.5">
            {changePct != null && (
              <span className={`text-xs font-medium ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
                {positive ? '+' : ''}{changePct.toFixed(2)}%
              </span>
            )}
            {pos.shares > 0 && <span className={`text-xs font-semibold ${totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalPnl)}</span>}
          </div>
        </div>
        {quote?.company_name && (
          <div className="text-xs text-slate-500 truncate mb-0.5">{quote.company_name}</div>
        )}
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{pos.shares > 0 ? `${pos.shares.toFixed(4)} sh` : 'Watchlist'}</span>
          <span className="font-mono text-slate-400">
            {quote?.last_price != null ? `$${quote.last_price.toFixed(2)}` : pos.shares > 0 ? fmtMoney(equity) : '—'}
          </span>
        </div>
        {pos.shares > 0 && (
          <div className="flex items-center justify-between text-xs mt-0.5">
            <span className="text-slate-600">Equity {fmtMoney(equity)}</span>
            <span className={`font-semibold ${unrealised >= 0 ? 'text-emerald-500/80' : 'text-red-500/80'}`}>{fmt(unrealised)}</span>
          </div>
        )}
        {pos.strategy_name && (
          <div className="mt-0.5 text-xs text-blue-400/80 truncate">{pos.strategy_name.split(':')[0]}</div>
        )}
        {(() => {
          const s = quotesentiment(quote)
          const sig = quotesignal(quote)
          if (!s && !sig) return null
          return (
            <div className="mt-1 flex flex-wrap gap-1">
              {s && (
                <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SENTIMENT_COLORS[s]}`}>
                  {SENTIMENT_LABELS[s]}
                </div>
              )}
              {sig && (
                <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SIGNAL_COLORS[sig]}`}>
                  {SIGNAL_LABELS[sig]}
                </div>
              )}
            </div>
          )
        })()}
      </button>
      {/* Hover tooltip */}
      {quote && (
        <div className="pointer-events-none absolute left-full top-0 ml-2 z-50 w-52
                       rounded-lg bg-dark-600 border border-dark-400 p-3 shadow-xl
                       opacity-0 group-hover:opacity-100 transition-opacity text-xs space-y-1.5">
          <div className="font-bold text-slate-100 text-sm">{quote.symbol}</div>
          {quote.company_name && <div className="text-slate-400">{quote.company_name}</div>}
          {(() => {
            const s = quotesentiment(quote)
            const sig = quotesignal(quote)
            if (!s && !sig) return null
            return (
              <div className="flex flex-wrap gap-1">
                {s && (
                  <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SENTIMENT_COLORS[s]}`}>
                    {SENTIMENT_LABELS[s]}
                  </div>
                )}
                {sig && (
                  <div className={`inline-flex items-center px-1.5 py-0.5 rounded border text-xs font-medium ${SIGNAL_COLORS[sig]}`}>
                    {SIGNAL_LABELS[sig]}
                  </div>
                )}
              </div>
            )
          })()}
          <div className="border-t border-dark-500 pt-1.5 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-500">Price</span>
              <span className="text-slate-200 font-mono">${quote.last_price?.toFixed(2) ?? '—'}</span>
            </div>
            {changePct != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Day Change</span>
                <span className={`font-semibold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
                  {positive ? '+' : ''}{changePct.toFixed(2)}%
                </span>
              </div>
            )}
            {quote.day_high != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Day H / L</span>
                <span className="text-slate-300 font-mono">${quote.day_high.toFixed(2)} / ${quote.day_low?.toFixed(2)}</span>
              </div>
            )}
            {quote.open != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Open</span>
                <span className="text-slate-300 font-mono">${quote.open.toFixed(2)}</span>
              </div>
            )}
            {quote.previous_close != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Prev Close</span>
                <span className="text-slate-300 font-mono">${quote.previous_close.toFixed(2)}</span>
              </div>
            )}
            {quote.volume != null && (
              <div className="flex justify-between">
                <span className="text-slate-500">Volume</span>
                <span className="text-slate-300">{(quote.volume / 1e6).toFixed(2)}M</span>
              </div>
            )}
          </div>
          {pos.shares > 0 && (
            <div className="border-t border-dark-500 pt-1.5 space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500">Avg Cost</span>
                <span className="text-slate-300 font-mono">${pos.avg_cost?.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Unrealised</span>
                <span className={`font-semibold ${unrealised >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(unrealised)}</span>
              </div>
            </div>
          )}
          {quote.market_state && (
            <div className="text-slate-600 text-xs pt-0.5">Market: {quote.market_state}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ?? TradeRow ???????????????????????????????????????????????????????????????? //
function TradeRow({ trade }) {
  const isBuy = trade.side === 'BUY'
  return (
    <tr>
      <td className="text-slate-400 text-xs whitespace-nowrap">{trade.created_at ? new Date(trade.created_at).toLocaleString() : '—'}</td>
      <td><span className={`px-1.5 py-0.5 rounded text-xs font-bold ${isBuy ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-900/30 text-red-400'}`}>{trade.side}</span></td>
      <td className="font-mono text-slate-200">{trade.quantity}</td>
      <td className="font-mono text-slate-200">${trade.price?.toFixed(2)}</td>
      <td className="font-mono text-slate-200">${trade.total?.toFixed(2)}</td>
      <td className={`font-mono text-xs ${trade.pnl == null ? 'text-slate-600' : trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{trade.pnl != null ? fmt(trade.pnl) : '—'}</td>
      <td className="text-slate-500 text-xs max-w-xs truncate" title={trade.reason}>{trade.reason || '—'}</td>
      <td className="text-slate-500 text-xs whitespace-nowrap">{trade.strategy_name?.split(':')[0] || '—'}</td>
    </tr>
  )
}

// ?? PieTooltipContent ??????????????????????????????????????????????????????? //
function PieTooltipContent({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-dark-800 border border-dark-500 rounded-lg p-3 text-xs shadow-xl">
      <div className="font-bold text-slate-100 mb-1">{d.symbol}</div>
      <div className="text-slate-400">Shares: <span className="text-slate-200">{d.shares?.toFixed(4)}</span></div>
      {d.mv > 0 && <div className="text-slate-400">Market Value: <span className="text-emerald-300">{fmtMoney(d.mv)}</span></div>}
      {d.cash > 0 && <div className="text-slate-400">Allocated Cash: <span className="text-blue-300">{fmtMoney(d.cash)}</span></div>}
      <div className="text-slate-400">Total Slice: <span className="text-slate-200">{fmtMoney(d.market_value)}</span></div>
      <div className="text-slate-400">Portfolio %: <span className="text-slate-200">{d.pct}%</span></div>
    </div>
  )
}

// ?? Main SandboxPanel ??????????????????????????????????????????????????????? //
export default function SandboxPanel() {
  const qc = useQueryClient()
  const importInputRef = useRef(null)

  const [selectedSymbol, setSelectedSymbol] = useState(null)
  const [showAddFunds, setShowAddFunds] = useState(false)
  const [fundsInput, setFundsInput] = useState('')
  const [showAddSymbol, setShowAddSymbol] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [newAlloc, setNewAlloc] = useState('')
  const [addSymbolErr, setAddSymbolErr] = useState('')
  const [newStratType, setNewStratType] = useState('sma_crossover')
  const [newScriptId, setNewScriptId] = useState(null)
  const [newStratParams, setNewStratParams] = useState(defaultParams('sma_crossover'))

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
  const ibMode = ibConnected ? (ibStatus?.mode ?? 'paper') : null  // 'paper' | 'live' | null

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
  const quotes = quotesData ?? {}  // { SYMBOL: { last_price, change_pct, company_name, ... } }
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

  // mutations
  const addFundsMut = useMutation({
    mutationFn: a => addSandboxFunds(a),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sandbox-account'] }); setShowAddFunds(false); setFundsInput('') },
  })
  const addSymbolMut = useMutation({
    mutationFn: p => addSandboxSymbol(p),
    onSuccess: d => {
      qc.invalidateQueries({ queryKey: ['sandbox-positions'] })
      setShowAddSymbol(false); setNewSymbol(''); setNewAlloc(''); setAddSymbolErr('')
      setSelectedSymbol(d.symbol)
    },
    onError: e => setAddSymbolErr(e.response?.data?.detail || e.message),
  })
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

  // engine state (global)
  const { data: engineState } = useQuery({
    queryKey: ['sandbox-engine-state'],
    queryFn: getSandboxEngineState,
    refetchInterval: 10000,
  })

  // portfolio analytics (trade-derived time-series)
  const { data: analytics } = useQuery({
    queryKey: ['sandbox-analytics'],
    queryFn: getSandboxAnalytics,
    refetchInterval: 30000,
  })

  // handlers
  function handleNewStratChange(type) { setNewStratType(type); if (type !== CUSTOM_SCRIPT_KEY) setNewStratParams(defaultParams(type)) }
  function handleAddSymbol() {
    if (!newSymbol.trim()) return
    addSymbolMut.mutate({ symbol: newSymbol.trim().toUpperCase(), strategy_name: encodeStrategy(newStratType, newStratParams, newScriptId), allocated_funds: parseFloat(newAlloc) || 0 })
  }
  function handleEditStratOpen() {
    const d = decodeStrategy(selectedPos?.strategy_name)
    setEditStratType(d.type); setEditStratParams(d.params); setEditScriptId(d.scriptId); setEditingStrategy(true)
  }
  function handleEditStratChange(type) { setEditStratType(type); if (type !== CUSTOM_SCRIPT_KEY) setEditStratParams(defaultParams(type)) }
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

  return (
    <div className="flex h-full min-h-screen">

      {/* ?? Left sidebar ??? */}
      <aside className="w-72 flex-shrink-0 bg-dark-800 border-r border-dark-500 flex flex-col overflow-y-auto">

        {/* Account — click to show portfolio overview */}
        <button
          onClick={() => { setSelectedSymbol(null); setTradeMsg(null); setEditingStrategy(false) }}
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
            <button onClick={() => setShowAddFunds(v => !v)} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
              <CurrencyDollarIcon className="h-3.5 w-3.5" />Add Funds
            </button>
          </div>
          {showAddFunds && (
            <div className="flex gap-2 mb-3">
              <input className="input flex-1 py-1.5 text-sm" type="number" min="1" placeholder="Amount $"
                value={fundsInput} onChange={e => setFundsInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && fundsInput && addFundsMut.mutate(parseFloat(fundsInput))} />
              <button className="btn-primary py-1.5 px-3 text-xs" disabled={!fundsInput || addFundsMut.isPending}
                onClick={() => addFundsMut.mutate(parseFloat(fundsInput))}>Add</button>
            </div>
          )}
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Total Funds</span><span className="text-slate-200 font-semibold">{fmtMoney(accountData?.total_funds)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Available</span><span className="text-emerald-400 font-semibold">{fmtMoney(accountData?.available_funds)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Portfolio Equity</span><span className="text-slate-200 font-semibold">{fmtMoney(totalEquity)}</span></div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className={`rounded-lg p-2 text-center ${totalUnrealizedPnl >= 0 ? 'bg-emerald-900/20' : 'bg-red-900/20'}`}>
              <div className="text-xs text-slate-500 mb-0.5">Unrealised</div>
              <div className={`text-sm font-semibold ${totalUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalUnrealizedPnl)}</div>
            </div>
            <div className={`rounded-lg p-2 text-center ${totalRealizedPnl >= 0 ? 'bg-emerald-900/20' : 'bg-red-900/20'}`}>
              <div className="text-xs text-slate-500 mb-0.5">Realised</div>
              <div className={`text-sm font-semibold ${totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalRealizedPnl)}</div>
            </div>
          </div>
        </button>

        {/* Stock list */}
        <div className="flex-1 px-3 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Stocks</span>
            <button onClick={() => setShowAddSymbol(v => !v)} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
              <PlusIcon className="h-3.5 w-3.5" />Add
            </button>
          </div>

          {showAddSymbol && (
            <div className="mb-3 space-y-2 border border-dark-500 rounded-lg p-3 bg-dark-900/40">
              {/* Symbol search */}
              <SymbolAutocomplete
                value={newSymbol}
                onChange={v => setNewSymbol(v)}
                onSelect={hit => setNewSymbol(hit.symbol)}
                placeholder="Search symbol or name…"
              />
              <StrategySelector value={newStratType} scriptId={newScriptId} onStrategyChange={handleNewStratChange}
                onScriptChange={setNewScriptId} stratParams={newStratParams}
                onParamChange={(k, v) => setNewStratParams(p => ({ ...p, [k]: v }))} />
              <input className="input text-sm py-1.5 w-full" type="number" placeholder="Allocate funds $"
                value={newAlloc} onChange={e => setNewAlloc(e.target.value)} />
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
                isSelected={selectedSymbol === pos.symbol}
                onClick={() => { setSelectedSymbol(pos.symbol); setTradeMsg(null); setEditingStrategy(false) }} />
            ))}
            {positions.length === 0 && (
              <div className="text-center text-slate-600 text-xs py-6">No stocks yet.<br />Add a symbol above.</div>
            )}
          </div>
        </div>
      </aside>

      {/* ?? Right panel ??? */}
      <main className="flex-1 overflow-y-auto bg-dark-900">

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
            /* ?? Portfolio Overview ?? */
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
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="card">
                  <div className="text-xs text-slate-500 mb-1">Total Funds</div>
                  <div className="text-xl font-bold text-slate-100">{fmtMoney(accountData?.total_funds)}</div>
                  <div className="text-xs text-slate-500 mt-0.5">Available: <span className="text-emerald-400">{fmtMoney(accountData?.available_funds)}</span></div>
                </div>
                <div className="card">
                  <div className="text-xs text-slate-500 mb-1">Portfolio Equity</div>
                  <div className="text-xl font-bold text-slate-100">{fmtMoney(totalEquity)}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{positions.filter(p => p.shares > 0).length} positions held</div>
                </div>
                <div className={`card ${totalUnrealizedPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20'}`}>
                  <div className="text-xs text-slate-500 mb-1">Unrealised P&amp;L</div>
                  <div className={`text-xl font-bold ${totalUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalUnrealizedPnl)}</div>
                  {totalEquity > 0 && (
                    <div className="text-xs text-slate-500 mt-0.5">{((totalUnrealizedPnl / totalEquity) * 100).toFixed(2)}% of equity</div>
                  )}
                </div>
                <div className={`card ${totalRealizedPnl >= 0 ? 'border-emerald-700/20' : 'border-red-700/20'}`}>
                  <div className="text-xs text-slate-500 mb-1">Realised P&amp;L</div>
                  <div className={`text-xl font-bold ${totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalRealizedPnl)}</div>
                  <div className="text-xs text-slate-500 mt-0.5">All closed trades</div>
                </div>
              </div>

              {/* Pie chart + breakdown table */}
              {pieData.length > 0 ? (
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
                  {/* Pie */}
                  <div className="card lg:col-span-2">
                    <div className="flex items-center gap-2 mb-4">
                      <ChartPieIcon className="h-4 w-4 text-slate-400" />
                      <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Allocation by Market Value</h2>
                    </div>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pieData}
                            cx="50%" cy="50%"
                            innerRadius={60} outerRadius={100}
                            paddingAngle={2}
                            dataKey="market_value"
                            label={({ symbol, pct }) => `${symbol} ${pct}%`}
                            labelLine={true}
                          >
                            {pieData.map((e, i) => (
                              <Cell key={e.symbol} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip content={<PieTooltipContent />} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Legend */}
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
                      {pieData.map((d, i) => (
                        <div key={d.symbol} className="flex items-center gap-2 text-xs">
                          <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          <span className="text-slate-300 font-mono font-semibold">{d.symbol}</span>
                          <span className="text-slate-500 ml-auto">{d.pct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Per-position breakdown table */}
                  <div className="card lg:col-span-3">
                    <div className="flex items-center gap-2 mb-4">
                      <TableCellsIcon className="h-4 w-4 text-slate-400" />
                      <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Position Breakdown</h2>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-slate-500 border-b border-dark-600">
                            <th className="text-left pb-2 font-medium">Symbol</th>
                            <th className="text-right pb-2 font-medium">Shares</th>
                            <th className="text-right pb-2 font-medium">Mkt Value</th>
                            <th className="text-right pb-2 font-medium">Cash</th>
                            <th className="text-right pb-2 font-medium">Alloc</th>
                            <th className="text-right pb-2 font-medium">Unrealised</th>
                            <th className="text-right pb-2 font-medium">Realised</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-dark-700">
                          {positions.map((pos, i) => {
                            const q = quotes[pos.symbol]
                            const mp = q?.last_price ?? pos.avg_cost
                            const mv = mp * pos.shares
                            const cashRemaining = Math.max(0, pos.allocated_funds - pos.avg_cost * pos.shares)
                            const unreal = mv - pos.avg_cost * pos.shares
                            const pd = pieData.find(d => d.symbol === pos.symbol)
                            return (
                              <tr
                                key={pos.symbol}
                                className="hover:bg-dark-700/40 cursor-pointer transition-colors"
                                onClick={() => { setSelectedSymbol(pos.symbol); setTradeMsg(null); setEditingStrategy(false) }}
                              >
                                <td className="py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                                    <span className="font-bold text-slate-200 font-mono">{pos.symbol}</span>
                                  </div>
                                  {q?.company_name && <div className="text-slate-600 truncate max-w-[100px] pl-4">{q.company_name}</div>}
                                </td>
                                <td className="text-right text-slate-300 font-mono">{pos.shares > 0 ? pos.shares.toFixed(3) : '—'}</td>
                                <td className="text-right text-slate-200 font-mono">{pos.shares > 0 ? fmtMoney(mv) : '—'}</td>
                                <td className="text-right text-blue-300 font-mono">{cashRemaining > 0 ? fmtMoney(cashRemaining) : '—'}</td>
                                <td className="text-right text-slate-400">{pd ? `${pd.pct}%` : '—'}</td>
                                <td className={`text-right font-semibold font-mono ${unreal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {pos.shares > 0 ? fmt(unreal) : '—'}
                                </td>
                                <td className={`text-right font-semibold font-mono ${pos.realized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {fmt(pos.realized_pnl)}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-dark-500 text-slate-400 font-semibold">
                            <td className="pt-2">Total</td>
                            <td />
                            <td className="text-right pt-2 font-mono text-slate-200">{fmtMoney(totalEquity)}</td>
                            <td />
                            <td className="text-right pt-2">100%</td>
                            <td className={`text-right pt-2 font-mono ${totalUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalUnrealizedPnl)}</td>
                            <td className={`text-right pt-2 font-mono ${totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(totalRealizedPnl)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-48 text-slate-600 text-sm gap-2">
                  <ChartPieIcon className="h-10 w-10 text-slate-700" />
                  Add stocks and purchase shares to see your portfolio breakdown.
                </div>
              )}

              {/* ?? Analytics Charts ?? */}
              {analytics && analytics.total_trades > 0 && (
                <div className="space-y-4">
                  <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Portfolio Performance Over Time</h2>

                  {/* Cumulative P&L line chart */}
                  {analytics.cumulative_pnl.length > 1 && (
                    <div className="card">
                      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Cumulative Realised P&amp;L</div>
                      <div className="h-52">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={analytics.cumulative_pnl} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
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
                            <Area type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} fill="url(#pnlGrad)" dot={false} activeDot={{ r: 4, fill: '#10b981' }} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  {/* Daily trade volume bar chart */}
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

                  {/* Per-symbol P&L bar chart + win/loss */}
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
                                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                                formatter={(v) => [`$${v.toFixed(2)}`, 'Realised P&L']}
                              />
                              <Bar dataKey="realized_pnl" name="Realised P&L" radius={[0, 3, 3, 0]}
                                label={false}
                                fill="#10b981"
                              >
                                {analytics.symbol_pnl.map((entry, i) => (
                                  <Cell key={entry.symbol} fill={entry.realized_pnl >= 0 ? '#10b981' : '#ef4444'} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {/* Win / Loss ratio card */}
                    {analytics.win_loss && (analytics.win_loss.wins + analytics.win_loss.losses + analytics.win_loss.breakeven) > 0 && (() => {
                      const wl = analytics.win_loss
                      const total = wl.wins + wl.losses + wl.breakeven
                      const winRate = ((wl.wins / total) * 100).toFixed(1)
                      const donutData = [
                        { name: 'Wins', value: wl.wins, color: '#10b981' },
                        { name: 'Losses', value: wl.losses, color: '#ef4444' },
                        ...(wl.breakeven > 0 ? [{ name: 'Breakeven', value: wl.breakeven, color: '#64748b' }] : []),
                      ]
                      return (
                        <div className="card flex flex-col">
                          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Win / Loss Ratio</div>
                          <div className="flex-1 flex items-center gap-4">
                            <div className="h-40 flex-1">
                              <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                  <Pie data={donutData} cx="50%" cy="50%" innerRadius={44} outerRadius={68}
                                    paddingAngle={3} dataKey="value">
                                    {donutData.map((d) => <Cell key={d.name} fill={d.color} />)}
                                  </Pie>
                                  <Tooltip
                                    contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
                                    formatter={(v, name) => [v, name]}
                                  />
                                </PieChart>
                              </ResponsiveContainer>
                            </div>
                            <div className="space-y-2 text-xs shrink-0">
                              <div>
                                <div className="text-slate-500">Win Rate</div>
                                <div className="text-xl font-bold text-emerald-400">{winRate}%</div>
                              </div>
                              {donutData.map(d => (
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
            </div>
          ) : !selectedPos ? (
            <div className="text-slate-500 text-sm">Loading…</div>
          ) : (
            <>
              {/* Header */}
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-3xl font-bold text-slate-100">{selectedSymbol}</h1>
                    {quotes[selectedSymbol]?.change_pct != null && (
                      <span className={`text-base font-semibold ${
                        quotes[selectedSymbol].change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}>
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
                      <button className="text-emerald-400 hover:text-emerald-300" onClick={() => { updatePosMut.mutate({ symbol: selectedSymbol, payload: { allocated_funds: parseFloat(allocInput) } }); setEditingAlloc(false) }}><CheckIcon className="h-4 w-4" /></button>
                      <button className="text-slate-500 hover:text-slate-300" onClick={() => setEditingAlloc(false)}><XMarkIcon className="h-4 w-4" /></button>
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
                {/* Header row */}
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">Strategy</h3>
                    {/* Engine status badge */}
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
                    {/* Engine toggle button */}
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
                        ? <span className="text-blue-400 font-medium">{stratLabel(selectedPos.strategy_name.split(':')[0])}</span>
                        : <span className="text-slate-600 italic">No strategy assigned</span>}
                    </div>
                    {/* Engine status details */}
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
                            {selectedPos.last_signal === 1 ? '? BUY'
                              : selectedPos.last_signal === -1 ? '? SELL'
                              : selectedPos.last_signal === 0 ? '— HOLD'
                              : '— None'}
                          </div>
                        </div>
                        <div className="bg-dark-900/60 rounded-lg p-2.5 border border-dark-600">
                          <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                            <ClockIcon className="h-3 w-3" />Last Run
                          </div>
                          <div className="text-xs text-slate-400">
                            {selectedPos.last_run_at
                              ? new Date(selectedPos.last_run_at).toLocaleTimeString()
                              : '—'}
                          </div>
                        </div>
                        <div className="bg-dark-900/60 rounded-lg p-2.5 border border-dark-600">
                          <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                            <SignalIcon className="h-3 w-3" />Engine Tick
                          </div>
                          <div className="text-xs text-slate-400">
                            {engineState?.last_tick
                              ? new Date(engineState.last_tick).toLocaleTimeString()
                              : '—'}
                          </div>
                        </div>
                      </div>
                    )}
                    {/* Engine error */}
                    {selectedPos.engine_error && (
                      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-900/20 border border-amber-700/30 text-xs text-amber-400">
                        <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <span>{selectedPos.engine_error}</span>
                      </div>
                    )}
                    {/* Engine running info */}
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
          )}
        </div>
      </main>
    </div>
  )
}
