import { NavLink } from 'react-router-dom'
import { useState, useRef } from 'react'
import {
  ChartBarIcon,
  ArrowPathIcon,
  DocumentChartBarIcon,
  BoltIcon,
  CodeBracketIcon,
  BriefcaseIcon,
  Cog6ToothIcon,
  CircleStackIcon,
} from '@heroicons/react/24/outline'
import LivePriceTicker from './LivePriceTicker'

const navItems = [
  { to: '/', label: 'Dashboard', icon: ChartBarIcon, end: true },
  { to: '/sandbox', label: 'Portfolio', icon: BriefcaseIcon },
  { to: '/backtest', label: 'Backtest', icon: ArrowPathIcon },
  { to: '/reports', label: 'Reports', icon: DocumentChartBarIcon },
  { to: '/trading', label: 'Trading', icon: BoltIcon },
  { to: '/scripts', label: 'Scripts', icon: CodeBracketIcon },
  { to: '/data-library', label: 'Data Library', icon: CircleStackIcon },
  { to: '/settings', label: 'Settings', icon: Cog6ToothIcon },
]

const EXPAND_DELAY = 3000 // ms before expanding

export default function Layout({ children }) {
  const [expanded, setExpanded] = useState(false)
  const timerRef = useRef(null)

  function handleMouseEnter() {
    timerRef.current = setTimeout(() => setExpanded(true), EXPAND_DELAY)
  }

  function handleMouseLeave() {
    clearTimeout(timerRef.current)
    setExpanded(false)
  }

  return (
    <div className="flex h-full min-h-screen">
      {/* Sidebar — fixed-width icon strip; expanded panel overlaps content */}
      <aside
        className="flex-shrink-0 relative z-50"
        style={{ width: '3rem' }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Always-visible collapsed strip */}
        <div className="absolute inset-y-0 left-0 w-12 bg-dark-800 border-r border-dark-500 flex flex-col items-center pt-4 pb-4 gap-0.5 z-10">
          {/* Logo — height matches expanded header row (py-[1.125rem] + border-b + nav py-4) */}
          <div className="w-9 flex items-center justify-center flex-shrink-0" style={{ height: '4.75rem' }}>
            <span className="text-xl">📈</span>
          </div>
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <div key={to} className="py-2.5 w-9">
              <NavLink
                to={to}
                end={end}
                title={label}
                className={({ isActive }) =>
                  `flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30'
                      : 'text-slate-500 hover:text-slate-200 hover:bg-dark-700'
                  }`
                }
              >
                <Icon className="h-5 w-5 flex-shrink-0" />
              </NavLink>
            </div>
          ))}
        </div>

        {/* Expanded panel — overlaps main content, icons stay in same position */}
        <div
          className={`absolute inset-y-0 left-0 w-60 bg-dark-800 border-r border-dark-500 flex flex-col shadow-2xl z-20 transition-opacity duration-150 ${
            expanded ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Logo row — icon at same x-position as collapsed strip (pl-1.5 centres it in the 3rem zone) */}
          <div className="flex items-center gap-3 pl-1.5 pr-4 py-[1.125rem] border-b border-dark-500">
            <div className="w-9 h-9 flex items-center justify-center flex-shrink-0">
              <span className="text-2xl">📈</span>
            </div>
            <div>
              <div className="font-bold text-slate-100 leading-none whitespace-nowrap">Stock AI</div>
              <div className="text-xs text-slate-500 mt-0.5 whitespace-nowrap">Trading Platform</div>
            </div>
          </div>

          {/* Nav — icon column lines up with collapsed strip (px-1.5) */}
          <nav className="flex-1 px-1.5 py-4 space-y-1">
            {navItems.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-3 pl-0 pr-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                  }`
                }
              >
                {/* Icon wrapper — same 2.25rem (w-9) as collapsed strip */}
                <span className="w-9 h-9 flex items-center justify-center flex-shrink-0">
                  <Icon className="h-5 w-5" />
                </span>
                {label}
                {label === 'Portfolio' && (
                  <span className="ml-auto text-xs bg-blue-600/30 text-blue-400 border border-blue-600/30 rounded px-1.5 py-0.5 leading-none">
                    SIM
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-dark-500 mb-8">
            <div className="text-xs text-slate-600 text-center">Stock AI v0.1.0</div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-dark-900">
        {children}
      </main>

      <LivePriceTicker />
    </div>
  )
}


