import {
  ComposedChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Scatter,
} from 'recharts'

const PriceTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const chg = d.prev_close != null ? d.close - d.prev_close : null
  const chgPct = d.prev_close != null ? (chg / d.prev_close) * 100 : null
  const pos = chg == null || chg >= 0
  return (
    <div className="bg-[#1e293b] border border-[#334155] rounded-lg p-3 text-xs shadow-xl space-y-1 min-w-[160px]">
      <div className="text-slate-400 font-medium mb-1">{label}</div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Open</span><span className="text-slate-200">${d.open?.toFixed(2) ?? '—'}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">High</span><span className="text-emerald-400">${d.high?.toFixed(2) ?? '—'}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Low</span><span className="text-red-400">${d.low?.toFixed(2) ?? '—'}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Close</span><span className="text-slate-200 font-bold">${d.close?.toFixed(2) ?? '—'}</span></div>
      {chg != null && (
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">Change</span>
          <span className={`font-mono font-semibold ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
            {pos ? '+' : ''}{chg.toFixed(2)} ({pos ? '+' : ''}{chgPct.toFixed(2)}%)
          </span>
        </div>
      )}
      {d.volume != null && (
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">Vol</span>
          <span className="text-slate-400 font-mono">
            {d.volume >= 1e6 ? `${(d.volume / 1e6).toFixed(2)}M` : `${(d.volume / 1e3).toFixed(0)}K`}
          </span>
        </div>
      )}
    </div>
  )
}

export default function PriceChart({ data = [], height = 280, prevClose }) {
  if (!data.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
      No price data available
    </div>
  )

  // Subsample for performance, always keep signal bars
  const step = Math.max(1, Math.floor(data.length / 300))
  const sampled = data.filter((_, i) => i % step === 0 || data[i].signal !== 0)

  const lastClose = sampled[sampled.length - 1]?.close
  const base = prevClose ?? sampled[0]?.close
  const isUp = base == null || lastClose >= base
  const lineColor = isUp ? '#22c55e' : '#ef4444'
  const fillId = `price-grad-${isUp ? 'up' : 'dn'}`

  const maxVol = Math.max(...sampled.map(d => d.volume ?? 0))

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={sampled} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={lineColor} stopOpacity={0.25} />
            <stop offset="95%" stopColor={lineColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid horizontal={false} vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: '#1e293b' }}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="price"
          orientation="right"
          domain={['auto', 'auto']}
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={65}
          tickFormatter={v => `$${v.toFixed(0)}`}
        />
        <YAxis yAxisId="vol" orientation="left" domain={[0, maxVol * 5]} hide />
        <Tooltip content={<PriceTooltip />} />
        {prevClose != null && (
          <ReferenceLine
            yAxisId="price"
            y={prevClose}
            stroke="#64748b"
            strokeDasharray="4 3"
            strokeWidth={1}
            label={{ value: `Prev ${prevClose.toFixed(2)}`, position: 'right', fill: '#64748b', fontSize: 9 }}
          />
        )}
        <Bar yAxisId="vol" dataKey="volume" fill="#475569" opacity={0.25} isAnimationActive={false} />
        <Area
          yAxisId="price"
          type="monotone"
          dataKey="close"
          stroke={lineColor}
          strokeWidth={1.5}
          fill={`url(#${fillId})`}
          dot={false}
          activeDot={{ r: 3, fill: lineColor }}
          isAnimationActive={false}
        />
        {/* Buy/sell signal markers */}
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

