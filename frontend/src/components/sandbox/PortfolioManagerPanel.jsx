import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CpuChipIcon, ArrowsRightLeftIcon, ClockIcon, BanknotesIcon,
  ChartBarIcon, CheckCircleIcon, XCircleIcon, ChevronDownIcon, ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import { getPortfolioManagerState, updatePortfolioManagerSettings, getPortfolioManagerActivityLog, getStrategies, getScripts, getBuiltinTemplates, updateSandboxPosition, getIBStatus, togglePortfolioManager, resetCrashShutdown, getAiBotStatus } from '../../api/client'
import { useAppSettings } from '../../hooks/useAppSettings'
import { CUSTOM_SCRIPT_KEY, TEMPLATE_SCRIPT_KEY } from './sandboxConstants'
import { fmtMoney } from './sandboxHelpers'

const STORAGE_KEY = 'portfolio_manager_savestates_v1'
const PRESETS_KEY = 'portfolio_manager_presets_v1'
const PRESET_DEFAULT_SELECTION_KEY = 'portfolio_manager_default_preset_v1'
const PROFILE_ORDER = ['simulated', 'paper', 'live']
const INTRADAY_1M_TEMPLATE = 'template:intraday_1m_regime_template.py'

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
  'STRONG LONG': INTRADAY_1M_TEMPLATE,
  'LONG': INTRADAY_1M_TEMPLATE,
  'NEUTRAL': '',
  'SHORT': INTRADAY_1M_TEMPLATE,
  'STRONG SHORT': INTRADAY_1M_TEMPLATE,
}
const DEFAULT_SENTIMENT_STRATEGIES = {
  crash: INTRADAY_1M_TEMPLATE,
  bearish: INTRADAY_1M_TEMPLATE,
  neutral: INTRADAY_1M_TEMPLATE,
  bullish: INTRADAY_1M_TEMPLATE,
  euphoric: INTRADAY_1M_TEMPLATE,
}
const DEFAULT_TREND_SENTIMENT_STRATEGIES = {
  crash: INTRADAY_1M_TEMPLATE,
  bearish: INTRADAY_1M_TEMPLATE,
  neutral: INTRADAY_1M_TEMPLATE,
  bullish: INTRADAY_1M_TEMPLATE,
  euphoric: INTRADAY_1M_TEMPLATE,
}
const DEFAULT_PM_PRESET_DEFS = [
  {
    key: 'default-intraday-1m-volume-first',
    name: '1m Intraday Volume-First (ORB/VWAP/VSA + Regime)',
    strategyMap: DEFAULT_SENTIMENT_STRATEGIES,
    overrides: {
      stop_loss_pct: 0.5,
      take_profit_pct: 1.25,
      hold_positions_overnight: false,
      sentiment_interval: '1m',
      sentiment_lookback_days: 5,
      sentiment_data_points: 120,
      sentiment_bucket_persistence: 3,
      eod_sell_window_minutes: 5,
      pending_price_drift_cancel_pct: 0.25,
      pending_cancel_after_bars: 3,
      ai_tag_strategy_enabled: true,
      ai_sentiment_change_enabled: true,
      ai_external_sentiment_weight: 0.35,
      auto_trade_buy_price_offset_pct: 0.01,
      auto_trade_sell_price_offset_pct: 0.01,
      sim_buy_fill_rate_pct: 80,
      sim_sell_fill_rate_pct: 90,
    },
  },
  {
    key: 'default-intraday-strict',
    name: 'Intraday Strict (SL 0.5 / TP 1.25 / No Overnight / EOD 5m)',
    strategyMap: DEFAULT_SENTIMENT_STRATEGIES,
    overrides: {
      stop_loss_pct: 0.5,
      take_profit_pct: 1.25,
      hold_positions_overnight: false,
      sentiment_bucket_persistence: 5,
      eod_sell_window_minutes: 5,
      pending_price_drift_cancel_pct: 0.25,
      pending_cancel_after_bars: 3,
      auto_trade_buy_price_offset_pct: 0.01,
      auto_trade_sell_price_offset_pct: 0.01,
      sim_buy_fill_rate_pct: 80,
      sim_sell_fill_rate_pct: 90,
    },
  },
  {
    key: 'default-trend-base',
    name: 'Trend Base - Robust (SL 1.0 / TP 3.0 / No Overnight / Debounce 3)',
    strategyMap: DEFAULT_TREND_SENTIMENT_STRATEGIES,
    overrides: {
      stop_loss_pct: 1.0,
      take_profit_pct: 3.0,
      hold_positions_overnight: false,
      sentiment_bucket_persistence: 3,
      sim_buy_fill_rate_pct: 80,
      sim_sell_fill_rate_pct: 90,
    },
  },
  {
    key: 'default-trend-swing',
    name: 'Trend Swing - Low Drawdown (SL 1.5 / TP 4.0 / Overnight / Debounce 5)',
    strategyMap: DEFAULT_TREND_SENTIMENT_STRATEGIES,
    overrides: {
      stop_loss_pct: 1.5,
      take_profit_pct: 4.0,
      hold_positions_overnight: true,
      sentiment_bucket_persistence: 5,
      sim_buy_fill_rate_pct: 80,
      sim_sell_fill_rate_pct: 90,
    },
  },
]

// 5×5 default matrix: rows = PM market sentiment, columns = AI learner tag
// Rationale:
//   Crash    — high volatility, oversold bounces & momentum shorts dominate
//   Bearish  — trend continuation with oscillator confirmation
//   Neutral  — range-bound; mean-reversion & volatility breakout
//   Bullish  — trend following; short pullbacks use oscillators
//   Euphoric — momentum peaks; fade overbought conditions for shorts
const DEFAULT_SENTIMENT_MATRIX = {
  crash: {
    'STRONG LONG': INTRADAY_1M_TEMPLATE,
    'LONG':        INTRADAY_1M_TEMPLATE,
    'NEUTRAL':     INTRADAY_1M_TEMPLATE,
    'SHORT':       INTRADAY_1M_TEMPLATE,
    'STRONG SHORT':INTRADAY_1M_TEMPLATE,
  },
  bearish: {
    'STRONG LONG': INTRADAY_1M_TEMPLATE,
    'LONG':        INTRADAY_1M_TEMPLATE,
    'NEUTRAL':     INTRADAY_1M_TEMPLATE,
    'SHORT':       INTRADAY_1M_TEMPLATE,
    'STRONG SHORT':INTRADAY_1M_TEMPLATE,
  },
  neutral: {
    'STRONG LONG': INTRADAY_1M_TEMPLATE,
    'LONG':        INTRADAY_1M_TEMPLATE,
    'NEUTRAL':     INTRADAY_1M_TEMPLATE,
    'SHORT':       INTRADAY_1M_TEMPLATE,
    'STRONG SHORT':INTRADAY_1M_TEMPLATE,
  },
  bullish: {
    'STRONG LONG': INTRADAY_1M_TEMPLATE,
    'LONG':        INTRADAY_1M_TEMPLATE,
    'NEUTRAL':     INTRADAY_1M_TEMPLATE,
    'SHORT':       INTRADAY_1M_TEMPLATE,
    'STRONG SHORT':INTRADAY_1M_TEMPLATE,
  },
  euphoric: {
    'STRONG LONG': INTRADAY_1M_TEMPLATE,
    'LONG':        INTRADAY_1M_TEMPLATE,
    'NEUTRAL':     INTRADAY_1M_TEMPLATE,
    'SHORT':       INTRADAY_1M_TEMPLATE,
    'STRONG SHORT':INTRADAY_1M_TEMPLATE,
  },
}
// Cell action options for the sentiment matrix
// trade         = normal signal-driven trading (default)
// hold          = buy & hold — enter once, exits on duration cap or tag change
// advanced_hold = buy & hold with a per-cell exit policy (variant suffix after `:`)
// engine_off    = pause engine entirely — no new entries allowed
// force_sell    = liquidate existing position immediately
// no_trade      = skip this cycle entirely
const CELL_ACTION_OPTIONS = [
  { value: 'trade',         label: '↺ Trade',         color: '#475569' },
  { value: 'hold',          label: '⚓ Buy & Hold',    color: '#7c3aed' },
  { value: 'advanced_hold', label: '🛡 Advanced Hold', color: '#9333ea' },
  { value: 'engine_off',    label: '⏸ Engine Off',    color: '#dc2626' },
  { value: 'force_sell',    label: '⚡ Force Sell',    color: '#f97316' },
  { value: 'no_trade',      label: '— Skip Cycle',     color: '#64748b' },
]
const CELL_ACTION_LABELS = Object.fromEntries(CELL_ACTION_OPTIONS.map(o => [o.value, o.label]))
const CELL_ACTION_COLORS = Object.fromEntries(CELL_ACTION_OPTIONS.map(o => [o.value, o.color]))

// Per-cell variant options for the Advanced Hold action.
// Stored as `advanced_hold:<variant>` in the matrix.
const ADVANCED_HOLD_POLICY_OPTIONS = [
  { value: 'extended',         label: '×N Extended Duration' },
  { value: 'until_tag_change', label: '∞ Until Tag Changes' },
  { value: 'trailing',         label: '↘ Trailing Stop' },
]
const DEFAULT_ADVANCED_HOLD_POLICY = 'extended'

// Split a stored cell action into (base, variant). For non-advanced actions, variant is ''.
function splitCellAction(raw) {
  if (typeof raw !== 'string' || !raw.includes(':')) return { base: raw || 'trade', variant: '' }
  const [base, variant] = raw.split(':', 2)
  return { base, variant: variant || '' }
}

const DEFAULT_SENTIMENT_MATRIX_ACTIONS = {
  crash: {
    'STRONG LONG': 'trade',
    'LONG':        'trade',
    'NEUTRAL':     'trade',
    'SHORT':       'engine_off',  // crash + AI short confirmed — pause engine
    'STRONG SHORT':'engine_off',  // strong conviction crash short — full stop
  },
  bearish: {
    'STRONG LONG': 'no_trade',
    'LONG':        'no_trade',
    'NEUTRAL':     'no_trade',
    'SHORT':       'engine_off',
    'STRONG SHORT':'engine_off',  // double bear conviction — pause engine
  },
  neutral: {
    'STRONG LONG': 'trade',
    'LONG':        'trade',
    'NEUTRAL':     'trade',
    'SHORT':       'trade',
    'STRONG SHORT':'trade',
  },
  bullish: {
    'STRONG LONG': 'hold',        // confirmed bull trend + AI long — buy & hold
    'LONG':        'trade',
    'NEUTRAL':     'trade',
    'SHORT':       'trade',
    'STRONG SHORT':'force_sell',  // bull market but AI flips strong short — exit now
  },
  euphoric: {
    'STRONG LONG': 'hold',        // peak momentum + AI long — hold the surge
    'LONG':        'hold',        // euphoric phase + long — ride it
    'NEUTRAL':     'trade',
    'SHORT':       'trade',
    'STRONG SHORT':'force_sell',  // euphoric peak + AI strong short — major reversal, exit
  },
}

const MIN_SENTIMENT_DATA_POINTS = 35

function buildDefaultSentimentMatrix(marketStrategies) {
  const matrix = {}
  SENTIMENT_BUCKETS.forEach(pm => {
    // Start from the curated 2D defaults
    matrix[pm] = { ...DEFAULT_SENTIMENT_MATRIX[pm] }
    // If an explicit per-row override is provided (i.e. differs from the flat default),
    // apply it uniformly across all AI tag columns to preserve backward compatibility.
    const override = marketStrategies?.[pm]
    if (override && override !== DEFAULT_SENTIMENT_STRATEGIES[pm]) {
      AI_TAG_BUCKETS.forEach(ai => { matrix[pm][ai] = override })
    }
  })
  return matrix
}

