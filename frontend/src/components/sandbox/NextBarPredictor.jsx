import { useEffect, useMemo, useRef, useState } from 'react'

const CHART_HEIGHT = 220
const CHART_WIDTH = 960
const PAD_X = 18
const PAD_Y = 16

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function toNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function formatMoneyShort(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '—'
}

function formatVolume(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return '—'
  if (numeric >= 1e6) return `${(numeric / 1e6).toFixed(2)}M`
  if (numeric >= 1e3) return `${(numeric / 1e3).toFixed(1)}K`
  return numeric.toFixed(0)
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return null
  const usable = values.filter(Number.isFinite)
  if (!usable.length) return null
  const alpha = 2 / (period + 1)
  let current = usable[0]
  for (let index = 1; index < usable.length; index += 1) {
    current = usable[index] * alpha + current * (1 - alpha)
  }
  return current
}

function computeAtr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return 0
  const ranges = []
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index]
    const previous = bars[index - 1]
    const high = toNumber(current?.high)
    const low = toNumber(current?.low)
    const prevClose = toNumber(previous?.close)
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue
    ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }
  return ema(ranges.slice(-period), Math.min(period, ranges.length)) ?? 0
}

function computeHeikinAshiBias(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return 0
  let previousOpen = null
  let previousClose = null
  let lastBias = 0

  bars.forEach((bar) => {
    const open = toNumber(bar?.open)
    const high = toNumber(bar?.high)
    const low = toNumber(bar?.low)
    const close = toNumber(bar?.close)
    if (![open, high, low, close].every(Number.isFinite)) return
    const haClose = (open + high + low + close) / 4
    const haOpen = previousOpen == null || previousClose == null
      ? (open + close) / 2
      : (previousOpen + previousClose) / 2
    previousOpen = haOpen
    previousClose = haClose
    const range = Math.max(high - low, Math.abs(haClose - haOpen), 0.0001)
    lastBias = clamp((haClose - haOpen) / range, -1, 1)
  })

  return lastBias
}

function computeMacdBias(closes) {
  if (!Array.isArray(closes) || closes.length < 5) return 0
  const fast = ema(closes.slice(-12), Math.min(12, closes.length))
  const slow = ema(closes.slice(-26), Math.min(26, closes.length))
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return 0
  const diff = fast - slow
  const scale = Math.max(Math.abs(slow), 0.0001)
  return clamp(diff / scale * 18, -1, 1)
}

function computeSlopeBias(closes) {
  if (!Array.isArray(closes) || closes.length < 3) return 0
  const recent = closes.slice(-6)
  if (recent.length < 2) return 0
  const first = recent[0]
  const last = recent[recent.length - 1]
  const avg = ema(recent, Math.min(5, recent.length)) ?? last
  const scale = Math.max(avg, 0.0001)
  return clamp(((last - first) / scale) * 9, -1, 1)
}

function computeBookPressure(topOfBook) {
  const bidSize = toNumber(topOfBook?.bid_size)
  const askSize = toNumber(topOfBook?.ask_size)
  const mid = toNumber(topOfBook?.mid)
  const microprice = toNumber(topOfBook?.microprice)
  let pressure = 0

  if (Number.isFinite(bidSize) && Number.isFinite(askSize) && bidSize + askSize > 0) {
    pressure += ((bidSize - askSize) / (bidSize + askSize)) * 0.65
  }
  if (Number.isFinite(mid) && Number.isFinite(microprice) && mid > 0) {
    pressure += clamp(((microprice - mid) / mid) * 12000, -1, 1) * 0.35
  }

  return clamp(pressure, -1, 1)
}

function aggregateFiveMinuteBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return []
  const groups = []
  for (let index = 0; index < bars.length; index += 5) {
    const chunk = bars.slice(index, index + 5)
    if (!chunk.length) continue
    const open = toNumber(chunk[0]?.open)
    const close = toNumber(chunk[chunk.length - 1]?.close)
    const highs = chunk.map(item => toNumber(item?.high)).filter(Number.isFinite)
    const lows = chunk.map(item => toNumber(item?.low)).filter(Number.isFinite)
    const volumes = chunk.map(item => toNumber(item?.volume) ?? 0)
    if (!Number.isFinite(open) || !Number.isFinite(close) || !highs.length || !lows.length) continue
    groups.push({
      open,
      high: Math.max(...highs),
      low: Math.min(...lows),
      close,
      volume: volumes.reduce((sum, value) => sum + value, 0),
    })
  }
  return groups
}

