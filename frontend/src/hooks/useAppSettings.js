/**
 * useAppSettings – lightweight localStorage-backed settings store.
 *
 * All timing/refresh values are stored here so every component can read them
 * without waiting for a React context or backend call.
 *
 * Defaults match the original hard-coded values in each component.
 */

const STORAGE_KEY = 'app_ui_settings'

export const SETTINGS_DEFAULTS = {
  // Refresh rates (ms)
  quotes_refresh_ms:         30_000,   // Dashboard watchlist quotes
  chart_refresh_ms:          60_000,   // Dashboard price chart (intraday)
  movers_refresh_ms:         60_000,   // Movers tab (market open)
  news_refresh_ms:          1_800_000, // News tab (30 min)
  earnings_refresh_ms:       900_000,  // Earnings tab (15 min)
  sandbox_account_ms:        10_000,   // Sandbox account / positions
  sandbox_quotes_ms:         30_000,   // Sandbox position quotes
  sandbox_trades_ms:          8_000,   // Sandbox recent trades / activity
  sandbox_engine_ms:         10_000,   // Sandbox engine state
  portfolio_positions_ms:    10_000,   // Portfolio manager positions
  portfolio_detail_ms:       15_000,   // Position detail panel
  trading_status_ms:          5_000,   // IB connection status
  trading_positions_ms:      10_000,   // IB open positions
  trading_orders_ms:          5_000,   // IB open orders

  // Ticker bar
  ticker_scroll_speed_s:         30,   // seconds for one full scroll cycle
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return { ...SETTINGS_DEFAULTS }
}

function save(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {}
}

// Module-level cache so all hook instances share one object
let _cache = load()
const _listeners = new Set()

function notify() {
  _listeners.forEach(fn => fn({ ..._cache }))
}

export function setSetting(key, value) {
  _cache = { ..._cache, [key]: value }
  save(_cache)
  notify()
}

export function setSettings(patch) {
  _cache = { ..._cache, ...patch }
  save(_cache)
  notify()
}

export function getAppSettings() {
  return { ..._cache }
}

// React hook
import { useState, useEffect } from 'react'

export function useAppSettings() {
  const [settings, setSettingsState] = useState(() => ({ ..._cache }))

  useEffect(() => {
    const handler = (next) => setSettingsState(next)
    _listeners.add(handler)
    return () => _listeners.delete(handler)
  }, [])

  return settings
}
