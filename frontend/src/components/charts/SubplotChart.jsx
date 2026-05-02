/**
 * SubplotChart — a configurable multi-panel price chart.
 *
 * Layout
 * ──────
 *  ┌──────────────────────────────────┐
 *  │  Subplots: [Volume] [RSI] [MACD] │  ⚙
 *  ├──────────────────────────────────┤
 *  │  PRICE  (main panel, close line  │
 *  │          + strategy overlays     │
 *  │          + buy/sell triangles)   │
 *  ├──────────────────────────────────┤
 *  │  VOLUME  (bar chart)             │
 *  ├──────────────────────────────────┤
 *  │  RSI (14) (line + 30/70 bands)   │
 *  ├──────────────────────────────────┤
 *  │  MACD  (line + signal + hist)    │
 *  └──────────────────────────────────┘
 *
 * All panels share the same syncId so tooltips and the crosshair are
 * synchronised across panels.
 *
 * Props
 * ─────
 *  data    – OHLCV array.  May contain extra strategy indicator fields
 *            (fast_ma, slow_ma, upper, lower, mid, rsi, macd, …) that are
 *            already computed by the backend; these are auto-detected and
 *            displayed automatically.
 *  height  – Height (px) of the main price panel. Default 240.
 */
import { useState, useMemo } from 'react'
import {
  ComposedChart, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Cog6ToothIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { enrichData } from './indicators'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const YAXIS_WIDTH = 62
const SYNC_ID = 'subplot-sync'

const SHARED_AXIS_STYLE = {
  tick: { fill: '#64748b', fontSize: 10 },
  tickLine: false,
  axisLine: false,
}

/**
 * Strategy indicator keys that are overlaid on the main price panel.
 * Keys must match what the backend attaches to each ohlcv row.
 */
const PRICE_OVERLAYS = {
  fast_ma: { stroke: '#f59e0b', strokeWidth: 1.5, label: 'MA Fast' },
  slow_ma: { stroke: '#60a5fa', strokeWidth: 1.5, label: 'MA Slow' },
  mid:     { stroke: '#94a3b8', strokeWidth: 1,   label: 'BB Mid',   strokeDasharray: '4 4' },
  upper:   { stroke: '#64748b', strokeWidth: 1,   label: 'BB Upper', strokeDasharray: '3 3' },
  lower:   { stroke: '#64748b', strokeWidth: 1,   label: 'BB Lower', strokeDasharray: '3 3' },
}

/** Registered subplot types. */
const SUBPLOT_DEFS = [
  { id: 'volume', label: 'Volume',    defaultEnabled: true,  panelHeight: 85  },
  { id: 'rsi',    label: 'RSI (14)',  defaultEnabled: true,  panelHeight: 100 },
  { id: 'macd',   label: 'MACD',     defaultEnabled: false, panelHeight: 100 },
]

// ─────────────────────────────────────────────────────────────────────────────
// Shared tooltip
// ─────────────────────────────────────────────────────────────────────────────

function SubplotTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-dark-700 border border-dark-500 rounded-lg p-2.5 text-xs shadow-xl min-w-[160px] space-y-0.5">
      <div className="text-slate-400 font-medium mb-1">{label}</div>
      {payload.map((p, i) =>
        p.value != null ? (
          <div key={i} className="flex justify-between gap-4">
            <span style={{ color: p.color }} className="truncate max-w-[90px]">{p.name}</span>
            <span className="text-slate-200 font-mono">
              {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}
            </span>
          </div>
        ) : null
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom dot — renders buy (▲) / sell (▽) triangles on signal points
// ─────────────────────────────────────────────────────────────────────────────

function signalDot(props) {
  const { cx, cy, payload } = props
  if (payload.signal === 1) {
    return (
      <polygon
        key={`buy-${cx}-${cy}`}
        points={`${cx},${cy - 10} ${cx - 5},${cy} ${cx + 5},${cy}`}
        fill="#4ade80"
        opacity={0.9}
      />
    )
  }
  if (payload.signal === -1) {
    return (
      <polygon
        key={`sell-${cx}-${cy}`}
        points={`${cx},${cy + 10} ${cx - 5},${cy} ${cx + 5},${cy}`}
        fill="#f87171"
        opacity={0.9}
      />
    )
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-panel components
// ─────────────────────────────────────────────────────────────────────────────

function VolumePanel({ data, height, showXAxis }) {
  const maxVol = Math.max(...data.map(d => d.volume || 0))
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 2, right: 5, left: 0, bottom: 0 }} syncId={SYNC_ID}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="date" {...SHARED_AXIS_STYLE} interval="preserveStartEnd" hide={!showXAxis} />
        <YAxis
          {...SHARED_AXIS_STYLE}
          width={YAXIS_WIDTH}
          domain={[0, maxVol * 1.1 || 1]}
          tickFormatter={v =>
            v >= 1_000_000
              ? `${(v / 1_000_000).toFixed(0)}M`
              : `${(v / 1_000).toFixed(0)}K`
          }
        />
        <Tooltip content={<SubplotTooltip />} />
        <Bar dataKey="volume" name="Volume" maxBarSize={8} opacity={0.75}>
          {data.map((entry, i) => (
            <Cell key={`vol-${i}`} fill={entry.close >= entry.open ? '#4ade80' : '#f87171'} />
          ))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function RSIPanel({ data, height, showXAxis }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 2, right: 5, left: 0, bottom: 0 }} syncId={SYNC_ID}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="date" {...SHARED_AXIS_STYLE} interval="preserveStartEnd" hide={!showXAxis} />
        <YAxis {...SHARED_AXIS_STYLE} width={YAXIS_WIDTH} domain={[0, 100]} ticks={[30, 50, 70]} />
        <Tooltip content={<SubplotTooltip />} />
        <ReferenceLine y={70} stroke="#f87171" strokeDasharray="4 4" strokeOpacity={0.5} />
        <ReferenceLine y={50} stroke="#475569" strokeDasharray="2 4" strokeOpacity={0.4} />
        <ReferenceLine y={30} stroke="#4ade80" strokeDasharray="4 4" strokeOpacity={0.5} />
        <Line
          type="monotone"
          dataKey="rsi"
          stroke="#a78bfa"
          strokeWidth={1.5}
          dot={false}
          name="RSI"
          connectNulls
          activeDot={{ r: 3, fill: '#a78bfa' }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function MACDPanel({ data, height, showXAxis }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 2, right: 5, left: 0, bottom: 0 }} syncId={SYNC_ID}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="date" {...SHARED_AXIS_STYLE} interval="preserveStartEnd" hide={!showXAxis} />
        <YAxis
          {...SHARED_AXIS_STYLE}
          width={YAXIS_WIDTH}
          domain={['auto', 'auto']}
          tickFormatter={v => v.toFixed(2)}
        />
        <Tooltip content={<SubplotTooltip />} />
        <ReferenceLine y={0} stroke="#475569" strokeOpacity={0.6} />
        <Bar dataKey="macd_hist" name="Histogram" maxBarSize={8} opacity={0.6}>
          {data.map((entry, i) => (
            <Cell
              key={`hist-${i}`}
              fill={(entry.macd_hist ?? 0) >= 0 ? '#4ade80' : '#f87171'}
            />
          ))}
        </Bar>
        <Line
          type="monotone"
          dataKey="macd"
          stroke="#f59e0b"
          strokeWidth={1.5}
          dot={false}
          name="MACD"
          connectNulls
          activeDot={{ r: 3, fill: '#f59e0b' }}
        />
        <Line
          type="monotone"
          dataKey="macd_signal"
          stroke="#f87171"
          strokeWidth={1.5}
          dot={false}
          name="Signal"
          connectNulls
          activeDot={{ r: 3, fill: '#f87171' }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function SubplotChart({ data = [], height = 240 }) {
  const [subplots, setSubplots] = useState(
    SUBPLOT_DEFS.map(d => ({ ...d, enabled: d.defaultEnabled }))
  )
  const [showConfig, setShowConfig] = useState(false)

  // Enrich with client-computed indicators where backend hasn't provided them
  const enriched = useMemo(() => enrichData(data), [data])

  // Subsample for rendering performance (max ~300 points)
  const step = Math.max(1, Math.floor(enriched.length / 300))
  const sampled = useMemo(
    () => enriched.filter((_, i) => i % step === 0),
    [enriched, step]
  )

  // Detect which strategy indicator overlays are present in the data
  const overlayKeys = useMemo(
    () =>
      Object.keys(PRICE_OVERLAYS).filter(k => sampled.some(d => d[k] != null)),
    [sampled]
  )

  const hasBuySell = sampled.some(d => d.signal === 1 || d.signal === -1)

  const enabledSubplots = subplots.filter(s => s.enabled)

  const toggleSubplot = id =>
    setSubplots(prev => prev.map(s => (s.id === id ? { ...s, enabled: !s.enabled } : s)))

  const moveSubplot = (id, dir) =>
    setSubplots(prev => {
      const idx = prev.findIndex(s => s.id === id)
      const next = idx + dir
      if (next < 0 || next >= prev.length) return prev
      const arr = [...prev]
      ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
      return arr
    })

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
        No price data available
      </div>
    )
  }

  return (
    <div>
      {/* ── Config bar ── */}
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-slate-500 mr-1">Subplots:</span>
          {subplots.map(s => (
            <button
              key={s.id}
              onClick={() => toggleSubplot(s.id)}
              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                s.enabled
                  ? 'bg-emerald-600/15 text-emerald-400 border-emerald-600/40'
                  : 'text-slate-500 border-dark-500 hover:text-slate-300 hover:border-dark-400'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowConfig(c => !c)}
          title="Configure subplot order"
          className={`p-1.5 rounded-md transition-colors ${
            showConfig
              ? 'bg-dark-600 text-slate-200'
              : 'text-slate-400 hover:bg-dark-700 hover:text-slate-200'
          }`}
        >
          <Cog6ToothIcon className="h-4 w-4" />
        </button>
      </div>

      {/* ── Reorder / visibility config panel ── */}
      {showConfig && (
        <div className="bg-dark-900/80 border border-dark-500 rounded-lg p-3 mb-3 space-y-2">
          <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">
            Subplot Order &amp; Visibility
          </div>
          {subplots.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`subplot-${s.id}`}
                checked={s.enabled}
                onChange={() => toggleSubplot(s.id)}
                className="rounded accent-emerald-500 cursor-pointer"
              />
              <label
                htmlFor={`subplot-${s.id}`}
                className="text-sm text-slate-300 flex-1 cursor-pointer select-none"
              >
                {s.label}
              </label>
              <button
                onClick={() => moveSubplot(s.id, -1)}
                disabled={i === 0}
                title="Move up"
                className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-25 transition-colors"
              >
                <ChevronUpIcon className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => moveSubplot(s.id, 1)}
                disabled={i === subplots.length - 1}
                title="Move down"
                className="p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-25 transition-colors"
              >
                <ChevronDownIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Main price panel ── */}
      <div>
        <div className="text-[10px] font-medium text-slate-500 pl-1 mb-0.5 uppercase tracking-wider">
          Price
        </div>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={sampled}
            margin={{ top: 5, right: 5, left: 0, bottom: 0 }}
            syncId={SYNC_ID}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis
              dataKey="date"
              {...SHARED_AXIS_STYLE}
              interval="preserveStartEnd"
              hide={enabledSubplots.length > 0}
            />
            <YAxis
              {...SHARED_AXIS_STYLE}
              width={YAXIS_WIDTH}
              domain={['auto', 'auto']}
              tickFormatter={v => `$${v.toFixed(0)}`}
            />
            <Tooltip content={<SubplotTooltip />} />

            {/* Close price line */}
            <Line
              type="monotone"
              dataKey="close"
              stroke="#94a3b8"
              strokeWidth={1.5}
              dot={hasBuySell ? signalDot : false}
              activeDot={{ r: 3 }}
              name="Close"
            />

            {/* Strategy indicator overlays (auto-detected from data) */}
            {overlayKeys.map(k => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                stroke={PRICE_OVERLAYS[k].stroke}
                strokeWidth={PRICE_OVERLAYS[k].strokeWidth}
                strokeDasharray={PRICE_OVERLAYS[k].strokeDasharray}
                dot={false}
                name={PRICE_OVERLAYS[k].label}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── Enabled subplots (in user-defined order) ── */}
      {enabledSubplots.map((s, i) => {
        const isLast = i === enabledSubplots.length - 1
        return (
          <div key={s.id}>
            <div className="text-[10px] font-medium text-slate-500 pl-1 mt-1 mb-0.5 uppercase tracking-wider">
              {s.label}
            </div>
            {s.id === 'volume' && (
              <VolumePanel data={sampled} height={s.panelHeight} showXAxis={isLast} />
            )}
            {s.id === 'rsi' && (
              <RSIPanel data={sampled} height={s.panelHeight} showXAxis={isLast} />
            )}
            {s.id === 'macd' && (
              <MACDPanel data={sampled} height={s.panelHeight} showXAxis={isLast} />
            )}
          </div>
        )
      })}
    </div>
  )
}
