import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Component } from 'react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import Layout from './components/Layout'

const Dashboard = lazy(() => import('./components/Dashboard'))
const SandboxPanel = lazy(() => import('./components/SandboxPanel'))
const BacktestPanel = lazy(() => import('./components/BacktestPanel'))
const ReportsPanel = lazy(() => import('./components/ReportsPanel'))
const TradingPanel = lazy(() => import('./components/TradingPanel'))
const ScriptsPanel = lazy(() => import('./components/ScriptsPanel'))
const SettingsPanel = lazy(() => import('./components/SettingsPanel'))

class PanelErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8 text-center text-slate-400">
          <div className="text-red-400 font-semibold mb-2">Something went wrong</div>
          <div className="text-xs font-mono text-slate-500">{this.state.error?.message}</div>
          <button className="mt-4 text-xs text-emerald-400 underline" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const PANELS = [
  { path: '/',          Component: Dashboard      },
  { path: '/sandbox',   Component: SandboxPanel   },
  { path: '/backtest',  Component: BacktestPanel  },
  { path: '/reports',   Component: ReportsPanel   },
  { path: '/trading',   Component: TradingPanel   },
  { path: '/scripts',   Component: ScriptsPanel   },
  { path: '/settings',  Component: SettingsPanel  },
]

function PersistentPanels() {
  const { pathname } = useLocation()
  const [visitedPaths, setVisitedPaths] = useState(() => new Set(['/']))

  useEffect(() => {
    setVisitedPaths(prev => {
      if (prev.has(pathname)) return prev
      const next = new Set(prev)
      next.add(pathname)
      return next
    })
  }, [pathname])

  const allowedPaths = useMemo(() => new Set(PANELS.map(p => p.path)), [])
  const normalizedPath = allowedPaths.has(pathname) ? pathname : '/'

  useEffect(() => {
    setVisitedPaths(prev => {
      if (prev.has(normalizedPath)) return prev
      const next = new Set(prev)
      next.add(normalizedPath)
      return next
    })
  }, [normalizedPath])

  return (
    <>
      {PANELS.map(({ path, Component }) => (
        <div key={path} className={normalizedPath === path ? '' : 'hidden'}>
          <PanelErrorBoundary>
            {visitedPaths.has(path) && (
              <Suspense fallback={<div className="p-8 text-sm text-slate-400">Loading panel...</div>}>
                <Component />
              </Suspense>
            )}
          </PanelErrorBoundary>
        </div>
      ))}
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          {/* Catch-all so the router doesn't 404 on any path */}
          <Route path="*" element={<PersistentPanels />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
