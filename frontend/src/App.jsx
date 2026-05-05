import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Component } from 'react'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import BacktestPanel from './components/BacktestPanel'
import ReportsPanel from './components/ReportsPanel'
import TradingPanel from './components/TradingPanel'
import ScriptsPanel from './components/ScriptsPanel'
import SandboxPanel from './components/SandboxPanel'
import SettingsPanel from './components/SettingsPanel'

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
  return (
    <>
      {PANELS.map(({ path, Component }) => (
        <div key={path} className={pathname === path ? '' : 'hidden'}>
          <PanelErrorBoundary>
            <Component />
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
