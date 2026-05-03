import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { enrichData } from './indicators'

const PRICE_COLOR = '#94a3b8'
const BB_UPPER = '#60a5fa'
const BB_LOWER = '#f472b6'
const BB_MID = '#fbbf24'
const FAST_MA = '#facc15'
const SLOW_MA = '#fb923c'
const RSI_COLOR = '#a78bfa'
const MACD_COLOR = '#60a5fa'
const SIGNAL_COLOR = '#f97316'
const BUY_COLOR = '#4ade80'
const SELL_COLOR = '#f87171'

const sharedXAxis = (
  <XAxis
    dataKey="date"
    tick={{ fill: '#64748b', fontSize: 10 }}
    tickLine={false}
    axisLine={false}
    interval="preserveStartEnd"
  />
)

function PriceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-dark-700 border border-dark-500 rounded-lg p-3 text-xs shadow-xl space-y-0.5 min-w-[160px]">
      <div className="text-slate-400 font-medium mb-1">{label}</div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Close</span><span className="text-slate-200 font-bold">${d.close}</span></div>
      {d.rsi != null && <div className="flex justify-between gap-4"><span className="text-slate-500">RSI</span><span className="text-purple-400">{d.rsi?.toFixed(2)}</span></div>}
      {d.macd != null && <div className="flex justify-between gap-4"><span className="text-slate-500">MACD</span><span className="text-blue-400">{d.macd?.toFixed(4)}</span></div>}
    </div>
  )
}

export default function SubplotChart({ data = [], height = 240 }) {
  if (!data.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
      No price data available
    </div>
  )

  const enriched = enrichData(data)
  const step = Math.max(1, Math.floor(enriched.length / 300))
  const sampled = enriched.filter((_, i) => i % step === 0)

  const hasRSI = sampled.some(d => d.rsi != null)
  const hasMACD = sampled.some(d => d.macd != null)
  const hasBB = sampled.some(d => d.upper != null)
  const hasFastMA = sampled.some(d => d.fast_ma != null)
  const hasSlowMA = sampled.some(d => d.slow_ma != null)

  const oscPanels = []
  if (hasRSI) oscPanels.push('rsi')
  if (hasMACD) oscPanels.push('macd')

  const priceHeight = height
  const oscHeight = 100

  return (
    <div className="space-y-1">
      {/* Price panel */}
      <ResponsiveContainer width="100%" height={priceHeight}>
        <ComposedChart data={sampled} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          {sharedXAxis}
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={60}
            tickFormatter={v => `$${v.toFixed(0)}`}
          />
          <Tooltip content={<PriceTooltip />} />
          <Line type="monotone" dataKey="close" stroke={PRICE_COLOR} strokeWidth={1.5} dot={false} name="Close" />
          {hasBB && <Line type="monotone" dataKey="upper" stroke={BB_UPPER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} name="BB Upper" />}
          {hasBB && <Line type="monotone" dataKey="lower" stroke={BB_LOWER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} name="BB Lower" />}
          {hasBB && <Line type="monotone" dataKey="mid" stroke={BB_MID} strokeWidth={0.8} strokeDasharray="2 2" dot={false} name="BB Mid" />}
          {hasFastMA && <Line type="monotone" dataKey="fast_ma" stroke={FAST_MA} strokeWidth={0.9} dot={false} name="Fast MA" />}
          {hasSlowMA && <Line type="monotone" dataKey="slow_ma" stroke={SLOW_MA} strokeWidth={0.9} dot={false} name="Slow MA" />}
        </ComposedChart>
      </ResponsiveContainer>

      {/* RSI panel */}
      {hasRSI && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart data={sampled} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            {sharedXAxis}
            <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={60} />
            <Tooltip formatter={(v) => v?.toFixed(2)} />
            <ReferenceLine y={70} stroke={SELL_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={30} stroke={BUY_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line type="monotone" dataKey="rsi" stroke={RSI_COLOR} strokeWidth={1} dot={false} name="RSI" />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* MACD panel */}
      {hasMACD && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart data={sampled} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            {sharedXAxis}
            <YAxis domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={60} tickFormatter={v => v?.toFixed(2)} />
            <Tooltip formatter={(v) => v?.toFixed(4)} />
            <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.7} />
            <Bar dataKey="macd_hist" fill="#4ade80" opacity={0.5} name="Histogram"
              label={false}
              isAnimationActive={false}
            />
            <Line type="monotone" dataKey="macd" stroke={MACD_COLOR} strokeWidth={1} dot={false} name="MACD" />
            <Line type="monotone" dataKey="macd_signal" stroke={SIGNAL_COLOR} strokeWidth={0.9} strokeDasharray="4 2" dot={false} name="Signal" />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