function buildLiveBar(bars, currentPrice, topOfBook) {
  const last = bars[bars.length - 1]
  const previousClose = toNumber(last?.close)
  if (!Number.isFinite(previousClose)) return null
  const current = toNumber(currentPrice)
  const currentCandidate = Number.isFinite(current) && current > 0 ? current : null
  const candidateClose = currentCandidate ?? toNumber(topOfBook?.last_price) ?? previousClose
  const bid = toNumber(topOfBook?.bid)
  const ask = toNumber(topOfBook?.ask)
  const envelope = [candidateClose, previousClose, bid, ask].filter(Number.isFinite)
  return {
    kind: 'live',
    label: 'Live',
    open: previousClose,
    close: candidateClose,
    high: Math.max(...envelope),
    low: Math.min(...envelope),
    volume: toNumber(last?.volume) ?? 0,
    confidence: 1,
    noise: 0,
  }
}

function projectFutureBars({
  bars,
  liveBar,
  topOfBook,
}) {
  if (!Array.isArray(bars) || bars.length === 0 || !liveBar) return { futureBars: [], headline: null }
  const closes = bars.map(bar => toNumber(bar?.close)).filter(Number.isFinite)
  const volumes = bars.map(bar => toNumber(bar?.volume) ?? 0)
  const atr = Math.max(computeAtr(bars), Math.max((toNumber(liveBar.close) ?? 0) * 0.0016, 0.03))
  const slopeBias = computeSlopeBias(closes)
  const macdBias = computeMacdBias(closes)
  const heikinBias = computeHeikinAshiBias(bars)
  const bookPressure = computeBookPressure(topOfBook)
  const fiveMinuteBars = aggregateFiveMinuteBars(bars)
  const fiveMinuteCloses = fiveMinuteBars.map(bar => bar.close)
  const fiveMinuteSlope = computeSlopeBias(fiveMinuteCloses)
  const fiveMinuteMacd = computeMacdBias(fiveMinuteCloses)
  const baseVolume = ema(volumes.slice(-12), Math.min(8, volumes.length)) ?? (toNumber(liveBar.volume) ?? 0)

  const futureBars = []
  let currentOpen = toNumber(liveBar.close)
  let currentClose = toNumber(liveBar.close)
  let inheritedMomentum = (heikinBias * 0.42) + (macdBias * 0.28) + (slopeBias * 0.22) + (bookPressure * 0.08)

  for (let step = 0; step < 5; step += 1) {
    const horizon = step + 1
    const decay = step === 0 ? 1 : Math.max(0.2, 1 - step * 0.18)
    const bookWeight = step === 0 ? 0.16 : Math.max(0, 0.08 - step * 0.02)
    const trendWeight = 0.52 + step * 0.05
    const fiveMinuteWeight = step === 0 ? 0.08 : Math.min(0.26, 0.08 + step * 0.05)
    const momentumBias = clamp(
      (heikinBias * trendWeight)
      + (macdBias * 0.2)
      + (slopeBias * 0.18)
      + (bookPressure * bookWeight)
      + (fiveMinuteSlope * fiveMinuteWeight)
      + (fiveMinuteMacd * (fiveMinuteWeight * 0.65))
      + (inheritedMomentum * 0.14),
      -1,
      1,
    )
    const movement = atr * (0.28 + step * 0.07) * momentumBias * decay
    const projectedClose = currentClose + movement
    const projectedOpen = currentClose
    const wickPad = atr * (0.35 + step * 0.05)
    const noise = atr * (0.55 + step * 0.16)
    const projectedHigh = Math.max(projectedOpen, projectedClose) + wickPad
    const projectedLow = Math.min(projectedOpen, projectedClose) - wickPad
    const volumeScale = clamp(1 - step * 0.08 + Math.abs(momentumBias) * 0.12, 0.65, 1.3)
    const confidence = clamp(
      0.74
        - step * 0.09
        + (Math.sign(heikinBias || 0) === Math.sign(macdBias || 0) ? 0.06 : -0.04)
        - clamp(atr / Math.max(projectedClose, 0.0001), 0, 0.02) * 9,
      0.22,
      0.87,
    )

    futureBars.push({
      kind: step === 0 ? 'prediction-1m' : 'prediction-extended',
      label: step === 0 ? 'T+1m' : `T+${horizon}m`,
      open: projectedOpen,
      close: projectedClose,
      high: projectedHigh,
      low: projectedLow,
      volume: baseVolume * volumeScale,
      confidence,
      noise,
      pathIndex: step,
    })

    currentOpen = projectedOpen
    currentClose = projectedClose
    inheritedMomentum = momentumBias
  }

  return {
    futureBars,
    headline: {
      immediateConfidence: futureBars[0]?.confidence ?? 0,
      pathConfidence: futureBars.length > 1
        ? futureBars.slice(1).reduce((sum, item) => sum + item.confidence, 0) / (futureBars.length - 1)
        : futureBars[0]?.confidence ?? 0,
      atr,
      bias: inheritedMomentum,
      bookPressure,
    },
  }
}

