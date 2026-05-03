import {
  ComposedChart, Line, Bar, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
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

// ---------------------------------------------------------------------------
// 1D Yahoo-style chart
// ---------------------------------------------------------------------------

function OneDayTooltip({ active, payload, label, prevClose }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const chg = prevClose != null ? d.close - prevClose : null
  const chgPct = prevClose != null ? (chg / prevClose) * 100 : null
  const pos = chg == null || chg >= 0
  return (
    <div className="bg-[#1e293b] border border-[#334155] rounded-lg p-3 text-xs shadow-xl space-y-1 min-w-[170px]">
      <div className="text-slate-400 font-medium">{label}</div>
      <div className="flex justify-between gap-4">
        <span className="text-slate-500">Price</span>
        <span className="text-slate-100 font-bold font-mono">${d.close?.toFixed(2)}</span>
      </div>
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
      {d.rsi != null && <div className="flex justify-between gap-4"><span className="text-slate-500">RSI</span><span className="text-purple-400">{d.rsi?.toFixed(2)}</span></div>}
      {d.macd != null && <div className="flex justify-between gap-4"><span className="text-slate-500">MACD</span><span className="text-blue-400">{d.macd?.toFixed(4)}</span></div>}
    </div>
  )
}

function OneDayChart({ data, height, indicators, prevClose }) {
  if (!data.length) return null

  const enriched = enrichData(data)

  const lastClose = enriched[enriched.length - 1]?.close
  const isUp = prevClose == null || lastClose >= prevClose
  const lineColor = isUp ? '#22c55e' : '#ef4444'
  const fillColor = isUp ? '#22c55e' : '#ef4444'

  const timeOf = (d) => d.date?.slice(6) ?? ''   // "HH:MM"
  const dayOf  = (d) => d.date?.slice(0, 5) ?? '' // "MM/DD"

  const days = [...new Set(enriched.map(dayOf))]

  // Split each bar into session segments.
  // The last pre-market bar and last regular bar are shared into the next
  // segment so the three lines connect visually at 09:30 and 16:00.
  const segmented = enriched.map((d, i) => {
    const t = timeOf(d)
    const nextT = i < enriched.length - 1 ? timeOf(enriched[i + 1]) : ''
    const inPre     = t < '09:30'
    const inRegular = t >= '09:30' && t < '16:00'
    const inPost    = t >= '16:00'
    const isLastPre     = inPre     && nextT >= '09:30'          // 09:29 → shared with regular
    const isLastRegular = inRegular && (nextT >= '16:00' || nextT === '') // 15:59 → shared with post
    return {
      ...d,
      preClose:     inPre                           ? d.close : null,
      regularClose: inRegular || isLastPre          ? d.close : null,
      postClose:    inPost    || isLastRegular      ? d.close : null,
    }
  })

  // X-axis ticks: first bar of each day (→ date label) + key session times
  const KEY_SESSION_TIMES = ['09:30', '12:00', '16:00']
  const dayStartTicks = days.map(day => segmented.find(d => dayOf(d) === day)?.date).filter(Boolean)
  const sessionTicks  = segmented
    .filter(d => KEY_SESSION_TIMES.includes(timeOf(d)))
    .map(d => d.date)
  const allTicks = [...new Set([...dayStartTicks, ...sessionTicks])].sort()

  const formatTick = (val) => {
    if (!val) return ''
    const t = timeOf({ date: val })
    // First bar of a day → show MM/DD date
    if (dayStartTicks.includes(val)) return dayOf({ date: val })
    return t
  }

  // Day separator vertical lines
  const dayLines = days.slice(1).map(day => segmented.find(d => dayOf(d) === day)?.date).filter(Boolean)

  // Subtle background tint for off-hours zones only
  const sessionAreas = []
  days.forEach(day => {
    const dayData = segmented.filter(d => dayOf(d) === day)
    const pre  = dayData.filter(d => timeOf(d) < '09:30')
    const post = dayData.filter(d => timeOf(d) >= '16:00')
    if (pre.length)  sessionAreas.push({ x1: pre[0].date,  x2: pre[pre.length - 1].date })
    if (post.length) sessionAreas.push({ x1: post[0].date, x2: post[post.length - 1].date })
  })

  const maxVol = Math.max(...segmented.map(d => d.volume ?? 0))

  const hasRSI    = (indicators.rsi    !== false) && segmented.some(d => d.rsi     != null)
  const hasMACD   = (indicators.macd   !== false) && segmented.some(d => d.macd    != null)
  const hasBB     = (indicators.bb     !== false) && segmented.some(d => d.upper   != null)
  const hasFastMA = (indicators.fastMa !== false) && segmented.some(d => d.fast_ma != null)
  const hasSlowMA = (indicators.slowMa !== false) && segmented.some(d => d.slow_ma != null)

  const oscHeight = 90
  const gradId = `1d-grad-${isUp ? 'up' : 'dn'}`

  const offHourLine = { strokeWidth: 1, stroke: '#475569', strokeDasharray: '3 2' }

  const xAxisProps = {
    dataKey: 'date',
    ticks: allTicks,
    tickFormatter: formatTick,
    tick: { fill: '#64748b', fontSize: 10 },
    tickLine: false,
    axisLine: { stroke: '#1e293b' },
    interval: 0,
  }

  return (
    <div className="space-y-0.5">
      {/* Price + Volume panel */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={segmented} margin={{ top: 8, right: 64, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={fillColor} stopOpacity={0.25} />
              <stop offset="95%" stopColor={fillColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid horizontal={false} vertical={false} />
          <XAxis {...xAxisProps} />
          <YAxis
            yAxisId="price"
            orientation="right"
            domain={['auto', 'auto']}
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={58}
            tickFormatter={v => `$${v.toFixed(2)}`}
          />
          <YAxis yAxisId="vol" orientation="left" domain={[0, maxVol * 5]} hide />
          <Tooltip content={<OneDayTooltip prevClose={prevClose} />} />

          {/* Subtle off-hours background tint */}
          {sessionAreas.map((a, i) => (
            <ReferenceArea key={`off-${i}`} yAxisId="price" x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
          ))}

          {/* Day separator */}
          {dayLines.map((x, i) => (
            <ReferenceLine key={`day-${i}`} yAxisId="price" x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
          ))}

          {/* Previous close reference */}
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

          <Bar yAxisId="vol" dataKey="volume" fill="#475569" opacity={0.3} isAnimationActive={false} />

          {/* Gradient fill under regular session only */}
          <Area
            yAxisId="price"
            type="monotone"
            dataKey="regularClose"
            stroke="none"
            fill={`url(#${gradId})`}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
            legendType="none"
            tooltipType="none"
          />

          {/* Pre-market: muted dashed line */}
          <Line yAxisId="price" type="monotone" dataKey="preClose"     {...offHourLine} dot={false} connectNulls={false} isAnimationActive={false} name="Pre" />
          {/* Regular session: full-color solid line */}
          <Line yAxisId="price" type="monotone" dataKey="regularClose" stroke={lineColor} strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} name="Close" />
          {/* Post-market: muted dashed line */}
          <Line yAxisId="price" type="monotone" dataKey="postClose"    {...offHourLine} dot={false} connectNulls={false} isAnimationActive={false} name="After" />

          {hasBB && <Line yAxisId="price" type="monotone" dataKey="upper"   stroke={BB_UPPER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} isAnimationActive={false} />}
          {hasBB && <Line yAxisId="price" type="monotone" dataKey="lower"   stroke={BB_LOWER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} isAnimationActive={false} />}
          {hasBB && <Line yAxisId="price" type="monotone" dataKey="mid"     stroke={BB_MID}   strokeWidth={0.8} strokeDasharray="2 2" dot={false} isAnimationActive={false} />}
          {hasFastMA && <Line yAxisId="price" type="monotone" dataKey="fast_ma" stroke={FAST_MA} strokeWidth={0.9} dot={false} isAnimationActive={false} />}
          {hasSlowMA && <Line yAxisId="price" type="monotone" dataKey="slow_ma" stroke={SLOW_MA} strokeWidth={0.9} dot={false} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>

      {/* RSI panel */}
      {hasRSI && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart data={segmented} margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis {...xAxisProps} />
            <YAxis orientation="right" domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={58} />
            <Tooltip formatter={(v) => v?.toFixed(2)} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-r-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
            ))}
            {dayLines.map((x, i) => (
              <ReferenceLine key={`day-r-${i}`} x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            <ReferenceLine y={70} stroke={SELL_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={30} stroke={BUY_COLOR}  strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line type="monotone" dataKey="rsi" stroke={RSI_COLOR} strokeWidth={1} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* MACD panel */}
      {hasMACD && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart data={segmented} margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis {...xAxisProps} />
            <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={58} tickFormatter={v => v?.toFixed(2)} />
            <Tooltip formatter={(v) => v?.toFixed(4)} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-m-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
            ))}
            {dayLines.map((x, i) => (
              <ReferenceLine key={`day-m-${i}`} x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.7} />
            <Bar dataKey="macd_hist" fill="#4ade80" opacity={0.5} isAnimationActive={false} label={false} />
            <Line type="monotone" dataKey="macd"        stroke={MACD_COLOR}   strokeWidth={1}   dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="macd_signal" stroke={SIGNAL_COLOR} strokeWidth={0.9} strokeDasharray="4 2" dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session shading helpers for 5d
// ---------------------------------------------------------------------------

/**
 * For 5d (MM/DD HH:MM) data, compute off-market areas and day separator lines.
 */
function buildSessionAreas(sampled, period) {
  if (period !== '5d') return { areas: [], dayLines: [] }

  const areas = []
  const dayLines = []
  const days = [...new Set(sampled.map(d => d.date.slice(0, 5)))]
  days.forEach((day, i) => {
    const dayData = sampled.filter(d => d.date.startsWith(day))
    if (!dayData.length) return
    if (i > 0) dayLines.push(dayData[0].date)
    const pre  = dayData.filter(d => d.date < `${day} 09:30`)
    const post = dayData.filter(d => d.date >= `${day} 16:00`)
    if (pre.length)  areas.push({ x1: pre[0].date,  x2: pre[pre.length - 1].date })
    if (post.length) areas.push({ x1: post[0].date, x2: post[post.length - 1].date })
  })
  return { areas, dayLines }
}

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

export default function SubplotChart({ data = [], height = 240, indicators = {}, period = '', prevClose }) {
  if (!data.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
      No price data available
    </div>
  )

  // 1D and 2D get the Yahoo-style pre/regular/post chart
  if (period === '1d' || period === '2d') {
    return <OneDayChart data={data} height={height} indicators={indicators} prevClose={prevClose} />
  }

  const enriched = enrichData(data)
  const step = Math.max(1, Math.floor(enriched.length / 300))
  const sampled = enriched.filter((_, i) => i % step === 0)

  const { areas: sessionAreas, dayLines } = buildSessionAreas(sampled, period)

  const hasRSI  = (indicators.rsi    !== false) && sampled.some(d => d.rsi     != null)
  const hasMACD = (indicators.macd   !== false) && sampled.some(d => d.macd    != null)
  const hasBB   = (indicators.bb     !== false) && sampled.some(d => d.upper   != null)
  const hasFastMA = (indicators.fastMa !== false) && sampled.some(d => d.fast_ma != null)
  const hasSlowMA = (indicators.slowMa !== false) && sampled.some(d => d.slow_ma != null)

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
          {sessionAreas.map((a, i) => (
            <ReferenceArea key={`off-p-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
          ))}
          {dayLines.map((d, i) => (
            <ReferenceLine key={`day-p-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
          ))}
          <Line type="monotone" dataKey="close" stroke={PRICE_COLOR} strokeWidth={1.5} dot={false} name="Close" isAnimationActive={false} />
          {hasBB && <Line type="monotone" dataKey="upper" stroke={BB_UPPER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} name="BB Upper" isAnimationActive={false} />}
          {hasBB && <Line type="monotone" dataKey="lower" stroke={BB_LOWER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} name="BB Lower" isAnimationActive={false} />}
          {hasBB && <Line type="monotone" dataKey="mid" stroke={BB_MID} strokeWidth={0.8} strokeDasharray="2 2" dot={false} name="BB Mid" isAnimationActive={false} />}
          {hasFastMA && <Line type="monotone" dataKey="fast_ma" stroke={FAST_MA} strokeWidth={0.9} dot={false} name="Fast MA" isAnimationActive={false} />}
          {hasSlowMA && <Line type="monotone" dataKey="slow_ma" stroke={SLOW_MA} strokeWidth={0.9} dot={false} name="Slow MA" isAnimationActive={false} />}
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
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-r-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-r-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            <ReferenceLine y={70} stroke={SELL_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={30} stroke={BUY_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line type="monotone" dataKey="rsi" stroke={RSI_COLOR} strokeWidth={1} dot={false} name="RSI" isAnimationActive={false} />
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
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-m-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-m-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.7} />
            <Bar dataKey="macd_hist" fill="#4ade80" opacity={0.5} name="Histogram"
              label={false}
              isAnimationActive={false}
            />
            <Line type="monotone" dataKey="macd" stroke={MACD_COLOR} strokeWidth={1} dot={false} name="MACD" isAnimationActive={false} />
            <Line type="monotone" dataKey="macd_signal" stroke={SIGNAL_COLOR} strokeWidth={0.9} strokeDasharray="4 2" dot={false} name="Signal" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
