import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CpuChipIcon, ArrowsRightLeftIcon, ClockIcon, BanknotesIcon,
  ChartBarIcon, CheckCircleIcon, XCircleIcon,
} from '@heroicons/react/24/outline'
import { getPortfolioManagerState, updatePortfolioManagerSettings } from '../../api/client'
import { fmtMoney } from './sandboxHelpers'

const BULL_COLOR = '#10b981'
const BEAR_COLOR = '#ef4444'
const NEUTRAL_COLOR = '#64748b'

function classColor(cls) {
  if (cls === 'bullish') return BULL_COLOR
  if (cls === 'bearish') return BEAR_COLOR
  return NEUTRAL_COLOR
}

function classLabel(cls) {
  if (cls === 'bullish') return '▲ Bullish'
  if (cls === 'bearish') return '▼ Bearish'
  return '— Neutral'
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

export default function PortfolioManagerPanel() {
  const qc = useQueryClient()
  const [editSettings, setEditSettings] = useState(false)
  const [draft, setDraft] = useState(null)

  const { data: managerData, isLoading } = useQuery({
    queryKey: ['portfolio-manager-state'],
    queryFn: getPortfolioManagerState,
    refetchInterval: 10000,
  })

  const updateMut = useMutation({
    mutationFn: updatePortfolioManagerSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portfolio-manager-state'] })
      setEditSettings(false)
      setDraft(null)
    },
  })

  if (isLoading || !managerData) return null

  const settings = managerData.settings
  const scores = managerData.scores ?? {}
  const activity = managerData.last_activity ?? []

  function openEdit() {
    setDraft({
      transfer_pct: Math.round(settings.transfer_pct * 100),
      transfer_interval_s: settings.transfer_interval_s,
      indicator_interval_s: settings.indicator_interval_s,
      min_position_funds: settings.min_position_funds,
      deploy_available_funds: settings.deploy_available_funds ?? true,
      deploy_target: settings.deploy_target ?? 'most_bearish',
      deploy_target_symbol: settings.deploy_target_symbol ?? '',
    })
    setEditSettings(true)
  }

  function handleSave() {
    updateMut.mutate({
      transfer_pct: draft.transfer_pct / 100,
      transfer_interval_s: Number(draft.transfer_interval_s),
      indicator_interval_s: Number(draft.indicator_interval_s),
      min_position_funds: Number(draft.min_position_funds),
      deploy_available_funds: draft.deploy_available_funds,
      deploy_target: draft.deploy_target,
      deploy_target_symbol: draft.deploy_target_symbol ?? '',
    })
  }

  const symbolCount = Object.keys(scores).length
  const bullishCount = Object.values(scores).filter(s => s.classification === 'bullish').length
  const bearishCount = Object.values(scores).filter(s => s.classification === 'bearish').length
  const neutralCount = symbolCount - bullishCount - bearishCount

  return (
    <div className="card space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CpuChipIcon className="h-4 w-4 text-violet-400" />
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Portfolio Manager</h2>
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
        <button
          onClick={openEdit}
          className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 hover:border-dark-400 rounded-lg px-3 py-1.5 transition-colors"
        >
          Settings
        </button>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-dark-800 rounded-lg p-3">
          <div className="text-xs text-slate-500 mb-1">Total Redistributed</div>
          <div className="text-base font-bold text-slate-100">{fmtMoney(managerData.total_transferred ?? 0)}</div>
        </div>
        <div className="bg-dark-800 rounded-lg p-3">
          <div className="text-xs text-slate-500 mb-1">Transfers</div>
          <div className="text-base font-bold text-slate-100">{managerData.transfers_today ?? 0}</div>
        </div>
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
        <span className="flex items-center gap-1"><ArrowsRightLeftIcon className="h-3.5 w-3.5" />Transfer {Math.round(settings.transfer_pct * 100)}% of idle cash</span>
        <span className="flex items-center gap-1"><ClockIcon className="h-3.5 w-3.5" />Every {settings.transfer_interval_s}s</span>
        <span className="flex items-center gap-1"><ChartBarIcon className="h-3.5 w-3.5" />Score refresh {settings.indicator_interval_s}s</span>
        <span className="flex items-center gap-1"><BanknotesIcon className="h-3.5 w-3.5" />Min {fmtMoney(settings.min_position_funds)} per position</span>
        <span className={`flex items-center gap-1 ${settings.deploy_available_funds ? 'text-violet-400' : 'text-slate-600'}`}>
          <BanknotesIcon className="h-3.5 w-3.5" />
          {settings.deploy_available_funds
            ? `Deploying available funds → ${{ most_bearish: 'most bearish', most_bullish: 'most bullish', most_held: 'most held', least_held: 'least held', specific: settings.deploy_target_symbol || 'specific' }[settings.deploy_target] ?? settings.deploy_target}`
            : 'Available funds deployment off'}
        </span>
      </div>

      {/* Symbol scores */}
      {symbolCount > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Stock Signals</span>
            <span className="text-xs text-emerald-400 font-medium">{bullishCount} bullish</span>
            <span className="text-xs text-red-400 font-medium">{bearishCount} bearish</span>
            {neutralCount > 0 && <span className="text-xs text-slate-500 font-medium">{neutralCount} neutral</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(scores).map(([sym, sc]) => (
              <div
                key={sym}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-dark-800 border border-dark-600"
                title={`Score: ${sc.score} — Updated: ${sc.updated_at ? new Date(sc.updated_at).toLocaleTimeString() : '?'}`}
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

      {/* Settings modal */}
      {editSettings && draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-dark-800 border border-dark-600 rounded-xl shadow-2xl w-full max-w-md p-6 space-y-5">
            <div className="flex items-center gap-2">
              <CpuChipIcon className="h-5 w-5 text-violet-400" />
              <h3 className="text-base font-bold text-slate-100">Portfolio Manager Settings</h3>
            </div>

            <SettingRow
              label="Transfer Amount (%)"
              hint="Percentage of bearish positions' idle cash moved per cycle."
            >
              <div className="flex items-center gap-3">
                <input
                  type="range" min={1} max={100} step={1}
                  value={draft.transfer_pct}
                  onChange={e => setDraft(d => ({ ...d, transfer_pct: Number(e.target.value) }))}
                  className="flex-1 accent-violet-500"
                />
                <span className="w-10 text-right text-sm font-bold text-slate-200">{draft.transfer_pct}%</span>
              </div>
            </SettingRow>

            <SettingRow
              label="Transfer Interval (seconds)"
              hint="How often funds are redistributed between positions."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number" min={30} step={30}
                  value={draft.transfer_interval_s}
                  onChange={e => setDraft(d => ({ ...d, transfer_interval_s: e.target.value }))}
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

            <SettingRow
              label="Indicator Refresh Interval (seconds)"
              hint="How often bullish/bearish scores are recalculated for each stock."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number" min={30} step={30}
                  value={draft.indicator_interval_s}
                  onChange={e => setDraft(d => ({ ...d, indicator_interval_s: e.target.value }))}
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

            <SettingRow
              label="Minimum Funds per Position ($)"
              hint="Each position always keeps at least this much cash allocated, even when bearish."
            >
              <div className="flex items-center gap-1">
                <span className="text-slate-400 text-sm">$</span>
                <input
                  type="number" min={0} step={50}
                  value={draft.min_position_funds}
                  onChange={e => setDraft(d => ({ ...d, min_position_funds: e.target.value }))}
                  className="input w-28 text-sm py-1.5"
                />
              </div>
            </SettingRow>

            <SettingRow
              label="Deploy Available Funds"
              hint="Automatically allocate unassigned account cash to a target position each cycle."
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  className={`relative w-9 h-5 rounded-full transition-colors ${draft.deploy_available_funds ? 'bg-violet-600' : 'bg-dark-600'}`}
                  onClick={() => setDraft(d => ({ ...d, deploy_available_funds: !d.deploy_available_funds }))}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${draft.deploy_available_funds ? 'translate-x-4' : ''}`} />
                </div>
                <span className="text-xs text-slate-300">{draft.deploy_available_funds ? 'Enabled' : 'Disabled'}</span>
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
                        onChange={() => setDraft(d => ({ ...d, deploy_target: opt.value }))}
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
                      onChange={e => setDraft(d => ({ ...d, deploy_target_symbol: e.target.value.toUpperCase() }))}
                      className="input w-36 text-sm py-1.5 mt-1 font-mono uppercase"
                    />
                  )}
                </div>
              </SettingRow>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setEditSettings(false); setDraft(null) }}
                className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-lg px-4 py-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={updateMut.isPending}
                className="text-xs bg-violet-700 hover:bg-violet-600 text-white font-semibold rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
              >
                {updateMut.isPending ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