function makeDisplayBars(historyBars, liveBar, futureBars) {
  const confirmed = historyBars.slice(-5).map((bar, index) => ({
    key: `confirmed-${index}-${bar.date ?? index}`,
    kind: 'confirmed',
    label: bar.date ? String(bar.date).slice(-5) : `-${5 - index}`,
    open: toNumber(bar?.open),
    high: toNumber(bar?.high),
    low: toNumber(bar?.low),
    close: toNumber(bar?.close),
    volume: toNumber(bar?.volume) ?? 0,
    confidence: 1,
    noise: 0,
  }))

  const displays = [...confirmed]
  if (liveBar) displays.push({ key: 'live', ...liveBar })
  futureBars.forEach((bar, index) => displays.push({ key: `future-${index}`, ...bar }))
  return displays.filter(item => [item.open, item.high, item.low, item.close].every(Number.isFinite))
}

function priceY(value, minPrice, maxPrice) {
  const usableHeight = CHART_HEIGHT - PAD_Y * 2
  if (!Number.isFinite(value) || !Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice <= minPrice) {
    return PAD_Y + usableHeight / 2
  }
  return PAD_Y + ((maxPrice - value) / (maxPrice - minPrice)) * usableHeight
}

function confidenceTone(value) {
  if (value >= 0.68) return 'text-emerald-300 border-emerald-700/40 bg-emerald-900/20'
  if (value >= 0.45) return 'text-amber-300 border-amber-700/40 bg-amber-900/20'
  return 'text-rose-300 border-rose-700/40 bg-rose-900/20'
}

const AUTO_TRADE_MIN_CONFIDENCE = 0.68
const ACTIVE_ORDER_STATUSES = new Set(['PENDINGSUBMIT', 'APIPENDING', 'PRESUBMITTED', 'SUBMITTED'])

function isActiveOrderStatus(status) {
  return ACTIVE_ORDER_STATUSES.has(String(status ?? '').trim().toUpperCase())
}