function buildDraftFromSettings(settings) {
  const stopLossPct = Number(settings.stop_loss_pct ?? 0.5)
  const takeProfitPct = Number(settings.take_profit_pct ?? 1.25)
  const stopLossValue = Number(settings.stop_loss_value ?? 0)
  const takeProfitValue = Number(settings.take_profit_value ?? 0)
  const crashProtectionMode = (settings.crash_protection_mode === 'dollar') ? 'dollar' : 'percent'
  const crashProtectionValue = Number(settings.crash_protection_value ?? 0)
  const pctRiskActive = stopLossPct > 0 || takeProfitPct > 0
  const valueRiskActive = stopLossValue > 0 || takeProfitValue > 0
  const aiLongTpPct = Number(settings.ai_tag_long_tp_pct ?? 0)
  const aiLongSlPct = Number(settings.ai_tag_long_sl_pct ?? 0)
  const aiLongTpValue = Number(settings.ai_tag_long_tp_value ?? 0)
  const aiLongSlValue = Number(settings.ai_tag_long_sl_value ?? 0)
  const aiLongPctActive = aiLongTpPct > 0 || aiLongSlPct > 0
  const aiLongValueActive = aiLongTpValue > 0 || aiLongSlValue > 0
  const pendingNearTpMode = (settings.pending_sell_tp_near_mode === 'dollar') ? 'dollar' : 'percent'

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
    sentiment_strategy_enabled: settings.sentiment_strategy_enabled ?? true,
    risk_exit_mode: valueRiskActive && !pctRiskActive ? 'value' : 'percent',
    stop_loss_pct: stopLossPct,
    take_profit_pct: takeProfitPct,
    stop_loss_sell_market_enabled: settings.stop_loss_sell_market_enabled ?? true,
    stop_loss_value: stopLossValue,
    take_profit_value: takeProfitValue,
    crash_protection_enabled: settings.crash_protection_enabled ?? false,
    crash_protection_mode: crashProtectionMode,
    crash_protection_value: crashProtectionValue,
    crash_auto_restart: settings.crash_auto_restart ?? false,
    pm_enabled: settings.enabled ?? false,
    default_strategy_name: settings.default_strategy_name ?? INTRADAY_1M_TEMPLATE,
    intraday_1m_template_params: {
      orb_bars: Number(settings.intraday_1m_template_params?.orb_bars ?? 5),
      cooldown_bars: Number(settings.intraday_1m_template_params?.cooldown_bars ?? 1),
      max_hold_bars: Number(settings.intraday_1m_template_params?.max_hold_bars ?? 20),
      atr_sl_mult: Number(settings.intraday_1m_template_params?.atr_sl_mult ?? 1.5),
      atr_tp_mult: Number(settings.intraday_1m_template_params?.atr_tp_mult ?? 2.0),
      numeric_sl_value: Number(settings.intraday_1m_template_params?.numeric_sl_value ?? 0),
      numeric_tp_value: Number(settings.intraday_1m_template_params?.numeric_tp_value ?? 0),
    },
    position_overrides: settings.position_overrides ?? {},
    hold_positions_overnight: settings.hold_positions_overnight ?? false,
    premarket_order_placement_enabled: settings.premarket_order_placement_enabled ?? false,
    eod_engine_shutoff_minutes_before_sell: settings.eod_engine_shutoff_minutes_before_sell ?? 120,
    eod_sell_window_minutes: settings.eod_sell_window_minutes ?? 5,
    sentiment_lookback_days: settings.sentiment_lookback_days ?? 5,
    sentiment_data_points: Math.max(MIN_SENTIMENT_DATA_POINTS, Number(settings.sentiment_data_points ?? MIN_SENTIMENT_DATA_POINTS)),
    sentiment_interval: settings.sentiment_interval ?? '1m',
    sentiment_bucket_persistence: Math.max(1, Math.min(20, Number(settings.sentiment_bucket_persistence ?? 3))),
    ai_tag_strategy_enabled: settings.ai_tag_strategy_enabled ?? true,
    ai_sentiment_change_enabled: settings.ai_sentiment_change_enabled ?? true,
    ai_tag_strategies: {
      ...DEFAULT_AI_TAG_STRATEGIES,
      ...(settings.ai_tag_strategies ?? {}),
    },
    ai_tag_allow_overnight: settings.ai_tag_allow_overnight ?? true,
    ai_external_sentiment_weight: Math.max(0, Math.min(1, Number(settings.ai_external_sentiment_weight ?? 0))),
    ai_tag_long_engine_off: settings.ai_tag_long_engine_off ?? true,
    ai_long_exit_mode: aiLongValueActive && !aiLongPctActive ? 'value' : 'percent',
    ai_tag_long_tp_pct: aiLongTpPct,
    ai_tag_long_sl_pct: aiLongSlPct,
    ai_tag_long_tp_value: aiLongTpValue,
    ai_tag_long_sl_value: aiLongSlValue,
    ai_tag_no_loss_sell: settings.ai_tag_no_loss_sell ?? true,
    pm_hold_duration_days: settings.pm_hold_duration_days ?? 1,
    pm_hold_duration_bars: settings.pm_hold_duration_bars ?? 20,
    pm_hold_extended_multiplier: settings.pm_hold_extended_multiplier ?? 2.0,
    pm_hold_trailing_pct: settings.pm_hold_trailing_pct ?? 3.0,
    pending_price_drift_cancel_pct: settings.pending_price_drift_cancel_pct ?? 0.25,
    pending_cancel_after_bars: settings.pending_cancel_after_bars ?? 3,
    paper_buy_mkt_after_bars: Math.max(0, Math.min(Number(settings.paper_buy_mkt_after_bars ?? 0), Number(settings.pending_cancel_after_bars ?? 3))),
    pending_sell_tp_near_mode: pendingNearTpMode,
    pending_sell_tp_near_pct: settings.pending_sell_tp_near_pct ?? 0.20,
    pending_sell_tp_near_value: settings.pending_sell_tp_near_value ?? 0.0,
    // Anti-churn bypass toggles (UI-only; controls whether bypass values are sent on save)
    pending_drift_cancel_enabled: settings.pending_drift_cancel_enabled ?? true,
    pending_cancel_after_bars_enabled: settings.pending_cancel_after_bars_enabled ?? true,
    eod_engine_shutoff_enabled: (settings.eod_engine_shutoff_minutes_before_sell ?? 120) > 0,
    sentiment_persistence_enabled: settings.sentiment_persistence_enabled ?? true,
    hold_duration_enabled: (settings.pm_hold_duration_bars ?? 20) > 0,
    // Bar predictor momentum gating
    bar_predictor_enabled: settings.bar_predictor_enabled ?? false,
    bar_predictor_buy_min_bias: settings.bar_predictor_buy_min_bias ?? 0.3,
    bar_predictor_sell_min_bias: settings.bar_predictor_sell_min_bias ?? 0.3,
    // AI trade bot
    ai_bot_enabled: settings.ai_bot_enabled ?? false,
    ai_bot_prompt: settings.ai_bot_prompt ?? 'Help me make money using the positions in watchlist.',
    ai_bot_provider: settings.ai_bot_provider ?? 'ollama',
    ai_bot_base_url: settings.ai_bot_base_url ?? '',
    ai_bot_model: settings.ai_bot_model ?? '',
    ai_bot_interval_s: settings.ai_bot_interval_s ?? 300,
    ai_bot_use_local_1m: settings.ai_bot_use_local_1m ?? true,
    ai_bot_use_news: settings.ai_bot_use_news ?? true,
    ai_bot_max_context_bars: settings.ai_bot_max_context_bars ?? 60,
    sim_buy_fill_rate_pct: settings.sim_buy_fill_rate_pct ?? 80,
    sim_sell_fill_rate_pct: settings.sim_sell_fill_rate_pct ?? 90,
    auto_trade_buy_price_offset_mode: settings.auto_trade_buy_price_offset_mode ?? 'percent',
    auto_trade_sell_price_offset_mode: settings.auto_trade_sell_price_offset_mode ?? 'percent',
    auto_trade_buy_price_offset_pct: settings.auto_trade_buy_price_offset_pct ?? 0.01,
    auto_trade_sell_price_offset_pct: settings.auto_trade_sell_price_offset_pct ?? 0.01,
    sentiment_matrix_strategies: (() => {
      const base = buildDefaultSentimentMatrix({
        ...DEFAULT_SENTIMENT_STRATEGIES,
        ...(settings.market_sentiment_strategies ?? {}),
      })
      if (settings.sentiment_matrix_strategies && typeof settings.sentiment_matrix_strategies === 'object') {
        SENTIMENT_BUCKETS.forEach(pm => {
          if (settings.sentiment_matrix_strategies[pm]) {
            base[pm] = { ...base[pm], ...settings.sentiment_matrix_strategies[pm] }
          }
        })
      }
      return base
    })(),
    sentiment_matrix_actions: (() => {
      const base = {}
      SENTIMENT_BUCKETS.forEach(pm => {
        base[pm] = { ...DEFAULT_SENTIMENT_MATRIX_ACTIONS[pm] }
        if (settings.sentiment_matrix_actions?.[pm]) {
          base[pm] = { ...base[pm], ...settings.sentiment_matrix_actions[pm] }
        }
      })
      return base
    })(),
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

function loadPresetStore() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') {
        // Backward compatibility: merge legacy per-profile preset buckets
        // into a single shared preset list.
        const merged = []
        const seen = new Set()
        PROFILE_ORDER.forEach(profile => {
          const entries = Array.isArray(parsed?.[profile]) ? parsed[profile] : []
          entries.forEach(entry => {
            if (!entry || typeof entry !== 'object') return
            const id = String(entry.id ?? '')
            if (!id || seen.has(id)) return
            seen.add(id)
            merged.push(entry)
          })
        })
        return merged
      }
    }
  } catch {}
  return []
}

function savePresetStore(store) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(store))
  } catch {}
}

function loadDefaultPresetSelection() {
  try {
    const raw = localStorage.getItem(PRESET_DEFAULT_SELECTION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
      if (parsed && typeof parsed === 'object') {
        // Backward compatibility: pick a legacy per-profile default.
        for (const profile of PROFILE_ORDER) {
          if (typeof parsed[profile] === 'string' && parsed[profile]) {
            return parsed[profile]
          }
        }
      }
    }
  } catch {}
  return ''
}

function saveDefaultPresetSelection(selection) {
  try {
    localStorage.setItem(PRESET_DEFAULT_SELECTION_KEY, JSON.stringify(selection))
  } catch {}
}

