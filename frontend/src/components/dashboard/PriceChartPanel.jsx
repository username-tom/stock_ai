import { useNavigate } from 'react-router-dom'
import { BriefcaseIcon } from '@heroicons/react/24/outline'
import SubplotChart from '../charts/SubplotChart'

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

const PERIOD_OPTIONS = [
  { key: '1d',  label: '1D' },
  { key: '2d',  label: '2D' },
  { key: '5d',  label: '5D' },
  { key: '2w',  label: '2W' },
  { key: '1mo', label: '1M' },
  { key: '3mo', label: '3M' },
  { key: '6mo', label: '6M' },
  { key: '1y',  label: '1Y' },
  { key: '2y',  label: '2Y' },
  { key: '5y',  label: '5Y' },
  { key: 'max', label: 'Max' },
]

const INDICATOR_OPTIONS = [
  { key: 'bb',     label: 'BB' },
  { key: 'fastMa', label: 'Fast MA' },
  { key: 'slowMa', label: 'Slow MA' },
  { key: 'rsi',    label: 'RSI' },
  { key: 'macd',   label: 'MACD' },
]

export default function PriceChartPanel({
  chartSymbol, chartPeriod, setChartPeriod,
  indicators, toggleIndicator,
  histData, histLoading,
  chartPrevClose,
  quoteTelemetry = null,
  isInWatchlist = false,
}) {
  const navigate = useNavigate()
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
        </div>
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map(p => (
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
      {histLoading ? (
        <ChartSkeleton />
      ) : (
        <SubplotChart
          data={histData?.data ?? []}
          height={220}
          indicators={indicators}
          period={chartPeriod}
          prevClose={chartPrevClose}
        />
      )}
    </div>
  )
}
