import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BriefcaseIcon } from '@heroicons/react/24/outline'
import SubplotChart, { SharedPriceTooltip } from '../charts/SubplotChart'
import CandlestickChart from '../charts/CandlestickChart'

function ChartSkeleton() {
  // A lightweight SVG fake-chart that renders instantly with no layout shift
  const w = 600
  const h = 220
  // Fake price line: a gentle wave across the width
  const points = Array.from({ length: 40 }, (_, i) => {
    const x = (i / 39) * w
    const y = h * 0.45 + Math.sin(i * 0.55) * h * 0.12 + Math.sin(i * 1.3) * h * 0.06
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  return (
    <div className="rounded-lg overflow-hidden bg-dark-800 border border-dark-700" style={{ height: 220 }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full h-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="sk-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#334155" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#334155" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="sk-shimmer" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#1e293b" stopOpacity="0" />
            <stop offset="50%"  stopColor="#334155" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#1e293b" stopOpacity="0" />
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              from="-1 0" to="2 0"
              dur="1.6s"
              repeatCount="indefinite"
            />
          </linearGradient>
          <clipPath id="sk-clip">
            <rect x="0" y="0" width={w} height={h} />
          </clipPath>
        </defs>

        {/* Subtle grid lines */}
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1="0" y1={h * f} x2={w} y2={h * f} stroke="#1e293b" strokeWidth="1" />
        ))}

        {/* Gradient fill under the fake line */}
        <polygon
          points={`0,${h} ${points} ${w},${h}`}
          fill="url(#sk-fill)"
          clipPath="url(#sk-clip)"
        />

        {/* Fake price line */}
        <polyline
          points={points}
          fill="none"
          stroke="#334155"
          strokeWidth="1.5"
          strokeLinejoin="round"
          clipPath="url(#sk-clip)"
        />

        {/* Shimmer overlay */}
        <rect x="0" y="0" width={w} height={h} fill="url(#sk-shimmer)" clipPath="url(#sk-clip)" />
      </svg>
    </div>
  )
}

const INDICATOR_OPTIONS = [
  { key: 'bb',     label: 'BB' },
  { key: 'ma9',    label: 'MA(9)' },
  { key: 'ma20',   label: 'MA(20)' },
  { key: 'ma50',   label: 'MA(50)' },
  { key: 'ma100',  label: 'MA(100)' },
  { key: 'ma200',  label: 'MA(200)' },
  { key: 'rsi',    label: 'RSI' },
  { key: 'macd',   label: 'MACD' },
]