export default function NextBarPredictor({
  chartData = [],
  currentPrice,
  symbol,
  topOfBook,
  refetchInterval,
  tradeMode = 'SIMULATED',
  tradeQuantity = 0,
  positionShares = 0,
  positionAvgCost = 0,
  openOrders = [],
  managerSettings = null,
  onSubmitTrade = null,
  onTogglePredictor = null,
}) {
  const [flashCard, setFlashCard] = useState(null)
  const [animatingResolution, setAnimatingResolution] = useState(false)
  const previousConfirmedKeyRef = useRef(null)
  const previousImmediatePredictionRef = useRef(null)
  const flashTimeoutRef = useRef(null)
  const autoTradeEntryKeyRef = useRef(null)
  const previousPositionQtyRef = useRef(0)

  const liveBar = useMemo(
    () => buildLiveBar(chartData, currentPrice, topOfBook),
    [chartData, currentPrice, topOfBook],
  )

  const projectionState = useMemo(
    () => projectFutureBars({ bars: chartData, liveBar, topOfBook }),
    [chartData, liveBar, topOfBook],
  )

  const displayBars = useMemo(
    () => makeDisplayBars(chartData, liveBar, projectionState.futureBars),
    [chartData, liveBar, projectionState.futureBars],
  )

  const minPrice = useMemo(() => {
    const points = displayBars.flatMap(bar => [bar.low - (bar.noise ?? 0), bar.high + (bar.noise ?? 0)]).filter(Number.isFinite)
    return points.length ? Math.min(...points) : 0
  }, [displayBars])

  const maxPrice = useMemo(() => {
    const points = displayBars.flatMap(bar => [bar.low - (bar.noise ?? 0), bar.high + (bar.noise ?? 0)]).filter(Number.isFinite)
    return points.length ? Math.max(...points) : 1
  }, [displayBars])

  const confirmedKey = chartData.length ? `${chartData[chartData.length - 1]?.date ?? chartData.length}:${chartData.length}` : null

  useEffect(() => () => {
    if (flashTimeoutRef.current) {
      window.clearTimeout(flashTimeoutRef.current)
      flashTimeoutRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!confirmedKey || chartData.length < 2) {
      previousConfirmedKeyRef.current = confirmedKey
      previousImmediatePredictionRef.current = projectionState.futureBars[0] ?? null
      return undefined
    }

    if (previousConfirmedKeyRef.current && previousConfirmedKeyRef.current !== confirmedKey) {
      const actualBar = chartData[chartData.length - 1]
      const priorPrediction = previousImmediatePredictionRef.current
      if (priorPrediction && actualBar) {
        const predictedDirection = Math.sign(priorPrediction.close - priorPrediction.open)
        const actualDirection = Math.sign(Number(actualBar.close) - Number(actualBar.open))
        setAnimatingResolution(true)
        if (flashTimeoutRef.current) window.clearTimeout(flashTimeoutRef.current)
        window.setTimeout(() => setAnimatingResolution(false), 650)
        setFlashCard({
          predictedClose: toNumber(priorPrediction.close),
          actualClose: toNumber(actualBar.close),
          predictedRange: (toNumber(priorPrediction.high) ?? 0) - (toNumber(priorPrediction.low) ?? 0),
          actualRange: (toNumber(actualBar.high) ?? 0) - (toNumber(actualBar.low) ?? 0),
          confidence: priorPrediction.confidence ?? 0,
          directionHit: predictedDirection === actualDirection,
        })
        flashTimeoutRef.current = window.setTimeout(() => setFlashCard(null), Math.max(Number(refetchInterval) || 0, 5000))
      }
    }

    previousConfirmedKeyRef.current = confirmedKey
    previousImmediatePredictionRef.current = projectionState.futureBars[0] ?? null
  }, [chartData, confirmedKey, projectionState.futureBars, refetchInterval])

  if (!chartData.length || !displayBars.length) {
    return (
      <div className="rounded-2xl border border-dark-600 bg-dark-900/50 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Next Bar Lab</div>
        <div className="mt-4 text-sm text-slate-500">Waiting for enough intraday bars to build the live forecast.</div>
      </div>
    )
  }

  const slotWidth = (CHART_WIDTH - PAD_X * 2) / Math.max(displayBars.length, 1)
  const immediateBar = projectionState.futureBars[0]
  const extendedBars = projectionState.futureBars.slice(1)
  const pathDelta = projectionState.futureBars.length
    ? projectionState.futureBars[projectionState.futureBars.length - 1].close - liveBar.close
    : 0
  const immediateRange = (immediateBar?.high ?? 0) - (immediateBar?.low ?? 0)
  const immediateBody = (immediateBar?.close ?? 0) - (immediateBar?.open ?? 0)
  const liveToImmediateGap = Number.isFinite(liveBar?.close) && Number.isFinite(immediateBar?.close)
    ? immediateBar.close - liveBar.close
    : 0
  const futureConfidenceAvg = projectionState.futureBars.length
    ? projectionState.futureBars.reduce((sum, bar) => sum + (bar.confidence ?? 0), 0) / projectionState.futureBars.length
    : 0
  const projectedHigh = projectionState.futureBars.length
    ? Math.max(...projectionState.futureBars.map(bar => bar.high).filter(Number.isFinite))
    : null
  const projectedLow = projectionState.futureBars.length
    ? Math.min(...projectionState.futureBars.map(bar => bar.low).filter(Number.isFinite))
    : null
  const directionScore = clamp(((projectionState.headline?.bias ?? 0) * 0.6) + ((projectionState.headline?.bookPressure ?? 0) * 0.4), -1, 1)
  const directionLabel = directionScore >= 0.12 ? 'Bullish lean' : directionScore <= -0.12 ? 'Bearish lean' : 'Neutral lean'
  const volumeMax = Math.max(...displayBars.map(bar => Number(bar.volume) || 0), 1)
  const projectedVolumeAvg = projectionState.futureBars.length
    ? projectionState.futureBars.reduce((sum, bar) => sum + (Number(bar.volume) || 0), 0) / projectionState.futureBars.length
    : 0
  const liveVolume = Number(liveBar?.volume) || 0
  const volumeTiltPct = liveVolume > 0
    ? ((projectedVolumeAvg - liveVolume) / liveVolume) * 100
    : 0
  const takeProfitPct = Math.max(0, Number(managerSettings?.take_profit_pct ?? 1.25) || 0)
  const predictorEnabled = Boolean(managerSettings?.bar_predictor_enabled)
  const normalizedTradeMode = String(tradeMode || 'simulated').trim().toLowerCase()
  const positionQty = Math.max(0, Number(positionShares) || 0)
  const requestedQty = Math.max(0, Number(tradeQuantity) || 0)
  const activeBuyOrder = openOrders.some(order => {
    const side = String(order?.side ?? '').trim().toUpperCase()
    const remaining = Number(order?.remaining ?? order?.quantity ?? 0)
    return side === 'BUY' && remaining > 0 && isActiveOrderStatus(order?.status)
  })
  const activeSellOrder = openOrders.some(order => {
    const side = String(order?.side ?? '').trim().toUpperCase()
    const remaining = Number(order?.remaining ?? order?.quantity ?? 0)
    return side === 'SELL' && remaining > 0 && isActiveOrderStatus(order?.status)
  })
  const immediateConfidence = projectionState.headline?.immediateConfidence ?? 0
  const predictedGainPct = Number.isFinite(liveBar?.close) && Number.isFinite(immediateBar?.close) && Number(liveBar.close) > 0
    ? ((Number(immediateBar.close) - Number(liveBar.close)) / Number(liveBar.close)) * 100
    : null
  const bullishEnough = Boolean(
    managerSettings?.bar_predictor_enabled
      && Number.isFinite(predictedGainPct)
      && predictedGainPct >= takeProfitPct
      && immediateConfidence >= AUTO_TRADE_MIN_CONFIDENCE,
  )
  const autoTradeKey = `${symbol || 'UNKNOWN'}:${confirmedKey || 'no-confirmed'}:${takeProfitPct.toFixed(2)}:${immediateConfidence.toFixed(2)}`

  const handleTogglePredictor = async () => {
    if (typeof onTogglePredictor !== 'function') return
    await onTogglePredictor(!predictorEnabled)
  }

  useEffect(() => {
    setFlashCard(null)
    setAnimatingResolution(false)
    previousConfirmedKeyRef.current = null
    previousImmediatePredictionRef.current = null
    if (flashTimeoutRef.current) {
      window.clearTimeout(flashTimeoutRef.current)
      flashTimeoutRef.current = null
    }
    autoTradeEntryKeyRef.current = null
    previousPositionQtyRef.current = 0
  }, [symbol])

  useEffect(() => {
    if (typeof onSubmitTrade !== 'function') return
    if (!symbol || !liveBar || !immediateBar || !projectionState.headline) return
    if (!predictorEnabled) return

    const buyReason = `next_bar_predictor buy (conf=${(immediateConfidence * 100).toFixed(0)}%, tp=${takeProfitPct.toFixed(2)}%)`

    if (bullishEnough && positionQty <= 0 && requestedQty > 0 && !activeBuyOrder) {
      if (autoTradeEntryKeyRef.current === autoTradeKey) return
      autoTradeEntryKeyRef.current = autoTradeKey
      void onSubmitTrade({
        symbol,
        side: 'BUY',
        quantity: requestedQty,
        order_type: 'MKT',
        price: Number(Number(liveBar.close).toFixed(2)),
        mode: normalizedTradeMode,
        strategy_name: 'next_bar_predictor',
        reason: buyReason,
      }).catch(() => {
        autoTradeEntryKeyRef.current = null
      })
      return
    }
  }, [
    activeBuyOrder,
    autoTradeKey,
    bullishEnough,
    immediateBar,
    immediateConfidence,
    liveBar,
    predictorEnabled,
    normalizedTradeMode,
    onSubmitTrade,
    positionAvgCost,
    positionQty,
    projectionState.headline,
    requestedQty,
    symbol,
    takeProfitPct,
  ])

  useEffect(() => {
    if (positionQty <= 0 && !activeBuyOrder) {
      autoTradeEntryKeyRef.current = null
    }
    previousPositionQtyRef.current = positionQty
  }, [activeBuyOrder, positionQty])

  return (
    <div className="rounded-2xl border border-dark-600 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.12),_transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.92))] p-4 shadow-[0_20px_60px_rgba(2,6,23,0.45)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300/80">Predictive Flow</div>
          <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-100">
            <span>{symbol}</span>
            <span className="text-sm font-medium text-slate-500">5 confirmed + live + 5 minute path</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            The forward strip rolls left each minute. The first forecast is the next minute; the next four bars extend that path.
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {typeof onTogglePredictor === 'function' && (
            <button
              type="button"
              onClick={handleTogglePredictor}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${predictorEnabled ? 'border-emerald-700/40 bg-emerald-900/20 text-emerald-300 hover:bg-emerald-900/30' : 'border-slate-600/50 bg-slate-800/60 text-slate-300 hover:bg-slate-700/70'}`}
              title={predictorEnabled ? 'Disable predictor-driven buy/sell' : 'Enable predictor-driven buy/sell'}
            >
              {predictorEnabled ? 'Predictor ON' : 'Predictor OFF'}
            </button>
          )}
          <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${confidenceTone(projectionState.headline?.immediateConfidence ?? 0)}`}>
            1m conf {((projectionState.headline?.immediateConfidence ?? 0) * 100).toFixed(0)}%
          </span>
          <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${confidenceTone(projectionState.headline?.pathConfidence ?? 0)}`}>
            2-5m conf {((projectionState.headline?.pathConfidence ?? 0) * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="relative overflow-hidden rounded-2xl border border-dark-600 bg-slate-950/70 p-3">
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="h-[220px] w-full">
            <defs>
              <linearGradient id="predictor-history-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgba(56,189,248,0.18)" />
                <stop offset="100%" stopColor="rgba(15,23,42,0)" />
              </linearGradient>
            </defs>
            {[0.2, 0.4, 0.6, 0.8].map((ratio) => {
              const y = PAD_Y + (CHART_HEIGHT - PAD_Y * 2) * ratio
              return (
                <line
                  key={ratio}
                  x1={PAD_X}
                  x2={CHART_WIDTH - PAD_X}
                  y1={y}
                  y2={y}
                  stroke="rgba(148,163,184,0.12)"
                  strokeDasharray="4 8"
                />
              )
            })}

            {displayBars.map((bar, index) => {
              const centerX = PAD_X + slotWidth * index + slotWidth / 2
              const isProjected = bar.kind.startsWith('prediction')
              const isLive = bar.kind === 'live'
              const bodyWidth = isProjected ? slotWidth * 0.44 : slotWidth * 0.56
              const yOpen = priceY(bar.open, minPrice, maxPrice)
              const yClose = priceY(bar.close, minPrice, maxPrice)
              const yHigh = priceY(bar.high, minPrice, maxPrice)
              const yLow = priceY(bar.low, minPrice, maxPrice)
              const bodyTop = Math.min(yOpen, yClose)
              const bodyHeight = Math.max(Math.abs(yClose - yOpen), 2)
              const bullish = bar.close >= bar.open
              const stroke = isProjected
                  ? (bullish ? '#22d3ee' : '#fb923c')
                  : (bullish ? '#34d399' : '#f87171')
              const fill = isProjected
                  ? (bullish ? 'rgba(34,211,238,0.24)' : 'rgba(251,146,60,0.22)')
                  : (bullish ? 'rgba(52,211,153,0.22)' : 'rgba(248,113,113,0.22)')
              const noiseTop = priceY(bar.high + (bar.noise ?? 0), minPrice, maxPrice)
              const noiseBottom = priceY(bar.low - (bar.noise ?? 0), minPrice, maxPrice)
              const transitionClass = animatingResolution && index === 6 ? 'transition-all duration-700' : 'transition-all duration-500'

              return (
                <g key={bar.key} className={transitionClass}>
                  {isLive && (
                    <>
                      <line
                        x1={centerX - bodyWidth * 1.1}
                        x2={centerX - bodyWidth * 1.1}
                        y1={PAD_Y}
                        y2={CHART_HEIGHT - PAD_Y}
                        stroke="rgba(148,163,184,0.75)"
                        strokeWidth="1.5"
                      />
                      <line
                        x1={centerX + bodyWidth * 1.1}
                        x2={centerX + bodyWidth * 1.1}
                        y1={PAD_Y}
                        y2={CHART_HEIGHT - PAD_Y}
                        stroke="rgba(148,163,184,0.75)"
                        strokeWidth="1.5"
                      />
                    </>
                  )}

                  {isProjected && (
                    <rect
                      x={centerX - bodyWidth * 0.7}
                      y={noiseTop}
                      width={bodyWidth * 1.4}
                      height={Math.max(noiseBottom - noiseTop, 4)}
                      rx="10"
                      fill={bullish ? 'rgba(34,211,238,0.10)' : 'rgba(251,146,60,0.10)'}
                      stroke={bullish ? 'rgba(34,211,238,0.28)' : 'rgba(251,146,60,0.26)'}
                      strokeDasharray="4 6"
                    />
                  )}

                  {index > 0 && displayBars[index - 1] && (
                    <line
                      x1={PAD_X + slotWidth * (index - 1) + slotWidth / 2}
                      y1={priceY(displayBars[index - 1].close, minPrice, maxPrice)}
                      x2={centerX}
                      y2={priceY(bar.close, minPrice, maxPrice)}
                      stroke={isProjected ? 'rgba(56,189,248,0.55)' : 'rgba(100,116,139,0.35)'}
                      strokeDasharray={isProjected ? '3 5' : '0'}
                      strokeWidth="1.5"
                    />
                  )}

                  <line x1={centerX} x2={centerX} y1={yHigh} y2={yLow} stroke={stroke} strokeWidth="2" strokeLinecap="round" />
                  <rect
                    x={centerX - bodyWidth / 2}
                    y={bodyTop}
                    width={bodyWidth}
                    height={bodyHeight}
                    rx="6"
                    fill={fill}
                    stroke={stroke}
                    strokeWidth="2"
                    strokeDasharray={isProjected ? '5 4' : undefined}
                  />
                  <text x={centerX} y={CHART_HEIGHT - 6} textAnchor="middle" fill="rgba(148,163,184,0.75)" fontSize="11" fontWeight="600">
                    {bar.label}
                  </text>
                </g>
              )
            })}
          </svg>

          {flashCard && (
            <div className="pointer-events-none absolute left-3 top-3 w-56 rounded-2xl border border-cyan-700/40 bg-slate-950/92 p-3 shadow-2xl backdrop-blur">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300/80">Prediction vs Actual</div>
              <div className={`mt-2 text-sm font-semibold ${flashCard.directionHit ? 'text-emerald-300' : 'text-rose-300'}`}>
                {flashCard.directionHit ? 'Direction matched' : 'Direction missed'}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-400">
                <div>
                  <div className="text-slate-500">Pred close</div>
                  <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort(flashCard.predictedClose)}</div>
                </div>
                <div>
                  <div className="text-slate-500">Actual close</div>
                  <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort(flashCard.actualClose)}</div>
                </div>
                <div>
                  <div className="text-slate-500">Close delta</div>
                  <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort((flashCard.actualClose ?? 0) - (flashCard.predictedClose ?? 0))}</div>
                </div>
                <div>
                  <div className="text-slate-500">Range delta</div>
                  <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort((flashCard.actualRange ?? 0) - (flashCard.predictedRange ?? 0))}</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-500">Confidence {(flashCard.confidence * 100).toFixed(0)}%</div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-dark-600 bg-dark-900/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Volume strip</div>
            <div className="text-[11px] text-slate-500">Hist + live + projected minute flow</div>
          </div>
          <div className="mt-3 grid grid-cols-11 gap-1.5">
            {displayBars.map((bar, index) => {
              const normalized = clamp(((Number(bar.volume) || 0) / volumeMax) * 100, 6, 100)
              const tone = bar.kind.startsWith('prediction')
                ? 'bg-cyan-500/55'
                : bar.kind === 'live'
                  ? 'bg-amber-400/65'
                  : 'bg-slate-500/55'

              return (
                <div key={`volume-${bar.key}-${index}`} className="flex flex-col items-center gap-1">
                  <div className="text-[10px] font-semibold text-slate-400">{formatVolume(bar.volume)}</div>
                  <div className="flex h-12 w-full items-end rounded-md bg-slate-950/40 p-1">
                    <div className={`w-full rounded-sm ${tone}`} style={{ height: `${normalized}%` }} />
                  </div>
                  <div className="text-[10px] font-medium text-slate-500">{bar.label}</div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-3">
          <div className="rounded-2xl border border-dark-600 bg-dark-900/70 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Immediate minute</div>
            <div className="mt-2 text-lg font-semibold text-slate-100">{formatMoneyShort(immediateBar?.close)}</div>
            <div className="mt-1 text-xs text-slate-500">Open {formatMoneyShort(immediateBar?.open)} · Range {formatMoneyShort((immediateBar?.high ?? 0) - (immediateBar?.low ?? 0))}</div>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              <span className={`rounded-full border px-2 py-1 font-semibold ${confidenceTone(immediateBar?.confidence ?? 0)}`}>
                {((immediateBar?.confidence ?? 0) * 100).toFixed(0)}% confidence
              </span>
              <span className="rounded-full border border-cyan-700/30 bg-cyan-900/20 px-2 py-1 font-semibold text-cyan-200">
                Noise ±{formatMoneyShort(immediateBar?.noise ?? 0)}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2.5 py-2">
                <div className="text-slate-500">Body move</div>
                <div className={`mt-1 font-semibold ${immediateBody >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {immediateBody >= 0 ? '+' : ''}{formatMoneyShort(immediateBody).replace('$', '')}
                </div>
              </div>
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2.5 py-2">
                <div className="text-slate-500">Vs live close</div>
                <div className={`mt-1 font-semibold ${liveToImmediateGap >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {liveToImmediateGap >= 0 ? '+' : ''}{formatMoneyShort(liveToImmediateGap).replace('$', '')}
                </div>
              </div>
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2.5 py-2">
                <div className="text-slate-500">Projected high</div>
                <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort(immediateBar?.high)}</div>
              </div>
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2.5 py-2">
                <div className="text-slate-500">Projected low</div>
                <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort(immediateBar?.low)}</div>
              </div>
            </div>
            <div className="mt-2 rounded-lg border border-dark-600 bg-slate-950/40 px-2.5 py-2 text-[11px] text-slate-400">
              Wick + noise envelope: {formatMoneyShort(immediateRange + ((immediateBar?.noise ?? 0) * 2))}
            </div>
          </div>

          <div className="rounded-2xl border border-dark-600 bg-dark-900/70 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Forward strip</div>
            <div className={`mt-2 text-lg font-semibold ${pathDelta >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {pathDelta >= 0 ? '+' : ''}{formatMoneyShort(pathDelta).replace('$', '')}
            </div>
            <div className="mt-1 text-xs text-slate-500">Projected 5-minute drift from live close</div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2 py-1.5">
                <div className="text-slate-500">Path conf</div>
                <div className="mt-1 font-semibold text-slate-200">{(futureConfidenceAvg * 100).toFixed(0)}%</div>
              </div>
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2 py-1.5">
                <div className="text-slate-500">Path high</div>
                <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort(projectedHigh)}</div>
              </div>
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2 py-1.5">
                <div className="text-slate-500">Path low</div>
                <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort(projectedLow)}</div>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {extendedBars.map((bar) => (
                <div key={bar.label} className="flex items-center justify-between rounded-xl border border-dark-600 bg-slate-950/50 px-3 py-2 text-xs">
                  <div>
                    <div className="font-semibold text-slate-300">{bar.label}</div>
                    <div className="text-slate-500">{formatMoneyShort(bar.open)} → {formatMoneyShort(bar.close)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-slate-200">{formatMoneyShort(bar.close)}</div>
                    <div className="text-slate-500">±{formatMoneyShort(bar.noise)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-dark-600 bg-dark-900/70 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Signal blend</div>
            <div className={`mt-2 rounded-lg border px-2.5 py-2 text-xs font-semibold ${directionScore >= 0.12 ? 'border-emerald-700/40 bg-emerald-900/15 text-emerald-300' : directionScore <= -0.12 ? 'border-rose-700/40 bg-rose-900/15 text-rose-300' : 'border-slate-700/50 bg-slate-900/20 text-slate-300'}`}>
              {directionLabel}
              <span className="ml-1 text-[11px] font-medium text-slate-400">({(Math.abs(directionScore) * 100).toFixed(0)} strength)</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl border border-dark-600 bg-slate-950/50 px-3 py-2">
                <div className="text-slate-500">ATR envelope</div>
                <div className="mt-1 font-semibold text-slate-200">{formatMoneyShort(projectionState.headline?.atr)}</div>
              </div>
              <div className="rounded-xl border border-dark-600 bg-slate-950/50 px-3 py-2">
                <div className="text-slate-500">Book pressure</div>
                <div className={`mt-1 font-semibold ${(projectionState.headline?.bookPressure ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {((projectionState.headline?.bookPressure ?? 0) * 100).toFixed(0)}
                </div>
              </div>
              <div className="rounded-xl border border-dark-600 bg-slate-950/50 px-3 py-2">
                <div className="text-slate-500">Projected volume</div>
                <div className="mt-1 font-semibold text-slate-200">{formatVolume(immediateBar?.volume)}</div>
              </div>
              <div className="rounded-xl border border-dark-600 bg-slate-950/50 px-3 py-2">
                <div className="text-slate-500">Update cadence</div>
                <div className="mt-1 font-semibold text-slate-200">{Math.round((Number(refetchInterval) || 0) / 1000) || 60}s</div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2.5 py-2">
                <div className="text-slate-500">Live minute vol</div>
                <div className="mt-1 font-semibold text-slate-200">{formatVolume(liveVolume)}</div>
              </div>
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2.5 py-2">
                <div className="text-slate-500">Projected avg vol</div>
                <div className="mt-1 font-semibold text-slate-200">{formatVolume(projectedVolumeAvg)}</div>
              </div>
              <div className="rounded-lg border border-dark-600 bg-slate-950/50 px-2.5 py-2">
                <div className="text-slate-500">Volume tilt</div>
                <div className={`mt-1 font-semibold ${volumeTiltPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {volumeTiltPct >= 0 ? '+' : ''}{Number.isFinite(volumeTiltPct) ? volumeTiltPct.toFixed(1) : '0.0'}%
                </div>
              </div>
            </div>
            <div className="mt-2 rounded-lg border border-dark-600 bg-slate-950/40 px-2.5 py-2 text-[11px] text-slate-400">
              Blend formula: trend bias + momentum + order-book pressure. Higher agreement increases short-horizon confidence.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}