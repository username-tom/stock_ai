import { NavLink } from 'react-router-dom'
import {
  ChartBarIcon,
  ArrowPathIcon,
  DocumentChartBarIcon,
  BoltIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline'

const navItems = [
  { to: '/', label: 'Dashboard', icon: ChartBarIcon, end: true },
  { to: '/backtest', label: 'Backtest', icon: ArrowPathIcon },
  { to: '/reports', label: 'Reports', icon: DocumentChartBarIcon },
  { to: '/trading', label: 'Trading', icon: BoltIcon },
]

export default function Layout({ children }) {
  return (
    <div className="flex h-full min-h-screen">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-dark-800 border-r border-dark-500 flex flex-col">
        {/* Logo */}
        <div className="px-6 py-5 border-b border-dark-500">
          <div className="flex items-center gap-2">
            <span className="text-2xl">📈</span>
            <div>
              <div className="font-bold text-slate-100 leading-none">Stock AI</div>
              <div className="text-xs text-slate-500 mt-0.5">Trading Platform</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-dark-700'
                }`
              }
            >
              <Icon className="h-5 w-5 flex-shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-dark-500">
          <div className="text-xs text-slate-600 text-center">Stock AI v1.0.0</div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto bg-dark-900">
        {children}
      </main>
    </div>
  )
}
