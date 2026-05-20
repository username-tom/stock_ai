/**
 * Client-side technical indicator computation.
 *
 * All functions operate on plain number arrays and return new arrays of the
 * same length, using `null` for positions where there is not enough history
 * to produce a value.
 *
 * `enrichData` is the public entry point used by SubplotChart.  It adds RSI
 * and MACD fields to each data point, but only when those values are not
 * already present from backend-computed strategy output.
 */

/**
 * Compute Exponential Moving Average (EMA).
 * Seeded from the SMA of the first `period` values.
 *
 * @param {(number|null)[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function computeEMA(values, period) {
  const k = 2 / (period + 1)
  const result = new Array(values.length).fill(null)
  let count = 0
  let sum = 0
  let prev = null

  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) continue

    if (prev === null) {
      // Seed phase: accumulate SMA
      sum += v
      count++
      if (count === period) {
        prev = sum / period
        result[i] = prev
      }
    } else {
      prev = v * k + prev * (1 - k)
      result[i] = prev
    }
  }
  return result
}

/**
 * Compute RSI using Wilder's smoothing method.
 *
 * @param {(number|null)[]} closes
 * @param {number} [period=14]
 * @returns {(number|null)[]}
 */
export function computeRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return result

  let avgGain = 0
  let avgLoss = 0

  for (let i = 1; i <= period; i++) {
    if (closes[i] == null || closes[i - 1] == null) continue
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) avgGain += diff
    else avgLoss += -diff
  }
  avgGain /= period
  avgLoss /= period

  const toRSI = (gain, loss) => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss))

  result[period] = toRSI(avgGain, avgLoss)

  for (let i = period + 1; i < closes.length; i++) {
    if (closes[i] == null || closes[i - 1] == null) continue
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result[i] = toRSI(avgGain, avgLoss)
  }
  return result
}

/**
 * Compute MACD line, signal line, and histogram.
 *
 * @param {(number|null)[]} closes
 * @param {number} [fast=12]
 * @param {number} [slow=26]
 * @param {number} [signalPeriod=9]
 * @returns {{ macd: (number|null)[], macd_signal: (number|null)[], macd_hist: (number|null)[] }}
 */
export function computeMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = computeEMA(closes, fast)
  const emaSlow = computeEMA(closes, slow)
  const macd = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  )
  const macd_signal = computeEMA(macd, signalPeriod)
  const macd_hist = macd.map((v, i) =>
    v != null && macd_signal[i] != null ? v - macd_signal[i] : null
  )
  return { macd, macd_signal, macd_hist }
}

/**
 * Compute Simple Moving Average (SMA).
 *
 * @param {(number|null)[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function computeSMA(values, period) {
  const result = new Array(values.length).fill(null)
  let sum = 0
  let count = 0
  const window = []

  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v == null) { window.push(null); continue }
    window.push(v)
    sum += v
    count++
    if (window.length > period) {
      const removed = window.shift()
      if (removed != null) { sum -= removed; count-- }
    }
    if (count === period) result[i] = sum / period
  }
  return result
}

/**
 * Compute Bollinger Bands (20-period SMA ± 2 std dev).
 *
 * @param {(number|null)[]} closes
 * @param {number} [period=20]
 * @param {number} [multiplier=2]
 * @returns {{ upper: (number|null)[], mid: (number|null)[], lower: (number|null)[] }}
 */
export function computeBollingerBands(closes, period = 20, multiplier = 2) {
  const upper = new Array(closes.length).fill(null)
  const mid   = new Array(closes.length).fill(null)
  const lower = new Array(closes.length).fill(null)

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    if (slice.some(v => v == null)) continue
    const mean = slice.reduce((s, v) => s + v, 0) / period
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period
    const stddev = Math.sqrt(variance)
    mid[i]   = mean
    upper[i] = mean + multiplier * stddev
    lower[i] = mean - multiplier * stddev
  }
  return { upper, mid, lower }
}

/**
 * Compute Stochastic Oscillator (%K fast line and %D signal line).
 *
 * @param {(number|null)[]} highs
 * @param {(number|null)[]} lows
 * @param {(number|null)[]} closes
 * @param {number} [kPeriod=14]
 * @param {number} [dPeriod=3]
 * @returns {{ stoch_k: (number|null)[], stoch_d: (number|null)[] }}
 */
export function computeStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const n = closes.length
  const stoch_k = new Array(n).fill(null)

  for (let i = kPeriod - 1; i < n; i++) {
    const sliceH = highs.slice(i - kPeriod + 1, i + 1)
    const sliceL = lows.slice(i - kPeriod + 1, i + 1)
    if (closes[i] == null || sliceH.some(v => v == null) || sliceL.some(v => v == null)) continue
    const highest = Math.max(...sliceH)
    const lowest  = Math.min(...sliceL)
    const range = highest - lowest
    stoch_k[i] = range === 0 ? 50 : ((closes[i] - lowest) / range) * 100
  }

  const stoch_d = computeSMA(stoch_k, dPeriod)
  return { stoch_k, stoch_d }
}

