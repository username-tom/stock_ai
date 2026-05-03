import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getStrategies, runBacktest, getScripts } from '../api/client'
import EquityChart from './charts/EquityChart'
import SubplotChart from './charts/SubplotChart'
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  CodeBracketIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline'

function MetricCard({ label, value, sub, positive }) {
  const colorClass =
    positive === true ? 'text-emerald-400' :
    positive === false ? 'text-red-400' : 'text-slate-100'
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  )
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

const CUSTOM_SCRIPT_KEY = '__custom_script__'

export default function BacktestPanel() {
  const { data: stratData } = useQuery({
    queryKey: ['strategies'],
    queryFn: getStrategies,
  })

  const { data: scriptsData } = useQuery({
    queryKey: ['scripts'],
    queryFn: getScripts,
  })

  const [form, setForm] = useState({
    symbol: 'AAPL',
    strategy_type: 'sma_crossover',
    start_date: '2022-01-01',
    end_date: '2023-12-31',
    initial_capital: 10000,
    commission: 0.001,
  })
  const [stratParams, setStratParams] = useState({ fast_period: 10, slow_period: 30, ma_type: 'SMA' })
  const [selectedScriptId, setSelectedScriptId] = useState(null)
  const [result, setResult] = useState(null)
  const [activeTab, setActiveTab] = useState('equity')

  const isCustomScript = form.strategy_type === CUSTOM_SCRIPT_KEY
  const scripts = scriptsData?.scripts ?? []

  const mutation = useMutation({
    mutationFn: (payload) => runBacktest(payload),
    onSuccess: (data) => setResult(data),
  })

  const handleStrategyChange = (type) => {
    setForm(f => ({ ...f, strategy_type: type }))
    if (type !== CUSTOM_SCRIPT_KEY) {
      const defaults = {}
      ;(STRATEGY_PARAM_UI[type] || []).forEach(p => { defaults[p.key] = p.default })
      setStratParams(defaults)
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (isCustomScript) {
      if (!selectedScriptId) return
      mutation.mutate({
        ...form,
        strategy_type: 'custom_script',
        script_id: selectedScriptId,
        strategy_params: {},
      })
    } else {
      mutation.mutate({ ...form, strategy_params: stratParams })
    }
  }

  const paramFields = isCustomScript ? [] : (STRATEGY_PARAM_UI[form.strategy_type] || [])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Backtesting</h1>
        <p className="text-sm text-slate-400 mt-0.5">Test a strategy against historical data</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Config panel */}
        <form onSubmit={handleSubmit} className="card space-y-4 xl:col-span-1">
          <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
            Configuration
          </h2>

          <div>
            <label className="label">Symbol</label>
            <input
              className="input"
              value={form.symbol}
              onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
              placeholder="AAPL"
            />
          </div>

          <div>
            <label className="label">Strategy</label>
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
            </select>
          </div>

          {/* Custom script selector */}
          {isCustomScript && (
            <div className="border border-dark-500 rounded-lg p-3 space-y-3 bg-dark-900/30">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 uppercase tracking-wider">
                <CodeBracketIcon className="h-3.5 w-3.5" />
                Custom Script
              </div>
              {scripts.length === 0 ? (
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Start Date</label>
              <input
                className="input"
                type="date"
                value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">End Date</label>
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
            <label className="label">Commission (0.001 = 0.1%)</label>
            <input
              className="input"
              type="number"
              step="0.0001"
              value={form.commission}
              onChange={e => setForm(f => ({ ...f, commission: parseFloat(e.target.value) }))}
            />
          </div>

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
                  href={`/reports/${mutation.data.html_report_path.split('/').pop()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary text-xs flex items-center gap-1"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                  HTML Report
                </a>
              )}
            </div>
          )}
        </form>

        {/* Results */}
        <div className="xl:col-span-2 space-y-5">
          {result ? (
            <>
              {/* Metrics grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard
                  label="Total Return"
                  value={`${result.metrics.total_return_pct >= 0 ? '+' : ''}${result.metrics.total_return_pct?.toFixed(2)}%`}
                  positive={result.metrics.total_return_pct >= 0}
                />
                <MetricCard
                  label="Annualised Return"
                  value={`${result.metrics.annualized_return_pct >= 0 ? '+' : ''}${result.metrics.annualized_return_pct?.toFixed(2)}%`}
                  positive={result.metrics.annualized_return_pct >= 0}
                />
                <MetricCard
                  label="Sharpe Ratio"
                  value={result.metrics.sharpe_ratio?.toFixed(2)}
                  positive={result.metrics.sharpe_ratio >= 1}
                />
                <MetricCard
                  label="Max Drawdown"
                  value={`${result.metrics.max_drawdown_pct?.toFixed(2)}%`}
                  positive={false}
                />
                <MetricCard
                  label="Final Value"
                  value={`$${result.metrics.final_value?.toLocaleString()}`}
                />
                <MetricCard
                  label="Win Rate"
                  value={`${result.metrics.win_rate_pct?.toFixed(1)}%`}
                  positive={result.metrics.win_rate_pct >= 50}
                />
                <MetricCard label="Total Trades" value={result.metrics.total_trades} />
                <MetricCard
                  label="Initial Capital"
                  value={`$${result.result?.initial_capital?.toLocaleString()}`}
                />
              </div>

              {/* Chart tabs */}
              <div className="card space-y-4">
                <div className="flex gap-2 border-b border-dark-500 pb-3">
                  {['equity', 'price', 'trades'].map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                        activeTab === tab
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                      }`}
                    >
                      {tab === 'equity' ? 'Equity Curve' : tab === 'price' ? 'Price Chart' : 'Trade Log'}
                    </button>
                  ))}
                </div>

                {activeTab === 'equity' && (
                  <EquityChart
                    data={result.result?.equity_curve ?? []}
                    initialCapital={result.result?.initial_capital}
                    height={300}
                  />
                )}

                {activeTab === 'price' && (
                  <SubplotChart data={result.result?.ohlcv ?? []} height={240} />
                )}

                {activeTab === 'trades' && (
                  <div className="table-container max-h-80 overflow-y-auto">
                    <table>
                      <thead>
                        <tr>
                          <th>Entry</th>
                          <th>Exit</th>
                          <th>Entry $</th>
                          <th>Exit $</th>
                          <th>Qty</th>
                          <th>P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(result.result?.trades ?? []).map((t, i) => (
                          <tr key={i}>
                            <td className="font-mono text-xs">{t.entry_date}</td>
                            <td className="font-mono text-xs">{t.exit_date}</td>
                            <td className="font-mono">${t.entry_price}</td>
                            <td className="font-mono">${t.exit_price}</td>
                            <td>{t.quantity}</td>
                            <td className={t.pnl >= 0 ? 'pos' : 'neg'}>
                              {t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!(result.result?.trades?.length) && (
                      <div className="text-center text-slate-500 text-sm py-8">No trades executed</div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="card flex flex-col items-center justify-center h-64 text-slate-500">
              <ArrowPathIcon className="h-10 w-10 mb-3 text-slate-600" />
              <p className="font-medium">Configure and run a backtest to see results</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
