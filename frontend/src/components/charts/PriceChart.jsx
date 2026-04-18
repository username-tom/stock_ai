import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Scatter,
} from 'recharts'

const PriceTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-dark-700 border border-dark-500 rounded-lg p-3 text-xs shadow-xl space-y-0.5 min-w-[160px]">
      <div className="text-slate-400 font-medium mb-1">{label}</div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Open</span><span className="text-slate-200">${d.open}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">High</span><span className="text-emerald-400">${d.high}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Low</span><span className="text-red-400">${d.low}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Close</span><span className="text-slate-200 font-bold">${d.close}</span></div>
    </div>
  )
}

export default function PriceChart({ data = [], height = 280 }) {
  if (!data.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
      No price data available
    </div>
  )

  // Subsample for performance
  const step = Math.max(1, Math.floor(data.length / 300))
  const sampled = data.filter((_, i) => i % step === 0)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={sampled} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="date"
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="price"
          domain={['auto', 'auto']}
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={65}
          tickFormatter={v => `$${v.toFixed(0)}`}
        />
        <Tooltip content={<PriceTooltip />} />
        <Line
          yAxisId="price"
          type="monotone"
          dataKey="close"
          stroke="#94a3b8"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
        />
        {/* Buy signals */}
        {sampled.some(d => d.signal === 1) && (
          <Scatter
            yAxisId="price"
            dataKey="close"
            data={sampled.filter(d => d.signal === 1).map(d => ({ ...d, signalPrice: d.close }))}
            fill="#4ade80"
            shape="triangle"
            name="Buy"
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
