import { useRef, useState, useEffect, useCallback, Component } from 'react'
import { enrichData, enrichDataWithWarmup } from './indicators'

const BB_UPPER = '#60a5fa'
const BB_LOWER = '#f472b6'
const BB_MID = '#fbbf24'
const MA_9   = '#22d3ee'
const MA_20  = '#facc15'
const MA_50  = '#4ade80'
const MA_100 = '#fb923c'
const MA_200 = '#c084fc'

/* ?? Error boundary � any render crash logs to console ??????????? */
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('[CandlestickChart] render error:', error, info?.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-40 text-red-400 text-xs p-4 text-center">
          Chart failed to render � see browser console for details.
        </div>
      )
    }
    return this.props.children
  }
}

/* ?? Helpers ????????????????????????????????????????????????????? */
const isIntradayLabel = (s) => typeof s === 'string' && s.includes('/') && s.includes(':')
const timeOf = (s) => (isIntradayLabel(s) ? s.slice(6) : '')   // "MM/DD HH:MM" ? "HH:MM"
const shortDateLabel = (s) => {
  if (!s) return ''
  if (isIntradayLabel(s)) return s.slice(0, 5)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5)
  return String(s)
}
const fmt2   = (n) => (n != null ? n.toFixed(2) : '�')
const fmtVol = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}K`

const clamp01 = (v) => Math.max(0, Math.min(1, v))

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

function shouldHidePremarket() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)

  const day = parts.find((p) => p.type === 'weekday')?.value
  if (day === 'Sat' || day === 'Sun') return false

  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10)
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  const mins = hour * 60 + minute

  // Hide pre-market data starting one hour after regular open (10:30 ET).
  return mins >= 10 * 60 + 30
}

/* ?? Floating tooltip div ???????????????????????????????????????? */
function TooltipBox({ bar, x, y, chartWidth }) {
  if (!bar) return null
  const chg    = bar.prev_close != null ? bar.close - bar.prev_close : null
  const chgPct = chg != null ? (chg / bar.prev_close) * 100 : null
  const pos    = chg == null || chg >= 0
  const flip   = x > chartWidth * 0.65
  return (
    <div
      style={{
        position: 'absolute',
        top: y,
        left: flip ? x - 184 : x + 14,
        pointerEvents: 'none',
        zIndex: 50,
      }}
      className="bg-[#1e293b] border border-[#334155] rounded-lg p-3 text-xs shadow-xl space-y-1 min-w-[160px]"
    >
      <div className="text-slate-400 font-medium mb-1">{bar.date}</div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Open</span>  <span className="text-slate-200">${fmt2(bar.open)}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">High</span>  <span className="text-emerald-400">${fmt2(bar.high)}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Low</span>   <span className="text-red-400">${fmt2(bar.low)}</span></div>
      <div className="flex justify-between gap-4"><span className="text-slate-500">Close</span> <span className="text-slate-200 font-bold">${fmt2(bar.close)}</span></div>
      {chg != null && (
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">Change</span>
          <span className={`font-mono font-semibold ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
            {pos ? '+' : ''}{fmt2(chg)} ({pos ? '+' : ''}{fmt2(chgPct)}%)
          </span>
        </div>
      )}
      {bar.volume != null && (
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">Vol</span>
          <span className="text-slate-400 font-mono">{fmtVol(bar.volume)}</span>
        </div>
      )}
    </div>
  )
}

