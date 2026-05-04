import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'

const CustomTooltip = ({ active, payload, label, initialCapital }) => {
  if (!active || !payload?.length) return null
  const value = payload[0]?.value
  const chg = initialCapital != null ? value - initialCapital : null
  const chgPct = initialCapital != null ? (chg / initialCapital) * 100 : null
  const pos = chg == null || chg >= 0
  return (
    <div className="bg-[#1e293b] border border-[#334155] rounded-lg p-3 text-xs shadow-xl space-y-1 min-w-[160px]">
      <div className="text-slate-400 font-medium mb-1">{label}</div>
      <div className="flex justify-between gap-4">
        <span className="text-slate-500">Equity</span>
        <span className="text-slate-100 font-bold font-mono">
          ${parseFloat(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      {chg != null && (
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">P&amp;L</span>
          <span className={`font-mono font-semibold ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
            {pos ? '+' : ''}${chg.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({pos ? '+' : ''}{chgPct.toFixed(2)}%)
          </span>
        </div>
      )}
    </div>
  )
}

export default function EquityChart({ data = [], initialCapital = 10000, height = 280 }) {
  if (!data.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
      No equity data available
    </div>
  )

  const lastValue = data[data.length - 1]?.value
  const isUp = lastValue >= initialCapital
  const lineColor = isUp ? '#22c55e' : '#ef4444'
  const fillId = isUp ? 'equityGradUp' : 'equityGradDn'

  const min = Math.min(...data.map(d => d.value), initialCapital) * 0.995
  const max = Math.max(...data.map(d => d.value), initialCapital) * 1.005

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
          orientation="right"
          domain={[min, max]}
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
          width={55}
        />
        <Tooltip content={<CustomTooltip initialCapital={initialCapital} />} />
        <ReferenceLine
          y={initialCapital}
          stroke="#64748b"
          strokeDasharray="4 3"
          strokeWidth={1}
          label={{ value: `Start $${(initialCapital / 1000).toFixed(0)}k`, position: 'right', fill: '#64748b', fontSize: 9 }}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={lineColor}
          strokeWidth={1.5}
          fill={`url(#${fillId})`}
          dot={false}
          activeDot={{ r: 4, fill: lineColor }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

