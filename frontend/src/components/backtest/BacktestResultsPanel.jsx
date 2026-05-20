import { ArrowPathIcon, ArrowDownTrayIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import EquityChart from '../charts/EquityChart'
import SubplotChart from '../charts/SubplotChart'
import { getReportFilename } from '../../utils/reportPaths'

const REASON_COLORS = {
  rsi: 'bg-purple-900/50 text-purple-300 border-purple-700/40',
  rsi_exit: 'bg-purple-900/30 text-purple-400 border-purple-700/30',
  bb: 'bg-blue-900/50 text-blue-300 border-blue-700/40',
  bb_exit: 'bg-blue-900/30 text-blue-400 border-blue-700/30',
  ma: 'bg-yellow-900/50 text-yellow-300 border-yellow-700/40',
  ma_exit: 'bg-yellow-900/30 text-yellow-400 border-yellow-700/30',
  macd: 'bg-cyan-900/50 text-cyan-300 border-cyan-700/40',
  macd_exit: 'bg-cyan-900/30 text-cyan-400 border-cyan-700/30',
  stop_loss: 'bg-red-900/60 text-red-300 border-red-700/50',
  take_profit: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/40',
  fallback_exit: 'bg-slate-700/50 text-slate-400 border-slate-600/40',
  signal: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/30',
  strategy_exit: 'bg-slate-700/50 text-slate-400 border-slate-600/40',
}

const BUCKET_STYLES = {
  crash: 'bg-red-900/50 text-red-300 border-red-700/40',
  bearish: 'bg-orange-900/50 text-orange-300 border-orange-700/40',
  neutral: 'bg-slate-700/50 text-slate-300 border-slate-600/40',
  bullish: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/40',
  euphoric: 'bg-purple-900/50 text-purple-300 border-purple-700/40',
}

function MetricCard({ label, value, sub, positive }) {
  const colorClass = positive === true ? 'text-emerald-400' : positive === false ? 'text-red-400' : 'text-slate-100'
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

function SummaryPanel({ result }) {
  const r = result?.result ?? {}
  const m = result?.metrics ?? {}
  const finalVal = m.final_value ?? 0
  const initialCap = r.initial_capital ?? 0
  const gainLoss = finalVal - initialCap
  const gainLossPct = m.total_return_pct ?? 0
  const maxSharesHeld = r.max_shares_held ?? 0
  const cashRemaining = r.final_cash ?? 0
  const entryPrice = r.final_entry_price ?? null
  const lastTrade = r.trades?.length ? r.trades[r.trades.length - 1] : null
  const lastEquity = r.equity_curve?.length ? r.equity_curve[r.equity_curve.length - 1] : null
  const fmt = (n, opts) => Number(n).toLocaleString(undefined, opts)

  return (
    <div className="card bg-dark-900/60 border border-dark-500 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-0.5">Portfolio Summary</div>
          <div className="text-2xl font-bold text-slate-100">${fmt(finalVal, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className={`text-sm font-medium mt-0.5 ${gainLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {gainLoss >= 0 ? '+' : ''}${fmt(gainLoss, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            {' '}({gainLossPct >= 0 ? '+' : ''}{Number(gainLossPct).toFixed(2)}%)
          </div>
        </div>
        {lastEquity && <div className="text-xs text-slate-500">as of {lastEquity.date}</div>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-dark-600">
        <div>
          <div className="text-xs text-slate-500 mb-0.5">Max Shares Held</div>
          <div className="text-sm font-semibold text-slate-200">{maxSharesHeld > 0 ? fmt(maxSharesHeld, { maximumFractionDigits: 4 }) : '—'}</div>
          {entryPrice && maxSharesHeld > 0 && <div className="text-xs text-slate-500">last entry @ ${fmt(entryPrice, { maximumFractionDigits: 4 })}</div>}
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-0.5">Cash Remaining</div>
          <div className="text-sm font-semibold text-slate-200">${fmt(cashRemaining, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-0.5">Initial Capital</div>
          <div className="text-sm font-semibold text-slate-200">${fmt(initialCap)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-0.5">Last Trade P&amp;L</div>
          {lastTrade ? (
            <div className={`text-sm font-semibold ${(lastTrade.pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {(lastTrade.pnl ?? 0) >= 0 ? '+' : ''}${Number(lastTrade.pnl ?? 0).toFixed(2)}
            </div>
          ) : (
            <div className="text-sm font-semibold text-slate-500">—</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReasonBadge({ value }) {
  if (!value) return <span className="text-slate-600">—</span>
  const cls = REASON_COLORS[value] ?? 'bg-slate-700/50 text-slate-400 border-slate-600/40'
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium leading-tight whitespace-nowrap ${cls}`}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

function bucketClass(bucket) {
  return BUCKET_STYLES[bucket] ?? 'bg-slate-700/50 text-slate-400 border-slate-600'
}

export default function BacktestResultsPanel({
  mode,
  result,
  activeTab,
  setActiveTab,
  isPending,
  emptyMessage = 'Configure and run a backtest to see results',
  pendingMessage = 'Running backtest…',
}) {
  const metrics = result?.metrics ?? {}
  const trades = result?.result?.trades ?? []
  const switches = result?.result?.strategy_switches ?? []
  const tabs = mode === 'sentiment'
    ? ['equity', 'price', 'trades', 'switches']
    : ['equity', 'price', 'trades']

  if (isPending && result) {
    return (
      <div className="xl:col-span-2 space-y-5 animate-pulse">
        <div className="card bg-dark-900/60 border border-dark-500 space-y-3">
          <div className="h-4 w-36 bg-dark-600 rounded" />
          <div className="h-8 w-48 bg-dark-600 rounded" />
          <div className="h-4 w-32 bg-dark-700 rounded" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-dark-600">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-20 bg-dark-700 rounded" />
                <div className="h-5 w-16 bg-dark-600 rounded" />
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="metric-card space-y-2">
              <div className="h-3 w-20 bg-dark-700 rounded" />
              <div className="h-6 w-24 bg-dark-600 rounded" />
            </div>
          ))}
        </div>
        <div className="card">
          <div className="h-4 w-32 bg-dark-700 rounded mb-4" />
          <div className="h-64 bg-dark-700 rounded-lg" />
        </div>
      </div>
    )
  }

  if (!result && isPending) {
    return (
      <div className="xl:col-span-2 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="metric-card animate-pulse">
              <div className="h-3 w-20 bg-dark-500 rounded mb-2" />
              <div className="h-7 w-16 bg-dark-500 rounded" />
            </div>
          ))}
        </div>
        <div className="card h-64 flex flex-col items-center justify-center gap-3 text-slate-400">
          <ArrowPathIcon className="h-8 w-8 animate-spin text-emerald-500" />
          <p className="text-sm">{pendingMessage}</p>
        </div>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="card flex flex-col items-center justify-center h-64 text-slate-500">
        <ArrowPathIcon className="h-10 w-10 mb-3 text-slate-600" />
        <p className="font-medium">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="xl:col-span-2 space-y-5">
      {result.result?.day_trade && (
        <div className="flex items-center gap-2 px-3 py-2 bg-indigo-900/30 border border-indigo-700/40 rounded-lg text-xs text-indigo-300">
          <span className="font-semibold uppercase tracking-wide">Day Trade Mode</span>
          <span className="text-indigo-500">•</span>
          <span>Interval: <span className="font-mono font-semibold">{result.result.interval ?? '—'}</span></span>
        </div>
      )}

      <SummaryPanel result={result} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Total Return" value={`${metrics.total_return_pct >= 0 ? '+' : ''}${metrics.total_return_pct?.toFixed(2)}%`} positive={metrics.total_return_pct >= 0} />
        <MetricCard label="Annualised Return" value={`${metrics.annualized_return_pct >= 0 ? '+' : ''}${metrics.annualized_return_pct?.toFixed(2)}%`} positive={metrics.annualized_return_pct >= 0} />
        <MetricCard label="Sharpe Ratio" value={metrics.sharpe_ratio?.toFixed(2)} positive={metrics.sharpe_ratio >= 1} />
        <MetricCard label="Max Drawdown" value={`${metrics.max_drawdown_pct?.toFixed(2)}%`} positive={false} />
        <MetricCard label="Final Value" value={`$${metrics.final_value?.toLocaleString()}`} />
        <MetricCard label="Win Rate" value={`${metrics.win_rate_pct?.toFixed(1)}%`} positive={metrics.win_rate_pct >= 50} />
        <MetricCard label="Total Trades" value={metrics.total_trades} />
        <MetricCard label={mode === 'sentiment' ? 'Strategy Switches' : 'Initial Capital'} value={mode === 'sentiment' ? (switches.length) : `$${result.result?.initial_capital?.toLocaleString()}`} />
      </div>

      <div className="card space-y-4">
        <div className="flex gap-2 border-b border-dark-500 pb-3 flex-wrap">
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors capitalize ${
                activeTab === tab
                  ? mode === 'sentiment'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
              }`}
            >
              {tab === 'equity' ? 'Equity Curve' : tab === 'price' ? 'Price Chart' : tab === 'trades' ? 'Trade Log' : 'Strategy Switches'}
            </button>
          ))}
        </div>

        <div className={activeTab === 'equity' ? '' : 'hidden'}>
          <EquityChart data={result.result?.equity_curve ?? []} initialCapital={result.result?.initial_capital} height={300} />
        </div>

        <div className={activeTab === 'price' ? '' : 'hidden'}>
          <SubplotChart data={result.result?.ohlcv ?? []} height={240} />
        </div>

        <div className={activeTab === 'trades' ? '' : 'hidden'}>
          <div className="table-container max-h-80 overflow-y-auto">
            <table>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Entry $</th>
                  <th>Exit $</th>
                  <th>Qty</th>
                  {mode === 'sentiment' ? <><th>Strategy</th><th>Bucket</th></> : <><th>Buy Reason</th><th>Sell Reason</th></>}
                  <th>P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{t.entry_date}</td>
                    <td className="font-mono text-xs">{t.exit_date}</td>
                    <td className="font-mono">${t.entry_price}</td>
                    <td className="font-mono">${t.exit_price}</td>
                    <td>{t.quantity}</td>
                    {mode === 'sentiment' ? (
                      <>
                        <td className="text-xs text-indigo-300">{t.entry_strategy ?? '—'}</td>
                        <td>{t.entry_bucket ? <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${bucketClass(t.entry_bucket)}`}>{t.entry_bucket}</span> : '—'}</td>
                      </>
                    ) : (
                      <>
                        <td><ReasonBadge value={t.entry_reason} /></td>
                        <td><ReasonBadge value={t.exit_reason} /></td>
                      </>
                    )}
                    <td className={t.pnl >= 0 ? 'pos' : 'neg'}>{t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!trades.length && <div className="text-center text-slate-500 text-sm py-8">No trades executed</div>}
          </div>
        </div>

        {mode === 'sentiment' && (
          <div className={activeTab === 'switches' ? '' : 'hidden'}>
            {switches.length === 0 ? (
              <div className="text-center text-slate-500 text-sm py-8">No strategy switches occurred</div>
            ) : (
              <div className="space-y-0 max-h-80 overflow-y-auto">
                <div className="grid grid-cols-4 text-xs text-slate-500 uppercase tracking-wider px-2 pb-1 border-b border-dark-600">
                  <span>Date</span><span>From</span><span>To</span><span>Sentiment</span>
                </div>
                {switches.map((sw, i) => (
                  <div key={i} className="grid grid-cols-4 items-center text-xs py-1.5 px-2 border-b border-dark-700/50 hover:bg-dark-800/30">
                    <span className="font-mono text-slate-500">{sw.date}</span>
                    <span className="text-slate-400">{sw.from ?? <span className="text-slate-600">start</span>}</span>
                    <span className="text-indigo-300 font-medium">{sw.to}</span>
                    <span><span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold ${bucketClass(sw.bucket)}`}>{sw.bucket}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {result?.html_report_path && (
        <div className="flex items-center justify-between gap-2 p-3 bg-emerald-900/20 border border-emerald-700/30 rounded-lg text-sm text-emerald-400">
          <span className="flex items-center gap-2">
            <span>Backtest complete — report saved.</span>
          </span>
          <a
            href={`/report-files/${getReportFilename(result.html_report_path)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-xs flex items-center gap-1"
          >
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            HTML Report
          </a>
          {result?.script_snapshot && (
            <button
              type="button"
              onClick={() => {
                const blob = new Blob([result.script_snapshot], { type: 'text/plain' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `${result.name ?? 'backtest_script'}.py`
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
    </div>
  )
}