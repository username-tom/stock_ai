import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getReports, getReport, deleteReport } from '../api/client'
import EquityChart from './charts/EquityChart'
import {
  DocumentChartBarIcon,
  TrashIcon,
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'

function MetricBadge({ value, isPositive }) {
  if (value == null) return <span className="text-slate-500">—</span>
  const pos = isPositive ?? value >= 0
  return (
    <span className={pos ? 'pos' : 'neg'}>
      {value >= 0 ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

export default function ReportsPanel() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState(null)

  const { data: listData, isLoading } = useQuery({
    queryKey: ['reports'],
    queryFn: getReports,
  })

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['report', selected],
    queryFn: () => getReport(selected),
    enabled: !!selected,
  })

  const deleteMut = useMutation({
    mutationFn: deleteReport,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports'] })
      if (detail?.id === selected) setSelected(null)
    },
  })

  const reports = listData?.reports ?? []

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Reports</h1>
        <p className="text-sm text-slate-400 mt-0.5">Saved backtest reports</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* List */}
        <div className="card xl:col-span-1 space-y-2 max-h-[80vh] overflow-y-auto">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
            {reports.length} Report{reports.length !== 1 ? 's' : ''}
          </h2>
          {isLoading && (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-16 bg-dark-700 rounded-lg animate-pulse" />
              ))}
            </div>
          )}
          {!isLoading && reports.length === 0 && (
            <div className="text-center text-slate-500 text-sm py-12">
              <DocumentChartBarIcon className="h-8 w-8 mx-auto mb-2 text-slate-600" />
              No reports yet. Run a backtest first.
            </div>
          )}
          {reports.map(r => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={`w-full text-left p-3 rounded-lg border transition-all ${
                selected === r.id
                  ? 'border-emerald-600/50 bg-emerald-600/10'
                  : 'border-dark-500 hover:border-dark-400 bg-dark-900/30 hover:bg-dark-700/50'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm text-slate-200 truncate">{r.symbol}</div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">
                    {r.strategy_type.replace(/_/g, ' ')} · {r.start_date} → {r.end_date}
                  </div>
                </div>
                <div className="flex-shrink-0 text-right">
                  <div className={`text-sm font-mono font-bold ${r.total_return_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.total_return_pct >= 0 ? '+' : ''}{r.total_return_pct?.toFixed(1)}%
                  </div>
                  <div className="text-xs text-slate-500">{r.total_trades} trades</div>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Detail */}
        <div className="xl:col-span-2 space-y-5">
          {selected && detail && !detailLoading ? (
            <>
              <div className="card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 className="font-bold text-lg text-slate-100">{detail.symbol} — {detail.strategy_type}</h2>
                    <p className="text-sm text-slate-400">{detail.start_date} → {detail.end_date}</p>
                  </div>
                  <div className="flex gap-2">
                    {detail.html_report_path && (
                      <a
                        href={`/reports/${detail.html_report_path.split('/').pop()}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary text-xs"
                      >
                        <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                        HTML Report
                      </a>
                    )}
                    <button
                      onClick={() => deleteMut.mutate(detail.id)}
                      className="btn-danger text-xs"
                      disabled={deleteMut.isPending}
                    >
                      <TrashIcon className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Return', value: detail.metrics?.total_return_pct, unit: '%', isReturn: true },
                    { label: 'Annualised', value: detail.metrics?.annualized_return_pct, unit: '%', isReturn: true },
                    { label: 'Sharpe Ratio', value: detail.metrics?.sharpe_ratio, unit: '' },
                    { label: 'Max Drawdown', value: detail.metrics?.max_drawdown_pct, unit: '%', forceNeg: true },
                    { label: 'Win Rate', value: detail.metrics?.win_rate_pct, unit: '%' },
                    { label: 'Total Trades', value: detail.metrics?.total_trades, noColor: true },
                    { label: 'Final Value', value: detail.metrics?.final_value, prefix: '$', noColor: true },
                    { label: 'Initial Capital', value: detail.initial_capital, prefix: '$', noColor: true },
                  ].map(m => (
                    <div key={m.label} className="metric-card">
                      <div className="metric-label">{m.label}</div>
                      <div className={`metric-value ${
                        m.noColor ? 'text-slate-100' :
                        m.forceNeg ? 'text-red-400' :
                        m.isReturn ? (m.value >= 0 ? 'text-emerald-400' : 'text-red-400') :
                        m.value >= 1 ? 'text-emerald-400' : 'text-slate-100'
                      } text-lg`}>
                        {m.prefix}{typeof m.value === 'number'
                          ? m.noColor ? m.value?.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : (m.value >= 0 && m.isReturn ? '+' : '') + m.value?.toFixed(2)
                          : '—'}{m.unit}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Equity curve */}
              {detail.result_data?.equity_curve?.length > 0 && (
                <div className="card">
                  <h3 className="font-medium text-slate-200 mb-4">Equity Curve</h3>
                  <EquityChart
                    data={detail.result_data.equity_curve}
                    initialCapital={detail.initial_capital}
                    height={260}
                  />
                </div>
              )}

              {/* Trades */}
              {detail.result_data?.trades?.length > 0 && (
                <div className="card">
                  <h3 className="font-medium text-slate-200 mb-3">
                    Trade Log ({detail.result_data.trades.length} trades)
                  </h3>
                  <div className="table-container max-h-72 overflow-y-auto">
                    <table>
                      <thead>
                        <tr>
                          <th>Entry</th><th>Exit</th>
                          <th>Entry $</th><th>Exit $</th>
                          <th>Qty</th><th>P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.result_data.trades.map((t, i) => (
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
                  </div>
                </div>
              )}
            </>
          ) : selected && detailLoading ? (
            <div className="card h-64 flex items-center justify-center text-slate-500 text-sm">
              Loading report…
            </div>
          ) : (
            <div className="card flex flex-col items-center justify-center h-64 text-slate-500">
              <ChevronRightIcon className="h-10 w-10 mb-3 text-slate-600" />
              <p className="font-medium">Select a report to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
