import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Cog6ToothIcon,
  ServerIcon,
  CircleStackIcon,
  GlobeAltIcon,
  BoltIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'
import { getSettings, updateSettings } from '../api/client'
import { useAppSettings, setSettings as setUiSettings, SETTINGS_DEFAULTS } from '../hooks/useAppSettings'

// ---------------------------------------------------------------------------
// Small shared components
// ---------------------------------------------------------------------------

function SectionCard({ icon: Icon, title, description, children }) {
  return (
    <div className="bg-dark-800 border border-dark-500 rounded-xl p-6">
      <div className="flex items-start gap-3 mb-5">
        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-emerald-600/15 border border-emerald-600/25 flex items-center justify-center">
          <Icon className="h-5 w-5 text-emerald-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function Field({ label, hint, restartRequired, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <label className="text-xs font-medium text-slate-300">{label}</label>
        {restartRequired && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded px-1.5 py-0.5 leading-none">
            <ArrowPathIcon className="h-2.5 w-2.5" />
            Restart required
          </span>
        )}
      </div>
      {children}
      {hint && <p className="text-[11px] text-slate-500 mt-1">{hint}</p>}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, mono = false, disabled = false }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={`w-full bg-dark-700 border border-dark-500 rounded-md px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600
        focus:outline-none focus:border-emerald-600 transition-colors disabled:opacity-50
        ${mono ? 'font-mono' : ''}`}
    />
  )
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-dark-700 border border-dark-500 rounded-md px-3 py-1.5 text-sm text-slate-200
        focus:outline-none focus:border-emerald-600 transition-colors appearance-none cursor-pointer"
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function SliderInput({ value, onChange, min, max, step = 1, formatLabel }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{formatLabel ? formatLabel(min) : min}</span>
        <span className="text-xs font-mono font-semibold text-emerald-400 bg-emerald-600/10 border border-emerald-600/20 px-2 py-0.5 rounded">
          {formatLabel ? formatLabel(value) : value}
        </span>
        <span className="text-xs text-slate-500">{formatLabel ? formatLabel(max) : max}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{
          background: `linear-gradient(to right, #10b981 ${pct}%, #334155 ${pct}%)`,
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function SettingsPanel() {
  const qc = useQueryClient()
  const currentUiSettings = useAppSettings()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })

  // Local form state – mirrors every field returned by the API
  const [form, setForm] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saveResult, setSaveResult] = useState(null) // { saved, restart_required }

  // UI settings form (localStorage-backed, no backend needed)
  const [uiForm, setUiForm] = useState(() => ({ ...currentUiSettings }))
  const [uiDirty, setUiDirty] = useState(false)

  function setUi(key, val) {
    setUiForm(prev => ({ ...prev, [key]: val }))
    setUiDirty(true)
  }

  function saveUiSettings() {
    setUiSettings(uiForm)
    setUiDirty(false)
  }

  function resetUiSettings() {
    setUiForm({ ...SETTINGS_DEFAULTS })
    setUiDirty(true)
  }

  // Populate form once data arrives
  useEffect(() => {
    if (!data || form) return
    setForm({
      IB_HOST:            data.ib_connection.IB_HOST,
      IB_PORT:            data.ib_connection.IB_PORT,
      IB_CLIENT_ID:       data.ib_connection.IB_CLIENT_ID,
      TRADING_MODE:       data.trading.TRADING_MODE,
      DATABASE_URL:       data.storage.DATABASE_URL,
      REPORTS_DIR:        data.storage.REPORTS_DIR,
      LOCAL_STORAGE_DIR:  data.storage.LOCAL_STORAGE_DIR,
      CORS_ORIGINS:       data.network.CORS_ORIGINS,
    })
  }, [data, form])

  const restartKeys = data?.restart_required_keys ?? []

  function set(key, val) {
    setForm(prev => ({ ...prev, [key]: val }))
    setDirty(true)
    setSaveResult(null)
  }

  const saveMut = useMutation({
    mutationFn: updateSettings,
    onSuccess: (res) => {
      setSaveResult(res)
      setDirty(false)
      // Invalidate so next open gets fresh values
      qc.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => {
      setSaveResult({ error: err?.response?.data?.detail ?? 'Save failed.' })
    },
  })

  function handleSave() {
    if (!form) return
    saveMut.mutate(form)
  }

  function handleRestart() {
    // Reload the page – in Docker compose this asks the backend to restart via
    // a signal; here we just reload the frontend and let the user restart the
    // backend manually (or in Docker the compose restart happens via ops).
    window.location.reload()
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (isLoading || !form) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        <ArrowPathIcon className="h-5 w-5 animate-spin mr-2" />
        Loading settings…
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400 text-sm gap-2">
        <ExclamationTriangleIcon className="h-5 w-5" />
        Could not load settings from backend.
      </div>
    )
  }

  const needsRestartNow = saveResult?.restart_required?.length > 0

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Cog6ToothIcon className="h-7 w-7 text-emerald-400" />
        <div>
          <h1 className="text-xl font-bold text-slate-100">Settings</h1>
          <p className="text-xs text-slate-500 mt-0.5">Configure application behaviour. Changes are written to <code className="font-mono text-slate-400">.env</code>.</p>
        </div>
      </div>

      {/* Save feedback */}
      {saveResult && !saveResult.error && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
          needsRestartNow
            ? 'bg-amber-500/10 border-amber-500/25 text-amber-300'
            : 'bg-emerald-600/10 border-emerald-600/25 text-emerald-300'
        }`}>
          {needsRestartNow
            ? <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0 mt-0.5" />
            : <CheckCircleIcon className="h-5 w-5 flex-shrink-0 mt-0.5" />
          }
          <div className="flex-1">
            {needsRestartNow ? (
              <>
                <p className="font-semibold">Settings saved — restart required</p>
                <p className="text-xs mt-0.5 opacity-80">
                  The following keys require a backend restart to take effect:{' '}
                  <span className="font-mono">{saveResult.restart_required.join(', ')}</span>
                </p>
              </>
            ) : (
              <p className="font-semibold">Settings saved and applied.</p>
            )}
          </div>
          {needsRestartNow && (
            <button
              onClick={handleRestart}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 text-xs font-semibold transition-colors"
            >
              <ArrowPathIcon className="h-4 w-4" />
              Restart App
            </button>
          )}
        </div>
      )}

      {saveResult?.error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
          {saveResult.error}
        </div>
      )}

      {/* ── Group 1: Interactive Brokers Connection ── */}
      <SectionCard
        icon={ServerIcon}
        title="Interactive Brokers Connection"
        description="TWS / IB Gateway host, port, and client ID used by the ibapi connector."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field
            label="Host"
            hint="IP address or hostname of your TWS / Gateway instance."
          >
            <TextInput
              value={form.IB_HOST}
              onChange={v => set('IB_HOST', v)}
              placeholder="127.0.0.1"
              mono
            />
          </Field>

          <Field label="Port" hint="7497 = paper, 7496 = live.">
            <TextInput
              value={form.IB_PORT}
              onChange={v => set('IB_PORT', v)}
              placeholder="7497"
              mono
            />
          </Field>

      <Field label="Client ID" hint="Unique integer ID for this connection.">
        <TextInput
          value={form.IB_CLIENT_ID}
          onChange={v => set('IB_CLIENT_ID', v)}
          placeholder="1"
          mono
        />
      </Field>
    </div>
  </SectionCard>

      {/* ── Group 2: Trading ── */}
      <SectionCard
        icon={BoltIcon}
        title="Trading"
        description="Controls whether orders are routed to paper or live IB accounts."
      >
        <Field
          label="Trading Mode"
          hint="Paper mode uses IB's paper-trading port. Live mode routes real orders."
        >
          <Select
            value={form.TRADING_MODE}
            onChange={v => set('TRADING_MODE', v)}
            options={[
              { value: 'paper', label: 'Paper — simulated trading (port 7497)' },
              { value: 'live',  label: 'Live  — real money (port 7496)'        },
            ]}
          />
        </Field>
      </SectionCard>

      {/* ── Group 3: Storage & Paths ── */}
      <SectionCard
        icon={CircleStackIcon}
        title="Storage & Paths"
        description="Database connection string and output directories for reports and local data."
      >
        <Field
          label="Database URL"
          hint="SQLAlchemy async connection string. Changing this requires a restart."
          restartRequired={restartKeys.includes('DATABASE_URL')}
        >
          <TextInput
            value={form.DATABASE_URL}
            onChange={v => set('DATABASE_URL', v)}
            placeholder="sqlite+aiosqlite:///./stock_ai.db"
            mono
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Reports Directory" hint="Where HTML backtest reports are written.">
            <TextInput
              value={form.REPORTS_DIR}
              onChange={v => set('REPORTS_DIR', v)}
              placeholder="reports_output"
              mono
            />
          </Field>

          <Field
            label="Local Storage Directory"
            hint="Root folder for trade logs, backtest JSON, and portfolio activities."
            restartRequired={restartKeys.includes('LOCAL_STORAGE_DIR')}
          >
            <TextInput
              value={form.LOCAL_STORAGE_DIR}
              onChange={v => set('LOCAL_STORAGE_DIR', v)}
              placeholder="local_storage"
              mono
            />
          </Field>
        </div>
      </SectionCard>

      {/* ── Group 4: Network ── */}
      <SectionCard
        icon={GlobeAltIcon}
        title="Network & CORS"
        description="Allowed browser origins for cross-origin requests to the API."
      >
        <Field
          label="CORS Origins"
          hint="Comma-separated list of allowed origins, e.g. http://localhost:5173,https://myapp.com"
          restartRequired={restartKeys.includes('CORS_ORIGINS')}
        >
          <TextInput
            value={form.CORS_ORIGINS}
            onChange={v => set('CORS_ORIGINS', v)}
            placeholder="http://localhost:5173,http://localhost:3000"
            mono
          />
        </Field>
      </SectionCard>

      {/* ── Group 5: Refresh Rates ── */}
      <SectionCard
        icon={ClockIcon}
        title="Refresh Rates"
        description="How often each panel polls for new data. Changes apply instantly — no restart needed."
      >
        {/* Helper to format ms values */}
        {(() => {
          const fmtMs = (ms) => ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1_000} s`
          return (
            <div className="space-y-6">
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Dashboard</p>
                <div className="space-y-4">
                  <Field label="Watchlist Quotes" hint="How often watchlist prices refresh during market hours.">
                    <SliderInput value={uiForm.quotes_refresh_ms} onChange={v => setUi('quotes_refresh_ms', v)}
                      min={5_000} max={120_000} step={5_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="Price Chart" hint="Refresh interval for the intraday price chart.">
                    <SliderInput value={uiForm.chart_refresh_ms} onChange={v => setUi('chart_refresh_ms', v)}
                      min={15_000} max={300_000} step={15_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="Movers (Gainers & Losers)" hint="Refresh interval during market hours.">
                    <SliderInput value={uiForm.movers_refresh_ms} onChange={v => setUi('movers_refresh_ms', v)}
                      min={60_000} max={600_000} step={60_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="News Feed" hint="How often the news tab polls for new articles.">
                    <SliderInput value={uiForm.news_refresh_ms} onChange={v => setUi('news_refresh_ms', v)}
                      min={300_000} max={3_600_000} step={300_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="Earnings Calendar" hint="Refresh interval for the earnings tab.">
                    <SliderInput value={uiForm.earnings_refresh_ms} onChange={v => setUi('earnings_refresh_ms', v)}
                      min={300_000} max={3_600_000} step={300_000} formatLabel={fmtMs} />
                  </Field>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Portfolio / Sandbox</p>
                <div className="space-y-4">
                  <Field label="Account & Positions" hint="Sandbox account balance and open positions.">
                    <SliderInput value={uiForm.sandbox_account_ms} onChange={v => setUi('sandbox_account_ms', v)}
                      min={3_000} max={60_000} step={1_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="Position Quotes" hint="Live quote refresh for sandbox holdings.">
                    <SliderInput value={uiForm.sandbox_quotes_ms} onChange={v => setUi('sandbox_quotes_ms', v)}
                      min={5_000} max={120_000} step={5_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="Recent Trades & Activity" hint="Trade log and activity feed polling rate.">
                    <SliderInput value={uiForm.sandbox_trades_ms} onChange={v => setUi('sandbox_trades_ms', v)}
                      min={2_000} max={60_000} step={1_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="Engine & Manager State" hint="Automated trading engine status polling.">
                    <SliderInput value={uiForm.sandbox_engine_ms} onChange={v => setUi('sandbox_engine_ms', v)}
                      min={3_000} max={60_000} step={1_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="Portfolio Detail" hint="Fund events and position detail chart refresh.">
                    <SliderInput value={uiForm.portfolio_detail_ms} onChange={v => setUi('portfolio_detail_ms', v)}
                      min={5_000} max={120_000} step={5_000} formatLabel={fmtMs} />
                  </Field>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Trading (IB)</p>
                <div className="space-y-4">
                  <Field label="IB Connection Status" hint="How often the IB connect/disconnect status is checked.">
                    <SliderInput value={uiForm.trading_status_ms} onChange={v => setUi('trading_status_ms', v)}
                      min={1_000} max={30_000} step={1_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="IB Open Positions" hint="Refresh rate for IB live positions.">
                    <SliderInput value={uiForm.trading_positions_ms} onChange={v => setUi('trading_positions_ms', v)}
                      min={3_000} max={60_000} step={1_000} formatLabel={fmtMs} />
                  </Field>
                  <Field label="IB Open Orders" hint="Refresh rate for IB open order list.">
                    <SliderInput value={uiForm.trading_orders_ms} onChange={v => setUi('trading_orders_ms', v)}
                      min={1_000} max={30_000} step={1_000} formatLabel={fmtMs} />
                  </Field>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Live Ticker Bar</p>
                <div className="space-y-4">
                  <Field label="Scroll Speed" hint="Time in seconds for the ticker bar to scroll through all symbols once. Lower = faster.">
                    <SliderInput value={uiForm.ticker_scroll_speed_s} onChange={v => setUi('ticker_scroll_speed_s', v)}
                      min={5} max={120} step={5} formatLabel={v => `${v}s`} />
                  </Field>
                </div>
              </div>

              <div className="flex justify-between items-center pt-2 border-t border-dark-600">
                <button
                  onClick={resetUiSettings}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Reset to defaults
                </button>
                <button
                  onClick={saveUiSettings}
                  disabled={!uiDirty}
                  className="flex items-center gap-2 px-4 py-1.5 text-sm rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40 transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          )
        })()}
      </SectionCard>

      {/* Info note */}
      <div className="flex items-start gap-2 text-xs text-slate-500 bg-dark-800 border border-dark-600 rounded-lg px-4 py-3">
        <InformationCircleIcon className="h-4 w-4 flex-shrink-0 mt-0.5 text-slate-600" />
        <span>
          Settings are persisted to <code className="font-mono text-slate-400">.env</code> on the server.
          Fields marked <span className="text-amber-400 font-medium">Restart required</span> need the
          backend process to be restarted before they take effect.
        </span>
      </div>

      {/* Save bar */}
      <div className="sticky bottom-0 z-10 flex justify-end gap-3 bg-dark-900/90 backdrop-blur border-t border-dark-600 -mx-6 px-6 py-4">
        <button
          onClick={() => { setForm(null); setDirty(false); setSaveResult(null) }}
          disabled={!dirty || saveMut.isPending}
          className="px-4 py-2 text-sm rounded-md border border-dark-500 text-slate-400 hover:text-slate-200 hover:border-dark-400 disabled:opacity-40 transition-colors"
        >
          Reset
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty || saveMut.isPending}
          className="flex items-center gap-2 px-5 py-2 text-sm rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40 transition-colors"
        >
          {saveMut.isPending && (
            <span className="h-3.5 w-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          )}
          Save Settings
        </button>
      </div>
    </div>
  )
}
