import { useState } from 'react'
import {
  ChevronUpIcon,
  ArrowTrendingUpIcon,
  ArrowTrendingDownIcon,
  CpuChipIcon,
  SignalIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'

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

export default function ActivityLog({ activities }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="fixed bottom-12 right-4 z-40 w-80 select-none">
      {/* Collapsed / header tab */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-dark-800 border border-dark-500 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:border-dark-400 transition-colors shadow-lg"
      >
        <div className="flex items-center gap-2">
          <ClockIcon className="h-3.5 w-3.5" />
          <span className="font-medium">Activity Log</span>
          {activities.length > 0 && (
            <span className="bg-dark-600 text-slate-400 border border-dark-500 rounded-full px-1.5 py-px text-[10px] leading-none">
              {activities.length}
            </span>
          )}
        </div>
        <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? '' : 'rotate-180'}`} />
      </button>

      {/* Expanded panel */}
      {open && (
        <div className="mt-1 bg-dark-800 border border-dark-500 rounded-lg shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-dark-600 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">Recent Activity</span>
            <span className="text-[10px] text-slate-600">{activities.length} events</span>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-dark-700">
            {activities.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-600 text-center">No activity yet</div>
            ) : (
              activities.map((a, i) => (
                <div key={i} className="px-3 py-2 flex items-start gap-2 hover:bg-dark-750 transition-colors">
                  <div className="mt-0.5">
                    <ActivityIcon type={a.type} side={a.side} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-300 leading-snug truncate">{a.label}</p>
                    {a.sub && <p className="text-[10px] text-slate-600 truncate mt-0.5">{a.sub}</p>}
                  </div>
                  <span className="text-[10px] text-slate-600 whitespace-nowrap flex-shrink-0 mt-0.5">{a.time}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
