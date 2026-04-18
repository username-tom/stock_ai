import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import BacktestPanel from './components/BacktestPanel'
import ReportsPanel from './components/ReportsPanel'
import TradingPanel from './components/TradingPanel'

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/backtest" element={<BacktestPanel />} />
          <Route path="/reports" element={<ReportsPanel />} />
          <Route path="/trading" element={<TradingPanel />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
