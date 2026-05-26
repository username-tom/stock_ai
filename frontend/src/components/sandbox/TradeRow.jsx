import { fmt } from './sandboxHelpers'

export default function TradeRow({ trade }) {
  const isBuy = trade.side === 'BUY'
  return (
    <tr>
      <td className="text-slate-400 text-xs whitespace-nowrap">{trade.created_at ? new Date(trade.created_at).toLocaleString() : '—'}</td>
      <td><span className={`px-1.5 py-0.5 rounded text-xs font-bold ${isBuy ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-900/30 text-red-400'}`}>{trade.side}</span></td>
      <td className="font-mono text-slate-200">{trade.quantity}</td>
      <td className="font-mono text-slate-200">${trade.price?.toFixed(2)}</td>
      <td className="font-mono text-slate-200">${trade.total?.toFixed(2)}</td>
      <td className={`font-mono text-xs ${trade.pnl == null ? 'text-slate-600' : trade.pnl > 0 ? 'text-emerald-400' : trade.pnl < 0 ? 'text-red-400' : 'text-slate-400'}`}>{trade.pnl != null ? fmt(trade.pnl) : '—'}</td>
      <td className="text-slate-500 text-xs max-w-xs truncate" title={trade.reason}>{trade.reason || '—'}</td>
      <td className="text-slate-500 text-xs whitespace-nowrap">{trade.strategy_name?.split(':')[0] || '—'}</td>
    </tr>
  )
}
