import { useQuery } from '@tanstack/react-query'
import { getHistory } from '../../api/client'

export default function MiniSparkline({ symbol }) {
  const { data, isLoading } = useQuery({
    queryKey: ['history', symbol, '1d', '1m'],
    queryFn: () => getHistory(symbol, '1d', '1m'),
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  })

  if (isLoading) {
    return (
      <div className="w-16 h-[22px] rounded overflow-hidden bg-dark-700 relative">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-dark-500/40 to-transparent animate-shimmer" />
      </div>
    )
  }

  const raw = data?.data ?? []
  // Strip pre-market bars — dates are formatted "MM/DD HH:MM", keep only >= 09:30
  const regular = raw.filter(d => {
    const timePart = d.date?.slice(-5) // "HH:MM"
    return '16:00' >= timePart && timePart >= '09:30'
  })
  const prices = regular.map(d => d.close ?? d.open).filter(v => v != null && v > 0)
  if (prices.length < 2) {
    return <div className="w-16 h-[22px] rounded bg-dark-700/50" />
  }

  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || min * 0.01 || 1
  const W = 64, H = 22
  const pad = 2

  const toX = (i) => pad + (i / (prices.length - 1)) * (W - pad * 2)
  const toY = (p) => pad + (1 - (p - min) / range) * (H - pad * 2)

  const pts = prices.map((p, i) => `${toX(i).toFixed(1)},${toY(p).toFixed(1)}`).join(' ')
  const lastX = toX(prices.length - 1)
  const firstX = toX(0)

  const prevClose = data?.prev_close ?? prices[0]
  const positive = prices[prices.length - 1] >= prevClose
  const color = positive ? '#34d399' : '#f87171'
  const gradId = `spark-${symbol}`

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="overflow-hidden"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon
        points={`${firstX},${H} ${pts} ${lastX},${H}`}
        fill={`url(#${gradId})`}
      />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
