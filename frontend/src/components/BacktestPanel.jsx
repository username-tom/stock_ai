import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getStrategies,
  runBacktest,
  runSentimentBacktest,
  runSandboxBacktest,
  getScripts,
  getBuiltinTemplates,
  getSandboxPositions,
  getPortfolioManagerState,
} from '../api/client'
import SymbolAutocomplete from './shared/SymbolAutocomplete'
import { getReportFilename } from '../utils/reportPaths'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  ArrowTopRightOnSquareIcon,
  ArrowDownTrayIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/outline'
import BacktestResultsPanel from './backtest/BacktestResultsPanel'
import SandboxResultsView from './backtest/SandboxResultsView'

const WATCHLIST_KEY = 'dashboard_watchlist'
const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(WATCHLIST_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return DEFAULT_WATCHLIST
}

function formatDateInput(d) {
  return d.toISOString().slice(0, 10)
}

function getTodayDateString() {
  return formatDateInput(new Date())
}

function getOneWeekAgoDateString(fromDateString) {
  const base = new Date(`${fromDateString}T00:00:00`)
  base.setDate(base.getDate() - 7)
  return formatDateInput(base)
}

function getOneMonthAgoDateString(fromDateString) {
  const base = new Date(`${fromDateString}T00:00:00`)
  base.setMonth(base.getMonth() - 1)
  return formatDateInput(base)
}

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
    { key: 'std_dev', label: 'Std Deviation', type: 'number', default: 2.0, step: 0.1 },
  ],
}

const TEMPLATE_PARAM_UI = {
  'day_trade_template.py': [
    { key: 'ema_fast',       label: 'EMA Fast',          type: 'number', default: 9 },
    { key: 'ema_slow',       label: 'EMA Slow',          type: 'number', default: 21 },
    { key: 'rsi_period',     label: 'RSI Period',        type: 'number', default: 14 },
    { key: 'rsi_overbought', label: 'RSI Overbought',    type: 'number', default: 70, step: 1 },
    { key: 'atr_period',     label: 'ATR Period',        type: 'number', default: 14 },
    { key: 'atr_stop_mult',  label: 'ATR Stop ×',        type: 'number', default: 1.5, step: 0.1 },
    { key: 'atr_tp_mult',    label: 'ATR Take-Profit ×', type: 'number', default: 3.0, step: 0.1 },
    { key: 'use_vwap',       label: 'Require VWAP',      type: 'toggle', default: 1 },
    { key: 'use_macd',       label: 'Require MACD',      type: 'toggle', default: 1 },
    { key: 'use_squeeze',    label: 'Require BB Squeeze', type: 'toggle', default: 1 },
    { key: 'hold_overnight', label: 'Hold Overnight',    type: 'toggle', default: 0 },
  ],
  'day_trade_pro_template.py': [
    { key: 'entry_mode',            label: 'Entry Mode',             type: 'select', options: ['both', 'orb', 'vwap'], default: 'both' },
    { key: 'orb_bars',              label: 'ORB Bars (minutes)',      type: 'number', default: 15 },
    { key: 'orb_expire_bars',       label: 'ORB Expire After (bars)', type: 'number', default: 60 },
    { key: 'orb_volume_mult',       label: 'ORB Volume Surge ×',      type: 'number', default: 1.5, step: 0.1 },
    { key: 'ema_fast',              label: 'EMA Fast',                type: 'number', default: 9 },
    { key: 'ema_slow',              label: 'EMA Slow',                type: 'number', default: 21 },
    { key: 'ema_trend',             label: 'Trend EMA (0=off)',       type: 'number', default: 50 },
    { key: 'rsi_period',            label: 'RSI Period',              type: 'number', default: 14 },
    { key: 'rsi_min',               label: 'RSI Min (entry)',         type: 'number', default: 45, step: 1 },
    { key: 'rsi_max',               label: 'RSI Max (entry)',         type: 'number', default: 75, step: 1 },
    { key: 'use_macd_entry',        label: 'Require MACD Entry',      type: 'toggle', default: 1 },
    { key: 'atr_period',            label: 'ATR Period',              type: 'number', default: 14 },
    { key: 'atr_stop_mult',         label: 'Hard Stop ATR ×',         type: 'number', default: 2.0, step: 0.1 },
    { key: 'atr_tp_mult',           label: 'Take-Profit ATR ×',       type: 'number', default: 5.0, step: 0.1 },
    { key: 'trail_activation_mult', label: 'Trail Activate ATR ×',    type: 'number', default: 1.5, step: 0.1 },
    { key: 'trail_mult',            label: 'Trailing Stop ATR ×',     type: 'number', default: 1.2, step: 0.1 },
    { key: 'min_atr_pct',           label: 'Min ATR % of Price',       type: 'number', default: 0.05, step: 0.01 },
    { key: 'min_move_pct',          label: 'Min TP Move % (0=off)',    type: 'number', default: 0.05, step: 0.01 },
    { key: 'max_trades_per_day',    label: 'Max Trades/Day',          type: 'number', default: 2 },
    { key: 'cooldown_bars',         label: 'Cooldown Bars After Exit', type: 'number', default: 10 },
    { key: 'max_hold_bars',         label: 'Max Hold Bars (0=off)',   type: 'number', default: 60 },
    { key: 'hold_overnight',        label: 'Hold Overnight',          type: 'toggle', default: 0 },
  ],
}

const CUSTOM_SCRIPT_KEY = '__custom_script__'
const TEMPLATE_SCRIPT_KEY = '__template__'

