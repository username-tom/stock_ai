import { useEffect, useRef, useState } from 'react'

/**
 * Tracks price changes for symbols and provides color indicators.
 * 
 * Returns an object keyed by symbol with:
 * - bgColor: 'bg-green-900/30', 'bg-red-900/30', or null (no change)
 * - textColor: 'text-green-400', 'text-red-400', or 'text-slate-200' (neutral)
 * - isUp: true if price increased, false if decreased, null if no change
 * - prevPrice: the previous price used for comparison
 * - comparisonBasis: 'previous_close' or 'session_start' or 'previous'
 * 
 * @param {object} quotes - quote data keyed by symbol with last_price, previous_close, market_state
 * @param {boolean} forceRefresh - external trigger to force update
 */
export function usePriceChangeTracking(quotes = {}, forceRefresh = false) {
  const priceHistoryRef = useRef({}) // track previous session price per symbol
  const colorStateRef = useRef({}) // current color state
  const [colorState, setColorState] = useState({})

  useEffect(() => {
    const newState = {}

    for (const symbol in quotes) {
      const quote = quotes[symbol]
      if (!quote) continue

      const lastPrice = quote.last_price
      const previousClose = quote.previous_close
      const marketState = quote.market_state
      const isMarketOpen = marketState === 'REGULAR' || marketState === 'PRE' || marketState === 'POST'

      if (lastPrice === null || lastPrice === undefined) {
        newState[symbol] = { bgColor: null, textColor: 'text-slate-200', isUp: null, prevPrice: null, comparisonBasis: null }
        continue
      }

      // Get the previous price to compare against
      let comparisonPrice = null
      let comparisonBasis = null

      if (!isMarketOpen && previousClose !== null && previousClose !== undefined) {
        // Market is closed: use previous_close from market_service
        comparisonPrice = previousClose
        comparisonBasis = 'previous_close'
      } else if (priceHistoryRef.current[symbol]) {
        // Market is open or no previous_close: use tracked session price
        comparisonPrice = priceHistoryRef.current[symbol].sessionPrice
        comparisonBasis = priceHistoryRef.current[symbol].basis
      } else {
        // First time seeing this symbol in this session
        // If market is closed, use previous_close; otherwise use last_price as baseline
        if (!isMarketOpen && previousClose !== null) {
          comparisonPrice = previousClose
          comparisonBasis = 'previous_close'
        } else {
          comparisonPrice = lastPrice
          comparisonBasis = 'session_start'
        }
      }

      // Update the session price tracker if this is the first quote or market state changed
      if (!priceHistoryRef.current[symbol]) {
        priceHistoryRef.current[symbol] = {
          sessionPrice: lastPrice,
          basis: comparisonBasis,
          lastMarketState: marketState,
        }
      } else if (priceHistoryRef.current[symbol].lastMarketState !== marketState) {
        // Market state changed (e.g., closed -> open): reset comparison
        priceHistoryRef.current[symbol] = {
          sessionPrice: lastPrice,
          basis: isMarketOpen ? 'session_start' : 'previous_close',
          lastMarketState: marketState,
        }
      } else if (isMarketOpen) {
        // Continuously update session price while market is open
        priceHistoryRef.current[symbol].sessionPrice = lastPrice
      }

      // Determine color
      const change = lastPrice - comparisonPrice
      let bgColor = null
      let textColor = 'text-slate-200'
      let isUp = null

      if (Math.abs(change) < 0.0001) {
        // No meaningful change
        bgColor = null
        textColor = 'text-slate-200'
        isUp = null
      } else if (change > 0) {
        bgColor = 'bg-green-900/30'
        textColor = 'text-green-400'
        isUp = true
      } else {
        bgColor = 'bg-red-900/30'
        textColor = 'text-red-400'
        isUp = false
      }

      newState[symbol] = {
        bgColor,
        textColor,
        isUp,
        prevPrice: comparisonPrice,
        comparisonBasis,
      }
    }

    colorStateRef.current = newState
    setColorState(newState)
  }, [quotes, forceRefresh])

  return colorState
}
