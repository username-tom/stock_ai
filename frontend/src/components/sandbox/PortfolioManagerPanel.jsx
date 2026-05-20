import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CpuChipIcon, ArrowsRightLeftIcon, ClockIcon, BanknotesIcon,
  ChartBarIcon, CheckCircleIcon, XCircleIcon,
} from '@heroicons/react/24/outline'
import { getPortfolioManagerState, updatePortfolioManagerSettings, getStrategies, getScripts, getBuiltinTemplates, updateSandboxPosition, getIBStatus } from '../../api/client'
import { useAppSettings } from '../../hooks/useAppSettings'
import { CUSTOM_SCRIPT_KEY, TEMPLATE_SCRIPT_KEY } from './sandboxConstants'
import { fmtMoney } from './sandboxHelpers'

const STORAGE_KEY = 'portfolio_manager_savestates_v1'
const PROFILE_ORDER = ['simulated', 'paper', 'live']

const BULL_COLOR = '#10b981'
const BEAR_COLOR = '#ef4444'
const NEUTRAL_COLOR = '#64748b'
const EUPHORIC_COLOR = '#a855f7'
const CRASH_COLOR = '#f97316'
const SENTIMENT_BUCKETS = ['crash', 'bearish', 'neutral', 'bullish', 'euphoric']
const SENTIMENT_LABELS = {
  crash: 'Crash',
  bearish: 'Bearish',
  neutral: 'Neutral',
  bullish: 'Bullish',
  euphoric: 'Euphoric',
}

const AI_TAG_BUCKETS = ['STRONG LONG', 'LONG', 'NEUTRAL', 'SHORT', 'STRONG SHORT']
const AI_TAG_LABELS = {
  'STRONG LONG': 'Strong Long',
  'LONG': 'Long',
  'NEUTRAL': 'Neutral',
  'SHORT': 'Short',
  'STRONG SHORT': 'Strong Short',
}
const AI_TAG_COLORS = {
  'STRONG LONG': '#10b981',
  'LONG': '#34d399',
  'NEUTRAL': '#64748b',
  'SHORT': '#f87171',
  'STRONG SHORT': '#ef4444',
}
const DEFAULT_AI_TAG_STRATEGIES = {
  'STRONG LONG': 'sma_crossover',
  'LONG': 'sma_crossover',
  'NEUTRAL': '',
  'SHORT': 'rsi',
  'STRONG SHORT': 'rsi',
}
const DEFAULT_SENTIMENT_STRATEGIES = {
  crash: 'rsi',
  bearish: 'macd',
  neutral: 'bollinger_bands',
  bullish: 'sma_crossover',
  euphoric: 'rsi',
}

function buildDraftFromSettings(settings) {
  return {
    transfer_pct: Math.round(settings.transfer_pct * 100),
    transfer_interval_s: settings.transfer_interval_s,
    indicator_interval_s: settings.indicator_interval_s,
    min_position_funds: settings.min_position_funds,
    min_position_funds_mode: settings.min_position_funds_mode ?? 'dollar',
    min_position_funds_pct: settings.min_position_funds_pct ?? 1,
    deploy_available_funds: settings.deploy_available_funds ?? true,
    deploy_target: settings.deploy_target ?? 'most_bearish',
    deploy_target_symbol: settings.deploy_target_symbol ?? '',
    reallocation_enabled: settings.reallocation_enabled ?? true,
    reallocation_mode: settings.reallocation_mode ?? 'to_stock',
    allow_buy_outside_allocation: settings.allow_buy_outside_allocation ?? false,
    market_sentiment_strategies: {
      ...DEFAULT_SENTIMENT_STRATEGIES,
      ...(settings.market_sentiment_strategies ?? {}),
    },
    symbol_sentiment_strategies: {
      ...DEFAULT_SENTIMENT_STRATEGIES,
      ...(settings.symbol_sentiment_strategies ?? {}),
    },
    sentiment_strategy_enabled: settings.sentiment_strategy_enabled ?? true,
    stop_loss_pct: settings.stop_loss_pct ?? 0,
    take_profit_pct: settings.take_profit_pct ?? 0,
    hold_positions_overnight: settings.hold_positions_overnight ?? true,
    eod_engine_shutoff_minutes_before_sell: settings.eod_engine_shutoff_minutes_before_sell ?? 120,
    eod_sell_window_minutes: settings.eod_sell_window_minutes ?? 30,
    sentiment_lookback_days: settings.sentiment_lookback_days ?? 5,
    sentiment_data_points: settings.sentiment_data_points ?? 10,
    sentiment_interval: settings.sentiment_interval ?? '1m',
    ai_tag_strategy_enabled: settings.ai_tag_strategy_enabled ?? false,
    ai_tag_strategies: {
      ...DEFAULT_AI_TAG_STRATEGIES,
      ...(settings.ai_tag_strategies ?? {}),
    },
    ai_tag_allow_overnight: settings.ai_tag_allow_overnight ?? true,
    ai_tag_action_mode: settings.ai_tag_action_mode ?? 'strategy_override',
    ai_tag_long_engine_off: settings.ai_tag_long_engine_off ?? true,
    ai_tag_long_tp_pct: settings.ai_tag_long_tp_pct ?? 0,
    ai_tag_long_sl_pct: settings.ai_tag_long_sl_pct ?? 0,
  }
}

function normalizeProfile(profile) {
  return PROFILE_ORDER.includes(profile) ? profile : 'simulated'
}

function loadSavedStates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch {}
  return {}
}

function saveSavedStates(states) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(states))
  } catch {}
}

function classColor(cls) {
  if (cls === 'euphoric') return EUPHORIC_COLOR
  if (cls === 'crash') return CRASH_COLOR
  if (cls === 'bullish') return BULL_COLOR
  if (cls === 'bearish') return BEAR_COLOR
  return NEUTRAL_COLOR
}

function classLabel(cls) {
  if (cls === 'euphoric') return '▲▲ Euphoric'
  if (cls === 'crash') return '▼▼ Crash'
  if (cls === 'bullish') return '▲ Bullish'
  if (cls === 'bearish') return '▼ Bearish'
  return '— Neutral'
}

function parseStrategyValue(val) {
  if (val?.startsWith('custom:')) {
    return { type: CUSTOM_SCRIPT_KEY, scriptId: parseInt(val.slice(7)) || null, templateFilename: null }
  }
  if (val?.startsWith('template:')) {
    return { type: TEMPLATE_SCRIPT_KEY, scriptId: null, templateFilename: val.slice(9) }
  }
  return { type: val ?? '', scriptId: null, templateFilename: null }
}

function stratDisplayName(val, scripts, templates) {
  if (!val) return '—'
  if (val.startsWith('custom:')) {
    const id = parseInt(val.slice(7))
    const script = scripts.find(s => s.id === id)
    return script ? `⚙ ${script.name}` : `⚙ custom:${id}`
  }
  if (val.startsWith('template:')) {
    const fn = val.slice(9)
    const tmpl = templates.find(t => t.filename === fn)
    return tmpl ? `📄 ${tmpl.name ?? fn}` : `📄 ${fn}`
  }
  return val
}

function sanitizeSentimentMap(map) {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [
      k,
      (v === CUSTOM_SCRIPT_KEY || v === TEMPLATE_SCRIPT_KEY) ? (DEFAULT_SENTIMENT_STRATEGIES[k] ?? 'rsi') : v,
    ])
  )
}