const BUCKETS = [
  { key: 'crash',    label: 'Crash',    cls: 'bg-red-900/50 text-red-300 border-red-700/40' },
  { key: 'bearish',  label: 'Bearish',  cls: 'bg-orange-900/50 text-orange-300 border-orange-700/40' },
  { key: 'neutral',  label: 'Neutral',  cls: 'bg-slate-700/50 text-slate-300 border-slate-600/40' },
  { key: 'bullish',  label: 'Bullish',  cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/40' },
  { key: 'euphoric', label: 'Euphoric', cls: 'bg-purple-900/50 text-purple-300 border-purple-700/40' },
]

const DEFAULT_SENT_STRATS = {
  crash: 'rsi',
  bearish: 'macd',
  neutral: 'bollinger_bands',
  bullish: 'sma_crossover',
  euphoric: 'rsi',
}

export default function BacktestPanel() {
  const qc = useQueryClient()
  const defaultEndDate = getTodayDateString()
  const defaultStartDate = getOneWeekAgoDateString(defaultEndDate)

  const { data: stratData, isLoading: stratLoading } = useQuery({
    queryKey: ['strategies'],
    queryFn: getStrategies,
  })

  const { data: scriptsData, isLoading: scriptsLoading } = useQuery({
    queryKey: ['scripts'],
    queryFn: getScripts,
  })

  const { data: templatesData, isLoading: templatesLoading } = useQuery({
    queryKey: ['builtin-templates'],
    queryFn: getBuiltinTemplates,
  })

  const COMMISSION_PRESETS = [
    { label: 'IB Fixed (~$0.005/share)', value: 0.005 },
    { label: 'Low (0.1%)', value: 0.001 },
    { label: 'Medium (0.2%)', value: 0.002 },
    { label: 'Zero', value: 0 },
    { label: 'Custom', value: null },
  ]

  const [form, setForm] = useState({
    symbol: 'AAPL',
    strategy_type: 'sma_crossover',
    start_date: defaultStartDate,
    end_date: defaultEndDate,
    initial_capital: 10000,
    commission: 0.005,
    day_trade: true,
    hold_positions_overnight: false,
    eod_sell_window_minutes: 5,
  })
  const [commissionPreset, setCommissionPreset] = useState('0.005')
  const [stratParams, setStratParams] = useState({ fast_period: 10, slow_period: 30, ma_type: 'SMA' })
  const [selectedScriptId, setSelectedScriptId] = useState(null)
  const [selectedTemplateFilename, setSelectedTemplateFilename] = useState(null)
  const [tmplParams, setTmplParams] = useState({})
  const [tmplPreviewOpen, setTmplPreviewOpen] = useState(false)
  const [result, setResult] = useState(null)
  const [activeTab, setActiveTab] = useState('equity')
  const [progress, setProgress] = useState(0)
  const progressRef = useRef(null)
  const [watchlist, setWatchlist] = useState(loadWatchlist)

  // Keep watchlist in sync when user edits it in another panel
  useEffect(() => {
    const sync = () => setWatchlist(loadWatchlist())
    window.addEventListener('watchlist-updated', sync)
    return () => window.removeEventListener('watchlist-updated', sync)
  }, [])

  // ── Advanced / Sentiment mode ──────────────────────────────────────────── //
  const [mode, setMode] = useState('standard') // 'standard' | 'sentiment'
  const [sentForm, setSentForm] = useState({
    symbol: 'AAPL',
    start_date: defaultStartDate,
    end_date: defaultEndDate,
    initial_capital: 10000,
    commission: 0.005,
    day_trade: true,
    sentimentStrategies: { ...DEFAULT_SENT_STRATS },
    sentiment_warmup: 35,
    stop_loss_pct: 0,
    take_profit_pct: 0,
    hold_positions_overnight: false,
    eod_sell_window_minutes: 5,
  })
  const [sentResult, setSentResult] = useState(null)
  const [sentActiveTab, setSentActiveTab] = useState('equity')
  const [sentProgress, setSentProgress] = useState(0)
  const sentProgressRef = useRef(null)

  const sentMutation = useMutation({
    mutationFn: (payload) => runSentimentBacktest(payload),
    onSuccess: (data) => {
      clearInterval(sentProgressRef.current)
      setSentProgress(100)
      setTimeout(() => setSentProgress(0), 600)
      setSentResult(data)
      qc.invalidateQueries({ queryKey: ['reports'] })
    },
    onError: () => {
      clearInterval(sentProgressRef.current)
      setSentProgress(0)
    },
  })

  useEffect(() => () => clearInterval(sentProgressRef.current), [])

  const handleSentSubmit = (e) => {
    e.preventDefault()
    setSentProgress(0)
    const tradingDays = estimateTradingDays(sentForm.start_date, sentForm.end_date)
    const tickMs = Math.min(600, Math.max(80, tradingDays * 120 / 25))
    let cur = 0
    clearInterval(sentProgressRef.current)
    sentProgressRef.current = setInterval(() => {
      cur += 1
      setSentProgress(Math.min(cur, 99))
      if (cur >= 99) clearInterval(sentProgressRef.current)
    }, tickMs)
    // Sanitize: drop any CUSTOM_SCRIPT_KEY/TEMPLATE_SCRIPT_KEY placeholders (no item picked yet)
    const sanitizedStrategies = Object.fromEntries(
      Object.entries(sentForm.sentimentStrategies).map(([k, v]) => [
        k,
        (v === CUSTOM_SCRIPT_KEY || v === TEMPLATE_SCRIPT_KEY) ? (DEFAULT_SENT_STRATS[k] ?? 'rsi') : v,
      ])
    )
    sentMutation.mutate({
      symbol: sentForm.symbol,
      start_date: sentForm.start_date,
      end_date: sentForm.end_date,
      initial_capital: sentForm.initial_capital,
      commission: sentForm.commission,
      day_trade: sentForm.day_trade,
      sentiment_strategies: sanitizedStrategies,
      sentiment_warmup: sentForm.sentiment_warmup,
      stop_loss_pct: sentForm.stop_loss_pct,
      take_profit_pct: sentForm.take_profit_pct,
      hold_positions_overnight: sentForm.hold_positions_overnight,
      eod_sell_window_minutes: sentForm.eod_sell_window_minutes,
    })
  }

  // ── Sandbox + PM batch backtest ─────────────────────────────────────── //
  const [sandboxForm, setSandboxForm] = useState({
    start_date: defaultStartDate,
    end_date: defaultEndDate,
    initial_capital: 10000,
    commission: 0.005,
    allocation_mode: 'equal',
    use_shared_pool: true,
    per_position_min_pct: 5,
    per_position_max_pct: 15,
    symbols_override: '', // optional comma-separated override
  })
  const [sandboxResult, setSandboxResult] = useState(null)
  const [sandboxProgress, setSandboxProgress] = useState(0)
  const sandboxProgressRef = useRef(null)
  const [pmSettingsOpen, setPmSettingsOpen] = useState(false)

  const { data: sandboxPositionsData, isLoading: sandboxPositionsLoading } = useQuery({
    queryKey: ['sandbox-positions'],
    queryFn: getSandboxPositions,
    refetchOnWindowFocus: false,
  })
  const { data: pmData } = useQuery({
    queryKey: ['portfolio-manager-state'],
    queryFn: getPortfolioManagerState,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    staleTime: 0,
    refetchInterval: 10_000,
  })

  const sandboxMutation = useMutation({
    mutationFn: (payload) => runSandboxBacktest(payload),
    onSuccess: (data) => {
      clearInterval(sandboxProgressRef.current)
      setSandboxProgress(100)
      setTimeout(() => setSandboxProgress(0), 600)
      setSandboxResult(data)
      qc.invalidateQueries({ queryKey: ['reports'] })
    },
    onError: () => {
      clearInterval(sandboxProgressRef.current)
      setSandboxProgress(0)
    },
  })

  useEffect(() => () => clearInterval(sandboxProgressRef.current), [])

  const handleSandboxSubmit = (e) => {
    e.preventDefault()
    setSandboxProgress(0)
    const tradingDays = estimateTradingDays(sandboxForm.start_date, sandboxForm.end_date)
    const tickMs = Math.min(600, Math.max(80, tradingDays * 120 / 25))
    let cur = 0
    clearInterval(sandboxProgressRef.current)
    sandboxProgressRef.current = setInterval(() => {
      cur += 1
      setSandboxProgress(Math.min(cur, 99))
      if (cur >= 99) clearInterval(sandboxProgressRef.current)
    }, tickMs)
    const overrideSymbols = sandboxForm.symbols_override
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    sandboxMutation.mutate({
      start_date: sandboxForm.start_date,
      end_date: sandboxForm.end_date,
      initial_capital: sandboxForm.initial_capital,
      commission: sandboxForm.commission,
      allocation_mode: sandboxForm.allocation_mode,
      use_shared_pool: sandboxForm.use_shared_pool,
      per_position_min_pct: sandboxForm.per_position_min_pct,
      per_position_max_pct: sandboxForm.per_position_max_pct,
      ...(overrideSymbols.length > 0 ? { symbols: overrideSymbols } : {}),
    })
  }

  const isCustomScript = form.strategy_type === CUSTOM_SCRIPT_KEY
  const isTemplate = form.strategy_type === TEMPLATE_SCRIPT_KEY
  const scripts = scriptsData?.scripts ?? []
  const templates = (templatesData?.templates ?? []).filter(t => !t.filename.startsWith('_'))

  // Estimate trading days between two date strings to pace the progress bar
  const estimateTradingDays = (start, end) => {
    const ms = new Date(end) - new Date(start)
    const calDays = ms / (1000 * 60 * 60 * 24)
    return Math.max(1, Math.round(calDays * 5 / 7))
  }

  const startProgress = (start, end) => {
    setProgress(0)
    const tradingDays = estimateTradingDays(start, end)
    // Phase 1: 0 → 25%, speed proportional to date range
    const phase1TickMs = Math.min(600, Math.max(80, tradingDays * 120 / 25))
    let current = 0
    let phase = 1
    clearInterval(progressRef.current)
    progressRef.current = setInterval(() => {
      current += 1
      if (phase === 1 && current >= 25) {
        // Switch to phase 2: 25 → 99% over ~10 minutes (600000 ms / 74 steps ≈ 8100 ms/tick)
        phase = 2
        clearInterval(progressRef.current)
        progressRef.current = setInterval(() => {
          current += 1
          const next = Math.min(current, 99)
          setProgress(next)
          if (next >= 99) clearInterval(progressRef.current)
        }, 600000 / 74)
        return
      }
      setProgress(Math.min(current, 25))
    }, phase1TickMs)
  }

  const finishProgress = () => {
    clearInterval(progressRef.current)
    setProgress(100)
    setTimeout(() => setProgress(0), 600)
  }

  useEffect(() => () => clearInterval(progressRef.current), [])

  const mutation = useMutation({
    mutationFn: (payload) => runBacktest(payload),
    onSuccess: (data) => {
      finishProgress()
      setResult(data)
      qc.invalidateQueries({ queryKey: ['reports'] })
    },
    onError: () => finishProgress(),
  })

  const handleStrategyChange = (type) => {
    setForm(f => ({ ...f, strategy_type: type }))
    if (type !== CUSTOM_SCRIPT_KEY && type !== TEMPLATE_SCRIPT_KEY) {
      const defaults = {}
      ;(STRATEGY_PARAM_UI[type] || []).forEach(p => { defaults[p.key] = p.default })
      setStratParams(defaults)
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (isCustomScript) {
      if (!selectedScriptId) return
      startProgress(form.start_date, form.end_date)
      mutation.mutate({
        ...form,
        strategy_type: 'custom_script',
        script_id: selectedScriptId,
        strategy_params: {},
      })
    } else if (isTemplate) {
      if (!selectedTemplateFilename) return
      startProgress(form.start_date, form.end_date)
      mutation.mutate({
        ...form,
        strategy_type: 'custom_script',
        template_filename: selectedTemplateFilename,
        strategy_params: tmplParams,
      })
    } else {
      startProgress(form.start_date, form.end_date)
      mutation.mutate({ ...form, strategy_params: stratParams })
    }
  }

  const paramFields = (isCustomScript || isTemplate) ? [] : (STRATEGY_PARAM_UI[form.strategy_type] || [])

  return (
    <div className="p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">Backtesting</h1>
            <p className="text-sm text-slate-400 mt-0.5">Test a strategy against historical data</p>
          </div>
          <div className="flex gap-1 bg-dark-800/60 rounded-lg p-1 border border-dark-600 shrink-0">
            <button
              type="button"
              onClick={() => setMode('standard')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${mode === 'standard' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'}`}
            >
              Standard
            </button>
            <button
              type="button"
              onClick={() => setMode('sentiment')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${mode === 'sentiment' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'}`}
            >
              Advanced — Sentiment
            </button>
            <button
              type="button"
              onClick={() => setMode('sandbox')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${mode === 'sandbox' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'}`}
            >
              Sandbox + PM
            </button>
          </div>
        </div>

        {mode === 'standard' && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Config panel */}
        <form onSubmit={handleSubmit} className="card space-y-4 xl:col-span-1">
          <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
            Configuration
          </h2>

          <div>
            <label className="label">Symbol</label>
            <SymbolAutocomplete
              value={form.symbol}
              onChange={v => setForm(f => ({ ...f, symbol: v }))}
              placeholder="Search or type symbol…"
              extraSuggestions={watchlist.map(s => ({ symbol: s }))}
            />
          </div>

          <div>
            <label className="label">Strategy</label>
            {stratLoading ? (
              <div className="input animate-pulse bg-dark-700 text-transparent">Loading…</div>
            ) : (
              <select
                className="input"
                value={form.strategy_type}
                onChange={e => handleStrategyChange(e.target.value)}
              >
                {(stratData?.strategies || []).map(s => (
                  <option key={s.type} value={s.type}>
                    {s.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                  </option>
                ))}
                <option value={CUSTOM_SCRIPT_KEY}>⚙ Custom Script</option>
                <option value={TEMPLATE_SCRIPT_KEY}>📄 Built-in Template</option>
              </select>
            )}
          </div>

          {/* Built-in template selector */}
          {isTemplate && (
            <div className="border border-dark-500 rounded-lg p-3 space-y-3 bg-dark-900/30">
              <div className="flex items-center gap-1.5 text-xs text-indigo-400 uppercase tracking-wider">
                <DocumentTextIcon className="h-3.5 w-3.5" />
                Built-in Template
              </div>
              {templatesLoading ? (
                <div className="h-8 bg-dark-700 rounded animate-pulse" />
              ) : templates.length === 0 ? (
                <div className="text-xs text-amber-400/80">No templates found.</div>
              ) : (
                <div className="space-y-2">
                  <label className="label">Select Template</label>
                  <select
                    className="input"
                    value={selectedTemplateFilename ?? ''}
                    onChange={e => {
                      const fn = e.target.value || null
                      setSelectedTemplateFilename(fn)
                      setTmplPreviewOpen(false)
                      // Pre-populate params with defaults for this template
                      const fields = TEMPLATE_PARAM_UI[fn] ?? []
                      const defaults = {}
                      fields.forEach(f => { defaults[f.key] = f.default })
                      setTmplParams(defaults)
                    }}
                  >
                    <option value="">— choose a template —</option>
                    {templates.map(t => (
                      <option key={t.filename} value={t.filename}>{t.name}</option>
                    ))}
                  </select>
                  {selectedTemplateFilename && (() => {
                    const tmpl = templates.find(t => t.filename === selectedTemplateFilename)
                    return tmpl ? (
                      <>
                        {tmpl.description && (
                          <div className="text-xs text-slate-500">{tmpl.description}</div>
                        )}
                        <button
                          type="button"
                          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors w-full text-left"
                          onClick={() => setTmplPreviewOpen(v => !v)}
                        >
                          <span className={`inline-block transition-transform ${tmplPreviewOpen ? 'rotate-180' : ''}`}>▾</span>
                          {tmplPreviewOpen ? 'Hide' : 'Preview'} template code
                        </button>
                        {tmplPreviewOpen && (
                          <textarea
                            readOnly
                            className="w-full h-64 font-mono text-xs bg-dark-950 border border-dark-500 rounded-lg p-3 text-slate-400 resize-y focus:outline-none cursor-default"
                            value={tmpl.script_code}
                            spellCheck={false}
                          />
                        )}
                      </>
                    ) : null
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Template parameters */}
          {isTemplate && selectedTemplateFilename && (TEMPLATE_PARAM_UI[selectedTemplateFilename] ?? []).length > 0 && (
            <div className="border border-dark-500 rounded-lg p-3 space-y-3 bg-dark-900/30">
              <div className="text-xs text-slate-500 uppercase tracking-wider">Template Parameters</div>
              {(TEMPLATE_PARAM_UI[selectedTemplateFilename] ?? []).map(f => (
                <div key={f.key}>
                  <label className="label">{f.label}</label>
                  {f.type === 'toggle' ? (
                    <label className="flex items-center gap-3 cursor-pointer mt-1">
                      <div className="relative">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={!!(tmplParams[f.key] ?? f.default)}
                          onChange={e => setTmplParams(p => ({ ...p, [f.key]: e.target.checked ? 1 : 0 }))}
                        />
                        <div className="w-9 h-5 bg-dark-600 rounded-full peer-checked:bg-indigo-500 transition-colors" />
                        <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                      </div>
                      <span className="text-xs text-slate-400">
                        {(tmplParams[f.key] ?? f.default) ? 'Enabled' : 'Disabled'}
                      </span>
                    </label>
                  ) : f.type === 'select' ? (
                    <select
                      className="input"
                      value={tmplParams[f.key] ?? f.default}
                      onChange={e => setTmplParams(p => ({ ...p, [f.key]: e.target.value }))}
                    >
                      {f.options.map(o => <option key={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      className="input"
                      type="number"
                      step={f.step ?? 1}
                      value={tmplParams[f.key] ?? f.default}
                      onChange={e => setTmplParams(p => ({
                        ...p,
                        [f.key]: f.step ? parseFloat(e.target.value) : parseInt(e.target.value, 10),
                      }))}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Custom script selector */}
          {isCustomScript && (
            <div className="border border-dark-500 rounded-lg p-3 space-y-3 bg-dark-900/30">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 uppercase tracking-wider">
                <CodeBracketIcon className="h-3.5 w-3.5" />
                Custom Script
              </div>
              {scriptsLoading ? (
                <div className="space-y-2">
                  {[...Array(2)].map((_, i) => (
                    <div key={i} className="h-8 bg-dark-700 rounded animate-pulse" />
                  ))}
                </div>
              ) : scripts.length === 0 ? (
                <div className="text-xs text-amber-400/80">
                  No scripts saved yet. Create one in the{' '}
                  <a href="/scripts" className="underline">Scripts</a> panel.
                </div>
              ) : (
                <div>
                  <label className="label">Select Script</label>
                  <select
                    className="input"
                    value={selectedScriptId ?? ''}
                    onChange={e => setSelectedScriptId(e.target.value ? parseInt(e.target.value, 10) : null)}
                  >
                    <option value="">— choose a script —</option>
                    {scripts.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {selectedScriptId && scripts.find(s => s.id === selectedScriptId)?.description && (
                    <div className="mt-1.5 text-xs text-slate-500">
                      {scripts.find(s => s.id === selectedScriptId).description}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Strategy parameters (built-in only) */}
          {!isCustomScript && paramFields.length > 0 && (
            <div className="border border-dark-500 rounded-lg p-3 space-y-3 bg-dark-900/30">
              <div className="text-xs text-slate-500 uppercase tracking-wider">Strategy Parameters</div>
              {paramFields.map(f => (
                <div key={f.key}>
                  <label className="label">{f.label}</label>
                  {f.type === 'select' ? (
                    <select
                      className="input"
                      value={stratParams[f.key] ?? f.default}
                      onChange={e => setStratParams(p => ({ ...p, [f.key]: e.target.value }))}
                    >
                      {f.options.map(o => <option key={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      className="input"
                      type="number"
                      step={f.step ?? 1}
                      value={stratParams[f.key] ?? f.default}
                      onChange={e => setStratParams(p => ({
                        ...p,
                        [f.key]: f.step ? parseFloat(e.target.value) : parseInt(e.target.value, 10),
                      }))}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Day Trade toggle */}
          <div className="border border-dark-500 rounded-lg p-3 bg-dark-900/30">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={form.day_trade}
                  onChange={e => {
                    const on = e.target.checked
                    if (on) {
                      const today = getTodayDateString()
                      const weekAgo = getOneWeekAgoDateString(today)
                      setForm(f => ({ ...f, day_trade: true, start_date: weekAgo, end_date: today }))
                    } else {
                      setForm(f => ({ ...f, day_trade: false }))
                    }
                  }}
                />
                <div className="w-9 h-5 bg-dark-600 rounded-full peer-checked:bg-indigo-500 transition-colors" />
                <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-200">Day Trade Mode</div>
                <div className="text-xs text-slate-500">Use intraday data (IB: 5s; Yahoo: 1m → 2m → 5m)</div>
              </div>
            </label>
            {form.day_trade && (
              <div className="mt-2 text-xs text-amber-400/80 border-t border-dark-600 pt-2">
                ⚠ Yahoo Finance limits: 1m data to last 7 days, 2m/5m to last 60 days.
              </div>
            )}

          {/* End-of-Day Settings */}
          <div className="space-y-3 border-t border-dark-600 pt-4">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={form.hold_positions_overnight}
                  onChange={e => setForm(f => ({ ...f, hold_positions_overnight: e.target.checked }))}
                />
                <div className="w-9 h-5 bg-dark-600 rounded-full peer-checked:bg-emerald-600 transition-colors" />
                <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-200">
                  {form.hold_positions_overnight ? 'Hold Overnight' : 'Liquidate at EOD'}
                </div>
                <div className="text-xs text-slate-500">
                  {form.hold_positions_overnight ? 'Keep positions open overnight' : 'Force-close positions before market close'}
                </div>
              </div>
            </label>
            
            {!form.hold_positions_overnight && (
              <div>
                <label className="label">End-of-Day Sell Window (minutes)</label>
                <div className="flex items-center gap-3">
                  <input
                    className="flex-1 input"
                    type="range"
                    min="1"
                    max="240"
                    value={form.eod_sell_window_minutes}
                    onChange={e => setForm(f => ({ ...f, eod_sell_window_minutes: Number(e.target.value) }))}
                  />
                  <span className="text-sm font-medium text-orange-400 w-12 text-right">{form.eod_sell_window_minutes}m</span>
                </div>
                <p className="text-xs text-slate-400 mt-1">Duration before market close (16:00 ET) to start EOD liquidation</p>
              </div>
            )}
          </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="label mb-0">Start Date</label>
                <button
                  type="button"
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                  onClick={() => {
                    const today = getTodayDateString()
                    setForm(f => ({ ...f, start_date: getOneMonthAgoDateString(today), end_date: today }))
                  }}
                >
                  Past Month
                </button>
              </div>
              <input
                className="input"
                type="date"
                value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="label mb-0">End Date</label>
                <button
                  type="button"
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                  onClick={() => setForm(f => ({ ...f, end_date: getTodayDateString() }))}
                >
                  Today
                </button>
              </div>
              <input
                className="input"
                type="date"
                value={form.end_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <label className="label">Initial Capital ($)</label>
            <input
              className="input"
              type="number"
              value={form.initial_capital}
              onChange={e => setForm(f => ({ ...f, initial_capital: parseFloat(e.target.value) }))}
            />
          </div>

          <div>
            <label className="label">Commission</label>
            <select
              className="input mb-1.5"
              value={commissionPreset}
              onChange={e => {
                setCommissionPreset(e.target.value)
                if (e.target.value !== 'custom') {
                  setForm(f => ({ ...f, commission: parseFloat(e.target.value) }))
                }
              }}
            >
              {COMMISSION_PRESETS.map(p => (
                <option key={p.label} value={p.value === null ? 'custom' : String(p.value)}>
                  {p.label}
                </option>
              ))}
            </select>
            {commissionPreset === 'custom' && (
              <input
                className="input"
                type="number"
                step="0.0001"
                placeholder="e.g. 0.001"
                value={form.commission}
                onChange={e => setForm(f => ({ ...f, commission: parseFloat(e.target.value) }))}
              />
            )}
            {commissionPreset !== 'custom' && (
              <div className="text-xs text-slate-500 mt-1">
                {(form.commission * 100).toFixed(3)}% of trade value per leg
              </div>
            )}
          </div>

          {/* Progress bar */}
          {mutation.isPending && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-400">
                <span>{progress <= 25 ? 'Fetching & computing signals…' : 'Processing data…'}</span>
                <span>{progress}%</span>
              </div>
              <div className="w-full h-2 bg-dark-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-200 ease-linear"
                  style={{
                    width: `${progress}%`,
                    background: progress <= 50
                      ? 'linear-gradient(90deg, #10b981, #34d399)'
                      : 'linear-gradient(90deg, #34d399, #6ee7b7)',
                  }}
                />
              </div>
              <div className="flex justify-between text-xs text-slate-600">
                <span>Signals</span>
                <span className="text-slate-500">|</span>
                <span>Processing</span>
              </div>
            </div>
          )}

          <button
            type="submit"
            className="btn-primary w-full justify-center"
            disabled={mutation.isPending || (isCustomScript && !selectedScriptId)}
          >
            {mutation.isPending ? (
              <>
                <ArrowPathIcon className="h-4 w-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <ArrowPathIcon className="h-4 w-4" />
                Run Backtest
              </>
            )}
          </button>

          {mutation.isError && (
            <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-700/30 rounded-lg text-sm text-red-400">
              <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
              {mutation.error?.response?.data?.detail || mutation.error?.message || 'Unknown error'}
            </div>
          )}

          {mutation.isSuccess && (
            <div className="flex items-center justify-between gap-2 p-3 bg-emerald-900/20 border border-emerald-700/30 rounded-lg text-sm text-emerald-400">
              <span className="flex items-center gap-2">
                <CheckCircleIcon className="h-4 w-4" />
                Backtest complete — report saved.
              </span>
              {mutation.data?.html_report_path && (
                <a
                  href={`/report-files/${getReportFilename(mutation.data.html_report_path)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary text-xs flex items-center gap-1"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                  HTML Report
                </a>
              )}
              {mutation.data?.script_snapshot && (
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([mutation.data.script_snapshot], { type: 'text/plain' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${mutation.data.name ?? 'backtest_script'}.py`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                  className="btn-secondary text-xs flex items-center gap-1"
                >
                  <ArrowDownTrayIcon className="h-4 w-4" />
                  Script
                </button>
              )}
            </div>
          )}
        </form>

        <BacktestResultsPanel
          mode={mode}
          result={mode === 'standard' ? result : sentResult}
          activeTab={mode === 'standard' ? activeTab : sentActiveTab}
          setActiveTab={mode === 'standard' ? setActiveTab : setSentActiveTab}
          isPending={mode === 'standard' ? mutation.isPending : sentMutation.isPending}
          emptyMessage={mode === 'standard'
            ? 'Configure and run a backtest to see results'
            : 'Configure sentiment strategy map and run'}
          pendingMessage={mode === 'standard' ? 'Running backtest…' : 'Running sentiment backtest…'}
        />
      </div>
          )}

        {mode === 'sentiment' && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Sentiment Config */}
            <form onSubmit={handleSentSubmit} className="card space-y-4 xl:col-span-1">
              <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider flex items-center gap-2">
                Advanced Backtest
                <span className="text-indigo-400 text-xs font-normal normal-case">Sentiment Switching</span>
              </h2>
              <p className="text-xs text-slate-500 -mt-2">
                Strategy auto-switches per bar based on rolling RSI + MACD + SMA. Positions
                are force-closed on each switch.
              </p>

              <div>
                <label className="label">Symbol</label>
                <SymbolAutocomplete
                  value={sentForm.symbol}
                  onChange={v => setSentForm(f => ({ ...f, symbol: v }))}
                  placeholder="Search or type symbol…"
                  extraSuggestions={watchlist.map(s => ({ symbol: s }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="label mb-0">Start Date</label>
                    <button
                      type="button"
                      className="text-xs text-emerald-400 hover:text-emerald-300"
                      onClick={() => {
                        const today = getTodayDateString()
                        setSentForm(f => ({ ...f, start_date: getOneMonthAgoDateString(today), end_date: today }))
                      }}
                    >
                      Past Month
                    </button>
                  </div>
                  <input
                    className="input"
                    type="date"
                    value={sentForm.start_date}
                    onChange={e => setSentForm(f => ({ ...f, start_date: e.target.value }))}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="label mb-0">End Date</label>
                    <button
                      type="button"
                      className="text-xs text-emerald-400 hover:text-emerald-300"
                      onClick={() => setSentForm(f => ({ ...f, end_date: getTodayDateString() }))}
                    >
                      Today
                    </button>
                  </div>
                  <input
                    className="input"
                    type="date"
                    value={sentForm.end_date}
                    onChange={e => setSentForm(f => ({ ...f, end_date: e.target.value }))}
                  />
                </div>
              </div>

              <div>
                <label className="label">Initial Capital ($)</label>
                <input
                  className="input"
                  type="number"
                  value={sentForm.initial_capital}
                  onChange={e => setSentForm(f => ({ ...f, initial_capital: parseFloat(e.target.value) }))}
                />
              </div>

              <div>
                <label className="label">Commission</label>
                <select
                  className="input"
                  value={String(sentForm.commission)}
                  onChange={e => setSentForm(f => ({ ...f, commission: parseFloat(e.target.value) }))}
                >
                  {COMMISSION_PRESETS.filter(p => p.value !== null).map(p => (
                    <option key={p.label} value={String(p.value)}>{p.label}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Stop-Loss % (0=off)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={0.1}
                    value={sentForm.stop_loss_pct}
                    onChange={e => setSentForm(f => ({ ...f, stop_loss_pct: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
                <div>
                  <label className="label">Take-Profit % (0=off)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={0.1}
                    value={sentForm.take_profit_pct}
                    onChange={e => setSentForm(f => ({ ...f, take_profit_pct: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
              </div>

              <div className="border border-dark-500 rounded-lg p-3 bg-dark-900/30">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <div className="relative">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={sentForm.day_trade}
                      onChange={e => {
                        const on = e.target.checked
                        if (on) {
                          const today = getTodayDateString()
                          const weekAgo = getOneWeekAgoDateString(today)
                          setSentForm(f => ({ ...f, day_trade: true, start_date: weekAgo, end_date: today }))
                        } else {
                          setSentForm(f => ({ ...f, day_trade: false }))
                        }
                      }}
                    />
                    <div className="w-9 h-5 bg-dark-600 rounded-full peer-checked:bg-indigo-500 transition-colors" />
                    <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-200">Day Trade Mode</div>
                    <div className="text-xs text-slate-500">Use intraday data (IB: 5s; Yahoo: 1m → 2m → 5m)</div>
                  </div>
                </label>
              </div>

              {/* End-of-Day Settings */}
              <div className="space-y-3 border-t border-dark-600 pt-4">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <div className="relative">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={sentForm.hold_positions_overnight}
                      onChange={e => setSentForm(f => ({ ...f, hold_positions_overnight: e.target.checked }))}
                    />
                    <div className="w-9 h-5 bg-dark-600 rounded-full peer-checked:bg-emerald-600 transition-colors" />
                    <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-slate-200">
                      {sentForm.hold_positions_overnight ? 'Hold Overnight' : 'Liquidate at EOD'}
                    </div>
                    <div className="text-xs text-slate-500">
                      {sentForm.hold_positions_overnight ? 'Keep positions open overnight' : 'Force-close positions before market close'}
                    </div>
                  </div>
                </label>
                
                {!sentForm.hold_positions_overnight && (
                  <div>
                    <label className="label">End-of-Day Sell Window (minutes)</label>
                    <div className="flex items-center gap-3">
                      <input
                        className="flex-1 input"
                        type="range"
                        min="1"
                        max="240"
                        value={sentForm.eod_sell_window_minutes}
                        onChange={e => setSentForm(f => ({ ...f, eod_sell_window_minutes: Number(e.target.value) }))}
                      />
                      <span className="text-sm font-medium text-orange-400 w-12 text-right">{sentForm.eod_sell_window_minutes}m</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">Duration before market close (16:00 ET) to start EOD liquidation</p>
                  </div>
                )}
              </div>

              {/* Sentiment strategy map */}
              <div className="border border-dark-500 rounded-lg p-3 space-y-3 bg-dark-900/30">
                <div className="text-xs text-slate-500 uppercase tracking-wider">Sentiment → Strategy Map</div>
                <div className="space-y-2">
                  {BUCKETS.map(b => {
                    const current = sentForm.sentimentStrategies[b.key] ?? 'rsi'
                    const isCustom = current === CUSTOM_SCRIPT_KEY || current.startsWith('custom:')
                    const isTemplate = current === TEMPLATE_SCRIPT_KEY || current.startsWith('template:')
                    const scriptId = current.startsWith('custom:') ? parseInt(current.slice(7)) : null
                    const templateFn = current.startsWith('template:') ? current.slice(9) : null
                    return (
                      <div key={b.key} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className={`shrink-0 inline-block w-16 text-center text-[10px] font-semibold px-1.5 py-0.5 rounded border ${b.cls}`}>
                            {b.label}
                          </span>
                          <select
                            className="input flex-1 text-xs py-1"
                            value={isCustom ? CUSTOM_SCRIPT_KEY : isTemplate ? TEMPLATE_SCRIPT_KEY : current}
                            onChange={e => {
                              const val = e.target.value
                              setSentForm(f => ({
                                ...f,
                                sentimentStrategies: { ...f.sentimentStrategies, [b.key]: val },
                              }))
                            }}
                          >
                            {(stratData?.strategies || []).map(s => (
                              <option key={s.type} value={s.type}>
                                {s.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                              </option>
                            ))}
                            <option value={CUSTOM_SCRIPT_KEY}>⚙ Custom Script</option>
                            <option value={TEMPLATE_SCRIPT_KEY}>📄 Template</option>
                          </select>
                        </div>
                        {isCustom && (
                          <div className="pl-[72px]">
                            {scripts.length === 0 ? (
                              <div className="text-xs text-amber-400/80">No scripts saved yet.</div>
                            ) : (
                              <select
                                className="input w-full text-xs py-1"
                                value={scriptId ?? ''}
                                onChange={e => {
                                  const sid = e.target.value
                                  setSentForm(f => ({
                                    ...f,
                                    sentimentStrategies: {
                                      ...f.sentimentStrategies,
                                      [b.key]: sid ? `custom:${sid}` : CUSTOM_SCRIPT_KEY,
                                    },
                                  }))
                                }}
                              >
                                <option value="">— select script —</option>
                                {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </select>
                            )}
                          </div>
                        )}
                        {isTemplate && (
                          <div className="pl-[72px]">
                            {templates.length === 0 ? (
                              <div className="text-xs text-amber-400/80">No templates found.</div>
                            ) : (
                              <select
                                className="input w-full text-xs py-1"
                                value={templateFn ?? ''}
                                onChange={e => {
                                  const fn = e.target.value
                                  setSentForm(f => ({
                                    ...f,
                                    sentimentStrategies: {
                                      ...f.sentimentStrategies,
                                      [b.key]: fn ? `template:${fn}` : TEMPLATE_SCRIPT_KEY,
                                    },
                                  }))
                                }}
                              >
                                <option value="">— select template —</option>
                                {templates.map(t => <option key={t.filename} value={t.filename}>{t.name ?? t.filename}</option>)}
                              </select>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-slate-600 border-t border-dark-600 pt-2">
                  Sentiment scored per bar via RSI-14, MACD, &amp; SMA-20. Positions close on switch.
                </p>
              </div>

              {/* Warmup bars */}
              <div>
                <label className="label">Sentiment Warmup Bars</label>
                <input
                  className="input"
                  type="number"
                  min={5}
                  max={500}
                  value={sentForm.sentiment_warmup}
                  onChange={e => setSentForm(f => ({ ...f, sentiment_warmup: parseInt(e.target.value, 10) }))}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Bars before switching begins (indicators need data to warm up). Default 35.
                </p>
              </div>

              {/* Progress bar */}
              {sentMutation.isPending && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Computing sentiment &amp; signals…</span>
                    <span>{sentProgress}%</span>
                  </div>
                  <div className="w-full h-2 bg-dark-700 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-200 ease-linear"
                      style={{ width: `${sentProgress}%`, background: 'linear-gradient(90deg,#6366f1,#818cf8)' }} />
                  </div>
                </div>
              )}

              <button type="submit" className="btn-primary w-full justify-center"
                disabled={sentMutation.isPending}
                style={sentMutation.isPending ? {} : { background: 'linear-gradient(90deg,#4f46e5,#7c3aed)' }}
              >
                {sentMutation.isPending ? (
                  <><ArrowPathIcon className="h-4 w-4 animate-spin" />Running…</>
                ) : (
                  <><ArrowPathIcon className="h-4 w-4" />Run Sentiment Backtest</>
                )}
              </button>

              {sentMutation.isError && (
                <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-700/30 rounded-lg text-sm text-red-400">
                  <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 shrink-0" />
                  {sentMutation.error?.response?.data?.detail || sentMutation.error?.message || 'Unknown error'}
                </div>
              )}
              {sentMutation.isSuccess && (
                <div className="flex items-center gap-2 p-3 bg-indigo-900/20 border border-indigo-700/30 rounded-lg text-sm text-indigo-300">
                  <CheckCircleIcon className="h-4 w-4" />
                  Sentiment backtest complete — report saved.
                </div>
              )}
            </form>

            {/* Sentiment Results */}
            <div className="xl:col-span-2 space-y-5">
              {sentResult ? (
                <>
                  <SummaryPanel result={sentResult} />

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <MetricCard label="Total Return"
                      value={`${sentResult.metrics.total_return_pct >= 0 ? '+' : ''}${sentResult.metrics.total_return_pct?.toFixed(2)}%`}
                      positive={sentResult.metrics.total_return_pct >= 0} />
                    <MetricCard label="Annualised Return"
                      value={`${sentResult.metrics.annualized_return_pct >= 0 ? '+' : ''}${sentResult.metrics.annualized_return_pct?.toFixed(2)}%`}
                      positive={sentResult.metrics.annualized_return_pct >= 0} />
                    <MetricCard label="Sharpe Ratio"
                      value={sentResult.metrics.sharpe_ratio?.toFixed(2)}
                      positive={sentResult.metrics.sharpe_ratio >= 1} />
                    <MetricCard label="Max Drawdown"
                      value={`${sentResult.metrics.max_drawdown_pct?.toFixed(2)}%`}
                      positive={false} />
                    <MetricCard label="Final Value"
                      value={`$${sentResult.metrics.final_value?.toLocaleString()}`} />
                    <MetricCard label="Win Rate"
                      value={`${sentResult.metrics.win_rate_pct?.toFixed(1)}%`}
                      positive={sentResult.metrics.win_rate_pct >= 50} />
                    <MetricCard label="Total Trades" value={sentResult.metrics.total_trades} />
                    <MetricCard label="Strategy Switches"
                      value={(sentResult.result?.strategy_switches ?? []).length} />
                  </div>

                  {/* Chart / table tabs */}
                  <div className="card space-y-4">
                    <div className="flex gap-2 border-b border-dark-500 pb-3 flex-wrap">
                      {['equity', 'price', 'trades', 'switches'].map(tab => (
                        <button key={tab} onClick={() => setSentActiveTab(tab)}
                          className={`px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                            sentActiveTab === tab
                              ? 'bg-indigo-600 text-white'
                              : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                          }`}>
                          {tab === 'equity' ? 'Equity Curve'
                            : tab === 'price' ? 'Price Chart'
                            : tab === 'trades' ? 'Trade Log'
                            : 'Strategy Switches'}
                        </button>
                      ))}
                    </div>

                    <div className={sentActiveTab === 'equity' ? '' : 'hidden'}>
                      <EquityChart data={sentResult.result?.equity_curve ?? []}
                        initialCapital={sentResult.result?.initial_capital} height={300} />
                    </div>

                    <div className={sentActiveTab === 'price' ? '' : 'hidden'}>
                      <SubplotChart data={sentResult.result?.ohlcv ?? []} height={240} />
                    </div>

                    <div className={sentActiveTab === 'trades' ? '' : 'hidden'}>
                      <div className="table-container max-h-80 overflow-y-auto">
                        <table>
                          <thead>
                            <tr>
                              <th>Entry</th><th>Exit</th>
                              <th>Entry $</th><th>Exit $</th>
                              <th>Qty</th>
                              <th>Strategy</th>
                              <th>Bucket</th>
                              <th>Exit Reason</th>
                              <th>P&amp;L</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(sentResult.result?.trades ?? []).map((t, i) => (
                              <tr key={i}>
                                <td className="font-mono text-xs">{t.entry_date}</td>
                                <td className="font-mono text-xs">{t.exit_date}</td>
                                <td className="font-mono">${t.entry_price}</td>
                                <td className="font-mono">${t.exit_price}</td>
                                <td>{t.quantity}</td>
                                <td className="text-xs text-indigo-300">{t.entry_strategy ?? '—'}</td>
                                <td>
                                  {t.entry_bucket ? (
                                    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${BUCKETS.find(b => b.key === t.entry_bucket)?.cls ?? 'bg-slate-700/50 text-slate-400 border-slate-600'}`}>
                                      {t.entry_bucket}
                                    </span>
                                  ) : '—'}
                                </td>
                                <td>
                                  <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${t.exit_reason === 'strategy_switch' ? 'bg-amber-900/50 text-amber-300 border-amber-700/40' : 'bg-slate-700/50 text-slate-400 border-slate-600/40'}`}>
                                    {t.exit_reason?.replace(/_/g, ' ') ?? '—'}
                                  </span>
                                </td>
                                <td className={t.pnl >= 0 ? 'pos' : 'neg'}>
                                  {t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!(sentResult.result?.trades?.length) && (
                          <div className="text-center text-slate-500 text-sm py-8">No trades executed</div>
                        )}
                      </div>
                    </div>

                    <div className={sentActiveTab === 'switches' ? '' : 'hidden'}>
                      {(sentResult.result?.strategy_switches ?? []).length === 0 ? (
                        <div className="text-center text-slate-500 text-sm py-8">No strategy switches occurred</div>
                      ) : (
                        <div className="space-y-0 max-h-80 overflow-y-auto">
                          <div className="grid grid-cols-4 text-xs text-slate-500 uppercase tracking-wider px-2 pb-1 border-b border-dark-600">
                            <span>Date</span><span>From</span><span>To</span><span>Sentiment</span>
                          </div>
                          {(sentResult.result?.strategy_switches ?? []).map((sw, i) => (
                            <div key={i} className="grid grid-cols-4 items-center text-xs py-1.5 px-2 border-b border-dark-700/50 hover:bg-dark-800/30">
                              <span className="font-mono text-slate-500">{sw.date}</span>
                              <span className="text-slate-400">{sw.from ?? <span className="text-slate-600">start</span>}</span>
                              <span className="text-indigo-300 font-medium">{sw.to}</span>
                              <span>
                                <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold ${BUCKETS.find(b => b.key === sw.bucket)?.cls ?? 'bg-slate-700/50 text-slate-400 border-slate-600'}`}>
                                  {sw.bucket}
                                </span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              ) : sentMutation.isPending ? (
                <div className="card flex flex-col items-center justify-center h-64 gap-3 text-slate-400">
                  <ArrowPathIcon className="h-8 w-8 animate-spin text-indigo-400" />
                  <p className="text-sm">Running sentiment backtest…</p>
                </div>
              ) : (
                <div className="card flex flex-col items-center justify-center h-64 text-slate-500 gap-2">
                  <ArrowPathIcon className="h-10 w-10 text-slate-600 mb-1" />
                  <p className="font-medium">Configure sentiment strategy map and run</p>
                  <p className="text-xs text-slate-600 text-center max-w-xs">
                    Each bar's strategy is chosen by computing rolling RSI, MACD &amp; SMA,
                    then mapping the result to one of five sentiment buckets.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {mode === 'sandbox' && (() => {
          const positions = sandboxPositionsData?.positions ?? []
          const watchlistPositions = positions.filter(p => p.is_on_watchlist !== false)
          const pmSettings = pmData?.settings ?? {}
          const symbolsOverride = sandboxForm.symbols_override
            .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
          const effectiveSymbols = symbolsOverride.length > 0
            ? symbolsOverride
            : watchlistPositions.map(p => p.symbol)
          const totalAllocated = watchlistPositions.reduce(
            (s, p) => s + Math.max(0, Number(p.allocated_funds) || 0), 0
          )
          const previewRows = effectiveSymbols.map(sym => {
            const pos = positions.find(p => p.symbol === sym)
            const alloc = Math.max(0, Number(pos?.allocated_funds) || 0)
            let capShare = 0
            if (sandboxForm.allocation_mode === 'equal' || totalAllocated <= 0) {
              capShare = effectiveSymbols.length
                ? sandboxForm.initial_capital / effectiveSymbols.length
                : 0
            } else {
              capShare = sandboxForm.initial_capital * (alloc / totalAllocated)
            }
            // In shared-pool mode, "capital" column = per-symbol earmark (min).
            if (sandboxForm.use_shared_pool) {
              const n = effectiveSymbols.length || 1
              const totalEarmarkPct = Math.min((Number(sandboxForm.per_position_min_pct) || 0) * n, 100)
              const totalEarmark = (totalEarmarkPct / 100) * sandboxForm.initial_capital
              if (sandboxForm.allocation_mode === 'proportional' && totalAllocated > 0) {
                capShare = totalEarmark * (alloc / totalAllocated)
              } else {
                capShare = totalEarmark / n
              }
            }
            return {
              symbol: sym,
              strategy: pos?.strategy_name ?? null,
              allocated: alloc,
              capital: capShare,
            }
          })
          const sharedPoolInfo = sandboxForm.use_shared_pool
            ? (() => {
                const n = effectiveSymbols.length || 1
                const totalEarmarkPct = Math.min((Number(sandboxForm.per_position_min_pct) || 0) * n, 100)
                const totalEarmark = (totalEarmarkPct / 100) * sandboxForm.initial_capital
                const pool = sandboxForm.initial_capital - totalEarmark
                const cap = (Math.max(0, Number(sandboxForm.per_position_max_pct) || 0) / 100) * sandboxForm.initial_capital
                return { totalEarmark, pool, cap }
              })()
            : null
          const r = sandboxResult?.result ?? {}
          const m = sandboxResult?.metrics ?? {}
          return (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              {/* Sandbox Config */}
              <form onSubmit={handleSandboxSubmit} className="card space-y-4 xl:col-span-1">
                <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider flex items-center gap-2">
                  Sandbox + PM Backtest
                  <span className="text-amber-400 text-xs font-normal normal-case">Watchlist Portfolio</span>
                </h2>
                <p className="text-xs text-slate-500 -mt-2">
                  Runs a backtest for every symbol in the current sandbox watchlist using PM
                  settings (stop-loss, take-profit, EOD, strategy routing). Capital is split
                  per allocation mode and results are aggregated.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="label mb-0">Start Date</label>
                      <button
                        type="button"
                        className="text-xs text-emerald-400 hover:text-emerald-300"
                        onClick={() => {
                          const today = getTodayDateString()
                          setSandboxForm(f => ({ ...f, start_date: getOneMonthAgoDateString(today), end_date: today }))
                        }}
                      >
                        Past Month
                      </button>
                    </div>
                    <input
                      className="input"
                      type="date"
                      value={sandboxForm.start_date}
                      onChange={e => setSandboxForm(f => ({ ...f, start_date: e.target.value }))}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="label mb-0">End Date</label>
                      <button
                        type="button"
                        className="text-xs text-emerald-400 hover:text-emerald-300"
                        onClick={() => setSandboxForm(f => ({ ...f, end_date: getTodayDateString() }))}
                      >
                        Today
                      </button>
                    </div>
                    <input
                      className="input"
                      type="date"
                      value={sandboxForm.end_date}
                      onChange={e => setSandboxForm(f => ({ ...f, end_date: e.target.value }))}
                    />
                  </div>
                </div>

                <div>
                  <label className="label">Initial Capital ($)</label>
                  <input
                    className="input"
                    type="number"
                    value={sandboxForm.initial_capital}
                    onChange={e => setSandboxForm(f => ({ ...f, initial_capital: parseFloat(e.target.value) || 0 }))}
                  />
                </div>

                <div>
                  <label className="label">Commission</label>
                  <select
                    className="input"
                    value={String(sandboxForm.commission)}
                    onChange={e => setSandboxForm(f => ({ ...f, commission: parseFloat(e.target.value) }))}
                  >
                    {COMMISSION_PRESETS.filter(p => p.value !== null).map(p => (
                      <option key={p.label} value={String(p.value)}>{p.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="label">Allocation Mode</label>
                  <select
                    className="input"
                    value={sandboxForm.allocation_mode}
                    onChange={e => setSandboxForm(f => ({ ...f, allocation_mode: e.target.value }))}
                  >
                    <option value="proportional">Proportional to sandbox allocated_funds</option>
                    <option value="equal">Equal split across symbols</option>
                  </select>
                </div>

                {/* Shared liquidity pool controls (sandbox-style) */}
                <div className="border border-dark-500 rounded-lg p-3 bg-dark-900/30 space-y-3">
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <div className="relative">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={sandboxForm.use_shared_pool}
                        onChange={e => setSandboxForm(f => ({ ...f, use_shared_pool: e.target.checked }))}
                      />
                      <div className="w-9 h-5 bg-dark-600 rounded-full peer-checked:bg-emerald-500 transition-colors" />
                      <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-slate-200">
                        Shared Liquidity Pool {sandboxForm.use_shared_pool ? '(sandbox-style)' : '(isolated)'}
                      </div>
                      <div className="text-xs text-slate-500">
                        {sandboxForm.use_shared_pool
                          ? 'Coordinated simulation. Per-position floor + cap; idle cash flows into a central pool that positions can draw from to buy.'
                          : 'Legacy: split capital up front per allocation mode and run each symbol in isolation.'}
                      </div>
                    </div>
                  </label>

                  {sandboxForm.use_shared_pool && (
                    <div className="grid grid-cols-2 gap-3 pt-1 border-t border-dark-700/60">
                      <div>
                        <label className="label">Min per position (%)</label>
                        <input
                          className="input"
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={sandboxForm.per_position_min_pct}
                          onChange={e => setSandboxForm(f => ({ ...f, per_position_min_pct: Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)) }))}
                        />
                        <p className="text-xs text-slate-500 mt-1">Earmarked per symbol. 0 = all funds start in the pool.</p>
                      </div>
                      <div>
                        <label className="label">Max per position (%)</label>
                        <input
                          className="input"
                          type="number"
                          min="0"
                          max="200"
                          step="1"
                          value={sandboxForm.per_position_max_pct}
                          onChange={e => setSandboxForm(f => ({ ...f, per_position_max_pct: Math.max(0, Math.min(200, parseFloat(e.target.value) || 0)) }))}
                        />
                        <p className="text-xs text-slate-500 mt-1">Cap on any single position. 0 = uncapped.</p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="border border-dark-500 rounded-lg p-3 bg-dark-900/30">
                  <div className="text-sm font-medium text-slate-200">Execution Mode</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Uses PM sentiment strategy routing and always runs in day-trade mode.
                  </div>
                </div>

                <div>
                  <label className="label">Override Symbols (optional)</label>
                  <input
                    className="input"
                    type="text"
                    placeholder="e.g. AAPL, MSFT, NVDA"
                    value={sandboxForm.symbols_override}
                    onChange={e => setSandboxForm(f => ({ ...f, symbols_override: e.target.value }))}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Leave blank to use all sandbox watchlist symbols
                    {watchlistPositions.length > 0 ? ` (${watchlistPositions.length} on watchlist)` : ''}.
                  </p>
                </div>

                {/* PM settings preview */}
                <div className="border border-dark-500 rounded-lg bg-dark-900/30 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPmSettingsOpen(v => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-dark-800/50 transition-colors"
                  >
                    <div className="text-xs text-slate-500 uppercase tracking-wider">Active PM Settings</div>
                    <ChevronDownIcon className={`h-4 w-4 text-slate-500 transition-transform ${pmSettingsOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {pmSettingsOpen && (
                    <div className="border-t border-dark-700/70 px-3 py-3">
                      {(() => {
                        const rows = []
                        const add = (label, value, show = true) => {
                          if (show) rows.push({ label, value })
                        }

                        const stopLossPct = Number(pmSettings.stop_loss_pct ?? 0)
                        const stopLossValue = Number(pmSettings.stop_loss_value ?? 0)
                        const takeProfitPct = Number(pmSettings.take_profit_pct ?? 0)
                        const takeProfitValue = Number(pmSettings.take_profit_value ?? 0)
                        const riskMode = (stopLossValue > 0 || takeProfitValue > 0) ? 'value' : 'percent'
                        const holdOvernight = !!pmSettings.hold_positions_overnight
                        const shutoffMins = Number(pmSettings.eod_engine_shutoff_minutes_before_sell ?? 0)
                        const eodMins = Number(pmSettings.eod_sell_window_minutes ?? 0)
                        const driftCancel = Number(pmSettings.pending_price_drift_cancel_pct ?? 0)
                        const pendingBars = Number(pmSettings.pending_cancel_after_bars ?? 0)
                        const buyFill = Number(pmSettings.sim_buy_fill_rate_pct ?? 0)
                        const sellFill = Number(pmSettings.sim_sell_fill_rate_pct ?? 0)
                        const buyOffsetMode = String(pmSettings.auto_trade_buy_price_offset_mode ?? 'percent')
                        const sellOffsetMode = String(pmSettings.auto_trade_sell_price_offset_mode ?? 'percent')
                        const buyOffset = Number(pmSettings.auto_trade_buy_price_offset_pct ?? 0)
                        const sellOffset = Number(pmSettings.auto_trade_sell_price_offset_pct ?? 0)
                        const extWeight = Number(pmSettings.ai_external_sentiment_weight ?? 0)
                        const aiTpPct = Number(pmSettings.ai_tag_long_tp_pct ?? 0)
                        const aiSlPct = Number(pmSettings.ai_tag_long_sl_pct ?? 0)
                        const aiTpValue = Number(pmSettings.ai_tag_long_tp_value ?? 0)
                        const aiSlValue = Number(pmSettings.ai_tag_long_sl_value ?? 0)

                        add('Risk Exit Mode', riskMode === 'value' ? 'Dollar ($)' : 'Percentage (%)')
                        add('Stop Loss %', `${stopLossPct.toFixed(2)}%`, riskMode === 'percent' && stopLossPct > 0)
                        add('Take Profit %', `${takeProfitPct.toFixed(2)}%`, riskMode === 'percent' && takeProfitPct > 0)
                        add('Stop Loss $', `$${stopLossValue.toFixed(2)}`, riskMode === 'value' && stopLossValue > 0)
                        add('Take Profit $', `$${takeProfitValue.toFixed(2)}`, riskMode === 'value' && takeProfitValue > 0)
                        add('Hold Overnight', holdOvernight ? 'Yes' : 'No')
                        add('EOD Shutoff', `${shutoffMins}m`, !holdOvernight && shutoffMins > 0)
                        add('EOD Window', `${eodMins}m`, !holdOvernight && eodMins > 0)
                        add('Drift Cancel', `${driftCancel.toFixed(2)}%`, driftCancel > 0)
                        add('Pending Timeout', `${Math.max(1, pendingBars)} bars`, pendingBars > 0)
                        add('Buy Fill Rate', `${buyFill.toFixed(0)}%`, buyFill > 0)
                        add('Sell Fill Rate', `${sellFill.toFixed(0)}%`, sellFill > 0)
                        add(
                          'Auto Offsets',
                          `${buyOffsetMode === 'dollar' ? 'B$+' : 'B+'}${buyOffset.toFixed(2)}${buyOffsetMode === 'dollar' ? '' : '%'} / ${sellOffsetMode === 'dollar' ? 'S$-' : 'S-'}${sellOffset.toFixed(2)}${sellOffsetMode === 'dollar' ? '' : '%'}`,
                          buyOffset > 0 || sellOffset > 0,
                        )
                        add('Sentiment Lookback', `${Number(pmSettings.sentiment_lookback_days ?? 5)}d`)
                        add('Sentiment Interval', String(pmSettings.sentiment_interval ?? '1m'))
                        add('Sentiment Warmup', `${Number(pmSettings.sentiment_data_points ?? 35)} bars`, Number(pmSettings.sentiment_data_points ?? 0) > 0)
                        add('Sentiment Debounce', `${Math.max(1, Number(pmSettings.sentiment_bucket_persistence ?? 3))} bars`, Number(pmSettings.sentiment_bucket_persistence ?? 0) > 0)
                        add('PM Hold Duration', `${Math.max(0, Number(pmSettings.pm_hold_duration_bars ?? 0))} bars`, Number(pmSettings.pm_hold_duration_bars ?? 0) > 0)
                        add('PM Hold Extended', `${Number(pmSettings.pm_hold_extended_multiplier ?? 0).toFixed(2)}x`, Number(pmSettings.pm_hold_extended_multiplier ?? 0) > 0)
                        add('PM Hold Trailing', `${Number(pmSettings.pm_hold_trailing_pct ?? 0).toFixed(2)}%`, Number(pmSettings.pm_hold_trailing_pct ?? 0) > 0)
                        add('AI Sentiment Changes', 'On', pmSettings.ai_sentiment_change_enabled !== false)
                        add('AI Strategy Routing', 'On', !!pmSettings.ai_tag_strategy_enabled)
                        add('AI Overnight Exempt', 'LONG/STRONG LONG', !!pmSettings.ai_tag_allow_overnight)
                        add('AI External Weight', `${(extWeight * 100).toFixed(0)}%`, extWeight > 0)
                        add('AI Long TP %', `${aiTpPct.toFixed(2)}%`, aiTpPct > 0)
                        add('AI Long SL %', `${aiSlPct.toFixed(2)}%`, aiSlPct > 0)
                        add('AI Long TP $', `$${aiTpValue.toFixed(2)}`, aiTpValue > 0)
                        add('AI Long SL $', `$${aiSlValue.toFixed(2)}`, aiSlValue > 0)
                        add('AI No-Loss Sell', 'On', pmSettings.ai_tag_no_loss_sell !== false)

                        return (
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-400">
                            {rows.flatMap(row => ([
                              <span key={`${row.label}-k`}>{row.label}</span>,
                              <span key={`${row.label}-v`} className="font-mono text-slate-200">{row.value}</span>,
                            ]))}
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </div>

                {/* Allocation preview */}
                {previewRows.length > 0 && (
                  <div className="border border-dark-500 rounded-lg p-3 bg-dark-900/30">
                    <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                      {sandboxForm.use_shared_pool ? 'Per-Position Earmark' : 'Capital Split'} ({previewRows.length} symbols)
                    </div>
                    {sharedPoolInfo && (
                      <div className="grid grid-cols-3 gap-2 text-xs mb-2 pb-2 border-b border-dark-700/60">
                        <div>
                          <div className="text-slate-500">Shared Pool</div>
                          <div className="font-mono text-emerald-300">${sharedPoolInfo.pool.toFixed(0)}</div>
                        </div>
                        <div>
                          <div className="text-slate-500">Total Earmark</div>
                          <div className="font-mono text-amber-300">${sharedPoolInfo.totalEarmark.toFixed(0)}</div>
                        </div>
                        <div>
                          <div className="text-slate-500">Cap / symbol</div>
                          <div className="font-mono text-slate-200">
                            {sharedPoolInfo.cap > 0 ? `$${sharedPoolInfo.cap.toFixed(0)}` : 'uncapped'}
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="max-h-40 overflow-y-auto space-y-0.5 text-xs">
                      {previewRows.map(row => (
                        <div key={row.symbol} className="grid grid-cols-3 gap-2 py-0.5 border-b border-dark-700/40">
                          <span className="font-semibold text-slate-200">{row.symbol}</span>
                          <span className="text-slate-500 truncate">{row.strategy ?? '—'}</span>
                          <span className="font-mono text-right text-amber-300">${row.capital.toFixed(0)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {sandboxPositionsLoading && (
                  <div className="text-xs text-slate-500">Loading sandbox positions…</div>
                )}

                {/* Progress bar */}
                {sandboxMutation.isPending && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Running per-symbol backtests…</span>
                      <span>{sandboxProgress}%</span>
                    </div>
                    <div className="w-full h-2 bg-dark-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-200 ease-linear"
                        style={{ width: `${sandboxProgress}%`, background: 'linear-gradient(90deg,#f59e0b,#fbbf24)' }} />
                    </div>
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-primary w-full justify-center"
                  disabled={sandboxMutation.isPending || effectiveSymbols.length === 0}
                  style={sandboxMutation.isPending ? {} : { background: 'linear-gradient(90deg,#d97706,#f59e0b)' }}
                >
                  {sandboxMutation.isPending ? (
                    <><ArrowPathIcon className="h-4 w-4 animate-spin" />Running…</>
                  ) : (
                    <><ArrowPathIcon className="h-4 w-4" />Run Sandbox Backtest</>
                  )}
                </button>

                {effectiveSymbols.length === 0 && !sandboxPositionsLoading && (
                  <div className="text-xs text-amber-400/80">
                    No watchlist symbols found. Add some in the Sandbox panel or enter overrides above.
                  </div>
                )}

                {sandboxMutation.isError && (
                  <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-700/30 rounded-lg text-sm text-red-400">
                    <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 shrink-0" />
                    {sandboxMutation.error?.response?.data?.detail || sandboxMutation.error?.message || 'Unknown error'}
                  </div>
                )}
                {sandboxMutation.isSuccess && (
                  <div className="flex items-center gap-2 p-3 bg-amber-900/20 border border-amber-700/30 rounded-lg text-sm text-amber-300">
                    <CheckCircleIcon className="h-4 w-4" />
                    Sandbox backtest complete — report saved.
                  </div>
                )}
              </form>

              {/* Sandbox Results */}
              <div className="xl:col-span-2 space-y-5">
                {sandboxResult ? (
                  <SandboxResultsView result={r} metrics={m} />
                ) : sandboxMutation.isPending ? (
                  <div className="card flex flex-col items-center justify-center h-64 gap-3 text-slate-400">
                    <ArrowPathIcon className="h-8 w-8 animate-spin text-amber-400" />
                    <p className="text-sm">Running sandbox backtest…</p>
                    <p className="text-xs text-slate-600">Backtesting {effectiveSymbols.length} symbol(s) in parallel</p>
                  </div>
                ) : (
                  <div className="card flex flex-col items-center justify-center h-64 text-slate-500 gap-2">
                    <ArrowPathIcon className="h-10 w-10 text-slate-600 mb-1" />
                    <p className="font-medium">Configure and run a sandbox backtest</p>
                    <p className="text-xs text-slate-600 text-center max-w-xs">
                      Backtests every symbol in your sandbox watchlist using current PM
                      settings. Capital is split across symbols and results are aggregated.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )
        })()}
    </div>
  )
}
