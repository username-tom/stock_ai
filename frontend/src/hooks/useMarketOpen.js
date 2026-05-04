import { useState, useEffect } from 'react'
import { deriveMarketOpen, isMarketHours } from '../utils/marketHours'

/**
 * Returns a live `marketOpen` boolean that re-evaluates every minute so that
 * refetchIntervals based on market hours are always accurate.
 *
 * @param {object|null} quotesMap  Optional quotes map for market_state signals.
 */
export function useMarketOpen(quotesMap = null) {
  const [marketOpen, setMarketOpen] = useState(() => deriveMarketOpen(quotesMap))

  // Re-evaluate whenever quotesMap changes (server signal takes priority)
  useEffect(() => {
    setMarketOpen(deriveMarketOpen(quotesMap))
  }, [quotesMap])

  // Re-evaluate on a 60-second clock so the interval switches automatically
  // when the market opens or closes while the app is idle
  useEffect(() => {
    const id = setInterval(() => {
      setMarketOpen(prev => {
        const next = quotesMap ? deriveMarketOpen(quotesMap) : isMarketHours()
        return next !== prev ? next : prev
      })
    }, 60_000)
    return () => clearInterval(id)
  }, [quotesMap])

  return marketOpen
}
