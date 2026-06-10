import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { getDataLibraryTradingDays } from '../../api/client'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function pad(n) {
  return String(n).padStart(2, '0')
}

function toISO(year, month, day) {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

function todayISO() {
  const d = new Date()
  return toISO(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * Calendar range picker that greys out non-trading (weekend/holiday) days.
 * Selecting the same start and end day yields a single-day range.
 *
 * Props:
 *  - value: { start: ISO|null, end: ISO|null }
 *  - onChange: ({ start, end }) => void
 */
export default function TradingDayRangePicker({ value, onChange }) {
  const start = value?.start ?? null
  const end = value?.end ?? null

  const initial = useMemo(() => {
    const base = end || start
    if (base) {
      const [y, m] = base.split('-').map(Number)
      return { year: y, month: m - 1 }
    }
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [view, setView] = useState(initial)
  // When a start is chosen but no end yet, we are mid-selection.
  const [pendingStart, setPendingStart] = useState(null)

  const monthStartISO = toISO(view.year, view.month, 1)
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate()
  const monthEndISO = toISO(view.year, view.month, daysInMonth)

  const { data: tradingData } = useQuery({
    queryKey: ['data-library-trading-days', monthStartISO, monthEndISO],
    queryFn: () => getDataLibraryTradingDays(monthStartISO, monthEndISO),
    staleTime: 24 * 60 * 60 * 1000,
  })

  const tradingSet = useMemo(() => {
    const set = new Set()
    for (const d of tradingData?.days ?? []) {
      if (d.trading) set.add(d.date)
    }
    return set
  }, [tradingData])

  const today = todayISO()
  const firstWeekday = new Date(view.year, view.month, 1).getDay()

  const cells = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  function prevMonth() {
    setView(v => {
      const m = v.month - 1
      return m < 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: m }
    })
  }

  function nextMonth() {
    setView(v => {
      const m = v.month + 1
      return m > 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: m }
    })
  }

  function handlePick(iso) {
    if (pendingStart) {
      // Completing a range.
      if (iso < pendingStart) {
        onChange?.({ start: iso, end: pendingStart })
      } else {
        onChange?.({ start: pendingStart, end: iso })
      }
      setPendingStart(null)
    } else {
      // Starting a new range.
      setPendingStart(iso)
      onChange?.({ start: iso, end: iso })
    }
  }

  const activeStart = pendingStart ?? start
  const activeEnd = pendingStart ? pendingStart : end

  function cellState(iso) {
    if (activeStart && activeEnd) {
      const lo = activeStart < activeEnd ? activeStart : activeEnd
      const hi = activeStart < activeEnd ? activeEnd : activeStart
      if (iso === lo && iso === hi) return 'single'
      if (iso === lo) return 'start'
      if (iso === hi) return 'end'
      if (iso > lo && iso < hi) return 'between'
    } else if (activeStart && iso === activeStart) {
      return 'single'
    }
    return 'none'
  }

  return (
    <div className="bg-dark-800 border border-dark-500 rounded-xl p-4 w-full">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={prevMonth}
          className="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-dark-700"
          title="Previous month"
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>
        <div className="text-sm font-semibold text-slate-200">
          {MONTH_NAMES[view.month]} {view.year}
        </div>
        <button
          onClick={nextMonth}
          className="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-dark-700"
          title="Next month"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="text-center text-[10px] font-medium text-slate-500 py-1">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, idx) => {
          if (d == null) return <div key={`e${idx}`} />
          const iso = toISO(view.year, view.month, d)
          const isFuture = iso > today
          const isTrading = tradingSet.has(iso)
          const disabled = isFuture || !isTrading
          const state = cellState(iso)

          let cls = 'text-slate-300 hover:bg-dark-600'
          if (disabled) {
            cls = 'text-slate-700 cursor-not-allowed'
          } else if (state === 'single' || state === 'start' || state === 'end') {
            cls = 'bg-emerald-600 text-white font-semibold'
          } else if (state === 'between') {
            cls = 'bg-emerald-600/20 text-emerald-300'
          }

          let rounded = 'rounded-md'
          if (state === 'start') rounded = 'rounded-l-md rounded-r-none'
          else if (state === 'end') rounded = 'rounded-r-md rounded-l-none'
          else if (state === 'between') rounded = 'rounded-none'

          return (
            <button
              key={iso}
              disabled={disabled}
              onClick={() => handlePick(iso)}
              title={disabled ? (isFuture ? 'Future date' : 'Non-trading day') : iso}
              className={`h-8 text-xs flex items-center justify-center transition-colors ${rounded} ${cls}`}
            >
              {d}
            </button>
          )
        })}
      </div>

      <div className="mt-3 pt-3 border-t border-dark-600 flex items-center justify-between text-xs">
        <div className="text-slate-400">
          <span className="text-slate-500">From</span>{' '}
          <span className="font-mono text-slate-200">{start ?? '—'}</span>
        </div>
        <div className="text-slate-400">
          <span className="text-slate-500">To</span>{' '}
          <span className="font-mono text-slate-200">{end ?? '—'}</span>
        </div>
      </div>
    </div>
  )
}