function IconButton({ title, onClick, disabled = false, children }) {
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

/* ?? Pure-SVG chart � zero recharts, zero invariant risk ????????? */
function CandlestickInner({
  data = [],
  prevClose,
  height = 260,
  className = '',
  indicators = null,
  warmupData = null,
  hidePremarketAfterOpen = true,
  showFloatingTooltip = true,
  viewWindow,
  onViewWindowChange,
  hoverState,
  onHoverStateChange,
  priceLines = [],
  tradeFlags = [],
}) {
  const containerRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [hovered, setHovered] = useState(null)
  const [viewStart, setViewStart] = useState(0)
  const [viewEnd, setViewEnd] = useState(0)
  const [dragState, setDragState] = useState(null)

  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setWidth(containerRef.current.getBoundingClientRect().width)
      }
    }

    updateWidth()
    if (!containerRef.current) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(containerRef.current)
    window.addEventListener('resize', updateWidth)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [])

  /* layout */
  const CONTROL_ROW_H = 22
  const chartHeight = Math.max(120, height - CONTROL_ROW_H)
  const PAD_TOP    = 16
  const PAD_BOTTOM = 24
  const PAD_LEFT   = 0
  const PAD_RIGHT  = 70
  const VOL_HEIGHT = Math.round(chartHeight * 0.18)
  const plotW = width  - PAD_LEFT - PAD_RIGHT
  const plotH = chartHeight - PAD_TOP  - PAD_BOTTOM

  const rawBars = data.filter(d => d != null && d.date != null)
  const enrichedBars = warmupData?.length
    ? enrichDataWithWarmup(warmupData, rawBars)
    : enrichData(rawBars)
  const isIntraday = enrichedBars.some(d => isIntradayLabel(d.date))
  const hidePremarket = isIntraday && hidePremarketAfterOpen && shouldHidePremarket()
  /* Session-time filter is opt-in via `hidePremarketAfterOpen`.
     - true  (PositionDetail default): clip early pre-market (<07:30 ET), and
       collapse to regular session (>=09:30 ET) once we're past 10:30 ET.
     - false (Dashboard): keep every bar so the candlestick range matches the
       paired subplot, which never drops pre/post-market data. */
  const minTime = hidePremarket ? '09:30' : '07:30'
  const bars = (isIntraday && hidePremarketAfterOpen)
    ? enrichedBars.filter(d => timeOf(d.date) >= minTime)
    : enrichedBars
  const isControlled = viewWindow != null && typeof onViewWindowChange === 'function'

  useEffect(() => {
    if (isControlled) return
    if (!bars.length) {
      setViewStart(0)
      setViewEnd(0)
      return
    }
    setViewStart(0)
    setViewEnd(bars.length - 1)
  }, [bars.length, isControlled])

  if (!bars.length) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center text-slate-500 text-sm"
        style={{ height: chartHeight }}
      >
        No price data available
      </div>
    )
  }

  const controlledIndices = windowToIndices(viewWindow, bars.length)
  const safeStart = isControlled
    ? controlledIndices.start
    : Math.max(0, Math.min(viewStart, Math.max(0, bars.length - 1)))
  const safeEnd = isControlled
    ? controlledIndices.end
    : Math.max(safeStart, Math.min(viewEnd || (bars.length - 1), bars.length - 1))
  const visibleBars = bars.slice(safeStart, safeEnd + 1)
  const n = visibleBars.length

  const safePriceLines = (priceLines ?? []).filter((line) => Number.isFinite(Number(line?.price)) && Number(line.price) > 0)

  /* Price scale: guard against one-off bad ticks (e.g. rogue wick) that can
     flatten the whole chart. For intraday windows with enough bars, use an
     IQR fence to ignore extreme outliers when computing axis bounds. */
  const barPrices = visibleBars.flatMap(d => [d.low, d.high, d.close].filter(Number.isFinite))
  const refPrices = []
  if (prevClose != null) refPrices.push(prevClose)
  for (const line of safePriceLines) refPrices.push(Number(line.price))

  let scalePrices = [...barPrices, ...refPrices]
  if (isIntraday && barPrices.length >= 40) {
    const sorted = [...barPrices].sort((a, b) => a - b)
    const quantile = (arr, q) => {
      if (!arr.length) return null
      const pos = (arr.length - 1) * q
      const loIdx = Math.floor(pos)
      const hiIdx = Math.ceil(pos)
      if (loIdx === hiIdx) return arr[loIdx]
      const w = pos - loIdx
      return arr[loIdx] * (1 - w) + arr[hiIdx] * w
    }
    const q1 = quantile(sorted, 0.25)
    const q3 = quantile(sorted, 0.75)
    const iqr = (q3 ?? 0) - (q1 ?? 0)
    if (Number.isFinite(iqr) && iqr > 0) {
      const lowFence = q1 - iqr * 3
      const highFence = q3 + iqr * 3
      const filteredPrices = barPrices.filter((p) => p >= lowFence && p <= highFence)
      if (filteredPrices.length >= Math.max(20, Math.floor(barPrices.length * 0.85))) {
        // Preserve the regular-session opening/closing windows so legitimate
        // gap-and-run highs are not clipped just because the rest of the day
        // is tightly clustered around a narrow range.
        const protectedPrices = visibleBars
          .filter((bar) => {
            const t = timeOf(bar.date)
            return (t >= '09:30' && t <= '10:00') || (t >= '15:30' && t <= '16:00')
          })
          .flatMap((bar) => [bar.low, bar.high, bar.close].filter(Number.isFinite))
        scalePrices = [...new Set([...filteredPrices, ...protectedPrices]), ...refPrices]
      }
    }
  }

  const minP = scalePrices.length ? Math.min(...scalePrices) : 0
  const maxP = scalePrices.length ? Math.max(...scalePrices) : 1
  const padP = (maxP - minP) * 0.06 || 1
  const lo   = minP - padP
  const hi   = maxP + padP
  const pToY = (p) => {
    const clamped = Math.max(lo, Math.min(hi, p))
    return PAD_TOP + plotH - ((clamped - lo) / (hi - lo)) * plotH
  }

  /* volume scale */
  const maxVol = Math.max(...visibleBars.map(d => d.volume ?? 0), 1)
  const vToH   = (v) => (v / maxVol) * VOL_HEIGHT

  /* x scale */
  const bandwidth = plotW / n
  const xOf = (i) => PAD_LEFT + i * bandwidth + bandwidth / 2
  const bw  = Math.max(1, Math.min(14, bandwidth - 2))

  /* reference positions */
  const prevCloseY  = prevClose != null ? pToY(prevClose) : null

  // Session boundary lines for intraday charts
  const intradayDays = isIntraday
    ? [...new Set(visibleBars.map(d => d.date?.slice(0, 5)).filter(Boolean))]
    : []
  const isMultiDay   = intradayDays.length > 1
  const hasPreMkt    = isIntraday && visibleBars.some(d => timeOf(d.date) < '09:30')
  const hasPostMkt   = isIntraday && visibleBars.some(d => timeOf(d.date) > '16:00')

  // Single-day (1D): first occurrence only
  const mktOpenIdx  = !isMultiDay && isIntraday ? visibleBars.findIndex(d => timeOf(d.date) >= '09:30') : -1
  const mktCloseIdx = !isMultiDay && isIntraday ? visibleBars.findIndex(d => timeOf(d.date) >= '16:00') : -1

  // Multi-day: per-day separator indices
  const daySessionLines = isMultiDay
    ? intradayDays.flatMap((day, di) => {
        const out = []
        // Day separator: first bar of each day after the first
        if (di > 0) {
          const idx = visibleBars.findIndex(d => d.date?.startsWith(day))
          if (idx >= 0) out.push({ idx, label: null })
        }
        // If pre-market data present, mark regular open per day
        if (hasPreMkt) {
          const idx = visibleBars.findIndex(d => d.date?.startsWith(day) && timeOf(d.date) >= '09:30')
          if (idx >= 0) out.push({ idx, label: 'Open' })
        }
        // If post-market data present, mark regular close per day
        if (hasPostMkt) {
          const idx = visibleBars.findIndex(d => d.date?.startsWith(day) && timeOf(d.date) >= '16:00')
          if (idx >= 0) out.push({ idx, label: 'Close' })
        }
        return out
      })
    : []

  const hasBB    = indicators?.bb === true && visibleBars.some(d => d.upper != null)
  const hasMA9   = indicators?.ma9 === true && visibleBars.some(d => d.ma_9 != null)
  const hasMA20  = indicators?.ma20 === true && visibleBars.some(d => d.ma_20 != null)
  const hasMA50  = indicators?.ma50 === true && visibleBars.some(d => d.ma_50 != null)
  const hasMA100 = indicators?.ma100 === true && visibleBars.some(d => d.ma_100 != null)
  const hasMA200 = indicators?.ma200 === true && visibleBars.some(d => d.ma_200 != null)

  const renderSeries = (key, stroke, strokeWidth = 1, dashed = false) => {
    const segments = []
    let points = []
    for (let i = 0; i < visibleBars.length; i++) {
      const v = visibleBars[i]?.[key]
      if (v == null) {
        if (points.length > 1) segments.push(points)
        points = []
        continue
      }
      points.push(`${xOf(i)},${pToY(v)}`)
    }
    if (points.length > 1) segments.push(points)
    return segments.map((seg, idx) => (
      <polyline
        key={`${key}-${idx}`}
        points={seg.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dashed ? '4 2' : undefined}
        opacity={0.95}
      />
    ))
  }

  /* axis ticks */
  const yTicks    = Array.from({ length: 5 }, (_, i) => lo + (hi - lo) * (i / 4))
  const xTickStep = Math.ceil(n / 8)
  const xTicks    = visibleBars.reduce((acc, _d, i) => {
    if (i === 0 || i % xTickStep === 0 || i === n - 1) acc.push(i)
    return acc
  }, [])

  const isDragging = dragState != null
  const activeHover = isDragging ? null : hovered

  const normalizedBarDate = (value) => {
    const text = String(value ?? '').trim()
    if (!text) return ''
    const intradayMinuteMatch = text.match(/^(\d{2}\/\d{2}\s\d{2}:\d{2})/)
    if (intradayMinuteMatch) return intradayMinuteMatch[1]
    return text
  }

  const tradeFlagPoints = (tradeFlags ?? []).map((flag, idx) => {
    const targetDate = normalizedBarDate(flag?.chartDate)
    if (!targetDate) return null
    let barIndex = visibleBars.findIndex((bar) => normalizedBarDate(bar?.date) === targetDate)
    if (barIndex < 0) {
      barIndex = visibleBars.findIndex((bar) => String(bar?.date ?? '').startsWith(targetDate))
    }
    if (barIndex < 0) return null

    const bar = visibleBars[barIndex]
    const rawPrice = Number(flag?.price)
    const fallbackPrice = Number(bar?.close)
    const price = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : fallbackPrice
    if (!Number.isFinite(price) || price <= 0) return null

    const side = String(flag?.side ?? '').toUpperCase()
    const isBuy = side === 'BUY'
    if (!isBuy && side !== 'SELL') return null

    return {
      id: flag?.id ?? `trade-flag-${idx}`,
      isBuy,
      x: xOf(barIndex),
      y: pToY(price),
      label: isBuy ? 'BUY' : 'SELL',
      color: isBuy ? '#34d399' : '#f87171',
    }
  }).filter(Boolean)

  // Resolve highlighted bar index: prefer local hover, fall back to external
  // hoverState arriving from a sibling subplot chart. The subplot may sample/
  // filter `data` differently than the candlestick (it downsamples by stride
  // and doesn't drop null-OHLC rows), so the hovered date won't always exist
  // verbatim in `visibleBars`. We therefore match by *nearest* date in the
  // already-sorted bar list rather than requiring equality.
  const localHoverIdx = activeHover
    ? visibleBars.findIndex(b => b.date === activeHover.bar?.date)
    : -1
  const externalHoverDate = hoverState && hoverState.source !== 'candlestick'
    ? hoverState.date
    : null
  const externalHoverIdx = (() => {
    if (!externalHoverDate || !visibleBars.length) return -1
    // Bars are chronologically sorted and use the same lexically-sortable date
    // format ("YYYY-MM-DD" or "MM/DD HH:MM"). Find the largest date <= target,
    // then compare to the next bar to pick the truly closer one.
    let lower = -1
    for (let i = 0; i < visibleBars.length; i++) {
      if (visibleBars[i].date <= externalHoverDate) lower = i
      else break
    }
    if (lower < 0) return 0
    if (lower + 1 >= visibleBars.length) return lower
    const lowerDate = visibleBars[lower].date
    const upperDate = visibleBars[lower + 1].date
    // Cheap string distance: pick whichever neighbor sits closer to target.
    const distLower = Math.abs(externalHoverDate.localeCompare(lowerDate))
    const distUpper = Math.abs(externalHoverDate.localeCompare(upperDate))
    return distUpper < distLower ? lower + 1 : lower
  })()
  const highlightIdx = isDragging ? -1 : (localHoverIdx >= 0 ? localHoverIdx : externalHoverIdx)
  const highlightWidth = Math.max(bandwidth, 2)
  const highlightX = highlightIdx >= 0 ? xOf(highlightIdx) - highlightWidth / 2 : 0

  const maxZoomInBars = Math.min(24, bars.length)
  const isZoomed = safeStart > 0 || safeEnd < (bars.length - 1)

  const setViewByIndices = useCallback((nextStart, nextEnd) => {
    const total = bars.length
    if (!total) return
    const size = Math.max(1, nextEnd - nextStart + 1)
    const clampedStart = Math.max(0, Math.min(nextStart, total - size))
    const clampedEnd = clampedStart + size - 1

    if (isControlled) {
      onViewWindowChange(indicesToWindow(clampedStart, clampedEnd, total))
      return
    }
    setViewStart(clampedStart)
    setViewEnd(clampedEnd)
  }, [bars.length, isControlled, onViewWindowChange])

  const applyViewWindow = useCallback((nextStart, nextEnd) => {
    const total = bars.length
    if (!total) return
    const size = Math.max(1, nextEnd - nextStart + 1)
    const clampedStart = Math.max(0, Math.min(nextStart, total - size))
    const clampedEnd = clampedStart + size - 1
    setViewByIndices(clampedStart, clampedEnd)
  }, [bars.length, setViewByIndices])

  const zoomTo = useCallback((zoomIn, anchorRatio = 0.5) => {
    const total = bars.length
    if (!total) return
    const size = safeEnd - safeStart + 1
    const nextSize = zoomIn
      ? Math.max(maxZoomInBars, Math.floor(size * 0.8))
      : Math.min(total, Math.ceil(size * 1.25))
    if (nextSize === size) return

    const anchor = Math.max(0, Math.min(1, anchorRatio))
    const anchorGlobal = safeStart + Math.round((size - 1) * anchor)
    let nextStart = anchorGlobal - Math.round((nextSize - 1) * anchor)
    nextStart = Math.max(0, Math.min(nextStart, total - nextSize))
    applyViewWindow(nextStart, nextStart + nextSize - 1)
  }, [applyViewWindow, bars.length, maxZoomInBars, safeEnd, safeStart])

  const resetView = useCallback(() => {
    if (!bars.length) return
    setViewByIndices(0, bars.length - 1)
  }, [bars.length, setViewByIndices])

  const handleMouseMove = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    if (dragState && bandwidth > 0) {
      const dx = e.clientX - dragState.startClientX
      const shiftBars = Math.round(dx / bandwidth)
      const size = dragState.baseEnd - dragState.baseStart + 1
      const maxStart = Math.max(0, bars.length - size)
      const nextStart = Math.max(0, Math.min(dragState.baseStart - shiftBars, maxStart))
      const nextEnd = nextStart + size - 1
      setViewByIndices(nextStart, nextEnd)
      setHovered(null)
      onHoverStateChange?.(null)
      return
    }

    const mx  = e.clientX - rect.left - PAD_LEFT
    const idx = Math.floor(mx / bandwidth)
    if (idx >= 0 && idx < n) {
      const nextHovered = {
        bar: visibleBars[idx],
        x: e.clientX - rect.left,
        y: Math.max(0, e.clientY - rect.top - 20),
      }
      setHovered(nextHovered)
      onHoverStateChange?.({ date: visibleBars[idx].date, source: 'candlestick' })
    } else {
      setHovered(null)
      onHoverStateChange?.(null)
    }
  }, [dragState, bandwidth, n, bars.length, onHoverStateChange, setViewByIndices, visibleBars])

  const handleMouseDown = useCallback((e) => {
    if (bars.length <= n) return
    setHovered(null)
    onHoverStateChange?.(null)
    setDragState({
      startClientX: e.clientX,
      baseStart: safeStart,
      baseEnd: safeEnd,
    })
  }, [bars.length, n, onHoverStateChange, safeEnd, safeStart])

  const handleMouseUp = useCallback(() => {
    setDragState(null)
  }, [])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left - PAD_LEFT
    const anchorRatio = Math.max(0, Math.min(1, mx / Math.max(plotW, 1)))
    zoomTo(e.deltaY < 0, anchorRatio)
  }, [bars.length, plotW, zoomTo])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined

    const nativeWheel = (event) => {
      handleWheel(event)
    }

    el.addEventListener('wheel', nativeWheel, { passive: false })
    return () => el.removeEventListener('wheel', nativeWheel)
  }, [handleWheel])

  return (
    <div
      className={className}
      style={{ position: 'relative', width: '100%', height }}
    >
      <div className="h-[22px] flex items-center justify-end gap-0.5 pr-1">
        <IconButton title="Zoom in" onClick={() => zoomTo(true, 0.5)}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M11 8v6M8 11h6M20 20l-3.5-3.5" />
          </svg>
        </IconButton>
        <IconButton title="Zoom out" onClick={() => zoomTo(false, 0.5)}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M8 11h6M20 20l-3.5-3.5" />
          </svg>
        </IconButton>
        <IconButton title="Reset view" onClick={resetView} disabled={!isZoomed}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v4h4" />
          </svg>
        </IconButton>
      </div>

      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', height: chartHeight }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { setHovered(null); setDragState(null); onHoverStateChange?.(null) }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        <svg width={width} height={chartHeight} style={{ display: 'block', overflow: 'visible', width: '100%' }}>

        {/* Y grid + right-axis labels */}
        {yTicks.map((p, i) => {
          const y = pToY(p)
          return (
            <g key={i}>
              <line x1={PAD_LEFT} y1={y} x2={PAD_LEFT + plotW} y2={y} stroke="#1e293b" strokeWidth={1} />
              <text x={width - PAD_RIGHT + 6} y={y + 4} fill="#64748b" fontSize={10} fontFamily="monospace">
                ${p.toFixed(2)}
              </text>
            </g>
          )
        })}

        {/* Prev-close dashed line */}
        {prevCloseY != null && (
          <g>
            <line
              x1={PAD_LEFT} y1={prevCloseY} x2={PAD_LEFT + plotW} y2={prevCloseY}
              stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3"
            />
            <text x={PAD_LEFT + plotW - 2} y={prevCloseY - 3} fill="#94a3b8" fontSize={9} textAnchor="end">
              Prev ${fmt2(prevClose)}
            </text>
          </g>
        )}

        {/* Single-day market close line */}
        {!isMultiDay && mktCloseIdx >= 0 && (
          <g>
            <line
              x1={xOf(mktCloseIdx)} y1={PAD_TOP} x2={xOf(mktCloseIdx)} y2={PAD_TOP + plotH}
              stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3"
            />
            {hasPostMkt && <text x={xOf(mktCloseIdx) + 3} y={PAD_TOP + 10} fill="#f59e0b" fontSize={9}>Close</text>}
          </g>
        )}

        {/* Single-day market open line (hidden after 10:30 ET) */}
        {!isMultiDay && !hidePremarket && mktOpenIdx >= 0 && (
          <g>
            <line
              x1={xOf(mktOpenIdx)} y1={PAD_TOP} x2={xOf(mktOpenIdx)} y2={PAD_TOP + plotH}
              stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3"
            />
            {hasPreMkt && <text x={xOf(mktOpenIdx) + 3} y={PAD_TOP + 10} fill="#f59e0b" fontSize={9}>Open</text>}
          </g>
        )}

        {/* Multi-day session separator lines */}
        {daySessionLines.map((line, i) => (
          <g key={`sess-${i}`}>
            <line
              x1={xOf(line.idx)} y1={PAD_TOP} x2={xOf(line.idx)} y2={PAD_TOP + plotH}
              stroke={line.label ? '#f59e0b' : '#334155'} strokeWidth={1} strokeDasharray="3 3"
            />
            {line.label && (
              <text x={xOf(line.idx) + 3} y={PAD_TOP + 10} fill="#f59e0b" fontSize={9}>{line.label}</text>
            )}
          </g>
        ))}

        {/* Volume bars */}
        {visibleBars.map((d, i) => {
          if (!d.volume) return null
          const x = xOf(i)
          const h = vToH(d.volume)
          return (
            <rect key={i} x={x - bw / 2} y={PAD_TOP + plotH - h} width={bw} height={h} fill="#426392" opacity={0.5} />
          )
        })}

        {/* Vertical hover highlight band � aligns this chart with subplot
            crosshairs by tinting the column for the active timestamp. */}
        {highlightIdx >= 0 && (
          <rect
            x={highlightX}
            y={PAD_TOP}
            width={highlightWidth}
            height={plotH}
            fill="#94a3b8"
            fillOpacity={0.12}
            pointerEvents="none"
          />
        )}

        {/* Candlesticks */}
        {visibleBars.map((d, i) => {
          // Skip bars without a full OHLC quad (e.g. single-print pre-market
          // bars). The x slot is still reserved so subsequent bars line up
          // with the paired subplot's time axis.
          if (d.open == null || d.high == null || d.low == null || d.close == null) return null
          const x     = xOf(i)
          const isUp  = d.close >= d.open
          const color = isUp ? '#22c55e' : '#ef4444'
          const yH    = pToY(d.high)
          const yL    = pToY(d.low)
          const yO    = pToY(d.open)
          const yC    = pToY(d.close)
          const bodyY = Math.min(yO, yC)
          const bodyH = Math.max(Math.abs(yC - yO), 1)
          return (
            <g key={i}>
              <line x1={x} y1={yH} x2={x} y2={yL} stroke={color} strokeWidth={1} />
              <rect x={x - bw / 2} y={bodyY} width={bw} height={bodyH} fill={color} />
            </g>
          )
        })}

        {/* Indicator overlays on candlesticks */}
        {hasBB && renderSeries('upper', BB_UPPER, 1, true)}
        {hasBB && renderSeries('lower', BB_LOWER, 1, true)}
        {hasBB && renderSeries('mid', BB_MID, 1)}
        {hasMA9 && renderSeries('ma_9', MA_9)}
        {hasMA20 && renderSeries('ma_20', MA_20)}
        {hasMA50 && renderSeries('ma_50', MA_50)}
        {hasMA100 && renderSeries('ma_100', MA_100)}
        {hasMA200 && renderSeries('ma_200', MA_200, 1.1)}

        {/* Position reference lines (avg/TP/SL) */}
        {safePriceLines.map((line, idx) => {
          const y = pToY(Number(line.price))
          const stroke = line.color || '#94a3b8'
          const dash = line.dash || '4 3'
          const label = line.label || 'Line'
          return (
            <g key={line.id ?? `line-${idx}`}>
              <line
                x1={PAD_LEFT}
                y1={y}
                x2={PAD_LEFT + plotW}
                y2={y}
                stroke={stroke}
                strokeWidth={1.2}
                strokeDasharray={dash}
              />
              <text
                x={PAD_LEFT + plotW - 2}
                y={y - 4 - (idx * 2)}
                fill={stroke}
                fontSize={9}
                textAnchor="end"
                fontFamily="monospace"
              >
                {label} ${fmt2(Number(line.price))}
              </text>
            </g>
          )
        })}

        {/* Buy/sell execution flags */}
        {tradeFlagPoints.map((point) => {
          const poleTop = point.isBuy ? point.y - 14 : point.y - 4
          const flagTipY = point.isBuy ? point.y - 14 : point.y + 2
          const flagBottomY = point.isBuy ? point.y - 6 : point.y + 10
          return (
            <g key={point.id}>
              <line
                x1={point.x}
                y1={point.y + 1}
                x2={point.x}
                y2={poleTop}
                stroke={point.color}
                strokeWidth={1.2}
              />
              <polygon
                points={`${point.x},${flagTipY} ${point.x + 10},${point.isBuy ? point.y - 10 : point.y + 6} ${point.x},${flagBottomY}`}
                fill={point.color}
                opacity={0.95}
              />
              <text
                x={point.x + 12}
                y={point.isBuy ? point.y - 8 : point.y + 8}
                fill={point.color}
                fontSize={9}
                fontFamily="monospace"
              >
                {point.label}
              </text>
            </g>
          )
        })}

        {/* X-axis labels */}
        {xTicks.map(i => (
          <text key={i} x={xOf(i)} y={chartHeight - 6} fill="#64748b" fontSize={10} textAnchor="middle" fontFamily="monospace">
            {isIntraday ? (timeOf(visibleBars[i].date) || shortDateLabel(visibleBars[i].date)) : shortDateLabel(visibleBars[i].date)}
          </text>
        ))}
        </svg>

      {/* Floating tooltip */}
        {showFloatingTooltip && activeHover && (
          <TooltipBox
            bar={{ ...activeHover.bar, prev_close: prevClose }}
            x={activeHover.x}
            y={activeHover.y}
            chartWidth={width}
          />
        )}
      </div>
    </div>
  )
}

/* ?? Public export wrapped in error boundary ????????????????????? */
export default function CandlestickChart(props) {
  return (
    <ChartErrorBoundary>
      <CandlestickInner {...props} />
    </ChartErrorBoundary>
  )
}
