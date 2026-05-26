import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getIBStatus, connectIB, disconnectIB, setIBMode,
  getIBAccount, getIBPositions, getIBOrders, getTradeHistory,
  placeOrder, cancelOrder,
} from '../api/client'
import { useAppSettings } from '../hooks/useAppSettings'
import SymbolAutocomplete from './shared/SymbolAutocomplete'
import {
  BoltIcon, SignalIcon, SignalSlashIcon,
  ArrowUpIcon, ArrowDownIcon,
  ClockIcon, CheckCircleIcon, XCircleIcon,
} from '@heroicons/react/24/outline'

function StatusDot({ connected }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
  )
}

export default function TradingPanel() {
  const qc = useQueryClient()
  const appSettings = useAppSettings()
  const [orderForm, setOrderForm] = useState({
    symbol: 'AAPL',
    side: 'BUY',
    quantity: 10,
    order_type: 'MKT',
    limit_price: '',
    price: 150,
  })
  const [orderMsg, setOrderMsg] = useState(null)

  const { data: ibStatus } = useQuery({
    queryKey: ['ib-status'],
    queryFn: getIBStatus,
    refetchInterval: appSettings.trading_status_ms,
  })

  const { data: positions, isLoading: positionsLoading } = useQuery({
    queryKey: ['ib-positions'],
    queryFn: getIBPositions,
    enabled: ibStatus?.connected,
    refetchInterval: appSettings.trading_positions_ms,
  })

  const { data: ibAccount } = useQuery({
    queryKey: ['ib-account'],
    queryFn: getIBAccount,
    enabled: ibStatus?.connected,
    refetchInterval: appSettings.trading_positions_ms,
  })

  const { data: openOrders, isLoading: ordersLoading } = useQuery({
    queryKey: ['ib-orders'],
    queryFn: getIBOrders,
    enabled: ibStatus?.connected,
    refetchInterval: appSettings.trading_orders_ms,
  })

  const isConnected = ibStatus?.connected
  const currentMode = ibStatus?.mode ?? 'paper'
  const historyMode = isConnected
    ? (currentMode === 'live' ? 'LIVE' : 'PAPER')
    : 'SIMULATED'

  const { data: histData, isLoading: histLoading, refetch: refetchHistory } = useQuery({
    queryKey: ['trade-history', historyMode],
    queryFn: () => getTradeHistory(50, historyMode),
  })

  const connectMut = useMutation({
    mutationFn: connectIB,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ib-status'] }),
  })

  const disconnectMut = useMutation({
    mutationFn: disconnectIB,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ib-status'] }),
  })

  const ibModeMut = useMutation({
    mutationFn: (mode) => setIBMode(mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ib-status'] }),
  })

  const orderMut = useMutation({
    mutationFn: placeOrder,
    onSuccess: (data) => {
      setOrderMsg({ type: 'success', text: `Order placed — ID: ${data.id ?? data.ib_order_id}` })
      qc.invalidateQueries({ queryKey: ['trade-history', historyMode] })
      qc.invalidateQueries({ queryKey: ['ib-positions'] })
      qc.invalidateQueries({ queryKey: ['ib-orders'] })
    },
    onError: (err) => {
      setOrderMsg({ type: 'error', text: err.response?.data?.detail || err.message })
    },
  })

  const cancelMut = useMutation({
    mutationFn: async (ibOrderId) => {
      const result = await cancelOrder(ibOrderId)
      if (result?.error) {
        throw new Error(result.error)
      }
      return result
    },
    onSuccess: (data) => {
      setOrderMsg({ type: 'success', text: `Cancel submitted for order #${data?.cancelled ?? 'unknown'}` })
      qc.invalidateQueries({ queryKey: ['ib-orders'] })
      qc.invalidateQueries({ queryKey: ['trade-history', historyMode] })
    },
    onError: (err) => {
      setOrderMsg({ type: 'error', text: err.response?.data?.detail || err.message })
    },
  })

  const handleOrderSubmit = (e) => {
    e.preventDefault()
    setOrderMsg(null)
    if (orderForm.order_type === 'LMT' && !orderForm.limit_price) {
      setOrderMsg({ type: 'error', text: 'Limit price is required for limit orders.' })
      return
    }
    const executionMode = isConnected
      ? (currentMode === 'live' ? 'LIVE' : 'PAPER')
      : 'SIMULATED'

    const payload = {
      symbol: orderForm.symbol,
      side: orderForm.side,
      quantity: parseFloat(orderForm.quantity),
      mode: executionMode,
      order_type: orderForm.order_type,
    }
    if (executionMode === 'SIMULATED') {
      payload.price = parseFloat(orderForm.price)
    }
    if (orderForm.order_type === 'LMT' && orderForm.limit_price) {
      payload.limit_price = parseFloat(orderForm.limit_price)
    }
    orderMut.mutate(payload)
  }

  const executionModeLabel = isConnected
    ? (currentMode === 'live' ? 'LIVE (IB API)' : 'PAPER (IB API)')
    : 'SIMULATED'
  const connectState = connectMut.data?.status
  const connectMessage = connectMut.data?.message
  const portfolioRefreshSec = Math.max(1, Math.round((appSettings.trading_positions_ms ?? 5_000) / 1_000))

  const refreshPortfolioDetails = () => {
    qc.invalidateQueries({ queryKey: ['ib-account'] })
    qc.invalidateQueries({ queryKey: ['ib-positions'] })
  }

  const asMoney = (v, ccy = 'USD') => {
    const n = Number(v)
    if (!Number.isFinite(n)) return '—'
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(n)
  }
  const acctField = (key) => {
    if (!isConnected || !ibAccount || ibAccount.error) return '—'
    const node = ibAccount?.[key]
    if (!node || node.value == null) return '—'
    return asMoney(node.value, node.currency || 'USD')
  }
  const portfolioStats = (() => {
    const rows = positions?.positions ?? []
    const grossMarketValue = rows.reduce((s, p) => s + (Number(p.market_value) || 0), 0)
    const grossQty = rows.reduce((s, p) => s + Math.abs(Number(p.quantity) || 0), 0)
    return {
      symbols: rows.length,
      grossQty,
      grossMarketValue,
    }
  })()

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Trading</h1>
          <p className="text-sm text-slate-400 mt-0.5">Simulated, paper &amp; live order management via IB API</p>
        </div>
      </div>

      {/* IB Connection card */}
      <div className="card">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <StatusDot connected={isConnected} />
            <div>
              <div className="font-semibold text-slate-200">
                Interactive Brokers {isConnected ? 'Connected' : 'Disconnected'}
              </div>
              <div className="text-xs text-slate-500">
                {ibStatus?.host}:{ibStatus?.port} · Mode: {currentMode?.toUpperCase()} · Transport: ibapi
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Paper / Live toggle */}
            <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1 border border-dark-500">
              <button
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${currentMode === 'paper' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                onClick={() => !isConnected && ibModeMut.mutate('paper')}
                disabled={isConnected || ibModeMut.isPending}
                title={isConnected ? 'Disconnect first to switch modes' : 'Switch to Paper trading'}
              >
                Paper
              </button>
              <button
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${currentMode === 'live' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                onClick={() => !isConnected && ibModeMut.mutate('live')}
                disabled={isConnected || ibModeMut.isPending}
                title={isConnected ? 'Disconnect first to switch modes' : 'Switch to Live trading'}
              >
                🔴 Live
              </button>
            </div>
            <button
              className="btn-primary"
              onClick={() => connectMut.mutate()}
              disabled={isConnected || connectMut.isPending}
            >
              <SignalIcon className="h-4 w-4" />
              Connect TWS/Gateway
            </button>
            <button
              className="btn-secondary"
              onClick={() => disconnectMut.mutate()}
              disabled={!isConnected || disconnectMut.isPending}
            >
              <SignalSlashIcon className="h-4 w-4" />
              Disconnect
            </button>
          </div>
        </div>
        {connectMessage && (
          <div className={`mt-3 text-sm rounded-lg p-2 px-3 ${
            connectState === 'ok'
              ? 'text-emerald-300 bg-emerald-900/20 border border-emerald-700/30'
              : 'text-red-300 bg-red-900/20 border border-red-700/30'
          }`}>
            {connectMessage}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="space-y-5">
          {/* Order form */}
          <form onSubmit={handleOrderSubmit} className="card space-y-4">
            <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
              Place Order
            </h2>

            <div>
              <label className="label">Symbol</label>
              <SymbolAutocomplete
                value={orderForm.symbol}
                onChange={v => setOrderForm(f => ({ ...f, symbol: v }))}
                placeholder="Symbol…"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Side</label>
                <select className="input" value={orderForm.side}
                  onChange={e => setOrderForm(f => ({ ...f, side: e.target.value }))}>
                  <option>BUY</option>
                  <option>SELL</option>
                </select>
              </div>
              <div>
                <label className="label">Execution Mode</label>
                <div className="input flex items-center justify-between">
                  <span>{executionModeLabel}</span>
                  {isConnected ? (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${currentMode === 'live' ? 'text-red-300 border-red-700/40 bg-red-900/20' : 'text-blue-300 border-blue-700/40 bg-blue-900/20'}`}>
                      IB
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border text-slate-400 border-dark-500 bg-dark-800">
                      SIM
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Quantity</label>
                <input className="input" type="number" min="1" value={orderForm.quantity}
                  onChange={e => setOrderForm(f => ({ ...f, quantity: e.target.value }))} />
              </div>
              <div>
                <label className="label">Order Type</label>
                <select className="input" value={orderForm.order_type}
                  onChange={e => setOrderForm(f => ({ ...f, order_type: e.target.value }))}>
                  <option value="MKT">Market</option>
                  <option value="LMT">Limit</option>
                </select>
              </div>
            </div>

            {!isConnected && (
              <div>
                <label className="label">Fill Price ($)</label>
                <input className="input" type="number" step="0.01" value={orderForm.price}
                  onChange={e => setOrderForm(f => ({ ...f, price: e.target.value }))} />
              </div>
            )}

            {orderForm.order_type === 'LMT' && (
              <div>
                <label className="label">Limit Price ($)</label>
                <input className="input" type="number" step="0.01" min="0.01" required={orderForm.order_type === 'LMT'} value={orderForm.limit_price}
                  onChange={e => setOrderForm(f => ({ ...f, limit_price: e.target.value }))} />
              </div>
            )}

            {!isConnected && (
              <div className="text-xs text-slate-400 bg-dark-900/50 border border-dark-600 rounded-lg p-2">
                Orders are currently simulated. Connect to TWS/Gateway to route orders to IB ({currentMode.toUpperCase()}).
              </div>
            )}

            <button type="submit" className={`w-full justify-center ${orderForm.side === 'BUY' ? 'btn-primary' : 'btn-danger'}`}
              disabled={orderMut.isPending}>
              {orderMut.isPending ? 'Placing…' : (
                <>
                  {orderForm.side === 'BUY'
                    ? <ArrowUpIcon className="h-4 w-4" />
                    : <ArrowDownIcon className="h-4 w-4" />}
                  {orderForm.side} {orderForm.quantity} {orderForm.symbol}
                </>
              )}
            </button>

            {orderMsg && (
              <div className={`flex items-center gap-2 p-3 rounded-lg text-sm border ${
                orderMsg.type === 'success'
                  ? 'bg-emerald-900/20 border-emerald-700/30 text-emerald-400'
                  : 'bg-red-900/20 border-red-700/30 text-red-400'
              }`}>
                {orderMsg.type === 'success'
                  ? <CheckCircleIcon className="h-4 w-4 flex-shrink-0" />
                  : <XCircleIcon className="h-4 w-4 flex-shrink-0" />}
                {orderMsg.text}
              </div>
            )}
          </form>

          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
                Portfolio Details
              </h3>
              <button
                className="text-xs text-slate-400 hover:text-slate-200"
                onClick={refreshPortfolioDetails}
                title="Refresh portfolio details now"
              >
                Refresh
              </button>
            </div>
            <div className="text-[11px] text-slate-500 mb-2">Auto-refreshes every {portfolioRefreshSec}s</div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Connection</span><span className="text-slate-200">{isConnected ? 'Connected' : 'Disconnected'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Mode</span><span className="text-slate-200">{currentMode?.toUpperCase?.() ?? '—'}</span></div>
              <div className="h-px bg-dark-700 my-1" />
              <div className="flex justify-between"><span className="text-slate-500">Net Liquidation</span><span className="text-slate-200 font-mono">{acctField('NetLiquidation')}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Available Funds</span><span className="text-slate-200 font-mono">{acctField('AvailableFunds')}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Buying Power</span><span className="text-slate-200 font-mono">{acctField('BuyingPower')}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Total Cash Value</span><span className="text-slate-200 font-mono">{acctField('TotalCashValue')}</span></div>
              <div className="h-px bg-dark-700 my-1" />
              <div className="flex justify-between"><span className="text-slate-500">Symbols Held</span><span className="text-slate-200 font-mono">{isConnected ? portfolioStats.symbols : '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Gross Quantity</span><span className="text-slate-200 font-mono">{isConnected ? portfolioStats.grossQty.toFixed(2) : '—'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Gross Market Value</span><span className="text-slate-200 font-mono">{isConnected ? asMoney(portfolioStats.grossMarketValue) : '—'}</span></div>
            </div>
          </div>
        </div>

        {/* Positions & orders */}
        <div className="xl:col-span-2 space-y-5">
          {/* Open positions */}
          <div className="card">
            <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-3">
              Open Positions {isConnected ? '' : '(IB not connected)'}
            </h3>
            {positionsLoading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-8 bg-dark-700 rounded animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr><th>Symbol</th><th>Qty</th><th>Avg Cost</th><th>Market Value</th></tr>
                  </thead>
                  <tbody>
                    {(positions?.positions ?? []).map((p, i) => (
                      <tr key={i}>
                        <td className="font-mono font-bold text-slate-200">{p.symbol}</td>
                        <td className={p.quantity >= 0 ? 'pos' : 'neg'}>{p.quantity}</td>
                        <td className="font-mono">${p.avg_cost?.toFixed(2)}</td>
                        <td className="font-mono">${p.market_value?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!positions?.positions?.length && (
                  <div className="text-center text-slate-500 text-sm py-6">No open positions</div>
                )}
              </div>
            )}
          </div>

          {/* Open orders */}
          {isConnected && (
            <div className="card">
              <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-3">Open Orders</h3>
              {ordersLoading ? (
                <div className="space-y-2">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="h-8 bg-dark-700 rounded animate-pulse" />
                  ))}
                </div>
              ) : (
                <div className="table-container">
                  <table>
                    <thead>
                      <tr><th>Order ID</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Status</th><th></th></tr>
                    </thead>
                    <tbody>
                      {(openOrders?.orders ?? []).map((o, i) => (
                        <tr key={i}>
                          <td className="font-mono text-xs">{o.ib_order_id}</td>
                          <td className="font-mono font-bold">{o.symbol}</td>
                          <td className={o.side === 'BUY' ? 'pos' : 'neg'}>{o.side}</td>
                          <td>{o.quantity}</td>
                          <td><span className="badge-yellow">{o.status ?? 'Submitted'}</span></td>
                          <td>
                            <button
                              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                              disabled={cancelMut.isPending}
                              onClick={() => cancelMut.mutate(o.ib_order_id)}
                            >Cancel</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!openOrders?.orders?.length && (
                    <div className="text-center text-slate-500 text-sm py-6">No open orders</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Trade history */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
                Trade History
              </h3>
              <button className="text-xs text-slate-400 hover:text-slate-200" onClick={() => refetchHistory()}>
                Refresh
              </button>
            </div>
            {histLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-8 bg-dark-700 rounded animate-pulse" />
                ))}
              </div>
            ) : (
            <div className="table-container max-h-72 overflow-y-auto">
              <table>
                <thead>
                  <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Mode</th><th>Status</th><th>Date</th></tr>
                </thead>
                <tbody>
                  {(histData?.trades ?? []).map((t) => (
                    <tr key={t.id}>
                      <td className="font-mono font-bold text-slate-200">{t.symbol}</td>
                      <td className={t.side === 'BUY' ? 'pos' : 'neg'}>{t.side}</td>
                      <td>{t.quantity}</td>
                      <td className="font-mono">${t.price?.toFixed(2)}</td>
                      <td><span className="badge-slate">{t.mode}</span></td>
                      <td>
                        <span className={
                          t.status === 'FILLED' ? 'badge-green' :
                          t.status === 'CANCELLED' ? 'badge-red' : 'badge-yellow'
                        }>{t.status}</span>
                      </td>
                      <td className="text-xs text-slate-500 font-mono">
                        {t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!histData?.trades?.length && (
                <div className="text-center text-slate-500 text-sm py-6">No trades yet</div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