/**
 * Compute Average True Range (ATR) using Wilder's smoothing.
 *
 * @param {(number|null)[]} highs
 * @param {(number|null)[]} lows
 * @param {(number|null)[]} closes
 * @param {number} [period=14]
 * @returns {(number|null)[]}
 */
export function computeATR(highs, lows, closes, period = 14) {
  const n = closes.length
  const result = new Array(n).fill(null)
  if (n < period + 1) return result

  let sum = 0
  for (let i = 1; i <= period; i++) {
    if (highs[i] == null || lows[i] == null || closes[i - 1] == null) continue
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1]),
    )
    sum += tr
  }
  let atr = sum / period
  result[period] = atr

  for (let i = period + 1; i < n; i++) {
    if (highs[i] == null || lows[i] == null || closes[i - 1] == null) continue
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1]),
    )
    atr = (atr * (period - 1) + tr) / period
    result[i] = atr
  }
  return result
}

/**
 * Compute On-Balance Volume (OBV).
 *
 * @param {(number|null)[]} closes
 * @param {(number|null)[]} volumes
 * @returns {(number|null)[]}
 */
export function computeOBV(closes, volumes) {
  const n = closes.length
  const result = new Array(n).fill(null)
  if (n === 0) return result

  result[0] = volumes[0] ?? 0
  for (let i = 1; i < n; i++) {
    if (closes[i] == null || closes[i - 1] == null || result[i - 1] == null) continue
    const vol = volumes[i] ?? 0
    if (closes[i] > closes[i - 1])      result[i] = result[i - 1] + vol
    else if (closes[i] < closes[i - 1]) result[i] = result[i - 1] - vol
    else                                result[i] = result[i - 1]
  }
  return result
}

/**
 * Enrich an OHLCV data array with RSI, MACD, Bollinger Bands, and MAs.
 *
 * Backend-computed values take precedence — if the data already contains
 * non-null values for a given indicator, those fields are left untouched.
 *
 * @param {{ close: number, [key: string]: any }[]} data
 * @returns {object[]}
 */
export function enrichData(data) {
  if (!data || data.length === 0) return data

  const closes  = data.map(d => d.close)
  const highs    = data.map(d => d.high)
  const lows     = data.map(d => d.low)
  const volumes  = data.map(d => d.volume)

  const hasRSI    = data.some(d => d.rsi     != null)
  const hasMACD   = data.some(d => d.macd    != null)
  const hasBB     = data.some(d => d.upper   != null)
  const hasFastMA = data.some(d => d.fast_ma != null)
  const hasSlowMA = data.some(d => d.slow_ma != null)
  const hasStoch  = data.some(d => d.stoch_k != null)
  const hasATR    = data.some(d => d.atr     != null)
  const hasOBV    = data.some(d => d.obv     != null)

  const hasHighLow = highs.some(v => v != null) && lows.some(v => v != null)
  const hasVol     = volumes.some(v => v != null)

  const rsiValues   = hasRSI              ? null : computeRSI(closes)
  const macdValues  = hasMACD             ? null : computeMACD(closes)
  const bbValues    = hasBB               ? null : computeBollingerBands(closes)
  const fastMA      = hasFastMA           ? null : computeEMA(closes, 20)
  const slowMA      = hasSlowMA           ? null : computeEMA(closes, 50)
  const stochValues = hasStoch || !hasHighLow ? null : computeStochastic(highs, lows, closes)
  const atrValues   = hasATR   || !hasHighLow ? null : computeATR(highs, lows, closes)
  const obvValues   = hasOBV   || !hasVol     ? null : computeOBV(closes, volumes)

  const roundTo = (v, decimalPlaces = 2) => (v != null ? parseFloat(v.toFixed(decimalPlaces)) : null)

  return data.map((d, i) => ({
    ...d,
    ...(rsiValues ? { rsi: roundTo(rsiValues[i]) } : {}),
    ...(macdValues
      ? {
          macd: roundTo(macdValues.macd[i], 4),
          macd_signal: roundTo(macdValues.macd_signal[i], 4),
          macd_hist: roundTo(macdValues.macd_hist[i], 4),
        }
      : {}),
    ...(bbValues
      ? {
          upper: roundTo(bbValues.upper[i]),
          mid:   roundTo(bbValues.mid[i]),
          lower: roundTo(bbValues.lower[i]),
        }
      : {}),
    ...(fastMA ? { fast_ma: roundTo(fastMA[i]) } : {}),
    ...(slowMA ? { slow_ma: roundTo(slowMA[i]) } : {}),
    ...(stochValues
      ? {
          stoch_k: roundTo(stochValues.stoch_k[i]),
          stoch_d: roundTo(stochValues.stoch_d[i]),
        }
      : {}),
    ...(atrValues ? { atr: roundTo(atrValues[i], 4) } : {}),
    ...(obvValues ? { obv: obvValues[i] != null ? Math.round(obvValues[i]) : null } : {}),
  }))
}
