import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-dark-700 border border-dark-500 rounded-lg p-3 text-sm shadow-xl">
      <div className="text-slate-400 mb-1">{label}</div>
      <div className="text-emerald-400 font-bold">
        ${parseFloat(payload[0].value).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </div>
    </div>
  )
}

export default function EquityChart({ data = [], initialCapital = 10000, height = 280 }) {
  if (!data.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
      No equity data available
    </div>
  )

  const min = Math.min(...data.map(d => d.value)) * 0.99
  const max = Math.max(...data.map(d => d.value)) * 1.01

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#4ade80" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="date"
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[min, max]}
          tick={{ fill: '#64748b', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
          width={55}
        />
        <Tooltip content={<CustomTooltip />} />
        <ReferenceLine y={initialCapital} stroke="#64748b" strokeDasharray="4 4" />
        <Area
          type="monotone"
          dataKey="value"
          stroke="#4ade80"
          strokeWidth={2}
          fill="url(#equityGrad)"
          dot={false}
          activeDot={{ r: 4, fill: '#4ade80' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
