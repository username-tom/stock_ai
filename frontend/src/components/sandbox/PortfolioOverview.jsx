import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts'
import {
  HomeIcon, ChartPieIcon, TableCellsIcon,
} from '@heroicons/react/24/outline'
import { PIE_COLORS } from './sandboxConstants'
import { fmt, fmtMoney } from './sandboxHelpers'
import PieTooltipContent from './PieTooltipContent'
import PortfolioManagerPanel from './PortfolioManagerPanel'

export default function PortfolioOverview({
  ibMode,
  accountData,
  positions,
  quotes,
  totalEquity,
  totalUnrealizedPnl,
  totalRealizedPnl,
  pieData,
  analytics,
  onSelectSymbol,
}) {
  return (
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

      {/* Portfolio Manager */}
      <PortfolioManagerPanel />

      {/* Pie chart + breakdown table */}
      {pieData.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Pie */}
          <div className="card lg:col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <ChartPieIcon className="h-4 w-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Allocation by Market Value</h2>
            </div>
            <div style={{ height: 320 + Math.ceil(pieData.length / 2) * 24 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 20, right: 20, bottom: 0, left: 20 }}>
                  <Pie
                    data={pieData}
                    cx="50%" cy="42%"
                    innerRadius={65} outerRadius={105}
                    paddingAngle={2}
                    dataKey="market_value"
                    label={false}
                    labelLine={false}
                  >
                    {pieData.map((e, i) => (
                      <Cell key={e.symbol} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<PieTooltipContent />} />
                  <Legend
                    iconType="circle"
                    iconSize={9}
                    layout="horizontal"
                    verticalAlign="bottom"
                    align="center"
                    wrapperStyle={{ fontSize: 11, paddingTop: 16 }}
                    formatter={(value, entry) => (
                      <span style={{ color: '#cbd5e1' }}>
                        <span style={{ color: entry.color, fontWeight: 700 }}>{entry.payload.symbol}</span>
                        {' '}<span style={{ color: '#64748b' }}>{entry.payload.pct}%</span>
                      </span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
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
                        onClick={() => onSelectSymbol(pos.symbol)}
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

      {/* Analytics Charts */}
      {analytics && analytics.total_trades > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Portfolio Performance Over Time</h2>

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
                      <Bar dataKey="realized_pnl" name="Realised P&L" radius={[0, 3, 3, 0]}>
                        {analytics.symbol_pnl.map((entry) => (
                          <Cell key={entry.symbol} fill={entry.realized_pnl >= 0 ? '#10b981' : '#ef4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

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
  )
}
