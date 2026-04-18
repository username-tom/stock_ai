import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getIBStatus, connectIB, disconnectIB,
  getIBPositions, getIBOrders, getTradeHistory,
  placeOrder, cancelOrder,
} from '../api/client'
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
  const [orderForm, setOrderForm] = useState({
    symbol: 'AAPL',
    side: 'BUY',
    quantity: 10,
    mode: 'SIMULATED',
    order_type: 'MKT',
    limit_price: '',
    price: 150,
  })
  const [orderMsg, setOrderMsg] = useState(null)

  const { data: ibStatus } = useQuery({
    queryKey: ['ib-status'],
    queryFn: getIBStatus,
    refetchInterval: 5000,
  })

  const { data: positions } = useQuery({
    queryKey: ['ib-positions'],
    queryFn: getIBPositions,
    enabled: ibStatus?.connected,
    refetchInterval: 10000,
  })

  const { data: openOrders } = useQuery({
    queryKey: ['ib-orders'],
    queryFn: getIBOrders,
    enabled: ibStatus?.connected,
    refetchInterval: 5000,
  })

  const { data: histData, refetch: refetchHistory } = useQuery({
    queryKey: ['trade-history'],
    queryFn: () => getTradeHistory(50),
  })

  const connectMut = useMutation({
    mutationFn: connectIB,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ib-status'] }),
  })

  const disconnectMut = useMutation({
    mutationFn: disconnectIB,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ib-status'] }),
  })

  const orderMut = useMutation({
    mutationFn: placeOrder,
    onSuccess: (data) => {
      setOrderMsg({ type: 'success', text: `Order placed — ID: ${data.id ?? data.ib_order_id}` })
      qc.invalidateQueries({ queryKey: ['trade-history'] })
      qc.invalidateQueries({ queryKey: ['ib-positions'] })
    },
    onError: (err) => {
      setOrderMsg({ type: 'error', text: err.response?.data?.detail || err.message })
    },
  })

  const cancelMut = useMutation({
    mutationFn: cancelOrder,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ib-orders'] }),
  })

  const handleOrderSubmit = (e) => {
    e.preventDefault()
    setOrderMsg(null)
    const payload = {
      symbol: orderForm.symbol,
      side: orderForm.side,
      quantity: parseFloat(orderForm.quantity),
      mode: orderForm.mode,
      order_type: orderForm.order_type,
    }
    if (orderForm.mode === 'SIMULATED') {
      payload.price = parseFloat(orderForm.price)
    }
    if (orderForm.order_type === 'LMT' && orderForm.limit_price) {
      payload.limit_price = parseFloat(orderForm.limit_price)
    }
    orderMut.mutate(payload)
  }

  const isConnected = ibStatus?.connected

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Trading</h1>
          <p className="text-sm text-slate-400 mt-0.5">Simulated, paper &amp; live order management</p>
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
                {ibStatus?.host}:{ibStatus?.port} · Mode: {ibStatus?.mode?.toUpperCase()}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-primary"
              onClick={() => connectMut.mutate()}
              disabled={isConnected || connectMut.isPending}
            >
              <SignalIcon className="h-4 w-4" />
              Connect IB
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
        {connectMut.data?.message && (
          <div className="mt-3 text-sm text-slate-400 bg-dark-900/50 rounded-lg p-2 px-3">
            {connectMut.data.message}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Order form */}
        <form onSubmit={handleOrderSubmit} className="card space-y-4">
          <h2 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
            Place Order
          </h2>

          <div>
            <label className="label">Symbol</label>
            <input className="input" value={orderForm.symbol}
              onChange={e => setOrderForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} />
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
              <label className="label">Mode</label>
              <select className="input" value={orderForm.mode}
                onChange={e => setOrderForm(f => ({ ...f, mode: e.target.value }))}>
                <option value="SIMULATED">Simulated</option>
                <option value="PAPER">Paper (IB)</option>
                <option value="LIVE">Live (IB)</option>
              </select>
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

          {orderForm.mode === 'SIMULATED' && (
            <div>
              <label className="label">Fill Price ($)</label>
              <input className="input" type="number" step="0.01" value={orderForm.price}
                onChange={e => setOrderForm(f => ({ ...f, price: e.target.value }))} />
            </div>
          )}

          {orderForm.order_type === 'LMT' && (
            <div>
              <label className="label">Limit Price ($)</label>
              <input className="input" type="number" step="0.01" value={orderForm.limit_price}
                onChange={e => setOrderForm(f => ({ ...f, limit_price: e.target.value }))} />
            </div>
          )}

          {orderForm.mode !== 'SIMULATED' && !isConnected && (
            <div className="text-xs text-yellow-400 bg-yellow-400/10 border border-yellow-400/20 rounded-lg p-2">
              ⚠ Connect to IB to place paper/live orders.
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

        {/* Positions & orders */}
        <div className="xl:col-span-2 space-y-5">
          {/* Open positions */}
          <div className="card">
            <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-3">
              Open Positions {isConnected ? '' : '(IB not connected)'}
            </h3>
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
          </div>

          {/* Open orders */}
          {isConnected && (
            <div className="card">
              <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider mb-3">Open Orders</h3>
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
                        <td><span className="badge-yellow">{o.status}</span></td>
                        <td>
                          <button
                            className="text-xs text-red-400 hover:text-red-300"
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
          </div>
        </div>
      </div>
    </div>
  )
}