function SettingRow({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-300">{label}</label>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      {children}
    </div>
  )
}

export default function PortfolioManagerPanel({ profile = 'simulated', onShowOverview, onSelectSymbol }) {
  const qc = useQueryClient()
  const appSettings = useAppSettings()
  const activeProfile = normalizeProfile(profile)
  const [editSettings, setEditSettings] = useState(false)
  const [draft, setDraft] = useState(null)
  const [savedStates, setSavedStates] = useState(() => loadSavedStates())
  const [routingGroups, setRoutingGroups] = useState({ manual: [], market: [], symbol: [] })
  const [dragPayload, setDragPayload] = useState(null)
  const [dragOverMode, setDragOverMode] = useState(null)
  const [sentimentError, setSentimentError] = useState(null)

  const { data: managerData, isLoading } = useQuery({
    queryKey: ['portfolio-manager-state'],
    queryFn: getPortfolioManagerState,
    refetchInterval: appSettings.portfolio_positions_ms,
  })
  const { data: ibStatus } = useQuery({
    queryKey: ['ib-status'],
    queryFn: getIBStatus,
    refetchInterval: appSettings.trading_status_ms,
  })
  const ibConnected = ibStatus?.connected === true

  const { data: strategyData } = useQuery({
    queryKey: ['strategies'],
    queryFn: getStrategies,
    staleTime: 60_000,
  })
  const { data: scriptsData } = useQuery({
    queryKey: ['scripts'],
    queryFn: getScripts,
    staleTime: 60_000,
  })
  const scripts = scriptsData?.scripts ?? []
  const { data: templatesData } = useQuery({
    queryKey: ['builtin-templates'],
    queryFn: getBuiltinTemplates,
    staleTime: 300_000,
  })
  const templates = (templatesData?.templates ?? []).filter(t => !t.filename.startsWith('_'))

  const updateMut = useMutation({
    mutationFn: updatePortfolioManagerSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] })
      // Sentiment strategy changes update strategy_name on positions asynchronously;
      // delay the positions refetch to let the backend task finish.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['sandbox-positions'] }), 600)
      setSavedStates(prev => {
        const next = {
          ...prev,
          [activeProfile]: {
            draft,
            editSettings: false,
            updatedAt: new Date().toISOString(),
          },
        }
        saveSavedStates(next)
        return next
      })
      setEditSettings(false)
    },
  })

  const routingMut = useMutation({
    mutationFn: ({ symbol, mode }) => updateSandboxPosition(symbol, { sentiment_mode: mode }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] })
    },
  })

  useEffect(() => {
    if (isLoading || !managerData) return
    setSavedStates(prev => {
      const current = prev[activeProfile]
      if (current?.draft) {
        setDraft(current.draft)
        setEditSettings(!!current.editSettings)
        return prev
      }
      const next = {
        ...prev,
        [activeProfile]: {
          draft: buildDraftFromSettings(managerData.settings),
          editSettings: false,
          updatedAt: new Date().toISOString(),
        },
      }
      saveSavedStates(next)
      setDraft(next[activeProfile].draft)
      setEditSettings(false)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, managerData, isLoading])

  useEffect(() => {
    if (!managerData) return
    const symbols = Object.keys(managerData.scores ?? {}).sort()
    const marketRaw = managerData.sentiment_groups?.market ?? []
    const symbolRaw = managerData.sentiment_groups?.symbol ?? []

    const normalizedMarket = [...new Set(marketRaw)].filter(sym => symbols.includes(sym))
    const normalizedSymbol = [...new Set(symbolRaw)]
      .filter(sym => symbols.includes(sym) && !normalizedMarket.includes(sym))
    const normalizedManual = symbols.filter(
      sym => !normalizedMarket.includes(sym) && !normalizedSymbol.includes(sym)
    )

    setRoutingGroups({
      manual: normalizedManual,
      market: normalizedMarket,
      symbol: normalizedSymbol,
    })
  }, [managerData])

  if (isLoading || !managerData) return null

  const settings = managerData.settings
  const scores = managerData.scores ?? {}
  const aiTags = managerData.ai_tags ?? {}
  const activity = managerData.last_activity ?? []

  function openEdit() {
    setEditSettings(true)
    const next = {
      ...savedStates,
      [activeProfile]: {
        ...(savedStates[activeProfile] ?? { draft }),
        editSettings: true,
        updatedAt: new Date().toISOString(),
      },
    }
    setSavedStates(next)
    saveSavedStates(next)
  }

  function doneEditing() {
    // Revert to current backend settings when cancelling edits
    const nextDraft = buildDraftFromSettings(settings)
    setEditSettings(false)
    setDraft(nextDraft)
    const next = {
      ...savedStates,
      [activeProfile]: {
        draft: nextDraft,
        editSettings: false,
        updatedAt: new Date().toISOString(),
      },
    }
    setSavedStates(next)
    saveSavedStates(next)
  }

  function updateDraft(updater) {
    setSentimentError(null)
    setDraft(prev => {
      const nextDraft = typeof updater === 'function' ? updater(prev) : updater
      setSavedStates(prevStates => {
        const next = {
          ...prevStates,
          [activeProfile]: {
            draft: nextDraft,
            editSettings,
            updatedAt: new Date().toISOString(),
          },
        }
        saveSavedStates(next)
        return next
      })
      return nextDraft
    })
  }

  function handleSave() {
    if (!draft) return
    const hasIncomplete = (map) =>
      Object.values(map).some(v => v === CUSTOM_SCRIPT_KEY || v === TEMPLATE_SCRIPT_KEY)
    if (hasIncomplete(draft.market_sentiment_strategies) || hasIncomplete(draft.symbol_sentiment_strategies)) {
      setSentimentError('Select a specific script or template for every sentiment bucket before saving.')
      return
    }
    setSentimentError(null)
    updateMut.mutate({
      transfer_pct: draft.transfer_pct / 100,
      transfer_interval_s: Number(draft.transfer_interval_s),
      indicator_interval_s: Number(draft.indicator_interval_s),
      min_position_funds: Number(draft.min_position_funds),
      min_position_funds_mode: draft.min_position_funds_mode,
      min_position_funds_pct: Number(draft.min_position_funds_pct),
      deploy_available_funds: draft.deploy_available_funds,
      deploy_target: draft.deploy_target,
      deploy_target_symbol: draft.deploy_target_symbol ?? '',
      reallocation_enabled: draft.reallocation_enabled,
      reallocation_mode: draft.reallocation_mode,
      allow_buy_outside_allocation: draft.allow_buy_outside_allocation,
      market_sentiment_strategies: sanitizeSentimentMap(draft.market_sentiment_strategies),
      symbol_sentiment_strategies: sanitizeSentimentMap(draft.symbol_sentiment_strategies),
      sentiment_strategy_enabled: draft.sentiment_strategy_enabled,
      stop_loss_pct: Number(draft.stop_loss_pct),
      take_profit_pct: Number(draft.take_profit_pct),
      hold_positions_overnight: draft.hold_positions_overnight,
      eod_engine_shutoff_minutes_before_sell: Number(draft.eod_engine_shutoff_minutes_before_sell),
      eod_sell_window_minutes: Number(draft.eod_sell_window_minutes),
      sentiment_lookback_days: Number(draft.sentiment_lookback_days),
      sentiment_data_points: Number(draft.sentiment_data_points),
      sentiment_interval: draft.sentiment_interval,
      ai_tag_strategy_enabled: draft.ai_tag_strategy_enabled,
      ai_tag_strategies: draft.ai_tag_strategies,
      ai_tag_allow_overnight: draft.ai_tag_allow_overnight,
      ai_tag_action_mode: draft.ai_tag_action_mode,
      ai_tag_long_engine_off: draft.ai_tag_long_engine_off,
      ai_tag_long_tp_pct: Number(draft.ai_tag_long_tp_pct),
      ai_tag_long_sl_pct: Number(draft.ai_tag_long_sl_pct),
    })
  }

  const strategyOptions = strategyData?.strategies ?? []
  const marketSentimentStrategies = {
    ...DEFAULT_SENTIMENT_STRATEGIES,
    ...(settings.market_sentiment_strategies ?? {}),
  }
  const symbolSentimentStrategies = {
    ...DEFAULT_SENTIMENT_STRATEGIES,
    ...(settings.symbol_sentiment_strategies ?? {}),
  }

  const symbolCount = Object.keys(scores).length
  const sentimentCounts = SENTIMENT_BUCKETS.reduce((acc, bucket) => {
    acc[bucket] = Object.values(scores).filter(s => s.classification === bucket).length
    return acc
  }, {})

  function moveRoutingSymbol(symbol, targetMode) {
    setRoutingGroups(prev => {
      const without = {
        manual: prev.manual.filter(s => s !== symbol),
        market: prev.market.filter(s => s !== symbol),
        symbol: prev.symbol.filter(s => s !== symbol),
      }
      return {
        ...without,
        [targetMode]: [...without[targetMode], symbol],
      }
    })
  }

  async function applyRoutingMove(symbol, fromMode, targetMode) {
    if (!symbol || !targetMode || fromMode === targetMode || routingMut.isPending) return
    moveRoutingSymbol(symbol, targetMode)
    setDragOverMode(null)
    setDragPayload(null)

    try {
      const nextMode = targetMode === 'manual' ? 'none' : targetMode
      await routingMut.mutateAsync({ symbol, mode: nextMode })
    } catch {
      qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] })
    }
  }

  function handleDragStart(symbol, fromMode, event) {
    setDragPayload({ symbol, fromMode })
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', `${symbol}:${fromMode}`)
  }

  function handleDrop(targetMode, event) {
    event.preventDefault()
    event.stopPropagation()
    const payload = dragPayload
    if (!payload) return
    applyRoutingMove(payload.symbol, payload.fromMode, targetMode)
  }

  return (
    <div className="card space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CpuChipIcon className="h-4 w-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Portfolio Manager</h2>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-dark-700 text-slate-400 border border-dark-600 uppercase tracking-wide">
            {activeProfile}
          </span>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${
            settings.enabled
              ? 'bg-violet-900/30 text-violet-300 border-violet-700/40'
              : 'bg-dark-700 text-slate-500 border-dark-600'
          }`}>
            {settings.enabled
              ? <><CheckCircleIcon className="h-3 w-3" />Active</>
              : <><XCircleIcon className="h-3 w-3" />Inactive</>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onShowOverview && (
            <button
              onClick={onShowOverview}
              className="text-xs text-slate-400 hover:text-emerald-300 border border-dark-500 hover:border-emerald-700/50 rounded-lg px-3 py-1.5 transition-colors"
              title="Back to Portfolio Summary"
            >
              ← Summary
            </button>
          )}
          <button
            onClick={editSettings ? doneEditing : openEdit}
            className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors"
          >
            {editSettings ? 'Done' : 'Edit'}
          </button>
          <button
            onClick={handleSave}
            disabled={!editSettings || !draft || updateMut.isPending}
            className="text-xs bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {updateMut.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {sentimentError && (
        <p className="text-xs text-red-400 -mt-2">{sentimentError}</p>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-dark-800 rounded-lg p-3">
          <div className="text-xs text-slate-500 mb-1">Last Transfer</div>
          <div className="text-xs font-medium text-slate-300 leading-snug">
            {managerData.last_transfer_at
              ? new Date(managerData.last_transfer_at).toLocaleTimeString()
              : '—'}
          </div>
        </div>
        <div className="bg-dark-800 rounded-lg p-3">
          <div className="text-xs text-slate-500 mb-1">Last Score Update</div>
          <div className="text-xs font-medium text-slate-300 leading-snug">
            {managerData.last_score_at
              ? new Date(managerData.last_score_at).toLocaleTimeString()
              : '—'}
          </div>
        </div>
      </div>

      {/* Active settings summary */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        {(settings.reallocation_enabled ?? true) ? (
          <>
            <span className="flex items-center gap-1"><ArrowsRightLeftIcon className="h-3.5 w-3.5" />
              {(settings.reallocation_mode ?? 'to_stock') === 'to_stock'
                ? <>Reallocate {Math.round(settings.transfer_pct * 100)}% idle cash &rarr; bullish stocks</>
                : <>Free {Math.round(settings.transfer_pct * 100)}% idle cash &rarr; available funds</>}
            </span>
            <span className="flex items-center gap-1"><ClockIcon className="h-3.5 w-3.5" />Every {settings.transfer_interval_s}s</span>
          </>
        ) : (
          <span className="flex items-center gap-1 text-slate-600"><ArrowsRightLeftIcon className="h-3.5 w-3.5" />Reallocation off</span>
        )}
        <span className="flex items-center gap-1"><ChartBarIcon className="h-3.5 w-3.5" />Score refresh {settings.indicator_interval_s}s</span>
        <span className="flex items-center gap-1"><BanknotesIcon className="h-3.5 w-3.5" />
          {(settings.min_position_funds_mode ?? 'dollar') === 'percent'
            ? `Min ${settings.min_position_funds_pct ?? 1}% of total funds per position`
            : `Min ${fmtMoney(settings.min_position_funds)} per position`}
        </span>
        <span className={`flex items-center gap-1 ${settings.deploy_available_funds ? 'text-violet-400' : 'text-slate-600'}`}>
          <BanknotesIcon className="h-3.5 w-3.5" />
          {settings.deploy_available_funds
            ? `Deploying available funds → ${{ most_bearish: 'most bearish', most_bullish: 'most bullish', most_held: 'most held', least_held: 'least held', specific: settings.deploy_target_symbol || 'specific' }[settings.deploy_target] ?? settings.deploy_target}`
            : 'Available funds deployment off'}
        </span>
        <span className="flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          Risk exits: SL {Number(settings.stop_loss_pct ?? 0).toFixed(1)}% | TP {Number(settings.take_profit_pct ?? 0).toFixed(1)}%
        </span>
        <span className={`flex items-center gap-1 ${settings.hold_positions_overnight ? 'text-slate-600' : 'text-orange-400'}`}>
          <ClockIcon className="h-3.5 w-3.5" />
          {settings.hold_positions_overnight
            ? 'Hold positions overnight'
            : `Engine shutdown: ${settings.eod_engine_shutoff_minutes_before_sell ?? 120}min before sell | EOD liquidation: ${settings.eod_sell_window_minutes}min before close`}
        </span>
        <span className="flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          Sentiment window: last {settings.sentiment_data_points ?? 10} bars ({settings.sentiment_interval}, {settings.sentiment_lookback_days}d range)
        </span>
        {settings.ai_tag_strategy_enabled && (
          <span className="flex items-center gap-1 text-violet-400">
            <CpuChipIcon className="h-3.5 w-3.5" />
            AI tag routing active
            {' · '}{settings.ai_tag_action_mode === 'direct' ? 'direct' : 'strategy override'}
            {settings.ai_tag_allow_overnight ? ' · LONG/STRONG LONG exempt from EOD' : ''}
            {settings.ai_tag_action_mode !== 'direct' && settings.ai_tag_long_engine_off && ' · long hold mode'}
            {settings.ai_tag_long_tp_pct > 0 && ` TP ${settings.ai_tag_long_tp_pct}%`}
            {settings.ai_tag_long_sl_pct > 0 && ` SL ${settings.ai_tag_long_sl_pct}%`}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="bg-dark-800/70 border border-dark-600 rounded-lg p-3 space-y-1.5">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Market Sentiment Strategies</div>
          <div className="flex flex-wrap gap-1.5">
            {SENTIMENT_BUCKETS.map(sentiment => (
              <span key={`market-${sentiment}`} className="text-[11px] text-slate-400 bg-dark-700 px-2 py-0.5 rounded-md">
                {SENTIMENT_LABELS[sentiment]}: {stratDisplayName(marketSentimentStrategies[sentiment], scripts, templates)}
              </span>
            ))}
          </div>
        </div>
        <div className="bg-dark-800/70 border border-dark-600 rounded-lg p-3 space-y-1.5">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Symbol Sentiment Strategies</div>
          <div className="flex flex-wrap gap-1.5">
            {SENTIMENT_BUCKETS.map(sentiment => (
              <span key={`symbol-${sentiment}`} className="text-[11px] text-slate-400 bg-dark-700 px-2 py-0.5 rounded-md">
                {SENTIMENT_LABELS[sentiment]}: {stratDisplayName(symbolSentimentStrategies[sentiment], scripts, templates)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Sentiment strategy status */}
      {settings.sentiment_strategy_enabled && (
        <div className="bg-dark-800/70 border border-dark-600 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Sentiment Strategy Routing</div>
            {managerData.market_classification && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">Market:</span>
                <span
                  className="font-bold"
                  style={{ color: classColor(managerData.market_classification.classification) }}
                >
                  {SENTIMENT_LABELS[managerData.market_classification.bucket] ?? managerData.market_classification.bucket}
                </span>
                <span className="text-slate-600">({managerData.market_classification.score > 0 ? '+' : ''}{managerData.market_classification.score})</span>
              </div>
            )}
          </div>
          {/* Symbol group lists */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              {
                mode: 'manual',
                title: 'Manual',
                badge: 'bg-dark-700 text-slate-300 border-dark-500',
                hint: 'Dropped symbols use manual strategy selection.',
              },
              {
                mode: 'market',
                title: 'Market Sentiment',
                badge: 'bg-blue-900/20 text-blue-300 border-blue-800/30',
                hint: 'Uses overall market bucket routing.',
              },
              {
                mode: 'symbol',
                title: 'Symbol Sentiment',
                badge: 'bg-emerald-900/20 text-emerald-300 border-emerald-800/30',
                hint: 'Uses per-symbol sentiment routing.',
              },
            ].map(group => {
              const syms = routingGroups[group.mode] ?? []
              const isOver = dragOverMode === group.mode
              return (
                <div
                  key={group.mode}
                  className={`rounded-md border p-2 min-h-[66px] transition-colors ${
                    isOver ? 'border-violet-500 bg-violet-500/10' : 'border-dark-600 bg-dark-900/40'
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (!routingMut.isPending) setDragOverMode(group.mode)
                  }}
                  onDragLeave={() => setDragOverMode(prev => (prev === group.mode ? null : prev))}
                  onDrop={(e) => handleDrop(group.mode, e)}
                >
                  <div className="text-[11px] text-slate-500 mb-1 font-medium uppercase tracking-wide">{group.title}</div>
                  <div className="flex flex-wrap gap-1 min-h-[20px]">
                    {syms.length > 0 ? syms.map(sym => (
                      <span
                        key={`${group.mode}-${sym}`}
                        draggable={!routingMut.isPending}
                        onDragStart={(e) => handleDragStart(sym, group.mode, e)}
                        className={`text-[11px] font-mono font-bold border px-1.5 py-0.5 rounded cursor-grab active:cursor-grabbing ${group.badge}`}
                        title="Drag to another routing bucket"
                      >
                        {sym}
                      </span>
                    )) : (
                      <span className="text-[11px] text-slate-600">Empty</span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-600 mt-1">{group.hint}</p>
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-slate-600">Drag symbol tags between Manual, Market Sentiment, and Symbol Sentiment to update routing.</p>
        </div>
      )}

      {/* Symbol scores */}
      {symbolCount > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Stock Signals</span>
            {SENTIMENT_BUCKETS.map(bucket => {
              const count = sentimentCounts[bucket] ?? 0
              if (!count) return null
              return (
                <span key={bucket} className="text-xs font-medium" style={{ color: classColor(bucket) }}>
                  {count} {SENTIMENT_LABELS[bucket].toLowerCase()}
                </span>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(scores).map(([sym, sc]) => (
              <div
                key={sym}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-dark-800 border border-dark-600 ${
                  onSelectSymbol ? 'cursor-pointer hover:border-violet-600/60 hover:bg-dark-700 transition-colors' : ''
                }`}
                title={onSelectSymbol
                  ? `${sym} — Score: ${sc.score} · Click to view position detail`
                  : `Score: ${sc.score} — Updated: ${sc.updated_at ? new Date(sc.updated_at).toLocaleTimeString() : '?'}`}
                onClick={onSelectSymbol ? () => onSelectSymbol(sym) : undefined}
              >
                <span className="font-bold text-xs text-slate-200 font-mono">{sym}</span>
                <span className="text-xs font-semibold" style={{ color: classColor(sc.classification) }}>
                  {classLabel(sc.classification)}
                </span>
                <span className="text-xs text-slate-500">({sc.score > 0 ? '+' : ''}{sc.score})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Tags overview */}
      {settings.ai_tag_strategy_enabled && Object.keys(aiTags).length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">AI Tag Routing</span>
            {AI_TAG_BUCKETS.map(tag => {
              const count = Object.values(aiTags).filter(t => (t.learner_tag || '').toUpperCase() === tag).length
              if (!count) return null
              return (
                <span key={tag} className="text-xs font-medium" style={{ color: AI_TAG_COLORS[tag] }}>
                  {count} {AI_TAG_LABELS[tag].toLowerCase()}
                </span>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(aiTags).map(([sym, tagInfo]) => {
              const tag = (tagInfo.learner_tag || 'WATCH').toUpperCase()
              const color = AI_TAG_COLORS[tag] ?? NEUTRAL_COLOR
              const conf = tagInfo.learner_confidence != null ? Math.round(tagInfo.learner_confidence * 100) : null
              const isHolding = tagInfo.hold_mode === true
              return (
                <div
                  key={sym}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-dark-800 border transition-colors ${
                    isHolding ? 'border-violet-700/60' : 'border-dark-600'
                  } ${onSelectSymbol ? 'cursor-pointer hover:border-violet-600/60 hover:bg-dark-700' : ''}`}
                  title={`${sym} AI: ${tag}${conf != null ? ` (${conf}% confidence)` : ''}${isHolding ? ' · Engine paused (long hold)' : ''}`}
                  onClick={onSelectSymbol ? () => onSelectSymbol(sym) : undefined}
                >
                  <span className="font-bold text-xs text-slate-200 font-mono">{sym}</span>
                  <span className="text-xs font-semibold" style={{ color }}>
                    {tag === 'STRONG LONG' ? '▲▲' : tag === 'LONG' ? '▲' : tag === 'STRONG SHORT' ? '▼▼' : tag === 'SHORT' ? '▼' : '—'} {AI_TAG_LABELS[tag] ?? tag}
                  </span>
                  {conf != null && <span className="text-xs text-slate-500">{conf}%</span>}
                  {isHolding && <span className="text-[10px] text-violet-400 font-medium">HOLD</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Activity log */}
      {activity.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Recent Activity</div>
          <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
            {activity.map((a, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className="text-slate-600 shrink-0 font-mono">
                  {a.at ? new Date(a.at).toLocaleTimeString() : ''}
                </span>
                <span className="text-slate-400">{a.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inline settings */}
      {draft && (
        <div className="bg-dark-800/70 border border-dark-600 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CpuChipIcon className="h-4.5 w-4.5 text-violet-400" />
              <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">Manager Settings</h3>
            </div>
            <span className={`text-[11px] px-2 py-0.5 rounded-md border ${editSettings
              ? 'text-violet-300 bg-violet-900/30 border-violet-700/40'
              : 'text-slate-500 bg-dark-700 border-dark-600'}`}>
              {editSettings ? 'Editing enabled' : 'Read only'}
            </span>
          </div>

          <fieldset disabled={!editSettings || updateMut.isPending} className="space-y-5 disabled:opacity-70">

            <SettingRow
              label="Fund Reallocation"
              hint="Periodically move idle cash between positions or back to available funds."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${draft.reallocation_enabled ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => {
                    if (!editSettings) return
                    updateDraft(d => ({ ...d, reallocation_enabled: !d.reallocation_enabled }))
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.reallocation_enabled ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{draft.reallocation_enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingRow>

            <SettingRow
              label="Sentiment Lookback Period (days)"
              hint="Number of days of historical data used to calculate position sentiment scores (1-365 days)."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number" min={1} max={365} step={1}
                  value={draft.sentiment_lookback_days}
                  onChange={e => updateDraft(d => ({ ...d, sentiment_lookback_days: e.target.value }))}
                  className="input w-24 text-sm py-1.5"
                />
                <span className="text-xs text-slate-500">{draft.sentiment_lookback_days} day(s)</span>
              </div>
            </SettingRow>

            <SettingRow
              label="Sentiment Data Points"
              hint="Number of most recent bars used to determine sentiment (10-5000)."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number" min={10} max={5000} step={1}
                  value={draft.sentiment_data_points}
                  onChange={e => updateDraft(d => ({ ...d, sentiment_data_points: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
                <span className="text-xs text-slate-500">last {draft.sentiment_data_points} bars</span>
              </div>
            </SettingRow>

            <SettingRow
              label="Sentiment Data Interval"
              hint="Time interval for historical data used in sentiment calculation (e.g., 1-minute bars, 5-minute bars, daily, etc.)."
            >
              <select
                value={draft.sentiment_interval}
                onChange={e => updateDraft(d => ({ ...d, sentiment_interval: e.target.value }))}
                className="input text-sm py-1.5"
              >
                {ibConnected && <option value="5s">5 seconds (IB only)</option>}
                {!ibConnected && draft.sentiment_interval === '5s' && (
                  <option value="5s">5 seconds (requires IB connection)</option>
                )}
                <option value="1m">1 minute</option>
                <option value="5m">5 minutes</option>
                <option value="15m">15 minutes</option>
                <option value="30m">30 minutes</option>
                <option value="1h">1 hour</option>
                <option value="daily">Daily</option>
              </select>
            </SettingRow>

            {draft.reallocation_enabled && (
              <SettingRow
                label="Reallocation Mode"
                hint="Where idle cash is moved each cycle."
              >
                <div className="space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio" name="reallocation_mode" value="to_stock"
                      checked={draft.reallocation_mode === 'to_stock'}
                      onChange={() => updateDraft(d => ({ ...d, reallocation_mode: 'to_stock' }))}
                      className="mt-0.5 accent-violet-500"
                    />
                    <span>
                      <span className="text-xs font-medium text-slate-200">To Stock</span>
                      <span className="text-xs text-slate-500 ml-1">&mdash; Move idle cash from bearish positions to bullish ones</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio" name="reallocation_mode" value="to_available"
                      checked={draft.reallocation_mode === 'to_available'}
                      onChange={() => updateDraft(d => ({ ...d, reallocation_mode: 'to_available' }))}
                      className="mt-0.5 accent-violet-500"
                    />
                    <span>
                      <span className="text-xs font-medium text-slate-200">To Available Funds</span>
                      <span className="text-xs text-slate-500 ml-1">&mdash; Return idle cash from all positions to account available funds</span>
                    </span>
                  </label>
                </div>
              </SettingRow>
            )}

            {draft.reallocation_enabled && (
            <SettingRow
              label="Transfer Amount (%)"
              hint={draft.reallocation_mode === 'to_available'
                ? "Percentage of each position's idle cash returned to available funds per cycle."
                : "Percentage of bearish positions' idle cash moved per cycle."}
            >
              <div className="flex items-center gap-3">
                <input
                  type="range" min={1} max={100} step={1}
                  value={draft.transfer_pct}
                    onChange={e => updateDraft(d => ({ ...d, transfer_pct: Number(e.target.value) }))}
                  className="flex-1 accent-violet-500"
                />
                <span className="w-10 text-right text-sm font-bold text-slate-200">{draft.transfer_pct}%</span>
              </div>
            </SettingRow>
            )}

            {draft.reallocation_enabled && (
            <SettingRow
              label="Transfer Interval (seconds)"
              hint="How often funds are redistributed between positions."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number" min={30} step={30}
                  value={draft.transfer_interval_s}
                    onChange={e => updateDraft(d => ({ ...d, transfer_interval_s: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
                <span className="text-xs text-slate-500">
                  {draft.transfer_interval_s >= 3600
                    ? `${(draft.transfer_interval_s / 3600).toFixed(1)}h`
                    : draft.transfer_interval_s >= 60
                    ? `${Math.floor(draft.transfer_interval_s / 60)}m ${draft.transfer_interval_s % 60}s`
                    : `${draft.transfer_interval_s}s`}
                </span>
              </div>
            </SettingRow>
            )}

            {draft.reallocation_enabled && draft.reallocation_mode === 'to_stock' && (
            <SettingRow
              label="Indicator Refresh Interval (seconds)"
              hint="How often bullish/bearish scores are recalculated for each stock."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number" min={30} step={30}
                  value={draft.indicator_interval_s}
                    onChange={e => updateDraft(d => ({ ...d, indicator_interval_s: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
                <span className="text-xs text-slate-500">
                  {draft.indicator_interval_s >= 3600
                    ? `${(draft.indicator_interval_s / 3600).toFixed(1)}h`
                    : draft.indicator_interval_s >= 60
                    ? `${Math.floor(draft.indicator_interval_s / 60)}m ${draft.indicator_interval_s % 60}s`
                    : `${draft.indicator_interval_s}s`}
                </span>
              </div>
            </SettingRow>
            )}

            {draft.reallocation_enabled && (
            <SettingRow
              label="Minimum Funds Mode"
              hint="Choose whether minimum position funds use a fixed dollar amount or a percentage of total funds."
            >
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio" name="min_position_funds_mode" value="dollar"
                    checked={draft.min_position_funds_mode === 'dollar'}
                    onChange={() => updateDraft(d => ({ ...d, min_position_funds_mode: 'dollar' }))}
                    className="mt-0.5 accent-violet-500"
                  />
                  <span>
                    <span className="text-xs font-medium text-slate-200">Dollar Amount</span>
                    <span className="text-xs text-slate-500 ml-1">&mdash; Keep at least a fixed amount in each position</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio" name="min_position_funds_mode" value="percent"
                    checked={draft.min_position_funds_mode === 'percent'}
                    onChange={() => updateDraft(d => ({ ...d, min_position_funds_mode: 'percent' }))}
                    className="mt-0.5 accent-violet-500"
                  />
                  <span>
                    <span className="text-xs font-medium text-slate-200">Percent of Total Funds</span>
                    <span className="text-xs text-slate-500 ml-1">&mdash; Keep a proportional floor in each position</span>
                  </span>
                </label>
              </div>
            </SettingRow>
            )}

            {draft.reallocation_enabled && draft.min_position_funds_mode === 'dollar' && (
            <SettingRow
              label="Minimum Funds per Position ($)"
              hint="Each position always keeps at least this much cash allocated, even when bearish."
            >
              <div className="flex items-center gap-1">
                <span className="text-slate-400 text-sm">$</span>
                <input
                  type="number" min={0} step={50}
                  value={draft.min_position_funds}
                    onChange={e => updateDraft(d => ({ ...d, min_position_funds: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
              </div>
            </SettingRow>
            )}

            {draft.reallocation_enabled && draft.min_position_funds_mode === 'percent' && (
            <SettingRow
              label="Minimum Funds per Position (% of total funds)"
              hint="Each position keeps at least this percentage of total account funds before cash is reallocated."
            >
              <div className="flex items-center gap-1">
                <input
                  type="number" min={0} max={100} step={0.1}
                  value={draft.min_position_funds_pct}
                    onChange={e => updateDraft(d => ({ ...d, min_position_funds_pct: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
                <span className="text-slate-400 text-sm">%</span>
              </div>
            </SettingRow>
            )}

            <SettingRow
              label="Deploy Available Funds"
              hint="Automatically allocate unassigned account cash to a target position each cycle."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${draft.deploy_available_funds ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => {
                    if (!editSettings) return
                      updateDraft(d => ({ ...d, deploy_available_funds: !d.deploy_available_funds }))
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.deploy_available_funds ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{draft.deploy_available_funds ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingRow>

            <SettingRow
              label="Allow Buy Outside Allocation"
              hint="Permit sandbox buy orders even if allocated position funds are insufficient."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${draft.allow_buy_outside_allocation ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => {
                    if (!editSettings) return
                      updateDraft(d => ({ ...d, allow_buy_outside_allocation: !d.allow_buy_outside_allocation }))
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.allow_buy_outside_allocation ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{draft.allow_buy_outside_allocation ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingRow>

            <SettingRow
              label="Global Stop-Loss % (0 = off)"
              hint="Auto-sell when price drops this percent below average entry cost."
            >
              <div className="flex items-center gap-1">
                <input
                  type="number" min={0} max={100} step={0.1}
                  value={draft.stop_loss_pct}
                  onChange={e => updateDraft(d => ({ ...d, stop_loss_pct: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
                <span className="text-slate-400 text-sm">%</span>
              </div>
            </SettingRow>

            <SettingRow
              label="Global Take-Profit % (0 = off)"
              hint="Auto-sell when price rises this percent above average entry cost."
            >
              <div className="flex items-center gap-1">
                <input
                  type="number" min={0} max={1000} step={0.1}
                  value={draft.take_profit_pct}
                  onChange={e => updateDraft(d => ({ ...d, take_profit_pct: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
                <span className="text-slate-400 text-sm">%</span>
              </div>
            </SettingRow>

            {draft.deploy_available_funds && (
              <SettingRow
                label="Deploy Target"
                hint="Which position receives the available funds each cycle."
              >
                <div className="space-y-2">
                  {[
                    { value: 'most_bearish',  label: '▼ Most Bearish',  desc: 'Lowest composite signal score' },
                    { value: 'most_bullish',  label: '▲ Most Bullish',  desc: 'Highest composite signal score' },
                    { value: 'most_held',     label: '📈 Most Held',    desc: 'Position with highest market value' },
                    { value: 'least_held',    label: '📉 Least Held',   desc: 'Position with lowest market value' },
                    { value: 'specific',      label: '🎯 Specific Stock', desc: 'Always deploy to one symbol' },
                  ].map(opt => (
                    <label key={opt.value} className="flex items-start gap-2 cursor-pointer group">
                      <input
                        type="radio"
                        name="deploy_target"
                        value={opt.value}
                        checked={draft.deploy_target === opt.value}
                        onChange={() => updateDraft(d => ({ ...d, deploy_target: opt.value }))}
                        className="mt-0.5 accent-violet-500"
                      />
                      <span>
                        <span className="text-xs font-medium text-slate-200">{opt.label}</span>
                        <span className="text-xs text-slate-500 ml-1">— {opt.desc}</span>
                      </span>
                    </label>
                  ))}
                  {draft.deploy_target === 'specific' && (
                    <input
                      type="text"
                      placeholder="Symbol e.g. AAPL"
                      value={draft.deploy_target_symbol}
                        onChange={e => updateDraft(d => ({ ...d, deploy_target_symbol: e.target.value.toUpperCase() }))}
                      className="input w-36 text-sm py-1.5 mt-1 font-mono uppercase"
                    />
                  )}
                </div>
              </SettingRow>
            )}

            <SettingRow
              label="Sentiment Strategy Switching"
              hint="When enabled, the portfolio manager automatically updates the strategy for each symbol based on its assigned sentiment mode."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${draft.sentiment_strategy_enabled ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => {
                    if (!editSettings) return
                    updateDraft(d => ({ ...d, sentiment_strategy_enabled: !d.sentiment_strategy_enabled }))
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.sentiment_strategy_enabled ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{draft.sentiment_strategy_enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingRow>

            <SettingRow
              label="Market Sentiment Strategy"
              hint="Choose the default strategy to use under each overall market sentiment."
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SENTIMENT_BUCKETS.map(sentiment => {
                  const current = draft.market_sentiment_strategies[sentiment] ?? DEFAULT_SENTIMENT_STRATEGIES[sentiment]
                  const { type: currentType, scriptId: currentScriptId, templateFilename: currentTemplateFn } = parseStrategyValue(current)
                  return (
                    <div key={`market-row-${sentiment}`} className="bg-dark-900/60 border border-dark-600 rounded-md p-2 space-y-1">
                      <div className="text-xs text-slate-400">{SENTIMENT_LABELS[sentiment]}</div>
                      <select
                        className="input text-xs py-1.5"
                        value={currentType}
                        onChange={e => {
                          const newType = e.target.value
                          updateDraft(d => ({
                            ...d,
                            market_sentiment_strategies: {
                              ...d.market_sentiment_strategies,
                              [sentiment]: newType,
                            },
                          }))
                        }}
                      >
                        {strategyOptions.map(s => <option key={`market-${sentiment}-${s.type}`} value={s.type}>{s.type}</option>)}
                        <option value={CUSTOM_SCRIPT_KEY}>⚙ Custom Script</option>
                        <option value={TEMPLATE_SCRIPT_KEY}>📄 Template</option>
                      </select>
                      {currentType === CUSTOM_SCRIPT_KEY && (
                        <select
                          className="input text-xs py-1.5"
                          value={currentScriptId ?? ''}
                          onChange={e => {
                            const sid = e.target.value
                            updateDraft(d => ({
                              ...d,
                              market_sentiment_strategies: {
                                ...d.market_sentiment_strategies,
                                [sentiment]: sid ? `custom:${sid}` : CUSTOM_SCRIPT_KEY,
                              },
                            }))
                          }}
                        >
                          <option value="">— select script —</option>
                          {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      )}
                      {currentType === TEMPLATE_SCRIPT_KEY && (
                        <select
                          className="input text-xs py-1.5"
                          value={currentTemplateFn ?? ''}
                          onChange={e => {
                            const fn = e.target.value
                            updateDraft(d => ({
                              ...d,
                              market_sentiment_strategies: {
                                ...d.market_sentiment_strategies,
                                [sentiment]: fn ? `template:${fn}` : TEMPLATE_SCRIPT_KEY,
                              },
                            }))
                          }}
                        >
                          <option value="">— select template —</option>
                          {templates.map(t => <option key={t.filename} value={t.filename}>{t.name ?? t.filename}</option>)}
                        </select>
                      )}
                    </div>
                  )
                })}
              </div>
            </SettingRow>

            <SettingRow
              label="Symbol Sentiment Strategy"
              hint="Choose the default strategy to use under each individual symbol sentiment."
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {SENTIMENT_BUCKETS.map(sentiment => {
                  const current = draft.symbol_sentiment_strategies[sentiment] ?? DEFAULT_SENTIMENT_STRATEGIES[sentiment]
                  const { type: currentType, scriptId: currentScriptId, templateFilename: currentTemplateFn } = parseStrategyValue(current)
                  return (
                    <div key={`symbol-row-${sentiment}`} className="bg-dark-900/60 border border-dark-600 rounded-md p-2 space-y-1">
                      <div className="text-xs text-slate-400">{SENTIMENT_LABELS[sentiment]}</div>
                      <select
                        className="input text-xs py-1.5"
                        value={currentType}
                        onChange={e => {
                          const newType = e.target.value
                          updateDraft(d => ({
                            ...d,
                            symbol_sentiment_strategies: {
                              ...d.symbol_sentiment_strategies,
                              [sentiment]: newType,
                            },
                          }))
                        }}
                      >
                        {strategyOptions.map(s => <option key={`symbol-${sentiment}-${s.type}`} value={s.type}>{s.type}</option>)}
                        <option value={CUSTOM_SCRIPT_KEY}>⚙ Custom Script</option>
                        <option value={TEMPLATE_SCRIPT_KEY}>📄 Template</option>
                      </select>
                      {currentType === CUSTOM_SCRIPT_KEY && (
                        <select
                          className="input text-xs py-1.5"
                          value={currentScriptId ?? ''}
                          onChange={e => {
                            const sid = e.target.value
                            updateDraft(d => ({
                              ...d,
                              symbol_sentiment_strategies: {
                                ...d.symbol_sentiment_strategies,
                                [sentiment]: sid ? `custom:${sid}` : CUSTOM_SCRIPT_KEY,
                              },
                            }))
                          }}
                        >
                          <option value="">— select script —</option>
                          {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      )}
                      {currentType === TEMPLATE_SCRIPT_KEY && (
                        <select
                          className="input text-xs py-1.5"
                          value={currentTemplateFn ?? ''}
                          onChange={e => {
                            const fn = e.target.value
                            updateDraft(d => ({
                              ...d,
                              symbol_sentiment_strategies: {
                                ...d.symbol_sentiment_strategies,
                                [sentiment]: fn ? `template:${fn}` : TEMPLATE_SCRIPT_KEY,
                              },
                            }))
                          }}
                        >
                          <option value="">— select template —</option>
                          {templates.map(t => <option key={t.filename} value={t.filename}>{t.name ?? t.filename}</option>)}
                        </select>
                      )}
                    </div>
                  )
                })}
              </div>
            </SettingRow>

            <hr className="border-dark-600 my-4" />

            {/* ── AI Tag Strategy Routing ───────────────────────────────── */}
            <SettingRow
              label="AI Tag Strategy Switching"
              hint="When enabled, the portfolio manager automatically updates the strategy for each position based on its AI learner tag. WATCH tag always keeps the current default day-trading strategy unchanged."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${draft.ai_tag_strategy_enabled ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => {
                    if (!editSettings) return
                    updateDraft(d => ({ ...d, ai_tag_strategy_enabled: !d.ai_tag_strategy_enabled }))
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.ai_tag_strategy_enabled ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{draft.ai_tag_strategy_enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingRow>

            {draft.ai_tag_strategy_enabled && (
              <>
                {/* Mode toggle */}
                <SettingRow
                  label="Action Mode"
                  hint="Strategy Override: PM sets the strategy name per AI tag, the engine executes trades. Direct Actions: PM directly buys/sells LONG/STRONG LONG positions without the engine — bypasses engine shutoff windows."
                >
                  <div className="flex gap-0.5 p-0.5 bg-dark-900 rounded-lg">
                    {[
                      { value: 'strategy_override', label: 'Strategy Override' },
                      { value: 'direct', label: 'Direct Actions' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        disabled={!editSettings}
                        onClick={() => editSettings && updateDraft(d => ({ ...d, ai_tag_action_mode: opt.value }))}
                        className={`text-xs px-3 py-1.5 rounded-md transition-all ${
                          draft.ai_tag_action_mode === opt.value
                            ? 'bg-violet-600 text-white font-medium'
                            : 'text-slate-400 hover:text-slate-300 disabled:opacity-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </SettingRow>

                {/* Per-tag strategy selectors */}
                <SettingRow
                  label="AI Tag Strategies"
                  hint={draft.ai_tag_action_mode === 'direct'
                    ? 'In Direct Actions mode, LONG/STRONG LONG are managed by PM directly. Strategies below apply to NEUTRAL, SHORT, and STRONG SHORT.'
                    : 'Choose the strategy for each AI learner tag. Leave Neutral empty to keep the existing strategy. WATCH always uses the default engine (no override).'}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {AI_TAG_BUCKETS.map(tag => {
                      const isLong = tag === 'LONG' || tag === 'STRONG LONG'
                      const directManaged = draft.ai_tag_action_mode === 'direct' && isLong
                      const current = draft.ai_tag_strategies[tag] ?? DEFAULT_AI_TAG_STRATEGIES[tag] ?? ''
                      return (
                        <div key={`aitag-row-${tag}`} className={`border rounded-md p-2 space-y-1 ${directManaged ? 'bg-dark-900/30 border-dark-700 opacity-60' : 'bg-dark-900/60 border-dark-600'}`}>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-bold" style={{ color: AI_TAG_COLORS[tag] }}>{AI_TAG_LABELS[tag]}</span>
                            {directManaged && <span className="text-[10px] text-violet-400">PM direct</span>}
                          </div>
                          {directManaged ? (
                            <span className="text-[11px] text-slate-500 italic">Bought/sold directly by PM</span>
                          ) : (
                            <select
                              className="input text-xs py-1.5"
                              disabled={!editSettings}
                              value={current}
                              onChange={e => updateDraft(d => ({
                                ...d,
                                ai_tag_strategies: { ...d.ai_tag_strategies, [tag]: e.target.value },
                              }))}
                            >
                              <option value="">— no override —</option>
                              {strategyOptions.map(s => <option key={`aitag-${tag}-${s.type}`} value={s.type}>{s.type}</option>)}
                            </select>
                          )}
                        </div>
                      )
                    })}
                    <div className="bg-dark-900/40 border border-dark-700 rounded-md p-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[11px] font-bold text-slate-500">Watch</span>
                      </div>
                      <span className="text-[11px] text-slate-500 italic">Uses default day-trading engine — no override</span>
                    </div>
                  </div>
                </SettingRow>

                <SettingRow
                  label="Allow Overnight for Long Tags"
                  hint="When enabled, LONG/STRONG LONG positions are exempt from end-of-day liquidation. In Direct mode, the PM position simply stays open. In Strategy Override mode, the engine skips EOD sell for these positions."
                >
                  <label className="flex items-center gap-2 cursor-pointer">
                    <div
                      className={`relative w-9 h-5 rounded-full transition-colors ${draft.ai_tag_allow_overnight ? 'bg-violet-600' : 'bg-dark-600'}`}
                      onClick={() => {
                        if (!editSettings) return
                        updateDraft(d => ({ ...d, ai_tag_allow_overnight: !d.ai_tag_allow_overnight }))
                      }}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.ai_tag_allow_overnight ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-xs text-slate-300">{draft.ai_tag_allow_overnight ? 'Hold overnight for LONG/STRONG LONG' : 'EOD rules apply to all'}</span>
                  </label>
                </SettingRow>

                {/* Long TP/SL — always visible when AI tags enabled (used by both modes) */}
                <SettingRow
                  label="Long Take Profit %"
                  hint="Sell when price rises this % above avg cost. 0 = disabled. In Direct mode: PM sells directly. In Strategy Override + Long Hold mode: PM re-enables engine after selling."
                >
                  <div className="flex items-center gap-1">
                    <input
                      type="number" min={0} max={100} step={0.1}
                      disabled={!editSettings}
                      value={draft.ai_tag_long_tp_pct}
                      onChange={e => updateDraft(d => ({ ...d, ai_tag_long_tp_pct: e.target.value }))}
                      className="input w-28 text-sm py-1.5"
                    />
                    <span className="text-slate-400 text-sm">%{Number(draft.ai_tag_long_tp_pct) > 0 ? '' : ' (off)'}</span>
                  </div>
                </SettingRow>
                <SettingRow
                  label="Long Stop Loss %"
                  hint="Sell when price drops this % below avg cost. 0 = disabled."
                >
                  <div className="flex items-center gap-1">
                    <input
                      type="number" min={0} max={100} step={0.1}
                      disabled={!editSettings}
                      value={draft.ai_tag_long_sl_pct}
                      onChange={e => updateDraft(d => ({ ...d, ai_tag_long_sl_pct: e.target.value }))}
                      className="input w-28 text-sm py-1.5"
                    />
                    <span className="text-slate-400 text-sm">%{Number(draft.ai_tag_long_sl_pct) > 0 ? '' : ' (off)'}</span>
                  </div>
                </SettingRow>

                {/* Long Hold Mode — strategy_override only */}
                {draft.ai_tag_action_mode !== 'direct' && (
                  <SettingRow
                    label="Long Hold Mode"
                    hint="After a BUY fills for a LONG or STRONG LONG position, disable the strategy engine so the position is held without short-term signal interference. The engine re-enables when TP/SL is hit or the AI tag changes."
                  >
                    <label className="flex items-center gap-2 cursor-pointer">
                      <div
                        className={`relative w-9 h-5 rounded-full transition-colors ${draft.ai_tag_long_engine_off ? 'bg-violet-600' : 'bg-dark-600'}`}
                        onClick={() => {
                          if (!editSettings) return
                          updateDraft(d => ({ ...d, ai_tag_long_engine_off: !d.ai_tag_long_engine_off }))
                        }}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.ai_tag_long_engine_off ? 'translate-x-4' : ''}`} />
                      </div>
                      <span className="text-xs text-slate-300">{draft.ai_tag_long_engine_off ? 'Engine paused after buy (long hold)' : 'Engine runs normally for long tags'}</span>
                    </label>
                  </SettingRow>
                )}
              </>
            )}

            <hr className="border-dark-600 my-4" />

            <SettingRow
              label="Hold Positions Overnight"
              hint="When enabled, positions are held between days. When disabled, an end-of-day sell window forces liquidation."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${draft.hold_positions_overnight ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => {
                    if (!editSettings) return
                    updateDraft(d => ({ ...d, hold_positions_overnight: !d.hold_positions_overnight }))
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.hold_positions_overnight ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{draft.hold_positions_overnight ? 'Hold Overnight' : 'Liquidate at EOD'}</span>
              </label>
            </SettingRow>

            {!draft.hold_positions_overnight && (
              <SettingRow
                label="Pre-Sell Engine Shutoff (minutes)"
                hint="Duration before the final sell window where new engine BUY entries are blocked."
              >
                <div className="flex items-center gap-1">
                  <input
                    type="number" min={1} max={480} step={1}
                    value={draft.eod_engine_shutoff_minutes_before_sell}
                    onChange={e => updateDraft(d => ({ ...d, eod_engine_shutoff_minutes_before_sell: e.target.value }))}
                    className="input w-32 text-sm py-1.5"
                  />
                  <span className="text-slate-400 text-sm">minutes before final sell window</span>
                </div>
              </SettingRow>
            )}

            {!draft.hold_positions_overnight && (
              <SettingRow
                label="End-of-Day Sell Window (minutes)"
                hint="Duration in minutes before market close (16:00 ET) when positions are force-liquidated. The engine will only sell during this window, regardless of TP/SL."
              >
                <div className="flex items-center gap-1">
                  <input
                    type="number" min={1} max={240} step={1}
                    value={draft.eod_sell_window_minutes}
                    onChange={e => updateDraft(d => ({ ...d, eod_sell_window_minutes: e.target.value }))}
                    className="input w-32 text-sm py-1.5"
                  />
                  <span className="text-slate-400 text-sm">minutes before 16:00 ET</span>
                </div>
              </SettingRow>
            )}

          </fieldset>
        </div>
      )}
    </div>
  )
}
