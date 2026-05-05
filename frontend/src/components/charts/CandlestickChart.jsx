import { useRef, useState, useEffect, useCallback, Component } from 'react'

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
const timeOf = (s) => s?.slice(6) ?? ''                        // "MM/DD HH:MM" ? "HH:MM"
const fmt2   = (n) => (n != null ? n.toFixed(2) : '�')
const fmtVol = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}K`

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

/* ?? Pure-SVG chart � zero recharts, zero invariant risk ????????? */
function CandlestickInner({ data = [], prevClose, height = 260 }) {
  const containerRef = useRef(null)
  const [width, setWidth]   = useState(800)
  const [hovered, setHovered] = useState(null)

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  /* layout */
  const PAD_TOP    = 16
  const PAD_BOTTOM = 24
  const PAD_LEFT   = 8
  const PAD_RIGHT  = 72
  const VOL_HEIGHT = Math.round(height * 0.18)
  const plotW = width  - PAD_LEFT - PAD_RIGHT
  const plotH = height - PAD_TOP  - PAD_BOTTOM

  /* filter: 07:30 ET+ and full OHLC */
  const bars = data.filter(d =>
    timeOf(d.date) >= '07:30' &&
    d.open != null && d.high != null && d.low != null && d.close != null
  )

  if (!bars.length) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center text-slate-500 text-sm"
        style={{ height }}
      >
        No price data available
      </div>
    )
  }

  const n = bars.length

  /* price scale */
  const allP = bars.flatMap(d => [d.low, d.high])
  if (prevClose != null) allP.push(prevClose)
  const minP = Math.min(...allP)
  const maxP = Math.max(...allP)
  const padP = (maxP - minP) * 0.06 || 1
  const lo   = minP - padP
  const hi   = maxP + padP
  const pToY = (p) => PAD_TOP + plotH - ((p - lo) / (hi - lo)) * plotH

  /* volume scale */
  const maxVol = Math.max(...bars.map(d => d.volume ?? 0), 1)
  const vToH   = (v) => (v / maxVol) * VOL_HEIGHT

  /* x scale */
  const bandwidth = plotW / n
  const xOf = (i) => PAD_LEFT + i * bandwidth + bandwidth / 2
  const bw  = Math.max(1, Math.min(14, bandwidth - 2))

  /* reference positions */
  const mktOpenIdx  = bars.findIndex(d => timeOf(d.date) >= '09:30')
  const mktCloseIdx  = bars.findIndex(d => timeOf(d.date) >= '16:00')
  const prevCloseY  = prevClose != null ? pToY(prevClose) : null

  /* axis ticks */
  const yTicks    = Array.from({ length: 5 }, (_, i) => lo + (hi - lo) * (i / 4))
  const xTickStep = Math.ceil(n / 8)
  const xTicks    = bars.reduce((acc, _d, i) => {
    if (i === 0 || i % xTickStep === 0 || i === n - 1) acc.push(i)
    return acc
  }, [])

  const handleMouseMove = useCallback((e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx  = e.clientX - rect.left - PAD_LEFT
    const idx = Math.floor(mx / bandwidth)
    if (idx >= 0 && idx < n) {
      setHovered({
        bar: bars[idx],
        x: e.clientX - rect.left,
        y: Math.max(0, e.clientY - rect.top - 20),
      })
    } else {
      setHovered(null)
    }
  }, [bars, bandwidth, n])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHovered(null)}
    >
      <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>

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

        {/* Market-close vertical line */}
        {mktCloseIdx >= 0 && (
          <g>
            <line
              x1={xOf(mktCloseIdx)} y1={PAD_TOP} x2={xOf(mktCloseIdx)} y2={PAD_TOP + plotH}
              stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3"
            />
            <text x={xOf(mktCloseIdx) + 3} y={PAD_TOP + 10} fill="#f59e0b" fontSize={9}>Close</text>
          </g>
        )}

        {/* Market-open vertical line */}
        {mktOpenIdx >= 0 && (
          <g>
            <line
              x1={xOf(mktOpenIdx)} y1={PAD_TOP} x2={xOf(mktOpenIdx)} y2={PAD_TOP + plotH}
              stroke="#f59e0b" strokeWidth={1} strokeDasharray="3 3"
            />
            <text x={xOf(mktOpenIdx) + 3} y={PAD_TOP + 10} fill="#f59e0b" fontSize={9}>Open</text>
          </g>
        )}

        {/* Volume bars */}
        {bars.map((d, i) => {
          if (!d.volume) return null
          const x = xOf(i)
          const h = vToH(d.volume)
          return (
            <rect key={i} x={x - bw / 2} y={PAD_TOP + plotH - h} width={bw} height={h} fill="#426392" opacity={0.5} />
          )
        })}

        {/* Candlesticks */}
        {bars.map((d, i) => {
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

        {/* Hover crosshair */}
        {hovered && (
          <line
            x1={hovered.x} y1={PAD_TOP} x2={hovered.x} y2={PAD_TOP + plotH}
            stroke="#475569" strokeWidth={1} strokeDasharray="2 2"
          />
        )}

        {/* X-axis labels */}
        {xTicks.map(i => (
          <text key={i} x={xOf(i)} y={height - 6} fill="#64748b" fontSize={10} textAnchor="middle" fontFamily="monospace">
            {timeOf(bars[i].date)}
          </text>
        ))}
      </svg>

      {/* Floating tooltip */}
      {hovered && (
        <TooltipBox
          bar={{ ...hovered.bar, prev_close: prevClose }}
          x={hovered.x}
          y={hovered.y}
          chartWidth={width}
        />
      )}
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
