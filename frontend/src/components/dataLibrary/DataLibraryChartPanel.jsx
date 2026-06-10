import { useEffect, useRef, useState } from 'react'
import SubplotChart, { SharedPriceTooltip } from '../charts/SubplotChart'
import CandlestickChart from '../charts/CandlestickChart'

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

const CHART_TYPE_OPTIONS = [
  { key: 'line', label: 'Price Line' },
  { key: 'candles', label: 'Candlestick' },
]

export default function DataLibraryChartPanel({
  symbol,
  chartType,
  setChartType,
  displayPeriod,
  interval,
  indicators,
  toggleIndicator,
  histData,
  histLoading,
  prevClose,
  ibVerified = false,
  source = null,
}) {
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
  }, [symbol, displayPeriod, chartType, histData?.data?.length])

  const isCandlestick = chartType === 'candles'
  const hoverChartX = hoverPoint?.__chartX
  const effectiveHoverX = Number.isFinite(hoverCursorX) ? hoverCursorX : hoverChartX
  const shouldPlaceTooltipRight = Number.isFinite(effectiveHoverX) ? effectiveHoverX < 360 : false
  const rows = histData?.data ?? []
  const hasData = rows.length > 0

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-slate-200">{symbol || '—'} Historical Chart</h2>
            {source && (
              <span
                className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                  ibVerified
                    ? 'border-emerald-700/50 bg-emerald-900/20 text-emerald-300'
                    : 'border-slate-700 bg-dark-800 text-slate-400'
                }`}
                title={ibVerified ? 'IB-verified data' : 'Free source (e.g. Yahoo)'}
              >
                {ibVerified ? 'IB verified' : (source === 'yfinance' ? 'Yahoo' : source)}
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] text-slate-500">
            Interval {interval || '1m'}
          </div>
        </div>
        <div className="flex gap-1">
          {CHART_TYPE_OPTIONS.map(t => (
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
            <SharedPriceTooltip dataPoint={hoverPoint} label={hoverPoint.date} prevClose={prevClose} indicators={indicators} />
          </div>
        )}

        {histLoading ? (
          <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
            Loading historical data…
          </div>
        ) : !hasData ? (
          <div className="flex items-center justify-center h-64 text-slate-500 text-sm text-center px-6">
            No locally stored data for this symbol and date range.
          </div>
        ) : isCandlestick ? (
          <div className="space-y-1">
            <CandlestickChart
              data={rows}
              indicators={indicators}
              prevClose={prevClose}
              hidePremarketAfterOpen={false}
              showFloatingTooltip={false}
              height={440}
              viewWindow={syncedViewWindow}
              onViewWindowChange={setSyncedViewWindow}
              hoverState={syncedHoverState}
              onHoverStateChange={setSyncedHoverState}
              onHoverPointChange={setHoverPoint}
              showSharedHoverTooltip={false}
            />
            <SubplotChart
              data={rows}
              indicators={indicators}
              period={displayPeriod}
              prevClose={prevClose}
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
            data={rows}
            height={440}
            indicators={indicators}
            period={displayPeriod}
            prevClose={prevClose}
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