export default function PriceChartPanel({
  chartType,
  setChartType,
  chartTypeOptions,
  chartSymbol, chartPeriod, setChartPeriod,
  chartInterval,
  periodOptions,
  indicators, toggleIndicator,
  histData, histLoading,
  chartPrevClose,
  warmupData = null,
  quoteTelemetry = null,
  isInWatchlist = false,
  ibConnected = false,
  useFiveSec = false,
  setUseFiveSec = () => {},
  fiveSecAvailable = false,
}) {
  const navigate = useNavigate()
  const chartAreaRef = useRef(null)
  const [syncedViewWindow, setSyncedViewWindow] = useState({ startRatio: 0, endRatio: 1 })
  const [syncedHoverState, setSyncedHoverState] = useState(null)
  const [hoverPoint, setHoverPoint] = useState(null)
  const [hoverCursorX, setHoverCursorX] = useState(null)

  useEffect(() => {
    setSyncedViewWindow({ startRatio: 0, endRatio: 1 })
    setSyncedHoverState(null)
    setHoverPoint(null)
    setHoverCursorX(null)
  }, [chartSymbol, chartPeriod, chartType, histData?.data?.length])

  const isCandlestick = chartType === 'candles'
  const hoverChartX = hoverPoint?.__chartX
  const effectiveHoverX = Number.isFinite(hoverCursorX) ? hoverCursorX : hoverChartX
  const shouldPlaceTooltipRight = Number.isFinite(effectiveHoverX)
    ? effectiveHoverX < 360
    : false
  const ibTelemetry = histData?.ib_telemetry ?? quoteTelemetry
  const effectiveGap = ibTelemetry?.effective_request_gap_seconds
  const pacingReason = ibTelemetry?.last_pacing_error
  const pacingLimited = ibTelemetry?.pacing_limited === true
  const gapLabel = Number.isFinite(effectiveGap)
    ? `${Math.max(1, Math.round(effectiveGap))}s`
    : null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="font-semibold text-slate-200">{chartSymbol} Price Chart</h2>
            {isInWatchlist && (
              <button
                onClick={() => navigate(`/sandbox?symbol=${chartSymbol}`)}
                title="View in Portfolio"
                className="text-slate-500 hover:text-emerald-400 transition-colors"
              >
                <BriefcaseIcon className="h-4 w-4" />
              </button>
            )}
          </div>
          {gapLabel && (
            <div className="mt-1 flex items-center gap-2 min-w-0">
              <span
                className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                  pacingLimited
                    ? 'border-amber-700/50 bg-amber-900/20 text-amber-300'
                    : 'border-slate-700 bg-dark-800 text-slate-400'
                }`}
                title={`IB effective refresh cadence: ${gapLabel}`}
              >
                IB gap {gapLabel}
              </span>
              {pacingReason && (
                <span
                  className="truncate text-[10px] text-slate-500"
                  title={pacingReason}
                >
                  {pacingReason}
                </span>
              )}
            </div>
          )}
          <div className="mt-1 text-[10px] text-slate-500">
            Interval {chartInterval || '1d'}
          </div>
        </div>
        <div className="flex gap-1">
          {chartTypeOptions?.map(t => (
            <button
              key={t.key}
              onClick={() => setChartType(t.key)}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                chartType === t.key
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex gap-1">
          {periodOptions?.map(p => (
            <button
              key={p.key}
              onClick={() => setChartPeriod(p.key)}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                chartPeriod === p.key
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {ibConnected && chartType === 'candles' && chartPeriod === '1d' && (
          <button
            onClick={() => fiveSecAvailable && setUseFiveSec(!useFiveSec)}
            disabled={!fiveSecAvailable}
            title={
              fiveSecAvailable
                ? 'Stream 5-second IB bars (requires IB connection with live market data)'
                : '5s bars require IB connection with live market data enabled (market_data_type=1)'
            }
            className={`px-2 py-1 text-xs rounded-md border transition-colors ${
              !fiveSecAvailable
                ? 'bg-dark-800 border-dark-700 text-slate-600 cursor-not-allowed'
                : useFiveSec
                  ? 'bg-sky-600 border-sky-500 text-white'
                  : 'bg-dark-800 border-dark-500 text-slate-400 hover:text-slate-200'
            }`}
          >
            5s bars
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {INDICATOR_OPTIONS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => toggleIndicator(key)}
            className={`px-2 py-0.5 text-xs rounded-md border transition-colors ${
              indicators[key]
                ? 'bg-dark-600 border-emerald-600 text-emerald-400'
                : 'bg-dark-800 border-dark-500 text-slate-500 hover:text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        ref={chartAreaRef}
        className="relative"
        onMouseMove={(event) => {
          const rect = chartAreaRef.current?.getBoundingClientRect()
          if (!rect) return
          setHoverCursorX(event.clientX - rect.left)
        }}
        onMouseLeave={() => setHoverCursorX(null)}
      >
        {hoverPoint && (
          <div
            className={`pointer-events-none absolute top-0 z-20 pb-2 ${shouldPlaceTooltipRight ? 'right-3' : 'left-3'}`}
          >
            <SharedPriceTooltip dataPoint={hoverPoint} label={hoverPoint.date} prevClose={chartPrevClose} indicators={indicators} />
          </div>
        )}
        {histLoading ? (
          <ChartSkeleton />
        ) : isCandlestick ? (
          <div className="space-y-1">
          <CandlestickChart
            data={histData?.data ?? []}
            warmupData={warmupData ?? undefined}
            indicators={indicators}
            prevClose={chartPrevClose}
            hidePremarketAfterOpen={false}
            showFloatingTooltip={false}
            height={220}
            viewWindow={syncedViewWindow}
            onViewWindowChange={setSyncedViewWindow}
            hoverState={syncedHoverState}
            onHoverStateChange={setSyncedHoverState}
            onHoverPointChange={setHoverPoint}
            showSharedHoverTooltip={false}
          />
          <SubplotChart
            data={histData?.data ?? []}
            warmupData={warmupData ?? undefined}
            indicators={indicators}
            period={chartPeriod}
            prevClose={chartPrevClose}
            hidePricePanel
            viewWindow={syncedViewWindow}
            onViewWindowChange={setSyncedViewWindow}
            hoverState={syncedHoverState}
            onHoverStateChange={setSyncedHoverState}
            onHoverPointChange={setHoverPoint}
            showSharedHoverTooltip={false}
          />
          </div>
        ) : (
          <SubplotChart
            data={histData?.data ?? []}
            warmupData={warmupData ?? undefined}
            height={220}
            indicators={indicators}
            period={chartPeriod}
            prevClose={chartPrevClose}
            hoverState={syncedHoverState}
            onHoverStateChange={setSyncedHoverState}
            onHoverPointChange={setHoverPoint}
            showSharedHoverTooltip={false}
          />
        )}
      </div>
    </div>
  )
}
