import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ComposedChart, Line, Bar, Area, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { enrichData, enrichDataWithWarmup } from './indicators'

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
const STOCH_K = '#34d399'
const STOCH_D = '#f59e0b'
const ATR_COLOR = '#c084fc'
const OBV_COLOR = '#38bdf8'
const MA_9   = '#22d3ee'
const MA_20  = '#facc15'
const MA_50  = '#4ade80'
const MA_100 = '#fb923c'
const MA_200 = '#c084fc'

// Custom dot renderer: draws triangle up (buy) or down (sell) on signal bars
const SignalDot = (props) => {
  const { cx, cy, payload } = props
  if (!payload?.signal || payload.signal === 0) return null
  const isBuy = payload.signal === 1
  const size = 7
  const color = isBuy ? BUY_COLOR : SELL_COLOR
  // triangle points: tip at signal side, base opposite
  const points = isBuy
    ? `${cx},${cy - size} ${cx - size},${cy + size * 0.6} ${cx + size},${cy + size * 0.6}`
    : `${cx},${cy + size} ${cx - size},${cy - size * 0.6} ${cx + size},${cy - size * 0.6}`
  return <polygon points={points} fill={color} stroke="none" opacity={0.9} />
}

// ---------------------------------------------------------------------------
// 1D Yahoo-style chart
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared tooltip helpers
// ---------------------------------------------------------------------------

const TT_BASE = "bg-[#0f172a] border border-[#1e293b] rounded-lg p-3 text-xs shadow-2xl min-w-[180px] space-y-0.5"

function fmtVol(v) {
  if (v == null) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  return `${(v / 1e3).toFixed(0)}K`
}

