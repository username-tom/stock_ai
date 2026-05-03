import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import BacktestPanel from './components/BacktestPanel'
import ReportsPanel from './components/ReportsPanel'
import TradingPanel from './components/TradingPanel'
import ScriptsPanel from './components/ScriptsPanel'

const PANELS = [
  { path: '/',         Component: Dashboard      },
  { path: '/backtest', Component: BacktestPanel  },
  { path: '/reports',  Component: ReportsPanel   },
  { path: '/trading',  Component: TradingPanel   },
  { path: '/scripts',  Component: ScriptsPanel   },
]

function PersistentPanels() {
  const { pathname } = useLocation()
  return (
    <>
      {PANELS.map(({ path, Component }) => (
        <div key={path} className={pathname === path ? '' : 'hidden'}>
          <Component />
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
