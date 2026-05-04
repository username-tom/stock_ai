import { fmtMoney } from './sandboxHelpers'

export default function PieTooltipContent({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-dark-800 border border-dark-500 rounded-lg p-3 text-xs shadow-xl">
      <div className="font-bold text-slate-100 mb-1">{d.symbol}</div>
      <div className="text-slate-400">Shares: <span className="text-slate-200">{d.shares?.toFixed(4)}</span></div>
      {d.mv > 0 && <div className="text-slate-400">Market Value: <span className="text-emerald-300">{fmtMoney(d.mv)}</span></div>}
      {d.cash > 0 && <div className="text-slate-400">Allocated Cash: <span className="text-blue-300">{fmtMoney(d.cash)}</span></div>}
      <div className="text-slate-400">Total Slice: <span className="text-slate-200">{fmtMoney(d.market_value)}</span></div>
      <div className="text-slate-400">Portfolio %: <span className="text-slate-200">{d.pct}%</span></div>
    </div>
  )
}