function fmtOBV(v) {
  if (v == null) return '—'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`
  return `${sign}${abs.toFixed(0)}`
}

function TTRow({ label, value, className = 'text-slate-200' }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-slate-500">{label}</span>
      <span className={`font-mono ${className}`}>{value}</span>
    </div>
  )
}

function TTDivider() {
  return <div className="border-t border-[#1e293b] my-1" />
}

function OneDayTooltip({ active, payload, label, prevClose, indicators = {} }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const price = d.regularClose ?? d.preClose ?? d.postClose ?? d.close
  if (price == null) return null
  const chg = prevClose != null ? price - prevClose : null
  const chgPct = prevClose != null ? (chg / prevClose) * 100 : null
  const pos = chg == null || chg >= 0
  const session = d.preClose != null && d.regularClose == null && d.postClose == null ? 'Pre-market'
    : d.postClose != null && d.regularClose == null ? 'After-hours'
    : null
  return (
    <div className={TT_BASE}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-slate-400 font-medium">{label}</span>
        {session && <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{session}</span>}
      </div>
      <TTRow label="Price" value={`$${price.toFixed(2)}`} className="text-slate-100 font-bold" />
      {chg != null && (
        <TTRow
          label="Change"
          value={`${pos ? '+' : ''}${chg.toFixed(2)} (${pos ? '+' : ''}${chgPct.toFixed(2)}%)`}
          className={pos ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}
        />
      )}
      {d.open != null && <><TTDivider /><TTRow label="Open" value={`$${d.open.toFixed(2)}`} /></>}
      {d.high != null && <TTRow label="High" value={`$${d.high.toFixed(2)}`} className="text-emerald-400" />}
      {d.low  != null && <TTRow label="Low"  value={`$${d.low.toFixed(2)}`}  className="text-red-400" />}
      {d.volume != null && <><TTDivider /><TTRow label="Vol" value={fmtVol(d.volume)} className="text-slate-400" /></>}
      {(d.upper != null || d.fast_ma != null) && <TTDivider />}
      {d.upper   != null && <TTRow label="BB Upper" value={`$${d.upper.toFixed(2)}`}   className="text-blue-400" />}
      {d.mid     != null && <TTRow label="BB Mid"   value={`$${d.mid.toFixed(2)}`}     className="text-yellow-400" />}
      {d.lower   != null && <TTRow label="BB Lower" value={`$${d.lower.toFixed(2)}`}   className="text-pink-400" />}
      {d.fast_ma != null && <TTRow label="Fast MA"  value={`$${d.fast_ma.toFixed(2)}`} className="text-yellow-300" />}
      {d.slow_ma != null && <TTRow label="Slow MA"  value={`$${d.slow_ma.toFixed(2)}`} className="text-orange-400" />}
      {indicators.ma9   !== false && d.ma_9   != null && <TTRow label="MA(9)"   value={`$${d.ma_9.toFixed(2)}`}   className="text-cyan-400" />}
      {indicators.ma20  !== false && d.ma_20  != null && <TTRow label="MA(20)"  value={`$${d.ma_20.toFixed(2)}`}  className="text-yellow-300" />}
      {indicators.ma50  !== false && d.ma_50  != null && <TTRow label="MA(50)"  value={`$${d.ma_50.toFixed(2)}`}  className="text-green-400" />}
      {indicators.ma100 !== false && d.ma_100 != null && <TTRow label="MA(100)" value={`$${d.ma_100.toFixed(2)}`} className="text-orange-400" />}
      {indicators.ma200 !== false && d.ma_200 != null && <TTRow label="MA(200)" value={`$${d.ma_200.toFixed(2)}`} className="text-purple-400" />}
    </div>
  )
}

function OneDayChart({ data, period = '1d', prevClose, syncId, indicators = {}, height = 240, hoverState = null, onHoverStateChange }) {
  if (!data.length) return null

  // Keep only the latest day(s) based on selected short period.
  // 1D -> latest day, 2D -> latest two days.
  const _dayOf = (d) => d.date?.slice(0, 5) ?? ''
  const _allDays = [...new Set(data.map(_dayOf).filter(Boolean))].sort()
  const _daysToKeep = period === '2d' ? 2 : 1
  const _keepDays = new Set(_allDays.slice(-_daysToKeep))
  const filtered = data.filter(d =>
    _keepDays.has(_dayOf(d)) &&
    d.open != null && d.high != null && d.low != null && d.close != null
  )
  if (!filtered.length) return null

  const enriched = enrichData(filtered)

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

  const externalHover = hoverState?.source === 'candlestick' ? hoverState.date : null
  const externalHoverPoint = externalHover ? segmented.find((d) => d.date === externalHover) : null

  const handleHoverMove = useCallback((event) => {
    const payload = event?.activePayload?.[0]?.payload
    const date = payload?.date ?? event?.activeLabel ?? null
    if (!date) return
    onHoverStateChange?.({ date, source: 'subplot' })
  }, [onHoverStateChange])

  const handleHoverLeave = useCallback(() => {
    onHoverStateChange?.(null)
  }, [onHoverStateChange])

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

  const allPrices = segmented.flatMap(d => [d.preClose, d.regularClose, d.postClose].filter(v => v != null))
  const yMin = allPrices.length ? Math.min(...allPrices) : null
  const yMax = allPrices.length ? Math.max(...allPrices) : null
  const prevCloseInRange = prevClose == null || yMin == null || (prevClose >= yMin && prevClose <= yMax)

  const hasRSI    = (indicators.rsi    !== false) && segmented.some(d => d.rsi     != null)
  const hasMACD   = (indicators.macd   !== false) && segmented.some(d => d.macd    != null)
  const hasBB     = (indicators.bb     !== false) && segmented.some(d => d.upper   != null)
  const hasFastMA = (indicators.fastMa !== false) && segmented.some(d => d.fast_ma != null)
  const hasSlowMA = (indicators.slowMa !== false) && segmented.some(d => d.slow_ma != null)
  const hasMA9    = (indicators.ma9    !== false) && segmented.some(d => d.ma_9   != null)
  const hasMA20   = (indicators.ma20   !== false) && segmented.some(d => d.ma_20  != null)
  const hasMA50   = (indicators.ma50   !== false) && segmented.some(d => d.ma_50  != null)
  const hasMA100  = (indicators.ma100  !== false) && segmented.some(d => d.ma_100 != null)
  const hasMA200  = (indicators.ma200  !== false) && segmented.some(d => d.ma_200 != null)
  const hasStoch  = (indicators.stoch  !== false) && segmented.some(d => d.stoch_k != null)
  const hasATR    = (indicators.atr    !== false) && segmented.some(d => d.atr     != null)
  const hasOBV    = (indicators.obv    !== false) && segmented.some(d => d.obv     != null)

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
    <div className="relative space-y-0.5">
      {/* Price + Volume panel */}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart syncId={syncId} syncMethod="value" data={segmented} margin={{ top: 8, right: 64, left: 0, bottom: 0 }} onMouseMove={handleHoverMove} onMouseLeave={handleHoverLeave}>
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
          <Tooltip content={<OneDayTooltip prevClose={prevClose} indicators={indicators} />} />

          {/* Subtle off-hours background tint */}
          {sessionAreas.map((a, i) => (
            <ReferenceArea key={`off-${i}`} yAxisId="price" x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
          ))}

          {/* Day separator */}
          {dayLines.map((x, i) => (
            <ReferenceLine key={`day-${i}`} yAxisId="price" x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
          ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}

          {/* Previous close reference */}
          {prevClose != null && prevCloseInRange && (
            <ReferenceLine
              yAxisId="price"
              y={prevClose}
              stroke="#64748b"
              strokeDasharray="4 3"
              strokeWidth={1}
              label={{ value: `Prev ${prevClose.toFixed(2)}`, position: 'right', fill: '#64748b', fontSize: 9 }}
            />
          )}
          {prevClose != null && !prevCloseInRange && yMin != null && (
            <ReferenceLine
              yAxisId="price"
              y={yMin}
              stroke="none"
              label={(props) => {
                const { viewBox } = props
                if (!viewBox) return null
                const { x, width, y } = viewBox
                const isBelow = prevClose < yMin
                return (
                  <g>
                    <rect x={x + width + 2} y={y - 8} width={62} height={15} rx={3}
                      fill="#1e293b" stroke="#475569" strokeWidth={0.5} />
                    <text x={x + width + 6} y={y + 4} fill="#64748b" fontSize={9} fontFamily="monospace">
                      {isBelow ? '\u2193' : '\u2191'} ${prevClose.toFixed(2)}
                    </text>
                  </g>
                )
              }}
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
          {hasMA9   && <Line yAxisId="price" type="monotone" dataKey="ma_9"   stroke={MA_9}   strokeWidth={0.9} dot={false} name="MA(9)"   isAnimationActive={false} />}
          {hasMA20  && <Line yAxisId="price" type="monotone" dataKey="ma_20"  stroke={MA_20}  strokeWidth={0.9} dot={false} name="MA(20)"  isAnimationActive={false} />}
          {hasMA50  && <Line yAxisId="price" type="monotone" dataKey="ma_50"  stroke={MA_50}  strokeWidth={0.9} dot={false} name="MA(50)"  isAnimationActive={false} />}
          {hasMA100 && <Line yAxisId="price" type="monotone" dataKey="ma_100" stroke={MA_100} strokeWidth={0.9} dot={false} name="MA(100)" isAnimationActive={false} />}
          {hasMA200 && <Line yAxisId="price" type="monotone" dataKey="ma_200" stroke={MA_200} strokeWidth={1}   dot={false} name="MA(200)" isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>

      {/* RSI panel */}
      {hasRSI && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={segmented} margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis {...xAxisProps} />
            <YAxis orientation="right" domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={58} />
            <Tooltip content={<RSITooltip />} position={{ y: 50 }} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-r-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
            ))}
            {dayLines.map((x, i) => (
              <ReferenceLine key={`day-r-${i}`} x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <ReferenceLine y={70} stroke={SELL_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={30} stroke={BUY_COLOR}  strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line type="monotone" dataKey="rsi" stroke={RSI_COLOR} strokeWidth={1} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* MACD panel */}
      {hasMACD && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={segmented} margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis {...xAxisProps} />
            <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={58} tickFormatter={v => v?.toFixed(2)} />
            <Tooltip content={<MACDTooltip />} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-m-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
            ))}
            {dayLines.map((x, i) => (
              <ReferenceLine key={`day-m-${i}`} x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.7} />
            <Bar dataKey="macd_hist" isAnimationActive={false} label={false}>
              {segmented.map((entry, i) => (
                <Cell key={`1d-macd-cell-${i}`} fill={entry.macd_hist >= 0 ? '#4ade80' : '#f87171'} opacity={0.6} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="macd"        stroke={MACD_COLOR}   strokeWidth={1}   dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="macd_signal" stroke={SIGNAL_COLOR} strokeWidth={0.9} strokeDasharray="4 2" dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Stochastic panel */}
      {hasStoch && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={segmented} margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis {...xAxisProps} />
            <YAxis orientation="right" domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={58} />
            <Tooltip content={<StochTooltip />} position={{ y: 50 }} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-st-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
            ))}
            {dayLines.map((x, i) => (
              <ReferenceLine key={`day-st-${i}`} x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <ReferenceLine y={80} stroke={SELL_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={20} stroke={BUY_COLOR}  strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line type="monotone" dataKey="stoch_k" stroke={STOCH_K} strokeWidth={1}   dot={false} isAnimationActive={false} name="Stoch %K" />
            <Line type="monotone" dataKey="stoch_d" stroke={STOCH_D} strokeWidth={0.9} strokeDasharray="4 2" dot={false} isAnimationActive={false} name="Stoch %D" />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* ATR panel */}
      {hasATR && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={segmented} margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis {...xAxisProps} />
            <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={58} tickFormatter={v => `$${v?.toFixed(2)}`} />
            <Tooltip content={<ATRTooltip />} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-at-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
            ))}
            {dayLines.map((x, i) => (
              <ReferenceLine key={`day-at-${i}`} x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <Line type="monotone" dataKey="atr" stroke={ATR_COLOR} strokeWidth={1} dot={false} isAnimationActive={false} name="ATR(14)" />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* OBV panel */}
      {hasOBV && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={segmented} margin={{ top: 4, right: 64, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis {...xAxisProps} />
            <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={58} tickFormatter={v => fmtOBV(v)} />
            <Tooltip content={<OBVTooltip />} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-ov-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.45} />
            ))}
            {dayLines.map((x, i) => (
              <ReferenceLine key={`day-ov-${i}`} x={x} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.5} />
            <Area type="monotone" dataKey="obv" stroke={OBV_COLOR} strokeWidth={1} fill={OBV_COLOR} fillOpacity={0.08} dot={false} isAnimationActive={false} name="OBV" />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
// ---------------------------------------------------------------------------

/**
 * For 5d (MM/DD HH:MM) data, compute off-market areas and day separator lines.
 */
function buildSessionAreas(sampled, period) {
  const isIntraday = sampled.length > 0 && typeof sampled[0].date === 'string'
    && sampled[0].date.includes('/') && sampled[0].date.includes(':')
  if (!isIntraday) return { areas: [], dayLines: [] }

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

function PriceTooltip({ active, payload, label, prevClose, indicators = {} }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const price = d.close
  if (price == null) return null
  const chg = prevClose != null ? price - prevClose : null
  const chgPct = prevClose != null ? (chg / prevClose) * 100 : null
  const pos = chg == null || chg >= 0
  const signalLabel = d.signal === 1 ? '▲ BUY' : d.signal === -1 ? '▼ SELL' : null
  return (
    <div className={TT_BASE}>
      <div className="text-slate-400 font-medium mb-1.5">{label}</div>
      <TTRow label="Close" value={`$${price.toFixed(2)}`} className="text-slate-100 font-bold" />
      {chg != null && (
        <TTRow
          label="Change"
          value={`${pos ? '+' : ''}${chg.toFixed(2)} (${pos ? '+' : ''}${chgPct.toFixed(2)}%)`}
          className={pos ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}
        />
      )}
      {d.open != null && <><TTDivider /><TTRow label="Open" value={`$${d.open.toFixed(2)}`} /></>}
      {d.high != null && <TTRow label="High" value={`$${d.high.toFixed(2)}`} className="text-emerald-400" />}
      {d.low  != null && <TTRow label="Low"  value={`$${d.low.toFixed(2)}`}  className="text-red-400" />}
      {d.volume != null && <><TTDivider /><TTRow label="Vol" value={fmtVol(d.volume)} className="text-slate-400" /></>}
      {signalLabel && (
        <><TTDivider />
        <TTRow label="Signal" value={signalLabel} className={d.signal === 1 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'} /></>
      )}
      {(d.upper != null || d.fast_ma != null) && <TTDivider />}
      {d.upper   != null && <TTRow label="BB Upper" value={`$${d.upper.toFixed(2)}`}   className="text-blue-400" />}
      {d.mid     != null && <TTRow label="BB Mid"   value={`$${d.mid.toFixed(2)}`}     className="text-yellow-400" />}
      {d.lower   != null && <TTRow label="BB Lower" value={`$${d.lower.toFixed(2)}`}   className="text-pink-400" />}
      {d.fast_ma != null && <TTRow label="Fast MA"  value={`$${d.fast_ma.toFixed(2)}`} className="text-yellow-300" />}
      {d.slow_ma != null && <TTRow label="Slow MA"  value={`$${d.slow_ma.toFixed(2)}`} className="text-orange-400" />}
      {indicators.ma9   !== false && d.ma_9   != null && <TTRow label="MA(9)"   value={`$${d.ma_9.toFixed(2)}`}   className="text-cyan-400" />}
      {indicators.ma20  !== false && d.ma_20  != null && <TTRow label="MA(20)"  value={`$${d.ma_20.toFixed(2)}`}  className="text-yellow-300" />}
      {indicators.ma50  !== false && d.ma_50  != null && <TTRow label="MA(50)"  value={`$${d.ma_50.toFixed(2)}`}  className="text-green-400" />}
      {indicators.ma100 !== false && d.ma_100 != null && <TTRow label="MA(100)" value={`$${d.ma_100.toFixed(2)}`} className="text-orange-400" />}
      {indicators.ma200 !== false && d.ma_200 != null && <TTRow label="MA(200)" value={`$${d.ma_200.toFixed(2)}`} className="text-purple-400" />}
    </div>
  )
}

function SharedPriceTooltip({ dataPoint, label, prevClose, indicators = {} }) {
  if (!dataPoint) return null
  return <PriceTooltip active payload={[{ payload: dataPoint }]} label={label ?? dataPoint.date} prevClose={prevClose} indicators={indicators} />
}

function RSITooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  const rsi = d?.rsi
  if (rsi == null) return null
  const overbought = rsi >= 70
  const oversold = rsi <= 30
  const color = overbought ? 'text-red-400' : oversold ? 'text-emerald-400' : 'text-purple-400'
  const badge = overbought ? 'Overbought' : oversold ? 'Oversold' : null
  return (
    <div className="bg-[#0f172a] border border-[#1e293b] rounded-md px-2.5 py-1.5 text-xs shadow-2xl flex items-center gap-2">
      <span className="text-slate-500">RSI</span>
      <span className={`font-mono font-semibold ${color}`}>{rsi.toFixed(2)}</span>
      {badge && <span className={`text-[10px] ${color} opacity-70`}>{badge}</span>}
    </div>
  )
}

function MACDTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (d?.macd == null && d?.macd_hist == null) return null
  const hist = d.macd_hist
  const histPos = hist == null || hist >= 0
  return (
    <div className="bg-[#0f172a] border border-[#1e293b] rounded-md px-2.5 py-1.5 text-xs shadow-2xl space-y-0.5">
      {d.macd        != null && <TTRow label="MACD"   value={d.macd.toFixed(4)}        className="text-blue-400" />}
      {d.macd_signal != null && <TTRow label="Signal" value={d.macd_signal.toFixed(4)} className="text-orange-400" />}
      {hist          != null && <TTRow label="Hist"   value={(histPos ? '+' : '') + hist.toFixed(4)} className={histPos ? 'text-emerald-400' : 'text-red-400'} />}
    </div>
  )
}

function StochTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (d?.stoch_k == null && d?.stoch_d == null) return null
  const k = d.stoch_k
  const overbought = k != null && k >= 80
  const oversold   = k != null && k <= 20
  const kColor = overbought ? 'text-red-400' : oversold ? 'text-emerald-400' : 'text-emerald-300'
  const badge  = overbought ? 'Overbought' : oversold ? 'Oversold' : null
  return (
    <div className="bg-[#0f172a] border border-[#1e293b] rounded-md px-2.5 py-1.5 text-xs shadow-2xl space-y-0.5 min-w-[130px]">
      <div className="text-slate-500 font-medium mb-0.5">Stochastic</div>
      {d.stoch_k != null && <TTRow label="%K" value={d.stoch_k.toFixed(2)} className={kColor} />}
      {d.stoch_d != null && <TTRow label="%D" value={d.stoch_d.toFixed(2)} className="text-amber-400" />}
      {badge && <div className={`text-[10px] ${kColor} opacity-75 text-right pt-0.5`}>{badge}</div>}
    </div>
  )
}

function ATRTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (d?.atr == null) return null
  return (
    <div className="bg-[#0f172a] border border-[#1e293b] rounded-md px-2.5 py-1.5 text-xs shadow-2xl min-w-[140px]">
      <TTRow label="ATR(14)" value={`$${d.atr.toFixed(3)}`} className="text-purple-400" />
    </div>
  )
}

function OBVTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (d?.obv == null) return null
  return (
    <div className="bg-[#0f172a] border border-[#1e293b] rounded-md px-2.5 py-1.5 text-xs shadow-2xl min-w-[130px]">
      <TTRow label="OBV" value={fmtOBV(d.obv)} className="text-sky-400" />
    </div>
  )
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

function SubplotIconButton({ title, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-100 hover:bg-dark-700/60 disabled:opacity-40 disabled:hover:bg-transparent"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

function windowToIndices(window, total) {
  if (!total) return { start: 0, end: 0 }
  const startRatio = clamp01(window?.startRatio ?? 0)
  const endRatio = clamp01(window?.endRatio ?? 1)
  const orderedStart = Math.min(startRatio, endRatio)
  const orderedEnd = Math.max(startRatio, endRatio)
  const maxIndex = total - 1
  const start = Math.max(0, Math.min(maxIndex, Math.floor(orderedStart * maxIndex)))
  const end = Math.max(start, Math.min(maxIndex, Math.ceil(orderedEnd * maxIndex)))
  return { start, end }
}

function indicesToWindow(start, end, total) {
  if (!total || total <= 1) return { startRatio: 0, endRatio: 1 }
  const maxIndex = total - 1
  const safeStart = Math.max(0, Math.min(start, maxIndex))
  const safeEnd = Math.max(safeStart, Math.min(end, maxIndex))
  return {
    startRatio: safeStart / maxIndex,
    endRatio: safeEnd / maxIndex,
  }
}

export default function SubplotChart({
  data = [],
  warmupData,
  height = 240,
  indicators = {},
  period = '',
  prevClose,
  hidePricePanel = false,
  viewWindow,
  onViewWindowChange,
  hoverState,
  onHoverStateChange,
}) {
  const syncId = useId()
  const containerRef = useRef(null)
  const [dragState, setDragState] = useState(null)
  const [internalWindow, setInternalWindow] = useState({ startRatio: 0, endRatio: 1 })
  const isControlled = viewWindow != null && typeof onViewWindowChange === 'function'
  const effectiveWindow = isControlled ? viewWindow : internalWindow

  if (!data.length) return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
      No price data available
    </div>
  )

  const isOneDayMode = !hidePricePanel && (period === '1d' || period === '2d')

  const oneDayBase = (() => {
    if (!isOneDayMode) return []
    const dayOf = (d) => d.date?.slice(0, 5) ?? ''
    const allDays = [...new Set(data.map(dayOf).filter(Boolean))].sort()
    const daysToKeep = period === '2d' ? 2 : 1
    const keepDays = new Set(allDays.slice(-daysToKeep))
    return data.filter(d =>
      keepDays.has(dayOf(d)) &&
      d.open != null && d.high != null && d.low != null && d.close != null
    )
  })()

  const enriched = isOneDayMode
    ? []
    : (warmupData?.length ? enrichDataWithWarmup(warmupData, data) : enrichData(data))
  const step = isOneDayMode ? 1 : Math.max(1, Math.floor(enriched.length / 300))
  // Always keep signal bars so buy/sell markers are never dropped
  const sampled = isOneDayMode
    ? oneDayBase
    : enriched.filter((_, i) => i % step === 0 || enriched[i].signal !== 0)

  useEffect(() => {
    if (!isControlled) setInternalWindow({ startRatio: 0, endRatio: 1 })
  }, [isControlled, sampled.length])

  const { start: safeStart, end: safeEnd } = useMemo(
    () => windowToIndices(effectiveWindow, sampled.length),
    [effectiveWindow, sampled.length]
  )
  const visibleSampled = sampled.slice(safeStart, safeEnd + 1)
  const visibleCount = visibleSampled.length
  const canPan = sampled.length > visibleCount

  const updateWindowByIndices = useCallback((nextStart, nextEnd) => {
    const total = sampled.length
    if (!total) return
    const size = Math.max(1, nextEnd - nextStart + 1)
    const clampedStart = Math.max(0, Math.min(nextStart, total - size))
    const clampedEnd = clampedStart + size - 1
    const nextWindow = indicesToWindow(clampedStart, clampedEnd, total)
    if (isControlled) onViewWindowChange(nextWindow)
    else setInternalWindow(nextWindow)
  }, [isControlled, onViewWindowChange, sampled.length])

  const zoomBy = useCallback((zoomIn, anchorRatio = 0.5) => {
    const total = sampled.length
    if (!total) return
    const size = safeEnd - safeStart + 1
    const minWindowBars = Math.min(24, total)
    const nextSize = zoomIn
      ? Math.max(minWindowBars, Math.floor(size * 0.8))
      : Math.min(total, Math.ceil(size * 1.25))
    if (nextSize === size) return

    const anchor = clamp01(anchorRatio)
    const anchorGlobal = safeStart + Math.round((size - 1) * anchor)
    let nextStart = anchorGlobal - Math.round((nextSize - 1) * anchor)
    nextStart = Math.max(0, Math.min(nextStart, total - nextSize))
    updateWindowByIndices(nextStart, nextStart + nextSize - 1)
  }, [safeEnd, safeStart, sampled.length, updateWindowByIndices])

  const handleMouseDown = useCallback((e) => {
    if (!canPan) return
    setDragState({
      startClientX: e.clientX,
      baseStart: safeStart,
      baseEnd: safeEnd,
    })
  }, [canPan, safeEnd, safeStart])

  const handleMouseMove = useCallback((e) => {
    if (!dragState) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect?.width) return
    const barsPerPx = visibleCount / rect.width
    const shiftBars = Math.round((e.clientX - dragState.startClientX) * barsPerPx)
    updateWindowByIndices(dragState.baseStart - shiftBars, dragState.baseEnd - shiftBars)
  }, [dragState, updateWindowByIndices, visibleCount])

  const handleMouseUpOrLeave = useCallback(() => {
    setDragState(null)
  }, [])

  const externalHover = hoverState?.source === 'candlestick' ? hoverState.date : null
  const externalHoverPoint = externalHover ? visibleSampled.find((d) => d.date === externalHover) : null

  const handleHoverMove = useCallback((event) => {
    const payload = event?.activePayload?.[0]?.payload
    const date = payload?.date ?? event?.activeLabel ?? null
    if (!date) return
    onHoverStateChange?.({ date, source: 'subplot' })
  }, [onHoverStateChange])

  const handleHoverLeave = useCallback(() => {
    onHoverStateChange?.(null)
  }, [onHoverStateChange])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect?.width) return
    const anchorRatio = clamp01((e.clientX - rect.left) / rect.width)
    zoomBy(e.deltaY < 0, anchorRatio)
  }, [zoomBy])

  const resetView = useCallback(() => {
    const nextWindow = { startRatio: 0, endRatio: 1 }
    if (isControlled) onViewWindowChange(nextWindow)
    else setInternalWindow(nextWindow)
  }, [isControlled, onViewWindowChange])

  const isZoomed = effectiveWindow.startRatio > 0 || effectiveWindow.endRatio < 1

  if (isOneDayMode) {
    return (
      <div
        ref={containerRef}
        className="space-y-0.5"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onMouseLeave={handleMouseUpOrLeave}
        onWheel={handleWheel}
      >
        <div className="flex items-center justify-end gap-0.5 pr-1 h-[22px]">
          <SubplotIconButton title="Zoom in" onClick={() => zoomBy(true, 0.5)}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M11 8v6M8 11h6M20 20l-3.5-3.5" /></svg>
          </SubplotIconButton>
          <SubplotIconButton title="Zoom out" onClick={() => zoomBy(false, 0.5)}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M20 20l-3.5-3.5" /></svg>
          </SubplotIconButton>
          <SubplotIconButton title="Reset view" onClick={resetView} disabled={!isZoomed}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /></svg>
          </SubplotIconButton>
        </div>
        <OneDayChart
          data={visibleSampled}
          period={period}
          height={height}
          indicators={indicators}
          prevClose={prevClose}
          syncId={syncId}
        />
      </div>
    )
  }

  const { areas: sessionAreas, dayLines } = buildSessionAreas(visibleSampled, period)

  const hasRSI  = (indicators.rsi    !== false) && sampled.some(d => d.rsi     != null)
  const hasMACD = (indicators.macd   !== false) && sampled.some(d => d.macd    != null)
  const hasBB   = (indicators.bb     !== false) && sampled.some(d => d.upper   != null)
  const hasFastMA = (indicators.fastMa !== false) && sampled.some(d => d.fast_ma != null)
  const hasSlowMA = (indicators.slowMa !== false) && sampled.some(d => d.slow_ma != null)
  const hasMA9    = (indicators.ma9    !== false) && sampled.some(d => d.ma_9   != null)
  const hasMA20   = (indicators.ma20   !== false) && sampled.some(d => d.ma_20  != null)
  const hasMA50   = (indicators.ma50   !== false) && sampled.some(d => d.ma_50  != null)
  const hasMA100  = (indicators.ma100  !== false) && sampled.some(d => d.ma_100 != null)
  const hasMA200  = (indicators.ma200  !== false) && sampled.some(d => d.ma_200 != null)
  const hasStoch  = (indicators.stoch  !== false) && sampled.some(d => d.stoch_k != null)
  const hasATR    = (indicators.atr    !== false) && sampled.some(d => d.atr     != null)
  const hasOBV    = (indicators.obv    !== false) && sampled.some(d => d.obv     != null)

  const priceHeight = height
  const oscHeight = 100

  if (hidePricePanel && !hasRSI && !hasMACD && !hasStoch && !hasATR && !hasOBV) {
    return null
  }

  return (
    <div
      ref={containerRef}
      className="relative space-y-1"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUpOrLeave}
      onMouseLeave={handleMouseUpOrLeave}
      onWheel={handleWheel}
    >
      <div className="flex items-center justify-end gap-0.5 pr-1 h-[22px]">
        <SubplotIconButton title="Zoom in" onClick={() => zoomBy(true, 0.5)}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M11 8v6M8 11h6M20 20l-3.5-3.5" /></svg>
        </SubplotIconButton>
        <SubplotIconButton title="Zoom out" onClick={() => zoomBy(false, 0.5)}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M20 20l-3.5-3.5" /></svg>
        </SubplotIconButton>
        <SubplotIconButton title="Reset view" onClick={resetView} disabled={!isZoomed}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /></svg>
        </SubplotIconButton>
      </div>
      {externalHoverPoint && !hidePricePanel && (
        <div className="pointer-events-none absolute left-3 top-8 z-20">
          <SharedPriceTooltip dataPoint={externalHoverPoint} label={externalHoverPoint.date} prevClose={prevClose} indicators={indicators} />
        </div>
      )}
      {/* Price panel */}
      {!hidePricePanel && (
        <ResponsiveContainer width="100%" height={priceHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={visibleSampled} margin={{ top: 8, right: 10, left: 0, bottom: 0 }} onMouseMove={handleHoverMove} onMouseLeave={handleHoverLeave}>
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
            <Tooltip content={<PriceTooltip prevClose={prevClose} indicators={indicators} />} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-p-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-p-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <Line type="monotone" dataKey="close" stroke={PRICE_COLOR} strokeWidth={1.5} dot={<SignalDot />} activeDot={{ r: 3 }} name="Close" isAnimationActive={false} />
            {hasBB && <Line type="monotone" dataKey="upper" stroke={BB_UPPER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} name="BB Upper" isAnimationActive={false} />}
            {hasBB && <Line type="monotone" dataKey="lower" stroke={BB_LOWER} strokeWidth={0.8} strokeDasharray="4 2" dot={false} name="BB Lower" isAnimationActive={false} />}
            {hasBB && <Line type="monotone" dataKey="mid" stroke={BB_MID} strokeWidth={0.8} strokeDasharray="2 2" dot={false} name="BB Mid" isAnimationActive={false} />}
            {hasFastMA && <Line type="monotone" dataKey="fast_ma" stroke={FAST_MA} strokeWidth={0.9} dot={false} name="Fast MA" isAnimationActive={false} />}
            {hasSlowMA && <Line type="monotone" dataKey="slow_ma" stroke={SLOW_MA} strokeWidth={0.9} dot={false} name="Slow MA" isAnimationActive={false} />}
            {hasMA9   && <Line type="monotone" dataKey="ma_9"   stroke={MA_9}   strokeWidth={0.9} dot={false} name="MA(9)"   isAnimationActive={false} />}
            {hasMA20  && <Line type="monotone" dataKey="ma_20"  stroke={MA_20}  strokeWidth={0.9} dot={false} name="MA(20)"  isAnimationActive={false} />}
            {hasMA50  && <Line type="monotone" dataKey="ma_50"  stroke={MA_50}  strokeWidth={0.9} dot={false} name="MA(50)"  isAnimationActive={false} />}
            {hasMA100 && <Line type="monotone" dataKey="ma_100" stroke={MA_100} strokeWidth={0.9} dot={false} name="MA(100)" isAnimationActive={false} />}
            {hasMA200 && <Line type="monotone" dataKey="ma_200" stroke={MA_200} strokeWidth={1}   dot={false} name="MA(200)" isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      )}
      {externalHoverPoint && (
        <div className="pointer-events-none absolute left-3 top-8 z-20">
          <SharedPriceTooltip dataPoint={externalHoverPoint} label={externalHoverPoint.date} prevClose={prevClose} indicators={indicators} />
        </div>
      )}

      {/* RSI panel */}
      {hasRSI && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={visibleSampled} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            {sharedXAxis}
            <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={60} />
            <Tooltip content={<RSITooltip />} position={{ y: 50 }} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-r-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-r-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <ReferenceLine y={70} stroke={SELL_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={30} stroke={BUY_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line type="monotone" dataKey="rsi" stroke={RSI_COLOR} strokeWidth={1} dot={false} name="RSI" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* MACD panel */}
      {hasMACD && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={visibleSampled} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            {sharedXAxis}
            <YAxis domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={60} tickFormatter={v => v?.toFixed(2)} />
            <Tooltip content={<MACDTooltip />} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-m-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-m-${i}`} x={d} stroke="#334155" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.7} />
            <Bar dataKey="macd_hist" name="Histogram" isAnimationActive={false} label={false}>
              {visibleSampled.map((entry, i) => (
                <Cell key={`macd-cell-${i}`} fill={entry.macd_hist >= 0 ? '#4ade80' : '#f87171'} opacity={0.6} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="macd"        stroke={MACD_COLOR}   strokeWidth={1}   dot={false} name="MACD"   isAnimationActive={false} />
            <Line type="monotone" dataKey="macd_signal" stroke={SIGNAL_COLOR} strokeWidth={0.9} strokeDasharray="4 2" dot={false} name="Signal" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Stochastic panel */}
      {hasStoch && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={visibleSampled} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            {sharedXAxis}
            <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={60} />
            <Tooltip content={<StochTooltip />} position={{ y: 50 }} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-st-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-st-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <ReferenceLine y={80} stroke={SELL_COLOR} strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={20} stroke={BUY_COLOR}  strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line type="monotone" dataKey="stoch_k" stroke={STOCH_K} strokeWidth={1}   dot={false} name="Stoch %K" isAnimationActive={false} />
            <Line type="monotone" dataKey="stoch_d" stroke={STOCH_D} strokeWidth={0.9} strokeDasharray="4 2" dot={false} name="Stoch %D" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* ATR panel */}
      {hasATR && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={visibleSampled} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            {sharedXAxis}
            <YAxis domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={60} tickFormatter={v => `$${v?.toFixed(2)}`} />
            <Tooltip content={<ATRTooltip />} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-at-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-at-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <Line type="monotone" dataKey="atr" stroke={ATR_COLOR} strokeWidth={1} dot={false} name="ATR(14)" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* OBV panel */}
      {hasOBV && (
        <ResponsiveContainer width="100%" height={oscHeight}>
          <ComposedChart syncId={syncId} syncMethod="value" data={visibleSampled} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            {sharedXAxis}
            <YAxis domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={60} tickFormatter={v => fmtOBV(v)} />
            <Tooltip content={<OBVTooltip />} />
            {sessionAreas.map((a, i) => (
              <ReferenceArea key={`off-ov-${i}`} x1={a.x1} x2={a.x2} fill="#0f172a" fillOpacity={0.55} ifOverflow="visible" />
            ))}
            {dayLines.map((d, i) => (
              <ReferenceLine key={`day-ov-${i}`} x={d} stroke="#475569" strokeWidth={1} strokeDasharray="4 2" />
            ))}
            {externalHover && <ReferenceLine x={externalHover} stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" />}
            <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.5} />
            <Area type="monotone" dataKey="obv" stroke={OBV_COLOR} strokeWidth={1} fill={OBV_COLOR} fillOpacity={0.08} dot={false} name="OBV" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