function createPresetId() {
  return `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function buildPresetDraft(baseSettings, strategyMap, overrides = {}) {
  const base = buildDraftFromSettings(baseSettings)
  return {
    ...base,
    ...overrides,
    sentiment_matrix_strategies: buildDefaultSentimentMatrix(strategyMap),
  }
}

function buildDefaultPresetEntries(baseSettings) {
  const now = new Date().toISOString()
  return DEFAULT_PM_PRESET_DEFS.map(def => ({
    id: def.key,
    name: def.name,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
    draft: buildPresetDraft(baseSettings, def.strategyMap, def.overrides),
  }))
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

function sanitizeSentimentMatrix(matrix) {
  const result = {}
  SENTIMENT_BUCKETS.forEach(pm => {
    result[pm] = {}
    AI_TAG_BUCKETS.forEach(ai => {
      const val = matrix?.[pm]?.[ai]
      result[pm][ai] = (val === CUSTOM_SCRIPT_KEY || val === TEMPLATE_SCRIPT_KEY)
        ? (DEFAULT_SENTIMENT_STRATEGIES[pm] ?? 'rsi')
        : (val ?? DEFAULT_SENTIMENT_STRATEGIES[pm] ?? 'rsi')
    })
  })
  return result
}

function buildImportDraft(baseSettings, imported) {
  const baseDraft = buildDraftFromSettings(baseSettings)
  const payload = imported?.settings && typeof imported.settings === 'object' ? imported.settings : imported
  if (!payload || typeof payload !== 'object') return baseDraft

  const candidate = { ...baseDraft, ...payload }

  // Support importing backend-shape payloads where transfer_pct is stored as 0-1.
  if (typeof payload.transfer_pct === 'number' && payload.transfer_pct <= 1) {
    candidate.transfer_pct = Math.round(payload.transfer_pct * 100)
  }

  candidate.ai_tag_strategies = {
    ...baseDraft.ai_tag_strategies,
    ...(payload.ai_tag_strategies ?? {}),
  }

  candidate.sentiment_matrix_strategies = (() => {
    const base = buildDefaultSentimentMatrix({
      ...DEFAULT_SENTIMENT_STRATEGIES,
      ...(payload.market_sentiment_strategies ?? {}),
    })
    if (payload.sentiment_matrix_strategies && typeof payload.sentiment_matrix_strategies === 'object') {
      SENTIMENT_BUCKETS.forEach(pm => {
        if (payload.sentiment_matrix_strategies[pm]) {
          base[pm] = { ...base[pm], ...payload.sentiment_matrix_strategies[pm] }
        }
      })
    }
    return base
  })()

  candidate.sentiment_matrix_actions = (() => {
    const base = {}
    SENTIMENT_BUCKETS.forEach(pm => {
      base[pm] = { ...DEFAULT_SENTIMENT_MATRIX_ACTIONS[pm] }
      if (payload.sentiment_matrix_actions?.[pm]) {
        base[pm] = { ...base[pm], ...payload.sentiment_matrix_actions[pm] }
      }
    })
    return base
  })()

  return candidate
}

function SentimentMatrixTable({ draft, updateDraft, editSettings, strategyOptions, scripts, templates, aiColumns = AI_TAG_BUCKETS, headerLabel = 'PM ↓ / AI →' }) {
  function updateCell(pm, ai, newVal) {
    updateDraft(d => ({
      ...d,
      sentiment_matrix_strategies: {
        ...d.sentiment_matrix_strategies,
        [pm]: { ...(d.sentiment_matrix_strategies?.[pm] ?? {}), [ai]: newVal },
      },
    }))
  }

  function updateActionCell(pm, ai, newAction) {
    updateDraft(d => ({
      ...d,
      sentiment_matrix_actions: {
        ...d.sentiment_matrix_actions,
        [pm]: { ...(d.sentiment_matrix_actions?.[pm] ?? {}), [ai]: newAction },
      },
    }))
  }

  return (
    <div className="overflow-x-auto rounded-md border border-dark-600">
      <table className="w-full table-fixed border-collapse text-[10px] leading-tight">
        <colgroup>
          <col className="w-[96px]" />
          {aiColumns.map(ai => (
            <col key={ai} className="w-[calc((100%-96px)/5)]" />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="px-2 py-1 text-left font-semibold text-slate-500 uppercase tracking-wide border-b border-r border-dark-600 bg-dark-800 whitespace-nowrap">
              {headerLabel}
            </th>
            {aiColumns.map(ai => (
              <th
                key={ai}
                className="px-1.5 py-1 text-center font-semibold border-b border-r border-dark-600 bg-dark-800 last:border-r-0 whitespace-nowrap"
                style={{ color: AI_TAG_COLORS[ai] }}
              >
                {AI_TAG_LABELS[ai]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SENTIMENT_BUCKETS.map((pm, pmIdx) => (
            <tr key={pm} className={pmIdx % 2 === 0 ? 'bg-dark-900/70' : 'bg-dark-800/40'}>
              <td
                className="px-2 py-1 font-semibold border-r border-b border-dark-600 whitespace-nowrap"
                style={{ color: classColor(pm) }}
              >
                {SENTIMENT_LABELS[pm]}
              </td>
              {aiColumns.map(ai => {
                const val = draft.sentiment_matrix_strategies?.[pm]?.[ai] ?? DEFAULT_SENTIMENT_MATRIX[pm]?.[ai] ?? DEFAULT_SENTIMENT_STRATEGIES[pm]
                const rawAction = draft.sentiment_matrix_actions?.[pm]?.[ai] ?? DEFAULT_SENTIMENT_MATRIX_ACTIONS[pm]?.[ai] ?? 'trade'
                const { base: actionBase, variant: actionVariant } = splitCellAction(rawAction)
                const { type: valType, scriptId, templateFilename } = parseStrategyValue(val)
                const actionOpt = CELL_ACTION_OPTIONS.find(o => o.value === actionBase) ?? CELL_ACTION_OPTIONS[0]
                return (
                  <td
                    key={ai}
                    className={`p-1 border-b border-r border-dark-600 align-top last:border-r-0 ${pmIdx === SENTIMENT_BUCKETS.length - 1 ? 'border-b-0' : ''}`}
                  >
                    <select
                      className="input text-[10px] py-0 px-1.5 h-6 w-full"
                      disabled={!editSettings}
                      value={valType}
                      onChange={e => updateCell(pm, ai, e.target.value)}
                    >
                      {strategyOptions.map(s => (
                        <option key={s.type} value={s.type}>{s.type}</option>
                      ))}
                      <option value={CUSTOM_SCRIPT_KEY}>⚙ Custom Script</option>
                      <option value={TEMPLATE_SCRIPT_KEY}>📄 Template</option>
                    </select>
                    {valType === CUSTOM_SCRIPT_KEY && (
                      <select
                        className="input text-[10px] py-0 px-1.5 h-6 w-full mt-0.5"
                        disabled={!editSettings}
                        value={scriptId ?? ''}
                        onChange={e => {
                          const sid = e.target.value
                          updateCell(pm, ai, sid ? `custom:${sid}` : CUSTOM_SCRIPT_KEY)
                        }}
                      >
                        <option value="">— select script —</option>
                        {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    )}
                    {valType === TEMPLATE_SCRIPT_KEY && (
                      <select
                        className="input text-[10px] py-0 px-1.5 h-6 w-full mt-0.5"
                        disabled={!editSettings}
                        value={templateFilename ?? ''}
                        onChange={e => {
                          const fn = e.target.value
                          updateCell(pm, ai, fn ? `template:${fn}` : TEMPLATE_SCRIPT_KEY)
                        }}
                      >
                        <option value="">— select template —</option>
                        {templates.map(t => <option key={t.filename} value={t.filename}>{t.name ?? t.filename}</option>)}
                      </select>
                    )}
                    <select
                      className="w-full mt-0.5 text-[10px] font-semibold rounded px-1.5 h-6 cursor-pointer border appearance-none"
                      style={{
                        backgroundColor: actionOpt.color + '22',
                        color: actionOpt.color,
                        borderColor: actionOpt.color + '55',
                      }}
                      disabled={!editSettings}
                      value={actionBase}
                      onChange={e => {
                        const newBase = e.target.value
                        const newVal = newBase === 'advanced_hold'
                          ? `advanced_hold:${actionVariant || DEFAULT_ADVANCED_HOLD_POLICY}`
                          : newBase
                        updateActionCell(pm, ai, newVal)
                      }}
                    >
                      {CELL_ACTION_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {actionBase === 'advanced_hold' && (
                      <select
                        className="w-full mt-0.5 text-[10px] rounded px-1.5 h-6 cursor-pointer border appearance-none"
                        style={{
                          backgroundColor: actionOpt.color + '11',
                          color: actionOpt.color,
                          borderColor: actionOpt.color + '44',
                        }}
                        disabled={!editSettings}
                        value={actionVariant || DEFAULT_ADVANCED_HOLD_POLICY}
                        onChange={e => updateActionCell(pm, ai, `advanced_hold:${e.target.value}`)}
                      >
                        {ADVANCED_HOLD_POLICY_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CollapsibleSection({ title, badge, children, isOpen, onToggle }) {
  return (
    <div className="border border-dark-600 rounded-lg overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onToggle()}
        className="w-full flex items-center justify-between px-3 py-2 bg-dark-800/60 hover:bg-dark-700/50 transition-colors text-left gap-2 cursor-pointer select-none"
      >
        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</span>
        <div className="flex items-center gap-2 shrink-0">
          {badge && <span className="text-[11px] text-slate-500">{badge}</span>}
          <ChevronDownIcon className={`h-3.5 w-3.5 text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </div>
      {isOpen && (
        <div className="px-3 py-3 space-y-4 bg-dark-900/30 border-t border-dark-600/50">
          {children}
        </div>
      )}
    </div>
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
  const importPresetInputRef = useRef(null)
  const activeProfile = normalizeProfile(profile)
  const [editSettings, setEditSettings] = useState(false)
  const [draft, setDraft] = useState(null)
  const [savedStates, setSavedStates] = useState(() => loadSavedStates())
  const [presetStore, setPresetStore] = useState(() => loadPresetStore())
  const [launchDefaultPresetId, setLaunchDefaultPresetId] = useState(() => loadDefaultPresetSelection())
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [routingGroups, setRoutingGroups] = useState({ manual: [], market: [], symbol: [] })
  const [dragPayload, setDragPayload] = useState(null)
  const [dragOverMode, setDragOverMode] = useState(null)
  const [sentimentError, setSentimentError] = useState(null)
  const [importNotice, setImportNotice] = useState(null)
  const [presetNotice, setPresetNotice] = useState(null)
  const [openSections, setOpenSections] = useState({ reallocation: false, sentiment: false, sentimentStrategy: false, aiTag: false, barPredictor: false, risk: false, pmValues: false, aiBot: false })
  const [pmTab, setPmTab] = useState('settings')
  const [pmLogPage, setPmLogPage] = useState(1)
  const [pmLogPageSize, setPmLogPageSize] = useState(100)
  const activePresets = Array.isArray(presetStore) ? presetStore : []
  const selectedPreset = activePresets.find(p => p.id === selectedPresetId) ?? null

  function toggleSection(key) {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }))
  }
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

  const { data: pmActivityData, isLoading: pmActivityLoading } = useQuery({
    queryKey: ['portfolio-manager-activity-log', pmLogPage, pmLogPageSize],
    queryFn: () => getPortfolioManagerActivityLog({ page: pmLogPage, pageSize: pmLogPageSize }),
    refetchInterval: appSettings.portfolio_positions_ms,
  })

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

  const { data: aiBotData } = useQuery({
    queryKey: ['ai-bot-status'],
    queryFn: getAiBotStatus,
    staleTime: 60_000,
    refetchInterval: 30_000,
  })
  const aiBotModels = aiBotData?.available_models ?? aiBotData?.models ?? []
  const aiBotStatus = aiBotData ?? {}
  const aiBotState = aiBotData?.state ?? managerData?.ai_bot ?? {}

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

  const togglePmMut = useMutation({
    mutationFn: togglePortfolioManager,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] }),
  })

  const resetCrashMut = useMutation({
    mutationFn: resetCrashShutdown,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] }),
  })

  useEffect(() => {
    if (isLoading || !managerData) return
    setSavedStates(prev => {
      const current = prev[activeProfile]
      if (current?.draft && current?.editSettings) {
        // Merge with fresh defaults so fields added after the state was saved are populated
        const freshDefaults = buildDraftFromSettings(managerData.settings)
        const mergedDraft = {
          ...freshDefaults,
          ...current.draft,
          ai_tag_strategies: { ...freshDefaults.ai_tag_strategies, ...(current.draft.ai_tag_strategies ?? {}) },
          sentiment_matrix_actions: (() => {
            const base = {}
            SENTIMENT_BUCKETS.forEach(pm => {
              base[pm] = { ...(freshDefaults.sentiment_matrix_actions?.[pm] ?? DEFAULT_SENTIMENT_MATRIX_ACTIONS[pm]) }
              if (current.draft.sentiment_matrix_actions?.[pm]) {
                base[pm] = { ...base[pm], ...current.draft.sentiment_matrix_actions[pm] }
              }
            })
            return base
          })(),
        }
        setDraft(mergedDraft)
        setEditSettings(!!current.editSettings)
        return prev
      }
      const nextDraft = buildDraftFromSettings(managerData.settings)
      const next = {
        ...prev,
        [activeProfile]: {
          draft: nextDraft,
          editSettings: false,
          updatedAt: new Date().toISOString(),
        },
      }
      saveSavedStates(next)
      setDraft(nextDraft)
      setEditSettings(false)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, managerData, isLoading])

  useEffect(() => {
    if (isLoading || !managerData) return
    setPresetStore(prev => {
      const current = Array.isArray(prev) ? prev : []
      const merged = [...current]
      const defaults = buildDefaultPresetEntries(managerData.settings)
      let changed = false
      for (const d of defaults) {
        if (!merged.some(p => p.id === d.id)) {
          merged.push(d)
          changed = true
        }
      }
      if (!changed) return prev
      const next = merged
      savePresetStore(next)
      return next
    })
  }, [managerData, isLoading])

  useEffect(() => {
    if (!activePresets.length) {
      if (selectedPresetId) setSelectedPresetId('')
      return
    }
    const hasLaunchDefault = launchDefaultPresetId && activePresets.some(p => p.id === launchDefaultPresetId)
    if (!hasLaunchDefault && activePresets.some(p => p.id === 'default-intraday-1m-volume-first')) {
      const nextSelection = 'default-intraday-1m-volume-first'
      setLaunchDefaultPresetId(nextSelection)
      saveDefaultPresetSelection(nextSelection)
    }
    const effectiveDefault = hasLaunchDefault
      ? launchDefaultPresetId
      : (activePresets.some(p => p.id === 'default-intraday-1m-volume-first')
        ? 'default-intraday-1m-volume-first'
        : activePresets[0].id)
    if (!selectedPresetId || !activePresets.some(p => p.id === selectedPresetId)) {
      setSelectedPresetId(effectiveDefault)
    }
  }, [activePresets, selectedPresetId, launchDefaultPresetId])

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
  const pmRows = pmActivityData?.items ?? []
  const aiLogLines = pmRows
    .filter(row => String(row?.msg || '').startsWith('AI bot:'))
    .map(row => {
      const t = row?.at ? new Date(row.at).toLocaleTimeString() : '--:--:--'
      return `[${t}] ${String(row?.msg || '').replace(/^AI bot:\s*/, '')}`
    })
  const aiDecisionText = Array.isArray(aiBotState?.last_decisions) && aiBotState.last_decisions.length
    ? aiBotState.last_decisions
      .map(d => {
        const symbol = String(d?.symbol || '').toUpperCase()
        const action = String(d?.action || 'hold').toLowerCase()
        const reason = String(d?.reason || '').trim()
        return reason ? `${symbol}: ${action} (${reason})` : `${symbol}: ${action}`
      })
      .join('\n')
    : 'No model decisions in current cycle.'

  function openEdit() {
    setPresetNotice(null)
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
    setImportNotice(null)
    setPresetNotice(null)
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
    const matrixIncomplete = SENTIMENT_BUCKETS.some(pm =>
      AI_TAG_BUCKETS.some(ai => {
        const v = draft.sentiment_matrix_strategies?.[pm]?.[ai]
        return v === CUSTOM_SCRIPT_KEY || v === TEMPLATE_SCRIPT_KEY
      })
    )
    if (matrixIncomplete) {
      setSentimentError('Select a specific script or template for every sentiment bucket before saving.')
      return
    }
    const riskExitMode = draft.risk_exit_mode === 'value' ? 'value' : 'percent'
    const stopLossPct = riskExitMode === 'percent' ? Number(draft.stop_loss_pct) : 0
    const takeProfitPct = riskExitMode === 'percent' ? Number(draft.take_profit_pct) : 0
    const stopLossValue = riskExitMode === 'value' ? Number(draft.stop_loss_value) : 0
    const takeProfitValue = riskExitMode === 'value' ? Number(draft.take_profit_value) : 0
    const aiLongExitMode = draft.ai_long_exit_mode === 'value' ? 'value' : 'percent'
    const aiLongTpPct = aiLongExitMode === 'percent' ? Number(draft.ai_tag_long_tp_pct) : 0
    const aiLongSlPct = aiLongExitMode === 'percent' ? Number(draft.ai_tag_long_sl_pct) : 0
    const aiLongTpValue = aiLongExitMode === 'value' ? Number(draft.ai_tag_long_tp_value) : 0
    const aiLongSlValue = aiLongExitMode === 'value' ? Number(draft.ai_tag_long_sl_value) : 0
    const nearTpMode = draft.pending_sell_tp_near_mode === 'dollar' ? 'dollar' : 'percent'

    setSentimentError(null)
    setImportNotice(null)
    setPresetNotice(null)
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
      sentiment_strategy_enabled: draft.sentiment_strategy_enabled,
      stop_loss_pct: stopLossPct,
      take_profit_pct: takeProfitPct,
      stop_loss_sell_market_enabled: draft.stop_loss_sell_market_enabled,
      stop_loss_value: stopLossValue,
      take_profit_value: takeProfitValue,
      crash_protection_enabled: !!draft.crash_protection_enabled,
      crash_protection_mode: (draft.crash_protection_mode === 'dollar' ? 'dollar' : 'percent'),
      crash_protection_value: Math.max(0, Number(draft.crash_protection_value ?? 0)),
      crash_auto_restart: !!draft.crash_auto_restart,
      enabled: !!draft.pm_enabled,
      hold_positions_overnight: draft.hold_positions_overnight,
      premarket_order_placement_enabled: draft.premarket_order_placement_enabled,
      eod_sell_window_minutes: Number(draft.eod_sell_window_minutes),
      sentiment_lookback_days: Number(draft.sentiment_lookback_days),
      sentiment_data_points: Number(draft.sentiment_data_points),
      sentiment_interval: draft.sentiment_interval,
      ai_tag_strategy_enabled: draft.ai_tag_strategy_enabled,
      ai_sentiment_change_enabled: draft.ai_sentiment_change_enabled,
      ai_tag_strategies: draft.ai_tag_strategies,
      ai_tag_allow_overnight: draft.ai_tag_allow_overnight,
      ai_external_sentiment_weight: Math.max(0, Math.min(1, Number(draft.ai_external_sentiment_weight ?? 0))),
      ai_tag_long_engine_off: draft.ai_tag_long_engine_off,
      ai_tag_long_tp_pct: aiLongTpPct,
      ai_tag_long_sl_pct: aiLongSlPct,
      ai_tag_long_tp_value: aiLongTpValue,
      ai_tag_long_sl_value: aiLongSlValue,
      ai_tag_no_loss_sell: draft.ai_tag_no_loss_sell,
      pm_hold_duration_days: Math.max(0, Math.floor(Number(draft.pm_hold_duration_days ?? 1) || 0)),
      pm_hold_extended_multiplier: Math.max(0, Number(draft.pm_hold_extended_multiplier ?? 2.0) || 0),
      pm_hold_trailing_pct: Math.max(0, Number(draft.pm_hold_trailing_pct ?? 3.0) || 0),
      // Anti-churn bypass: when toggle is OFF, send the bypass value to the backend
      pending_price_drift_cancel_pct: draft.pending_drift_cancel_enabled ? Number(draft.pending_price_drift_cancel_pct) : 100,
      pending_cancel_after_bars: draft.pending_cancel_after_bars_enabled ? Math.max(0, Math.floor(Number(draft.pending_cancel_after_bars ?? 3) || 3)) : 0,
      paper_buy_mkt_after_bars: (() => {
        const timeoutBars = draft.pending_cancel_after_bars_enabled
          ? Math.max(0, Math.floor(Number(draft.pending_cancel_after_bars ?? 3) || 3))
          : 0
        const fallbackBars = Math.max(0, Math.floor(Number(draft.paper_buy_mkt_after_bars ?? 0) || 0))
        return Math.min(fallbackBars, timeoutBars)
      })(),
      pending_sell_tp_near_mode: nearTpMode,
      pending_sell_tp_near_pct: nearTpMode === 'percent' ? Math.max(0, Number(draft.pending_sell_tp_near_pct ?? 0.20) || 0) : 0,
      pending_sell_tp_near_value: nearTpMode === 'dollar' ? Math.max(0, Number(draft.pending_sell_tp_near_value ?? 0.0) || 0) : 0,
      eod_engine_shutoff_minutes_before_sell: draft.eod_engine_shutoff_enabled ? Number(draft.eod_engine_shutoff_minutes_before_sell) : 0,
      sentiment_bucket_persistence: draft.sentiment_persistence_enabled ? Math.max(1, Math.min(20, Number(draft.sentiment_bucket_persistence ?? 3))) : 1,
      pm_hold_duration_bars: draft.hold_duration_enabled ? Math.max(0, Math.floor(Number(draft.pm_hold_duration_bars ?? 20) || 0)) : 0,
      bar_predictor_enabled: draft.bar_predictor_enabled,
      bar_predictor_buy_min_bias: Number(draft.bar_predictor_buy_min_bias ?? 0.3),
      bar_predictor_sell_min_bias: Number(draft.bar_predictor_sell_min_bias ?? 0.3),
      ai_bot_enabled: !!draft.ai_bot_enabled,
      ai_bot_prompt: (draft.ai_bot_prompt ?? '').trim() || 'Help me make money using the positions in watchlist.',
      ai_bot_provider: draft.ai_bot_provider === 'lm_studio' ? 'lm_studio' : 'ollama',
      ai_bot_base_url: (draft.ai_bot_base_url ?? '').trim(),
      ai_bot_model: (draft.ai_bot_model ?? '').trim(),
      ai_bot_interval_s: Math.max(30, Math.floor(Number(draft.ai_bot_interval_s ?? 300) || 300)),
      ai_bot_use_local_1m: !!draft.ai_bot_use_local_1m,
      ai_bot_use_news: !!draft.ai_bot_use_news,
      ai_bot_max_context_bars: Math.max(10, Math.min(500, Math.floor(Number(draft.ai_bot_max_context_bars ?? 60) || 60))),
      sim_buy_fill_rate_pct: Number(draft.sim_buy_fill_rate_pct),
      sim_sell_fill_rate_pct: Number(draft.sim_sell_fill_rate_pct),
      auto_trade_buy_price_offset_mode: (draft.auto_trade_buy_price_offset_mode === 'dollar' ? 'dollar' : 'percent'),
      auto_trade_sell_price_offset_mode: (draft.auto_trade_sell_price_offset_mode === 'dollar' ? 'dollar' : 'percent'),
      auto_trade_buy_price_offset_pct: Number(draft.auto_trade_buy_price_offset_pct),
      auto_trade_sell_price_offset_pct: Number(draft.auto_trade_sell_price_offset_pct),
      default_strategy_name: draft.default_strategy_name,
      intraday_1m_template_params: draft.intraday_1m_template_params ?? {},
      position_overrides: draft.position_overrides ?? {},
      sentiment_matrix_strategies: sanitizeSentimentMatrix(draft.sentiment_matrix_strategies),
      sentiment_matrix_actions: draft.sentiment_matrix_actions ?? {},
    })
  }

  function upsertPreset(entry, { select = true } = {}) {
    setPresetStore(prev => {
      const list = Array.isArray(prev) ? [...prev] : []
      const idx = list.findIndex(p => p.id === entry.id)
      if (idx >= 0) list[idx] = entry
      else list.push(entry)
      const next = list
      savePresetStore(next)
      return next
    })
    if (select) setSelectedPresetId(entry.id)
  }

  function handleApplyPreset() {
    if (!selectedPreset?.draft) return
    const appliedDraft = cloneJson(selectedPreset.draft)
    setSentimentError(null)
    setImportNotice(null)
    setPresetNotice(`Applied preset: ${selectedPreset.name}`)
    setEditSettings(true)
    setDraft(appliedDraft)
    setSavedStates(prev => {
      const next = {
        ...prev,
        [activeProfile]: {
          draft: appliedDraft,
          editSettings: true,
          updatedAt: new Date().toISOString(),
        },
      }
      saveSavedStates(next)
      return next
    })
  }

  function handleSavePreset() {
    if (!draft || !selectedPreset) return
    const now = new Date().toISOString()
    upsertPreset({
      ...selectedPreset,
      draft: cloneJson(draft),
      updatedAt: now,
    })
    setPresetNotice(`Updated preset: ${selectedPreset.name}`)
  }

  function handleSaveAsPreset() {
    if (!draft) return
    const suggested = selectedPreset ? `${selectedPreset.name} Copy` : 'New PM Preset'
    const name = window.prompt('Preset name', suggested)?.trim()
    if (!name) return
    const now = new Date().toISOString()
    const entry = {
      id: createPresetId(),
      name,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      draft: cloneJson(draft),
    }
    upsertPreset(entry)
    setPresetNotice(`Saved new preset: ${name}`)
  }

  function handleRenamePreset() {
    if (!selectedPreset) return
    const nextName = window.prompt('Rename preset', selectedPreset.name)?.trim()
    if (!nextName || nextName === selectedPreset.name) return
    upsertPreset({ ...selectedPreset, name: nextName, updatedAt: new Date().toISOString() })
    setPresetNotice(`Renamed preset to: ${nextName}`)
  }

  function handleExportPreset() {
    const exportPreset = selectedPreset ?? {
      id: 'unsaved-draft',
      name: `Draft ${activeProfile}`,
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      draft: draft ?? buildDraftFromSettings(settings),
    }
    const payload = {
      type: 'portfolio_manager_preset',
      version: 1,
      profile: activeProfile,
      exported_at: new Date().toISOString(),
      preset: exportPreset,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    const safeName = exportPreset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'preset'
    anchor.download = `pm-preset-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  function handleImportPresetClick() {
    importPresetInputRef.current?.click()
  }

  function handleSetLaunchDefaultPreset() {
    if (!selectedPreset) return
    const nextSelection = selectedPreset.id
    setLaunchDefaultPresetId(nextSelection)
    saveDefaultPresetSelection(nextSelection)
    setPresetNotice(`Launch default preset set: ${selectedPreset.name}`)
  }

  async function handleImportPreset(event) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      let importedName = `Imported ${activeProfile} preset`
      let importedDraft = null

      if (parsed?.type === 'portfolio_manager_preset' && parsed?.preset?.draft) {
        importedName = parsed.preset.name || importedName
        importedDraft = buildImportDraft(settings, { settings: parsed.preset.draft })
      } else if (parsed?.type === 'portfolio_manager_settings') {
        importedDraft = buildImportDraft(settings, parsed)
      } else if (parsed?.draft && typeof parsed.draft === 'object') {
        importedName = parsed.name || importedName
        importedDraft = buildImportDraft(settings, { settings: parsed.draft })
      } else {
        importedDraft = buildImportDraft(settings, parsed)
      }

      const now = new Date().toISOString()
      const entry = {
        id: createPresetId(),
        name: importedName,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
        draft: importedDraft,
      }
      upsertPreset(entry)
      setSentimentError(null)
      setImportNotice(null)
      setPresetNotice(`Imported preset from ${file.name}. Review and click Save to apply.`)
      const appliedDraft = cloneJson(importedDraft)
      setEditSettings(true)
      setDraft(appliedDraft)
      setSavedStates(prev => {
        const next = {
          ...prev,
          [activeProfile]: {
            draft: appliedDraft,
            editSettings: true,
            updatedAt: new Date().toISOString(),
          },
        }
        saveSavedStates(next)
        return next
      })
    } catch {
      setSentimentError('Unable to import preset file. Please select a valid JSON export.')
      setImportNotice(null)
      setPresetNotice(null)
    } finally {
      event.target.value = ''
    }
  }

  const strategyOptions = strategyData?.strategies ?? []

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
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CpuChipIcon className="h-4 w-4 text-violet-400" />
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Portfolio Manager</h2>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-dark-700 text-slate-400 border border-dark-600 uppercase tracking-wide">
              {activeProfile}
            </span>
            <button
              onClick={() => togglePmMut.mutate()}
              disabled={togglePmMut.isPending}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border transition-colors ${
                settings.enabled
                  ? 'bg-violet-900/30 text-violet-300 border-violet-700/40 hover:bg-violet-900/50'
                  : 'bg-dark-700 text-slate-400 border-dark-600 hover:bg-dark-600'
              }`}
              title={settings.enabled ? 'Click to disable PM' : 'Click to enable PM'}
            >
              {settings.enabled
                ? <><CheckCircleIcon className="h-3 w-3" />Active</>
                : <><XCircleIcon className="h-3 w-3" />Inactive</>}
            </button>
            {managerData?.crash_shutdown_active && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-rose-900/40 text-rose-300 border border-rose-700/60 animate-pulse">
                <ExclamationTriangleIcon className="h-3 w-3" />CRASH SHUTDOWN
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onShowOverview && (
              <button
                onClick={onShowOverview}
                className="text-xs text-slate-400 hover:text-emerald-300 border border-dark-500 hover:border-emerald-700/50 rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap"
                title="Back to Portfolio Summary"
              >
                ← Summary
              </button>
            )}
            <button
              onClick={editSettings ? doneEditing : openEdit}
              className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap"
            >
              {editSettings ? 'Done' : 'Edit'}
            </button>
            <button
              onClick={handleSave}
              disabled={!editSettings || !draft || updateMut.isPending}
              className="text-xs bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {updateMut.isPending ? 'Saving…' : 'Save'}
            </button>
            {managerData?.crash_shutdown_active && (
              <button
                onClick={() => resetCrashMut.mutate()}
                disabled={resetCrashMut.isPending}
                className="text-xs bg-rose-700 hover:bg-rose-600 text-white font-semibold rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                title="Clear crash shutdown and resume PM operations"
              >
                {resetCrashMut.isPending ? 'Resetting…' : '⚠ Reset Crash'}
              </button>
            )}
          </div>
        </div>

        {/* Crash Shutdown Banner */}
        {managerData?.crash_shutdown_active && (
          <div className="rounded-lg border border-rose-700/60 bg-rose-900/20 px-3 py-2 flex flex-wrap items-start gap-2">
            <ExclamationTriangleIcon className="h-4 w-4 text-rose-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 space-y-0.5">
              <p className="text-xs font-semibold text-rose-300">PM halted — crash protection triggered</p>
              {managerData.crash_trigger_reason && (
                <p className="text-[11px] text-rose-400/80 break-words">{managerData.crash_trigger_reason}</p>
              )}
              {managerData.crash_triggered_at && (
                <p className="text-[11px] text-rose-500/70">
                  Triggered at {new Date(managerData.crash_triggered_at).toLocaleTimeString()}
                  {settings.crash_auto_restart
                    ? ' · Will auto-restart next trading day'
                    : ' · All engines paused until manually reset or next session (auto-restart off)'}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider min-w-[56px]">Preset</span>
          <select
            value={selectedPresetId}
            onChange={e => {
              setSelectedPresetId(e.target.value)
              setPresetNotice(null)
            }}
            className="input text-xs py-1.5 flex-1 min-w-[420px]"
            title="Select a preset"
          >
            {activePresets.length === 0 && <option value="">No presets</option>}
            {activePresets.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}{(launchDefaultPresetId === p.id) ? ' (launch default)' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={handleApplyPreset}
            disabled={!selectedPreset}
            className="text-xs text-slate-300 hover:text-white border border-dark-500 hover:border-dark-300 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            title="Apply selected preset to current draft"
          >
            Apply
          </button>
          <button
            onClick={handleSavePreset}
            disabled={!draft || !selectedPreset}
            className="text-xs text-slate-300 hover:text-white border border-dark-500 hover:border-dark-300 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            title="Save current draft into selected preset"
          >
            Save
          </button>
          <button
            onClick={handleSaveAsPreset}
            disabled={!draft}
            className="text-xs text-slate-300 hover:text-white border border-dark-500 hover:border-dark-300 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            title="Save current draft as a new preset"
          >
            Save As
          </button>
          <button
            onClick={handleRenamePreset}
            disabled={!selectedPreset}
            className="text-xs text-slate-300 hover:text-white border border-dark-500 hover:border-dark-300 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            title="Rename selected preset"
          >
            Rename
          </button>
          <button
            onClick={handleSetLaunchDefaultPreset}
            disabled={!selectedPreset}
            className="text-xs text-amber-300 hover:text-amber-200 border border-amber-700/50 hover:border-amber-500/70 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            title="Set selected preset as the default loaded on launch"
          >
            Set Launch Default
          </button>
          <button
            onClick={handleExportPreset}
            disabled={!draft && !selectedPreset}
            className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            title="Export selected preset as JSON"
          >
            Export
          </button>
          <button
            onClick={handleImportPresetClick}
            className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors whitespace-nowrap"
            title="Import preset from JSON"
          >
            Import
          </button>
          <input
            ref={importPresetInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportPreset}
          />
        </div>

        <div className="inline-flex rounded-lg border border-dark-600 overflow-hidden">
          <button
            type="button"
            onClick={() => setPmTab('settings')}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${pmTab === 'settings' ? 'bg-violet-700 text-white' : 'bg-dark-800 text-slate-400 hover:text-slate-200'}`}
          >
            Settings
          </button>
          <button
            type="button"
            onClick={() => setPmTab('logs')}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors border-l border-dark-600 ${pmTab === 'logs' ? 'bg-violet-700 text-white' : 'bg-dark-800 text-slate-400 hover:text-slate-200'}`}
          >
            Activity Log
          </button>
        </div>
      </div>
      {sentimentError && (
        <p className="text-xs text-red-400 -mt-2">{sentimentError}</p>
      )}
      {!sentimentError && importNotice && (
        <p className="text-xs text-emerald-400 -mt-2">{importNotice}</p>
      )}
      {!sentimentError && !importNotice && presetNotice && (
        <p className="text-xs text-cyan-300 -mt-2">{presetNotice}</p>
      )}

      {pmTab === 'settings' && (
        <>
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
          {((Number(settings.stop_loss_value ?? 0) > 0) || (Number(settings.take_profit_value ?? 0) > 0))
            ? `Risk exits ($): SL $${Number(settings.stop_loss_value ?? 0).toFixed(2)} | TP $${Number(settings.take_profit_value ?? 0).toFixed(2)}`
            : `Risk exits (%): SL ${Number(settings.stop_loss_pct ?? 0).toFixed(1)}% | TP ${Number(settings.take_profit_pct ?? 0).toFixed(1)}%`}
        </span>
        <span className="flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          SL sell execution: {(settings.stop_loss_sell_market_enabled ?? true) ? 'Market (fast)' : 'Limit (auto-priced)'}
        </span>
        <span className={`flex items-center gap-1 ${managerData?.crash_shutdown_active ? 'text-rose-400 font-semibold' : (settings.crash_protection_enabled ?? false) ? 'text-rose-300' : 'text-slate-600'}`}>
          <ChartBarIcon className="h-3.5 w-3.5" />
          {managerData?.crash_shutdown_active
            ? '⚠ PM halted — crash shutdown active'
            : (settings.crash_protection_enabled ?? false)
              ? `Crash protection: daily loss limit ${settings.crash_protection_mode === 'dollar' ? '-$' : '-'}${Number(settings.crash_protection_value ?? 0).toFixed(2)}${settings.crash_protection_mode === 'dollar' ? '' : '% of account'}${settings.crash_auto_restart ? ' · auto-restart' : ' · manual restart'}`
              : 'Crash protection off'}
        </span>
        <span className="flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          Auto pricing: BUY {((settings.auto_trade_buy_price_offset_mode ?? 'percent') === 'dollar') ? '$+' : '+'}
          {Number(settings.auto_trade_buy_price_offset_pct ?? 0.01).toFixed(2)}
          {((settings.auto_trade_buy_price_offset_mode ?? 'percent') === 'dollar') ? '' : '%'}
          {' / '}
          SELL {((settings.auto_trade_sell_price_offset_mode ?? 'percent') === 'dollar') ? '$-' : '-'}
          {Number(settings.auto_trade_sell_price_offset_pct ?? 0.01).toFixed(2)}
          {((settings.auto_trade_sell_price_offset_mode ?? 'percent') === 'dollar') ? '' : '%'}
          {' (top-of-book touch)'}
        </span>
        <span className="flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          Pending cancel: drift {Number(settings.pending_price_drift_cancel_pct ?? 0.25).toFixed(2)}%
          {' · timeout '}
          {Math.max(1, Number(settings.pending_cancel_after_bars ?? 3))} bars
          {' · TP chase '}
          {(settings.pending_sell_tp_near_mode ?? 'percent') === 'dollar'
            ? `$${Number(settings.pending_sell_tp_near_value ?? 0.0).toFixed(2)}`
            : `${Number(settings.pending_sell_tp_near_pct ?? 0.20).toFixed(2)}%`}
        </span>
        <span className={`flex items-center gap-1 ${settings.hold_positions_overnight ? 'text-slate-600' : 'text-orange-400'}`}>
          <ClockIcon className="h-3.5 w-3.5" />
          {settings.hold_positions_overnight
            ? 'Hold positions overnight'
            : `Engine shutdown: ${settings.eod_engine_shutoff_minutes_before_sell ?? 120}min before sell | EOD liquidation: ${settings.eod_sell_window_minutes}min before close`}
        </span>
        <span className={`flex items-center gap-1 ${(settings.premarket_order_placement_enabled ?? false) ? 'text-emerald-400' : 'text-slate-600'}`}>
          <ClockIcon className="h-3.5 w-3.5" />
          {(settings.premarket_order_placement_enabled ?? false)
            ? 'Premarket IB order placement enabled'
            : 'Premarket IB order placement disabled'}
        </span>
        <span className="flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          Sentiment window: last {settings.sentiment_data_points ?? 10} bars ({settings.sentiment_interval}, {settings.sentiment_lookback_days}d range)
        </span>
        <span className="flex items-center gap-1">
          <ChartBarIcon className="h-3.5 w-3.5" />
          Sentiment debounce: {settings.sentiment_bucket_persistence ?? 3} bar confirmation
        </span>
        {settings.ai_sentiment_change_enabled === false ? (
          <span className="flex items-center gap-1 text-slate-600">
            <CpuChipIcon className="h-3.5 w-3.5" />
            AI sentiment changes disabled
          </span>
        ) : (
          <span className="flex items-center gap-1 text-violet-400">
            <CpuChipIcon className="h-3.5 w-3.5" />
            AI tag routing active
            {settings.ai_tag_allow_overnight ? ' · LONG/STRONG LONG exempt from EOD' : ''}
            {settings.ai_tag_long_tp_pct > 0 && ` TP ${settings.ai_tag_long_tp_pct}%`}
            {settings.ai_tag_long_sl_pct > 0 && ` SL ${settings.ai_tag_long_sl_pct}%`}
            {settings.ai_tag_no_loss_sell !== false ? ' · no-loss AI exits' : ''}
            {settings.pending_price_drift_cancel_pct != null && ` · drift cancel ${Number(settings.pending_price_drift_cancel_pct).toFixed(2)}%`}
          </span>
        )}
      </div>

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
                  ? `${sym} — Score: ${sc.score} · Raw: ${sc.raw_classification ?? sc.classification} · Debounced: ${sc.debounced_classification ?? sc.classification} · Click to view position detail`
                  : `Score: ${sc.score} — Raw: ${sc.raw_classification ?? sc.classification} — Debounced: ${sc.debounced_classification ?? sc.classification} — Updated: ${sc.updated_at ? new Date(sc.updated_at).toLocaleTimeString() : '?'}`}
                onClick={onSelectSymbol ? () => onSelectSymbol(sym) : undefined}
              >
                <span className="font-bold text-xs text-slate-200 font-mono">{sym}</span>
                <span className="text-xs font-semibold" style={{ color: classColor(sc.classification) }}>
                  {classLabel(sc.classification)}
                </span>
                <span className="text-xs text-slate-500">({sc.score > 0 ? '+' : ''}{sc.score})</span>
                {sc.raw_classification && sc.raw_classification !== sc.classification && (
                  <span className="text-[10px] text-amber-300/90 uppercase tracking-wide">
                    raw:{sc.raw_classification}
                  </span>
                )}
                {Number(sc.debounce_countdown ?? 0) > 0 && (
                  <span className="text-[10px] text-violet-300/90 uppercase tracking-wide">
                    flip in {sc.debounce_countdown}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Tags overview */}
      {settings.ai_sentiment_change_enabled !== false && Object.keys(aiTags).length > 0 && (
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

      {/* Current PM Values (Collapsed Read-Only) */}
      {draft && (
        <CollapsibleSection
          title="Current PM Values"
          badge="Read-only"
          isOpen={openSections.pmValues}
          onToggle={() => toggleSection('pmValues')}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {Number(settings.transfer_pct ?? 0.5) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Transfer %:</span>
                <span className="ml-2 font-mono text-slate-300">{Math.round((settings.transfer_pct ?? 0.5) * 100)}%</span>
              </div>
            )}
            <div className="bg-dark-700/50 rounded px-2 py-1.5">
              <span className="text-slate-500">Transfer interval:</span>
              <span className="ml-2 font-mono text-slate-300">{settings.transfer_interval_s ?? 300}s</span>
            </div>
            <div className="bg-dark-700/50 rounded px-2 py-1.5">
              <span className="text-slate-500">Score refresh:</span>
              <span className="ml-2 font-mono text-slate-300">{settings.indicator_interval_s ?? 120}s</span>
            </div>
            {Number(settings.min_position_funds ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Min position:</span>
                <span className="ml-2 font-mono text-slate-300">
                  {(settings.min_position_funds_mode ?? 'dollar') === 'percent'
                    ? `${settings.min_position_funds_pct ?? 1}%`
                    : `$${Number(settings.min_position_funds).toFixed(2)}`}
                </span>
              </div>
            )}
            {(settings.deploy_available_funds ?? false) && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Deploy to:</span>
                <span className="ml-2 font-mono text-violet-300">{settings.deploy_target ?? 'most_bearish'}</span>
              </div>
            )}
            {Number(settings.stop_loss_pct ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Stop loss:</span>
                <span className="ml-2 font-mono text-slate-300">{Number(settings.stop_loss_pct).toFixed(2)}%</span>
              </div>
            )}
            {Number(settings.take_profit_pct ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Take profit:</span>
                <span className="ml-2 font-mono text-slate-300">{Number(settings.take_profit_pct).toFixed(2)}%</span>
              </div>
            )}
            {Number(settings.eod_engine_shutoff_minutes_before_sell ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">EOD shutoff:</span>
                <span className="ml-2 font-mono text-slate-300">{settings.eod_engine_shutoff_minutes_before_sell}min</span>
              </div>
            )}
            {Number(settings.eod_sell_window_minutes ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">EOD sell window:</span>
                <span className="ml-2 font-mono text-slate-300">{settings.eod_sell_window_minutes}min</span>
              </div>
            )}
            {Number(settings.pending_cancel_after_bars ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Pending cancel:</span>
                <span className="ml-2 font-mono text-slate-300">{settings.pending_cancel_after_bars} bars</span>
              </div>
            )}
            <div className="bg-dark-700/50 rounded px-2 py-1.5">
              <span className="text-slate-500">Sentiment window:</span>
              <span className="ml-2 font-mono text-slate-300">{settings.sentiment_data_points ?? 10} bars</span>
            </div>
            <div className="bg-dark-700/50 rounded px-2 py-1.5">
              <span className="text-slate-500">Sentiment interval:</span>
              <span className="ml-2 font-mono text-slate-300">{settings.sentiment_interval ?? '1m'}</span>
            </div>
            <div className="bg-dark-700/50 rounded px-2 py-1.5">
              <span className="text-slate-500">Sentiment lookback:</span>
              <span className="ml-2 font-mono text-slate-300">{settings.sentiment_lookback_days ?? 5}d</span>
            </div>
            <div className="bg-dark-700/50 rounded px-2 py-1.5">
              <span className="text-slate-500">Sentiment debounce:</span>
              <span className="ml-2 font-mono text-slate-300">{settings.sentiment_bucket_persistence ?? 3} bars</span>
            </div>
            {Number(settings.sim_buy_fill_rate_pct ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Buy fill rate:</span>
                <span className="ml-2 font-mono text-slate-300">{Number(settings.sim_buy_fill_rate_pct).toFixed(0)}%</span>
              </div>
            )}
            {Number(settings.sim_sell_fill_rate_pct ?? 0) > 0 && (
              <div className="bg-dark-700/50 rounded px-2 py-1.5">
                <span className="text-slate-500">Sell fill rate:</span>
                <span className="ml-2 font-mono text-slate-300">{Number(settings.sim_sell_fill_rate_pct).toFixed(0)}%</span>
              </div>
            )}
          </div>
        </CollapsibleSection>
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

          <fieldset disabled={!editSettings || updateMut.isPending} className="space-y-3 disabled:opacity-70">
            {/* ── PM Master Enable/Disable ── */}
            <SettingRow
              label="Portfolio Manager"
              hint="Master on/off switch for the Portfolio Manager. When disabled, PM stops all rebalancing, sentiment routing, and IB signal processing."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${(draft.pm_enabled ?? false) ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => {
                    if (!editSettings) return
                    updateDraft(d => ({ ...d, pm_enabled: !(d.pm_enabled ?? false) }))
                  }}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${(draft.pm_enabled ?? false) ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{(draft.pm_enabled ?? false) ? 'Enabled' : 'Disabled'}</span>
              </label>
            </SettingRow>
            {/* ── AI Trade Bot ── */}
            <CollapsibleSection
              title="AI Trade Bot"
              badge={draft.ai_bot_enabled ? 'AI Bot active' : 'Sentiment matrix'}
              isOpen={openSections.aiBot}
              onToggle={() => toggleSection('aiBot')}
            >
              <SettingRow
                label="Trading Mode"
                hint="Toggle between the current Sentiment Matrix engine and the locally-run AI trade bot. When the AI bot is active, it owns all entries and exits (for both Simulated and IB modes); the sentiment matrix and per-symbol strategy engines are paused."
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => editSettings && updateDraft(d => ({ ...d, ai_bot_enabled: false }))}
                    className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${!draft.ai_bot_enabled
                      ? 'bg-violet-900/40 border-violet-600/50 text-violet-200'
                      : 'bg-dark-700 border-dark-600 text-slate-400 hover:text-slate-200'}`}
                  >
                    Sentiment Matrix
                  </button>
                  <button
                    type="button"
                    onClick={() => editSettings && updateDraft(d => ({ ...d, ai_bot_enabled: true }))}
                    className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${draft.ai_bot_enabled
                      ? 'bg-emerald-900/40 border-emerald-600/50 text-emerald-200'
                      : 'bg-dark-700 border-dark-600 text-slate-400 hover:text-slate-200'}`}
                  >
                    AI Bot
                  </button>
                </div>
              </SettingRow>

              {/* Live status */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                <div className="bg-dark-700/50 rounded px-2 py-1.5">
                  <span className="text-slate-500">Status:</span>
                  <span className={`ml-2 font-mono ${aiBotStatus?.status === 'healthy' ? 'text-emerald-400' : aiBotStatus?.status === 'unreachable' ? 'text-rose-400' : 'text-amber-300'}`}>
                    {aiBotStatus?.status || (aiBotState?.running ? 'running' : 'idle')}
                  </span>
                </div>
                <div className="bg-dark-700/50 rounded px-2 py-1.5">
                  <span className="text-slate-500">Provider:</span>
                  <span className="ml-2 font-mono text-slate-300">{aiBotStatus?.provider_label || (draft.ai_bot_provider === 'lm_studio' ? 'LM Studio' : 'Ollama')}</span>
                </div>
                <div className="bg-dark-700/50 rounded px-2 py-1.5">
                  <span className="text-slate-500">Model:</span>
                  <span className="ml-2 font-mono text-slate-300">{aiBotStatus?.resolved_model || aiBotState?.last_model || draft.ai_bot_model || 'auto'}</span>
                </div>
                <div className="bg-dark-700/50 rounded px-2 py-1.5">
                  <span className="text-slate-500">Session:</span>
                  <span className="ml-2 font-mono text-slate-300">{aiBotState?.session_day || '—'}</span>
                </div>
                <div className="bg-dark-700/50 rounded px-2 py-1.5">
                  <span className="text-slate-500">Last run:</span>
                  <span className="ml-2 font-mono text-slate-300">
                    {aiBotState?.last_run_at ? new Date(aiBotState.last_run_at).toLocaleTimeString() : '—'}
                  </span>
                </div>
                <div className="bg-dark-700/50 rounded px-2 py-1.5">
                  <span className="text-slate-500">Models:</span>
                  <span className="ml-2 font-mono text-slate-300">{aiBotState?.model_count ?? aiBotModels.length}</span>
                </div>
              </div>
              <div className="bg-dark-700/40 border border-dark-600 rounded px-2 py-1.5 text-[11px] text-slate-300">
                <span className="text-slate-500">Endpoint:</span>
                <span className="ml-2 font-mono break-all">{aiBotStatus?.endpoint || draft.ai_bot_base_url || (draft.ai_bot_provider === 'lm_studio' ? 'http://localhost:1234/v1' : 'http://localhost:11434')}</span>
              </div>
              {aiBotStatus?.message && (
                <div className={`flex items-start gap-2 text-[11px] rounded px-2 py-1.5 border ${aiBotStatus?.status === 'healthy'
                  ? 'text-emerald-200 bg-emerald-900/20 border-emerald-700/30'
                  : 'text-amber-300 bg-amber-900/20 border-amber-700/30'}`}>
                  <CpuChipIcon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{aiBotStatus.message}</span>
                </div>
              )}
              {aiBotState?.last_error && (
                <div className="flex items-start gap-2 text-[11px] text-amber-300 bg-amber-900/20 border border-amber-700/30 rounded px-2 py-1.5">
                  <ExclamationTriangleIcon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{aiBotState.last_error}</span>
                </div>
              )}

              <SettingRow
                label="Prompt"
                hint="Instruction sent to the model each cycle alongside the live watchlist, positions, 1-minute data and news. The bot still cannot override the hard guardrails below."
              >
                <textarea
                  className="input w-full text-xs font-mono min-h-[72px] resize-y"
                  disabled={!editSettings}
                  value={draft.ai_bot_prompt ?? ''}
                  placeholder="Help me make money using the positions in watchlist."
                  onChange={e => updateDraft(d => ({ ...d, ai_bot_prompt: e.target.value }))}
                />
              </SettingRow>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SettingRow label="Provider" hint="Choose which local model server the AI Bot will query. LM Studio uses its OpenAI-compatible local API and gives you richer model visibility in its own desktop app.">
                  <select
                    className="input text-xs w-full"
                    disabled={!editSettings}
                    value={draft.ai_bot_provider ?? 'ollama'}
                    onChange={e => updateDraft(d => ({ ...d, ai_bot_provider: e.target.value === 'lm_studio' ? 'lm_studio' : 'ollama' }))}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="lm_studio">LM Studio</option>
                  </select>
                </SettingRow>
                <SettingRow label="Model" hint="Leave on Auto to use the first model reported by the selected provider.">
                  <select
                    className="input text-xs w-full"
                    disabled={!editSettings}
                    value={draft.ai_bot_model ?? ''}
                    onChange={e => updateDraft(d => ({ ...d, ai_bot_model: e.target.value }))}
                  >
                    <option value="">Auto (first installed)</option>
                    {aiBotModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                    {draft.ai_bot_model && !aiBotModels.includes(draft.ai_bot_model) && (
                      <option value={draft.ai_bot_model}>{draft.ai_bot_model} (not reported)</option>
                    )}
                  </select>
                </SettingRow>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SettingRow label="Base URL" hint={draft.ai_bot_provider === 'lm_studio' ? 'Optional override. Default LM Studio endpoint is http://localhost:1234/v1.' : 'Optional override. Default Ollama endpoint is http://localhost:11434.'}>
                  <input
                    type="text"
                    className="input text-xs w-full font-mono"
                    disabled={!editSettings}
                    value={draft.ai_bot_base_url ?? ''}
                    placeholder={draft.ai_bot_provider === 'lm_studio' ? 'http://localhost:1234/v1' : 'http://localhost:11434'}
                    onChange={e => updateDraft(d => ({ ...d, ai_bot_base_url: e.target.value }))}
                  />
                </SettingRow>
                <SettingRow label="Think Interval (s)" hint="How often the bot consults the model (min 30s).">
                  <input
                    type="number" min={30} step={30}
                    className="input text-xs w-full"
                    disabled={!editSettings}
                    value={draft.ai_bot_interval_s ?? 300}
                    onChange={e => updateDraft(d => ({ ...d, ai_bot_interval_s: e.target.value }))}
                  />
                </SettingRow>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <SettingRow label="Local 1m Data" hint="Feed recent locally-cached 1-minute bars.">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <div
                      className={`relative w-9 h-5 rounded-full transition-colors ${(draft.ai_bot_use_local_1m ?? true) ? 'bg-emerald-600' : 'bg-dark-600'}`}
                      onClick={() => editSettings && updateDraft(d => ({ ...d, ai_bot_use_local_1m: !(d.ai_bot_use_local_1m ?? true) }))}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${(draft.ai_bot_use_local_1m ?? true) ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-xs text-slate-300">{(draft.ai_bot_use_local_1m ?? true) ? 'On' : 'Off'}</span>
                  </label>
                </SettingRow>
                <SettingRow label="Financial News" hint="Feed related internet financial news headlines.">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <div
                      className={`relative w-9 h-5 rounded-full transition-colors ${(draft.ai_bot_use_news ?? true) ? 'bg-emerald-600' : 'bg-dark-600'}`}
                      onClick={() => editSettings && updateDraft(d => ({ ...d, ai_bot_use_news: !(d.ai_bot_use_news ?? true) }))}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${(draft.ai_bot_use_news ?? true) ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-xs text-slate-300">{(draft.ai_bot_use_news ?? true) ? 'On' : 'Off'}</span>
                  </label>
                </SettingRow>
                <SettingRow label="Max Context Bars" hint="Cap of recent 1m bars per symbol (keeps context bounded).">
                  <input
                    type="number" min={10} max={500} step={10}
                    className="input text-xs w-full"
                    disabled={!editSettings}
                    value={draft.ai_bot_max_context_bars ?? 60}
                    onChange={e => updateDraft(d => ({ ...d, ai_bot_max_context_bars: e.target.value }))}
                  />
                </SettingRow>
              </div>

              <div className="flex items-start gap-2 text-[11px] text-slate-400 bg-dark-700/40 border border-dark-600 rounded px-2 py-2">
                <ExclamationTriangleIcon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-400" />
                <span>
                  Hard guardrails are always enforced regardless of the model's output:
                  <span className="text-slate-300"> end-of-day liquidation</span> (when overnight holding is off),
                  <span className="text-slate-300"> stop-loss / take-profit</span>, and
                  <span className="text-slate-300"> crash protection</span>. Configure them in the
                  <span className="text-slate-300"> Risk Controls</span> section. The bot resets its working
                  session every trading day. Works in both Simulated and IB modes.
                </span>
              </div>
            </CollapsibleSection>
            {/* ── Fund Reallocation & Deployment ── */}
            <CollapsibleSection
              title="Fund Reallocation & Deployment"
              badge={draft.reallocation_enabled ? 'Enabled' : 'Disabled'}
              isOpen={openSections.reallocation}
              onToggle={() => toggleSection('reallocation')}
            >
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
            </CollapsibleSection>

            {/* ── Sentiment Analysis ── */}
            <CollapsibleSection
              title="Sentiment Analysis"
              badge={`${draft.sentiment_lookback_days}d · ${draft.sentiment_data_points} bars · ${draft.sentiment_interval}`}
              isOpen={openSections.sentiment}
              onToggle={() => toggleSection('sentiment')}
            >
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
                hint="Number of most recent bars used to determine sentiment (35-5000)."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={MIN_SENTIMENT_DATA_POINTS} max={5000} step={1}
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
                  <option value="5s">
                    {ibConnected ? '5 seconds (IB only)' : '5 seconds (requires IB connection)'}
                  </option>
                  <option value="1m">1 minute</option>
                  <option value="5m">5 minutes</option>
                  <option value="15m">15 minutes</option>
                  <option value="30m">30 minutes</option>
                  <option value="1h">1 hour</option>
                  <option value="daily">Daily</option>
                </select>
              </SettingRow>

              <SettingRow
                label="Sentiment Debounce Persistence"
                hint="Bars required before a proposed sentiment bucket flip is applied. Higher values reduce strategy-switch churn."
              >
                <div className="flex items-center gap-3">
                  <button
                    title={draft.sentiment_persistence_enabled ? 'Anti-churn active – click to bypass (instant bucket changes)' : 'Bypassed – click to re-enable'}
                    onClick={() => editSettings && updateDraft(d => ({ ...d, sentiment_persistence_enabled: !d.sentiment_persistence_enabled }))}
                    className={`shrink-0 px-2 py-0.5 rounded text-xs font-semibold border transition-colors ${draft.sentiment_persistence_enabled ? 'bg-violet-700 text-white border-violet-500' : 'bg-dark-700 text-slate-500 border-dark-600 line-through'}`}
                  >{draft.sentiment_persistence_enabled ? 'ON' : 'OFF'}</button>
                  <div className={`flex items-center gap-2 transition-opacity ${draft.sentiment_persistence_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                    <input
                      type="number" min={1} max={20} step={1}
                      value={draft.sentiment_bucket_persistence}
                      onChange={e => updateDraft(d => ({ ...d, sentiment_bucket_persistence: e.target.value }))}
                      className="input w-24 text-sm py-1.5"
                    />
                    <span className="text-xs text-slate-500">{draft.sentiment_bucket_persistence} bar(s)</span>
                  </div>
                </div>
              </SettingRow>
            </CollapsibleSection>

            {/* ── Sentiment & AI Strategy Matrix ── */}
            <CollapsibleSection
              title="Sentiment & AI Strategy Matrix"
              badge={draft.sentiment_strategy_enabled ? 'Active' : 'Disabled'}
              isOpen={openSections.sentimentStrategy}
              onToggle={() => toggleSection('sentimentStrategy')}
            >
              <SettingRow
                label="Sentiment Strategy Switching"
                hint="When enabled, the portfolio manager automatically selects the strategy and action for each symbol based on its PM sentiment and AI tag combination."
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
                label="AI Sentiment Changes"
                hint="Master switch for AI-driven strategy and action changes. Disable to prevent AI sentiment from altering PM behaviour."
              >
                <label className="flex items-center gap-2 cursor-pointer">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${draft.ai_sentiment_change_enabled ? 'bg-violet-600' : 'bg-dark-600'}`}
                    onClick={() => {
                      if (!editSettings) return
                      updateDraft(d => ({ ...d, ai_sentiment_change_enabled: !d.ai_sentiment_change_enabled }))
                    }}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.ai_sentiment_change_enabled ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-xs text-slate-300">{draft.ai_sentiment_change_enabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              </SettingRow>

              <SettingRow
                label="External Sentiment Weight"
                hint="Blend external news/social sentiment (Yahoo, StockTwits, SEC) into the AI learner score. 0 = pure learner (price/technical only); 1 = ignore learner and follow external feed. Effective weight is scaled by the external signal's own confidence."
              >
                <div className="flex items-center gap-2 w-full">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={!editSettings}
                    value={Number(draft.ai_external_sentiment_weight ?? 0)}
                    onChange={e => updateDraft(d => ({ ...d, ai_external_sentiment_weight: Number(e.target.value) }))}
                    className="flex-1 accent-violet-500"
                  />
                  <input
                    type="number" min={0} max={1} step={0.05}
                    disabled={!editSettings}
                    value={Number(draft.ai_external_sentiment_weight ?? 0)}
                    onChange={e => updateDraft(d => ({ ...d, ai_external_sentiment_weight: Math.max(0, Math.min(1, Number(e.target.value) || 0)) }))}
                    className="input w-20 text-sm py-1.5"
                  />
                  <span className="text-xs text-slate-400 whitespace-nowrap">
                    {Number(draft.ai_external_sentiment_weight ?? 0) === 0 ? 'learner only' : `${Math.round(Number(draft.ai_external_sentiment_weight) * 100)}% ext`}
                  </span>
                </div>
              </SettingRow>

              <SettingRow
                label="Intraday 1m Template Tunables"
                hint="These parameters are injected into template:intraday_1m_regime_template.py for PM engine and sandbox backtests."
              >
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {[
                    ['orb_bars', 'ORB Bars'],
                    ['cooldown_bars', 'Cooldown Bars'],
                    ['max_hold_bars', 'Max Hold Bars'],
                    ['atr_sl_mult', 'ATR SL Mult'],
                    ['atr_tp_mult', 'ATR TP Mult'],
                    ['numeric_sl_value', 'Numeric SL $'],
                    ['numeric_tp_value', 'Numeric TP $'],
                  ].map(([key, label]) => (
                    <label key={key} className="flex items-center gap-1 text-xs text-slate-300">
                      <span className="w-28 text-slate-500">{label}</span>
                      <input
                        type="number"
                        step={key.includes('mult') ? 0.1 : 1}
                        min={0}
                        disabled={!editSettings}
                        className="input w-24 text-xs py-1"
                        value={draft.intraday_1m_template_params?.[key] ?? 0}
                        onChange={e => updateDraft(d => ({
                          ...d,
                          intraday_1m_template_params: {
                            ...(d.intraday_1m_template_params ?? {}),
                            [key]: Number(e.target.value),
                          },
                        }))}
                      />
                    </label>
                  ))}
                </div>
              </SettingRow>

              <>
                  <SettingRow
                    label="Allow Overnight for Long Tags"
                    hint="LONG/STRONG LONG positions are exempt from end-of-day liquidation. In Direct mode the PM position stays open; in Strategy Override mode the engine skips EOD sell for these positions."
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

                  <SettingRow
                    label="Long Hold Exits"
                    hint="Choose one mode; inactive fields are saved as 0."
                  >
                    <div className="flex items-center gap-3">
                      <div className="inline-flex rounded-md border border-dark-600 overflow-hidden shrink-0">
                        <button
                          type="button"
                          disabled={!editSettings}
                          onClick={() => editSettings && updateDraft(d => ({ ...d, ai_long_exit_mode: 'percent' }))}
                          className={`px-2.5 py-1 text-xs transition-colors ${
                            (draft.ai_long_exit_mode ?? 'percent') === 'percent'
                              ? 'bg-violet-600 text-white'
                              : 'bg-dark-700 text-slate-300 hover:bg-dark-600'
                          }`}
                        >
                          %
                        </button>
                        <button
                          type="button"
                          disabled={!editSettings}
                          onClick={() => editSettings && updateDraft(d => ({ ...d, ai_long_exit_mode: 'value' }))}
                          className={`px-2.5 py-1 text-xs transition-colors border-l border-dark-600 ${
                            (draft.ai_long_exit_mode ?? 'percent') === 'value'
                              ? 'bg-violet-600 text-white'
                              : 'bg-dark-700 text-slate-300 hover:bg-dark-600'
                          }`}
                        >
                          $
                        </button>
                      </div>

                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-400">SL</span>
                        {(draft.ai_long_exit_mode ?? 'percent') === 'value' && <span className="text-slate-400 text-sm">$</span>}
                        <input
                          type="number"
                          min={0}
                          max={(draft.ai_long_exit_mode ?? 'percent') === 'value' ? 10000 : 100}
                          step={(draft.ai_long_exit_mode ?? 'percent') === 'value' ? 0.01 : 0.1}
                          disabled={!editSettings}
                          value={(draft.ai_long_exit_mode ?? 'percent') === 'value' ? draft.ai_tag_long_sl_value : draft.ai_tag_long_sl_pct}
                          onChange={e => updateDraft(d => ({
                            ...d,
                            ...(d.ai_long_exit_mode ?? 'percent') === 'value'
                              ? { ai_tag_long_sl_value: e.target.value }
                              : { ai_tag_long_sl_pct: e.target.value },
                          }))}
                          className="input w-24 text-sm py-1.5"
                        />
                        {(draft.ai_long_exit_mode ?? 'percent') !== 'value' && <span className="text-slate-400 text-sm">%</span>}
                      </div>

                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-400">TP</span>
                        {(draft.ai_long_exit_mode ?? 'percent') === 'value' && <span className="text-slate-400 text-sm">$</span>}
                        <input
                          type="number"
                          min={0}
                          max={(draft.ai_long_exit_mode ?? 'percent') === 'value' ? 10000 : 100}
                          step={(draft.ai_long_exit_mode ?? 'percent') === 'value' ? 0.01 : 0.1}
                          disabled={!editSettings}
                          value={(draft.ai_long_exit_mode ?? 'percent') === 'value' ? draft.ai_tag_long_tp_value : draft.ai_tag_long_tp_pct}
                          onChange={e => updateDraft(d => ({
                            ...d,
                            ...(d.ai_long_exit_mode ?? 'percent') === 'value'
                              ? { ai_tag_long_tp_value: e.target.value }
                              : { ai_tag_long_tp_pct: e.target.value },
                          }))}
                          className="input w-24 text-sm py-1.5"
                        />
                        {(draft.ai_long_exit_mode ?? 'percent') !== 'value' && <span className="text-slate-400 text-sm">%</span>}
                      </div>
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="No-Loss AI Sell Guard"
                    hint="Block AI-driven sells that would realize a loss. The position is held and retried later."
                  >
                    <label className="flex items-center gap-2 cursor-pointer">
                      <div
                        className={`relative w-9 h-5 rounded-full transition-colors ${draft.ai_tag_no_loss_sell ? 'bg-violet-600' : 'bg-dark-600'}`}
                        onClick={() => {
                          if (!editSettings) return
                          updateDraft(d => ({ ...d, ai_tag_no_loss_sell: !d.ai_tag_no_loss_sell }))
                        }}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.ai_tag_no_loss_sell ? 'translate-x-4' : ''}`} />
                      </div>
                      <span className="text-xs text-slate-300">{draft.ai_tag_no_loss_sell ? 'Enabled (block loss-making AI exits)' : 'Disabled (allow AI exits at loss)'}</span>
                    </label>
                  </SettingRow>

                  <SettingRow
                    label="Pending Order Controls"
                    hint="Drift threshold and max bars before auto-cancel."
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Anti-churn toggle */}
                      <button
                        title={draft.pending_drift_cancel_enabled ? 'Anti-churn active – click to bypass (allow all fills)' : 'Bypassed – click to re-enable'}
                        onClick={() => editSettings && updateDraft(d => ({ ...d, pending_drift_cancel_enabled: !d.pending_drift_cancel_enabled }))}
                        className={`shrink-0 px-2 py-0.5 rounded text-xs font-semibold border transition-colors ${draft.pending_drift_cancel_enabled ? 'bg-violet-700 text-white border-violet-500' : 'bg-dark-700 text-slate-500 border-dark-600 line-through'}`}
                      >{draft.pending_drift_cancel_enabled ? 'ON' : 'OFF'}</button>
                      <div className={`flex items-center gap-4 flex-wrap transition-opacity ${draft.pending_drift_cancel_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-slate-400">Drift</span>
                          <input
                            type="number" min={0} max={100} step={0.05}
                            disabled={!editSettings}
                            value={draft.pending_price_drift_cancel_pct}
                            onChange={e => updateDraft(d => ({ ...d, pending_price_drift_cancel_pct: e.target.value }))}
                            className="input w-24 text-sm py-1.5"
                          />
                          <span className="text-slate-400 text-sm">%</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-slate-400">Timeout</span>
                          <input
                            type="number" min={0} max={120} step={1}
                            disabled={!editSettings}
                            value={draft.pending_cancel_after_bars}
                            onChange={e => updateDraft(d => {
                              const timeoutBars = Math.max(0, Math.floor(Number(e.target.value ?? 0) || 0))
                              const fallbackBars = Math.max(0, Math.floor(Number(d.paper_buy_mkt_after_bars ?? 0) || 0))
                              return {
                                ...d,
                                pending_cancel_after_bars: e.target.value,
                                paper_buy_mkt_after_bars: Math.min(fallbackBars, timeoutBars),
                              }
                            })}
                            className="input w-24 text-sm py-1.5"
                          />
                          <span className="text-slate-400 text-sm">bars</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-slate-400">Paper BUY→MKT</span>
                          <input
                            type="number" min={0} max={Math.max(0, Number(draft.pending_cancel_after_bars ?? 0) || 0)} step={1}
                            disabled={!editSettings}
                            value={draft.paper_buy_mkt_after_bars}
                            onChange={e => updateDraft(d => {
                              const timeoutBars = Math.max(0, Math.floor(Number(d.pending_cancel_after_bars ?? 0) || 0))
                              const next = Math.max(0, Math.floor(Number(e.target.value ?? 0) || 0))
                              return { ...d, paper_buy_mkt_after_bars: Math.min(next, timeoutBars) }
                            })}
                            className="input w-24 text-sm py-1.5"
                          />
                          <span className="text-slate-400 text-sm">bars</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">Near TP</span>
                          <div className="inline-flex rounded-md border border-dark-600 overflow-hidden shrink-0">
                            <button
                              type="button"
                              disabled={!editSettings}
                              onClick={() => editSettings && updateDraft(d => ({ ...d, pending_sell_tp_near_mode: 'percent' }))}
                              className={`px-2.5 py-1 text-xs transition-colors ${(draft.pending_sell_tp_near_mode ?? 'percent') === 'percent' ? 'bg-violet-600 text-white' : 'bg-dark-700 text-slate-300 hover:bg-dark-600'}`}
                            >
                              %
                            </button>
                            <button
                              type="button"
                              disabled={!editSettings}
                              onClick={() => editSettings && updateDraft(d => ({ ...d, pending_sell_tp_near_mode: 'dollar' }))}
                              className={`px-2.5 py-1 text-xs transition-colors border-l border-dark-600 ${(draft.pending_sell_tp_near_mode ?? 'percent') === 'dollar' ? 'bg-violet-600 text-white' : 'bg-dark-700 text-slate-300 hover:bg-dark-600'}`}
                            >
                              $
                            </button>
                          </div>
                          {(draft.pending_sell_tp_near_mode ?? 'percent') === 'dollar' && <span className="text-slate-400 text-sm">$</span>}
                          <input
                            type="number"
                            min={0}
                            max={(draft.pending_sell_tp_near_mode ?? 'percent') === 'dollar' ? 10000 : 100}
                            step={0.01}
                            disabled={!editSettings}
                            value={(draft.pending_sell_tp_near_mode ?? 'percent') === 'dollar' ? draft.pending_sell_tp_near_value : draft.pending_sell_tp_near_pct}
                            onChange={e => updateDraft(d => ({
                              ...d,
                              ...(d.pending_sell_tp_near_mode ?? 'percent') === 'dollar'
                                ? { pending_sell_tp_near_value: e.target.value }
                                : { pending_sell_tp_near_pct: e.target.value },
                            }))}
                            className="input w-24 text-sm py-1.5"
                          />
                          {(draft.pending_sell_tp_near_mode ?? 'percent') !== 'dollar' && <span className="text-slate-400 text-sm">%</span>}
                        </div>
                      </div>
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="Simulated Fill Rates"
                    hint="Per-bar fill probability while order stays in range."
                  >
                    <div className="flex items-center gap-4 flex-wrap">
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-400">BUY</span>
                        <input
                          type="number" min={0} max={100} step={1}
                          disabled={!editSettings}
                          value={draft.sim_buy_fill_rate_pct}
                          onChange={e => updateDraft(d => ({ ...d, sim_buy_fill_rate_pct: e.target.value }))}
                          className="input w-24 text-sm py-1.5"
                        />
                        <span className="text-slate-400 text-sm">%</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-400">SELL</span>
                        <input
                          type="number" min={0} max={100} step={1}
                          disabled={!editSettings}
                          value={draft.sim_sell_fill_rate_pct}
                          onChange={e => updateDraft(d => ({ ...d, sim_sell_fill_rate_pct: e.target.value }))}
                          className="input w-24 text-sm py-1.5"
                        />
                        <span className="text-slate-400 text-sm">%</span>
                      </div>
                    </div>
                  </SettingRow>

                  <SettingRow
                      label="Long Hold Mode"
                      hint="After a BUY fills for a LONG/STRONG LONG position, disable the strategy engine so the position is held. Re-enables when TP/SL is hit or the AI tag changes."
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

                  <SettingRow
                    label="Advanced Hold Controls"
                    hint="Bars, duration multiplier, and trailing stop."
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Anti-churn toggle for hold duration */}
                      <button
                        title={draft.hold_duration_enabled ? 'Anti-churn active – click to disable hold duration cap' : 'Hold duration bypassed – click to re-enable'}
                        onClick={() => editSettings && updateDraft(d => ({ ...d, hold_duration_enabled: !d.hold_duration_enabled }))}
                        className={`shrink-0 px-2 py-0.5 rounded text-xs font-semibold border transition-colors ${draft.hold_duration_enabled ? 'bg-violet-700 text-white border-violet-500' : 'bg-dark-700 text-slate-500 border-dark-600 line-through'}`}
                      >{draft.hold_duration_enabled ? 'ON' : 'OFF'}</button>
                      <div className={`flex items-center gap-1 transition-opacity ${draft.hold_duration_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                        <span className="text-xs text-slate-400">Bars</span>
                        <input
                          type="number" min={0} max={50000} step={1}
                          disabled={!editSettings}
                          value={draft.pm_hold_duration_bars ?? 20}
                          onChange={(e) => updateDraft(d => ({ ...d, pm_hold_duration_bars: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
                          className="w-20 px-2 py-1 bg-dark-900 border border-dark-700 rounded text-xs text-slate-200 focus:border-violet-500 focus:outline-none disabled:opacity-50"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-400">Extend</span>
                        <input
                          type="number" min={0} max={20} step={0.5}
                          disabled={!editSettings}
                          value={draft.pm_hold_extended_multiplier ?? 2.0}
                          onChange={(e) => updateDraft(d => ({ ...d, pm_hold_extended_multiplier: Math.max(0, Number(e.target.value) || 0) }))}
                          className="w-20 px-2 py-1 bg-dark-900 border border-dark-700 rounded text-xs text-slate-200 focus:border-violet-500 focus:outline-none disabled:opacity-50"
                        />
                        <span className="text-slate-400 text-xs">x</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-400">Trail</span>
                        <input
                          type="number" min={0} max={50} step={0.1}
                          disabled={!editSettings}
                          value={draft.pm_hold_trailing_pct ?? 3.0}
                          onChange={(e) => updateDraft(d => ({ ...d, pm_hold_trailing_pct: Math.max(0, Number(e.target.value) || 0) }))}
                          className="w-20 px-2 py-1 bg-dark-900 border border-dark-700 rounded text-xs text-slate-200 focus:border-violet-500 focus:outline-none disabled:opacity-50"
                        />
                        <span className="text-slate-400 text-xs">%</span>
                      </div>
                    </div>
                  </SettingRow>
              </>

              {(draft.sentiment_strategy_enabled && draft.ai_sentiment_change_enabled) && (
                <SettingRow
                  label="Strategy & Action Matrix (5×5)"
                  hint="Shown only when both Sentiment Strategy Switching and AI Sentiment Changes are enabled."
                >
                  <SentimentMatrixTable
                    draft={draft}
                    updateDraft={updateDraft}
                    editSettings={editSettings}
                    strategyOptions={strategyOptions}
                    scripts={scripts}
                    templates={templates}
                  />
                </SettingRow>
              )}

              {(draft.sentiment_strategy_enabled && !draft.ai_sentiment_change_enabled) && (
                <SettingRow
                  label="Sentiment Strategy Row (5 cells)"
                  hint="AI sentiment is off, so each PM sentiment bucket uses one strategy/action cell (AI NEUTRAL column)."
                >
                  <SentimentMatrixTable
                    draft={draft}
                    updateDraft={updateDraft}
                    editSettings={editSettings}
                    strategyOptions={strategyOptions}
                    scripts={scripts}
                    templates={templates}
                    aiColumns={['NEUTRAL']}
                    headerLabel="PM ↓ / Strategy"
                  />
                </SettingRow>
              )}

              {!draft.sentiment_strategy_enabled && (
                <>
                  <SettingRow
                    label="Default Strategy"
                    hint="Sentiment strategy switching is off. PM falls back to this strategy unless a symbol override is provided below."
                  >
                    <select
                      className="input text-sm py-1.5"
                      disabled={!editSettings}
                      value={draft.default_strategy_name ?? INTRADAY_1M_TEMPLATE}
                      onChange={e => updateDraft(d => ({ ...d, default_strategy_name: e.target.value }))}
                    >
                      {strategyOptions.map(s => (
                        <option key={s.type} value={s.type}>{s.type}</option>
                      ))}
                      {templates.map(t => (
                        <option key={t.filename} value={`template:${t.filename}`}>📄 {t.name ?? t.filename}</option>
                      ))}
                    </select>
                  </SettingRow>

                  <SettingRow
                    label="Per-Position Overrides"
                    hint="Override strategy / TP / SL / hold bars for individual symbols."
                  >
                    <div className="overflow-x-auto rounded-md border border-dark-600">
                      <table className="w-full text-xs">
                        <thead className="bg-dark-800 text-slate-400">
                          <tr>
                            <th className="text-left px-2 py-1">Symbol</th>
                            <th className="text-left px-2 py-1">Strategy</th>
                            <th className="text-left px-2 py-1">SL %</th>
                            <th className="text-left px-2 py-1">TP %</th>
                            <th className="text-left px-2 py-1">SL $</th>
                            <th className="text-left px-2 py-1">TP $</th>
                            <th className="text-left px-2 py-1">Hold Bars</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.keys(scores).sort().map(sym => {
                            const ov = draft.position_overrides?.[sym] ?? {}
                            return (
                              <tr key={sym} className="border-t border-dark-700">
                                <td className="px-2 py-1 font-mono text-slate-200">{sym}</td>
                                <td className="px-2 py-1">
                                  <select
                                    className="input text-xs py-1"
                                    disabled={!editSettings}
                                    value={ov.strategy_name ?? ''}
                                    onChange={e => updateDraft(d => ({
                                      ...d,
                                      position_overrides: {
                                        ...(d.position_overrides ?? {}),
                                        [sym]: { ...(d.position_overrides?.[sym] ?? {}), strategy_name: e.target.value },
                                      },
                                    }))}
                                  >
                                    <option value="">(use default)</option>
                                    {strategyOptions.map(s => (
                                      <option key={s.type} value={s.type}>{s.type}</option>
                                    ))}
                                    {templates.map(t => (
                                      <option key={t.filename} value={`template:${t.filename}`}>{t.name ?? t.filename}</option>
                                    ))}
                                  </select>
                                </td>
                                {['stop_loss_pct', 'take_profit_pct', 'stop_loss_value', 'take_profit_value', 'hold_duration_bars'].map(k => (
                                  <td key={k} className="px-2 py-1">
                                    <input
                                      type="number"
                                      className="input text-xs py-1 w-20"
                                      disabled={!editSettings}
                                      value={ov[k] ?? ''}
                                      onChange={e => updateDraft(d => ({
                                        ...d,
                                        position_overrides: {
                                          ...(d.position_overrides ?? {}),
                                          [sym]: { ...(d.position_overrides?.[sym] ?? {}), [k]: e.target.value === '' ? 0 : Number(e.target.value) },
                                        },
                                      }))}
                                    />
                                  </td>
                                ))}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </SettingRow>
                </>
              )}
            </CollapsibleSection>

            {/* ── Bar Predictor Momentum Gate ── */}
            <CollapsibleSection
              title="Bar Predictor"
              badge={draft.bar_predictor_enabled ? `Buy≥+${Number(draft.bar_predictor_buy_min_bias ?? 0.3).toFixed(2)} · Sell≤-${Number(draft.bar_predictor_sell_min_bias ?? 0.3).toFixed(2)}` : 'Disabled'}
              isOpen={openSections.barPredictor}
              onToggle={() => toggleSection('barPredictor')}
            >
              <SettingRow label="Enable Bar Predictor" hint="Gate new BUY signals through a momentum bias computed from Heikin-Ashi, MACD and slope (ports the NextBarPredictor algorithm). Disabled = no gating.">
                <label className="flex items-center gap-2 cursor-pointer">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${draft.bar_predictor_enabled ? 'bg-violet-600' : 'bg-dark-600'}`}
                    onClick={() => { if (!editSettings) return; updateDraft(d => ({ ...d, bar_predictor_enabled: !d.bar_predictor_enabled })) }}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.bar_predictor_enabled ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-xs text-slate-300">{draft.bar_predictor_enabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              </SettingRow>
              {draft.bar_predictor_enabled && (
                <SettingRow label="Bias Thresholds" hint="BUY is blocked when bias < −threshold. Scale is −1 (strong bearish) to +1 (strong bullish). 0.3 is a reasonable default for 1m bars.">
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-400">Buy min bias</span>
                      <input
                        type="number" min={0} max={1} step={0.05}
                        disabled={!editSettings}
                        value={draft.bar_predictor_buy_min_bias ?? 0.3}
                        onChange={e => updateDraft(d => ({ ...d, bar_predictor_buy_min_bias: Number(e.target.value) }))}
                        className="input w-20 text-sm py-1.5"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-400">Sell min bias</span>
                      <input
                        type="number" min={0} max={1} step={0.05}
                        disabled={!editSettings}
                        value={draft.bar_predictor_sell_min_bias ?? 0.3}
                        onChange={e => updateDraft(d => ({ ...d, bar_predictor_sell_min_bias: Number(e.target.value) }))}
                        className="input w-20 text-sm py-1.5"
                      />
                    </div>
                  </div>
                </SettingRow>
              )}
            </CollapsibleSection>

            {/* ── Risk & End of Day ── */}
            <CollapsibleSection
              title="Risk & End of Day"
              badge={`${(draft.risk_exit_mode ?? 'percent') === 'value' ? 'Dollar risk' : 'Percent risk'} · ${draft.hold_positions_overnight ? 'overnight' : 'EOD sell'}`}
              isOpen={openSections.risk}
              onToggle={() => toggleSection('risk')}
            >
              <SettingRow
                label="Risk Exits"
                hint="Choose one mode; inactive fields are saved as 0."
              >
                <div className="flex items-center gap-3">
                  <div className="inline-flex rounded-md border border-dark-600 overflow-hidden shrink-0">
                    <button
                      type="button"
                      disabled={!editSettings}
                      onClick={() => editSettings && updateDraft(d => ({ ...d, risk_exit_mode: 'percent' }))}
                      className={`px-2.5 py-1 text-xs transition-colors ${
                        (draft.risk_exit_mode ?? 'percent') === 'percent'
                          ? 'bg-violet-600 text-white'
                          : 'bg-dark-700 text-slate-300 hover:bg-dark-600'
                      }`}
                    >
                      %
                    </button>
                    <button
                      type="button"
                      disabled={!editSettings}
                      onClick={() => editSettings && updateDraft(d => ({ ...d, risk_exit_mode: 'value' }))}
                      className={`px-2.5 py-1 text-xs transition-colors border-l border-dark-600 ${
                        (draft.risk_exit_mode ?? 'percent') === 'value'
                          ? 'bg-violet-600 text-white'
                          : 'bg-dark-700 text-slate-300 hover:bg-dark-600'
                      }`}
                    >
                      $
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-400">SL</span>
                    {(draft.risk_exit_mode ?? 'percent') === 'value' && <span className="text-slate-400 text-sm">$</span>}
                    <input
                      type="number"
                      min={0}
                      max={(draft.risk_exit_mode ?? 'percent') === 'value' ? 10000 : 100}
                      step={(draft.risk_exit_mode ?? 'percent') === 'value' ? 0.01 : 0.1}
                      value={(draft.risk_exit_mode ?? 'percent') === 'value' ? draft.stop_loss_value : draft.stop_loss_pct}
                      onChange={e => updateDraft(d => ({
                        ...d,
                        ...(d.risk_exit_mode ?? 'percent') === 'value'
                          ? { stop_loss_value: e.target.value }
                          : { stop_loss_pct: e.target.value },
                      }))}
                      className="input w-24 text-sm py-1.5"
                    />
                    {(draft.risk_exit_mode ?? 'percent') !== 'value' && <span className="text-slate-400 text-sm">%</span>}
                  </div>

                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-400">TP</span>
                    {(draft.risk_exit_mode ?? 'percent') === 'value' && <span className="text-slate-400 text-sm">$</span>}
                    <input
                      type="number"
                      min={0}
                      max={(draft.risk_exit_mode ?? 'percent') === 'value' ? 10000 : 1000}
                      step={(draft.risk_exit_mode ?? 'percent') === 'value' ? 0.01 : 0.1}
                      value={(draft.risk_exit_mode ?? 'percent') === 'value' ? draft.take_profit_value : draft.take_profit_pct}
                      onChange={e => updateDraft(d => ({
                        ...d,
                        ...(d.risk_exit_mode ?? 'percent') === 'value'
                          ? { take_profit_value: e.target.value }
                          : { take_profit_pct: e.target.value },
                      }))}
                      className="input w-24 text-sm py-1.5"
                    />
                    {(draft.risk_exit_mode ?? 'percent') !== 'value' && <span className="text-slate-400 text-sm">%</span>}
                  </div>
                </div>
              </SettingRow>

              <SettingRow
                label="Stop-Loss Sell Execution"
                hint="For IB mode exits triggered by stop loss: Market sells act faster in sharp moves; Limit sells use the auto-pricing offset."
              >
                <label className="flex items-center gap-2 cursor-pointer">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${(draft.stop_loss_sell_market_enabled ?? true) ? 'bg-violet-600' : 'bg-dark-600'}`}
                    onClick={() => {
                      if (!editSettings) return
                      updateDraft(d => ({
                        ...d,
                        stop_loss_sell_market_enabled: !(d.stop_loss_sell_market_enabled ?? true),
                      }))
                    }}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${(draft.stop_loss_sell_market_enabled ?? true) ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-xs text-slate-300">{(draft.stop_loss_sell_market_enabled ?? true) ? 'Market (enabled)' : 'Limit (disabled)'}</span>
                </label>
              </SettingRow>

              <SettingRow
                label="Crash Protection (Daily Kill Switch)"
                hint="Monitors today's realized gain (closed trades P&L). When the daily loss exceeds the threshold, PM liquidates all IB positions, disables all engines, and halts all operations for the rest of the trading day."
              >
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <div
                      className={`relative w-9 h-5 rounded-full transition-colors ${(draft.crash_protection_enabled ?? false) ? 'bg-rose-600' : 'bg-dark-600'}`}
                      onClick={() => {
                        if (!editSettings) return
                        updateDraft(d => ({ ...d, crash_protection_enabled: !(d.crash_protection_enabled ?? false) }))
                      }}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${(draft.crash_protection_enabled ?? false) ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-xs text-slate-300">{(draft.crash_protection_enabled ?? false) ? 'Enabled' : 'Disabled'}</span>
                  </label>

                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="inline-flex rounded-md border border-dark-600 overflow-hidden shrink-0">
                      <button
                        type="button"
                        disabled={!editSettings}
                        onClick={() => editSettings && updateDraft(d => ({ ...d, crash_protection_mode: 'percent' }))}
                        className={`px-2.5 py-1 text-xs transition-colors ${
                          (draft.crash_protection_mode ?? 'percent') === 'percent'
                            ? 'bg-rose-600 text-white'
                            : 'bg-dark-700 text-slate-300 hover:bg-dark-600'
                        }`}
                      >
                        % Drawdown
                      </button>
                      <button
                        type="button"
                        disabled={!editSettings}
                        onClick={() => editSettings && updateDraft(d => ({ ...d, crash_protection_mode: 'dollar' }))}
                        className={`px-2.5 py-1 text-xs transition-colors border-l border-dark-600 ${
                          (draft.crash_protection_mode ?? 'percent') === 'dollar'
                            ? 'bg-rose-600 text-white'
                            : 'bg-dark-700 text-slate-300 hover:bg-dark-600'
                        }`}
                      >
                        $ Drawdown
                      </button>
                    </div>

                    <div className="flex items-center gap-1">
                      {(draft.crash_protection_mode ?? 'percent') === 'dollar' && <span className="text-slate-400 text-sm">$</span>}
                      <input
                        type="number"
                        min={0}
                        max={(draft.crash_protection_mode ?? 'percent') === 'dollar' ? 1000000 : 100}
                        step={(draft.crash_protection_mode ?? 'percent') === 'dollar' ? 0.01 : 0.1}
                        value={draft.crash_protection_value ?? 0}
                        onChange={e => updateDraft(d => ({ ...d, crash_protection_value: e.target.value }))}
                        className="input w-28 text-sm py-1.5"
                      />
                      {(draft.crash_protection_mode ?? 'percent') !== 'dollar' && <span className="text-slate-400 text-sm">% of account</span>}
                    </div>
                    <span className="text-[11px] text-slate-500">daily realized loss limit</span>
                  </div>

                  {/* Auto-restart after crash */}
                  <label className="flex items-center gap-2 cursor-pointer mt-1">
                    <div
                      className={`relative w-9 h-5 rounded-full transition-colors ${(draft.crash_auto_restart ?? false) ? 'bg-amber-600' : 'bg-dark-600'}`}
                      onClick={() => {
                        if (!editSettings) return
                        updateDraft(d => ({ ...d, crash_auto_restart: !(d.crash_auto_restart ?? false) }))
                      }}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${(draft.crash_auto_restart ?? false) ? 'translate-x-4' : ''}`} />
                    </div>
                    <span className="text-xs text-slate-300">
                      {(draft.crash_auto_restart ?? false)
                        ? 'Auto-restart next trading day'
                        : 'Manual restart required after crash (default)'}
                    </span>
                  </label>
                </div>
              </SettingRow>

              <SettingRow
                label="Automated Price Offsets"
                hint="Offsets from top-of-book touch price (BUY ask / SELL bid)."
              >
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 w-full">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 w-9">BUY</span>
                    <select
                      value={draft.auto_trade_buy_price_offset_mode ?? 'percent'}
                      onChange={e => updateDraft(d => ({ ...d, auto_trade_buy_price_offset_mode: e.target.value }))}
                      className="input w-28 text-sm py-1.5"
                    >
                      <option value="percent">%</option>
                      <option value="dollar">$</option>
                    </select>
                    {(draft.auto_trade_buy_price_offset_mode ?? 'percent') === 'dollar' && (
                      <span className="text-slate-400 text-sm">$</span>
                    )}
                    <input
                      type="number"
                      min={0}
                      max={(draft.auto_trade_buy_price_offset_mode ?? 'percent') === 'dollar' ? 10 : 5}
                      step={0.01}
                      value={Number(draft.auto_trade_buy_price_offset_pct ?? 0.01)}
                      onChange={e => updateDraft(d => ({ ...d, auto_trade_buy_price_offset_pct: Number(e.target.value) }))}
                      className="input w-28 text-sm py-1.5"
                    />
                    {(draft.auto_trade_buy_price_offset_mode ?? 'percent') !== 'dollar' && (
                      <span className="text-slate-400 text-sm">%</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 w-9">SELL</span>
                    <select
                      value={draft.auto_trade_sell_price_offset_mode ?? 'percent'}
                      onChange={e => updateDraft(d => ({ ...d, auto_trade_sell_price_offset_mode: e.target.value }))}
                      className="input w-28 text-sm py-1.5"
                    >
                      <option value="percent">%</option>
                      <option value="dollar">$</option>
                    </select>
                    {(draft.auto_trade_sell_price_offset_mode ?? 'percent') === 'dollar' && (
                      <span className="text-slate-400 text-sm">$</span>
                    )}
                    <input
                      type="number"
                      min={0}
                      max={(draft.auto_trade_sell_price_offset_mode ?? 'percent') === 'dollar' ? 10 : 5}
                      step={0.01}
                      value={Number(draft.auto_trade_sell_price_offset_pct ?? 0.01)}
                      onChange={e => updateDraft(d => ({ ...d, auto_trade_sell_price_offset_pct: Number(e.target.value) }))}
                      className="input w-28 text-sm py-1.5"
                    />
                    {(draft.auto_trade_sell_price_offset_mode ?? 'percent') !== 'dollar' && (
                      <span className="text-slate-400 text-sm">%</span>
                    )}
                  </div>
                </div>
              </SettingRow>

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

              <SettingRow
                label="Premarket IB Order Placement"
                hint="Allow PM to place IB orders outside regular session hours. When disabled, PM defers premarket orders until regular session opens."
              >
                <label className="flex items-center gap-2 cursor-pointer">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${draft.premarket_order_placement_enabled ? 'bg-violet-600' : 'bg-dark-600'}`}
                    onClick={() => {
                      if (!editSettings) return
                      updateDraft(d => ({ ...d, premarket_order_placement_enabled: !d.premarket_order_placement_enabled }))
                    }}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.premarket_order_placement_enabled ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-xs text-slate-300">{draft.premarket_order_placement_enabled ? 'Enabled' : 'Disabled'}</span>
                </label>
              </SettingRow>

              {!draft.hold_positions_overnight && (
                <SettingRow
                  label="EOD Window Controls"
                  hint="Shutoff blocks new buys; sell window forces exits near close."
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* Anti-churn toggle for EOD shutoff */}
                    <button
                      title={draft.eod_engine_shutoff_enabled ? 'Anti-churn active – click to disable EOD buy block' : 'EOD buy block bypassed – click to re-enable'}
                      onClick={() => editSettings && updateDraft(d => ({ ...d, eod_engine_shutoff_enabled: !d.eod_engine_shutoff_enabled }))}
                      className={`shrink-0 px-2 py-0.5 rounded text-xs font-semibold border transition-colors ${draft.eod_engine_shutoff_enabled ? 'bg-violet-700 text-white border-violet-500' : 'bg-dark-700 text-slate-500 border-dark-600 line-through'}`}
                    >{draft.eod_engine_shutoff_enabled ? 'ON' : 'OFF'}</button>
                    <div className={`flex items-center gap-1 transition-opacity ${draft.eod_engine_shutoff_enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                      <span className="text-xs text-slate-400">Shutoff</span>
                      <input
                        type="number" min={0} max={480} step={1}
                        value={draft.eod_engine_shutoff_minutes_before_sell}
                        onChange={e => updateDraft(d => ({ ...d, eod_engine_shutoff_minutes_before_sell: e.target.value }))}
                        className="input w-24 text-sm py-1.5"
                      />
                      <span className="text-slate-400 text-sm">min</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-400">Sell</span>
                      <input
                        type="number" min={1} max={240} step={1}
                        value={draft.eod_sell_window_minutes}
                        onChange={e => updateDraft(d => ({ ...d, eod_sell_window_minutes: e.target.value }))}
                        className="input w-24 text-sm py-1.5"
                      />
                      <span className="text-slate-400 text-sm">min</span>
                    </div>
                  </div>
                </SettingRow>
              )}
            </CollapsibleSection>

          </fieldset>
        </div>
      )}
        </>
      )}

      {pmTab === 'logs' && (
        <div className="bg-dark-800/70 border border-dark-600 rounded-xl p-4 space-y-3">
          <div className="space-y-2">
            <div className="text-sm font-semibold text-slate-200 uppercase tracking-wider">AI Bot Output</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="border border-dark-600 rounded-lg overflow-hidden">
                <div className="px-2 py-1 text-[11px] text-slate-400 bg-dark-800 border-b border-dark-600">
                  Latest model decisions (current cycle)
                </div>
                <pre className="m-0 p-2 text-[11px] leading-5 text-cyan-200 font-mono whitespace-pre-wrap break-words bg-dark-900/50 max-h-44 overflow-auto">
{aiDecisionText}
                </pre>
              </div>
              <div className="border border-dark-600 rounded-lg overflow-hidden">
                <div className="px-2 py-1 text-[11px] text-slate-400 bg-dark-800 border-b border-dark-600">
                  AI bot messages from PM activity log
                </div>
                <pre className="m-0 p-2 text-[11px] leading-5 text-emerald-200 font-mono whitespace-pre-wrap break-words bg-dark-900/50 max-h-44 overflow-auto">
{aiLogLines.length ? aiLogLines.join('\n') : 'No AI bot activity rows yet.'}
                </pre>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-200 uppercase tracking-wider">PM Activity Log</div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500">Rows</label>
              <select
                className="input text-xs py-1"
                value={pmLogPageSize}
                onChange={(e) => {
                  const nextSize = Number(e.target.value)
                  setPmLogPageSize(nextSize)
                  setPmLogPage(1)
                }}
              >
                {[50, 100, 200, 500].map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="border border-dark-600 rounded-lg overflow-hidden">
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-dark-800 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1 text-slate-400 font-semibold uppercase tracking-wide">Time</th>
                    <th className="text-left px-2 py-1 text-slate-400 font-semibold uppercase tracking-wide">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {pmRows.map((row, idx) => (
                    <tr key={`${row.at ?? 'na'}-${idx}`} className="border-t border-dark-700/70 align-top">
                      <td className="px-2 py-1.5 text-slate-500 font-mono whitespace-nowrap">
                        {row.at ? new Date(row.at).toLocaleString() : ''}
                      </td>
                      <td className="px-2 py-1.5 text-slate-300">{row.msg ?? ''}</td>
                    </tr>
                  ))}
                  {!pmActivityLoading && (pmActivityData?.items?.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={2} className="px-2 py-8 text-center text-slate-500">No PM activity rows found for today.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs">
            <div className="text-slate-500">
              {pmActivityLoading
                ? 'Loading…'
                : `Showing ${(pmActivityData?.items?.length ?? 0)} of ${pmActivityData?.total ?? 0} rows (day ${pmActivityData?.day ?? '-'})`}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPmLogPage(p => Math.max(1, p - 1))}
                disabled={pmActivityLoading || !(pmActivityData?.has_prev)}
                className="text-xs text-slate-300 hover:text-white border border-dark-500 hover:border-dark-300 rounded-lg px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <span className="text-slate-400">Page {pmActivityData?.page ?? pmLogPage}</span>
              <button
                type="button"
                onClick={() => setPmLogPage(p => p + 1)}
                disabled={pmActivityLoading || !(pmActivityData?.has_next)}
                className="text-xs text-slate-300 hover:text-white border border-dark-500 hover:border-dark-300 rounded-lg px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
