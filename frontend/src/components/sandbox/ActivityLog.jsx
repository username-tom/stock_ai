import { useState, useMemo } from 'react'
import {
  ChevronUpIcon,
  ArrowTrendingUpIcon,
  ArrowTrendingDownIcon,
  CpuChipIcon,
  SignalIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'

const DATE_FILTERS = [
  { value: 'today',   label: 'Today' },
  { value: 'week',    label: 'This week' },
  { value: 'month',   label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: '6month',  label: 'Past 6 months' },
  { value: 'year',    label: 'Past year' },
  { value: 'ytd',     label: 'Year to date' },
  { value: 'all',     label: 'All' },
]

function getFilterStart(filter) {
  const now = new Date()
  switch (filter) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    case 'week':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime()
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    case 'quarter':
      return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).getTime()
    case '6month': {
      const d = new Date(now); d.setMonth(d.getMonth() - 6); return d.getTime()
    }
    case 'year': {
      const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d.getTime()
    }
    case 'ytd':
      return new Date(now.getFullYear(), 0, 1).getTime()
    default:
      return 0
  }
}

function ActivityIcon({ type, side }) {
  if (type === 'trade') {
    return side === 'BUY'
      ? <ArrowTrendingUpIcon className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
      : <ArrowTrendingDownIcon className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
  }
  if (type === 'manager') return <CpuChipIcon className="h-3.5 w-3.5 text-violet-400 flex-shrink-0" />
  if (type === 'engine') return <SignalIcon className="h-3.5 w-3.5 text-blue-400 flex-shrink-0" />
  return <ClockIcon className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" />
}

function formatActivityTimestamp(activity) {
  const ts = Number(activity?.ts)
  if (!Number.isFinite(ts) || ts <= 0) return activity?.time || ''
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function ActivityLog({ activities }) {
  const [open, setOpen] = useState(false)
  const [dateFilter, setDateFilter] = useState('all')
  const [expanded, setExpanded] = useState({})

  const filtered = useMemo(() => {
    if (dateFilter === 'all') return activities
    const start = getFilterStart(dateFilter)
    return activities.filter(a => (a.ts ?? Date.now()) >= start)
  }, [activities, dateFilter])

  // Group every event by its position symbol so per-symbol churn stays
  // contained inside a collapsible section instead of flooding the log.
  const groups = useMemo(() => {
    const bySymbol = new Map()
    for (const a of filtered) {
      const symbol = String(a?.symbol ?? '').trim().toUpperCase() || 'SYSTEM'
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, [])
      bySymbol.get(symbol).push(a)
    }
    const out = [...bySymbol.entries()].map(([symbol, items]) => ({
      symbol,
      items,
      latestTs: items.reduce((m, x) => Math.max(m, Number(x?.ts) || 0), 0),
    }))
    out.sort((a, b) => b.latestTs - a.latestTs)
    return out
  }, [filtered])

  const toggleGroup = (symbol) =>
    setExpanded(prev => ({ ...prev, [symbol]: !prev[symbol] }))

  const badgeCount = dateFilter === 'all'
    ? activities.length
    : filtered.length

  return (
    <div className="fixed bottom-12 right-4 z-40 w-[22rem] select-none">
      {/* Expanded panel — renders first so it appears ABOVE the toggle tab */}
      {open && (
        <div className="bg-dark-800 border border-b-0 border-dark-500 rounded-t-lg shadow-xl flex flex-col max-h-[calc(100vh-8rem)]">
          {/* Header row — never scrolls */}
          <div className="shrink-0 px-3 py-2 border-b border-dark-600 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-300 shrink-0">Activity</span>
            <div className="flex items-center gap-2 min-w-0">
              <select
                value={dateFilter}
                onChange={e => setDateFilter(e.target.value)}
                onClick={e => e.stopPropagation()}
                className="bg-dark-700 border border-dark-500 text-slate-400 text-[10px] rounded px-1.5 py-0.5 outline-none focus:border-dark-400 cursor-pointer"
              >
                {DATE_FILTERS.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              <span className="text-[10px] text-slate-600 whitespace-nowrap shrink-0">
                {filtered.length} event{filtered.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          {/* Grouped activity list — scrolls, takes remaining height */}
          <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-dark-700">
            {groups.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-600 text-center">No activity</div>
            ) : (
              groups.map(group => {
                const isOpen = Boolean(expanded[group.symbol])
                const last = group.items[0]
                return (
                  <div key={group.symbol}>
                    {/* Position section header */}
                    <button
                      onClick={() => toggleGroup(group.symbol)}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-dark-750 transition-colors text-left"
                    >
                      <ChevronUpIcon
                        className={`h-3 w-3 text-slate-500 flex-shrink-0 transition-transform duration-200 ${isOpen ? '' : 'rotate-180'}`}
                      />
                      <span className="text-xs font-semibold text-slate-200 flex-shrink-0">{group.symbol}</span>
                      <span className="text-[10px] text-slate-500 flex-1 min-w-0 truncate">
                        {!isOpen && last ? last.label : ''}
                      </span>
                      <span className="bg-dark-600 text-slate-400 border border-dark-500 rounded-full px-1.5 py-px text-[10px] leading-none flex-shrink-0">
                        {group.items.length}
                      </span>
                    </button>

                    {/* Position events */}
                    {isOpen && (
                      <div className="bg-dark-900 divide-y divide-dark-700 border-t border-dark-700">
                        {group.items.map((a, i) => (
                          <div key={i} className="pl-7 pr-3 py-2 flex items-start gap-2 hover:bg-dark-750 transition-colors">
                            <div className="mt-0.5">
                              <ActivityIcon type={a.type} side={a.side} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-slate-300 leading-snug truncate">{a.label}</p>
                              {a.notes && <p className="text-[10px] text-amber-300 truncate mt-0.5">{a.notes}</p>}
                              {!a.notes && a.sub && <p className="text-[10px] text-slate-600 truncate mt-0.5">{a.sub}</p>}
                            </div>
                            <span className="text-[10px] text-slate-600 whitespace-nowrap flex-shrink-0 mt-0.5">{formatActivityTimestamp(a)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {/* Toggle tab — always at the bottom, joins seamlessly with the panel */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-dark-800 border border-dark-500 text-xs text-slate-400 hover:text-slate-200 hover:border-dark-400 transition-colors shadow-lg ${open ? 'rounded-b-lg' : 'rounded-lg'}`}
      >
        <div className="flex items-center gap-2">
          <ClockIcon className="h-3.5 w-3.5" />
          <span className="font-medium">Activity Log</span>
          {activities.length > 0 && (
            <span className="bg-dark-600 text-slate-400 border border-dark-500 rounded-full px-1.5 py-px text-[10px] leading-none">
              {badgeCount}{dateFilter !== 'all' && filtered.length !== activities.length ? `/${activities.length}` : ''}
            </span>
          )}
        </div>
        <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? '' : 'rotate-180'}`} />
      </button>
    </div>
  )
}
