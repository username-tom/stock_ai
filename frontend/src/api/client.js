import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

// Market data
export const getQuote = (symbol) => api.get(`/market-data/quote/${symbol}`).then(r => r.data)
export const getHistory = (symbol, period = '1y', interval = '1d') =>
  api.get(`/market-data/history/${symbol}`, { params: { period, interval } }).then(r => r.data)

// Backtest
export const getStrategies = () => api.get('/backtest/strategies').then(r => r.data)
export const runBacktest = (payload) => api.post('/backtest/run', payload).then(r => r.data)
export const getReports = () => api.get('/backtest/reports').then(r => r.data)
export const getReport = (id) => api.get(`/backtest/reports/${id}`).then(r => r.data)
export const deleteReport = (id) => api.delete(`/backtest/reports/${id}`).then(r => r.data)

// Trading
export const getIBStatus = () => api.get('/trading/ib/status').then(r => r.data)
export const connectIB = () => api.post('/trading/ib/connect').then(r => r.data)
export const disconnectIB = () => api.post('/trading/ib/disconnect').then(r => r.data)
export const getIBAccount = () => api.get('/trading/ib/account').then(r => r.data)
export const getIBPositions = () => api.get('/trading/ib/positions').then(r => r.data)
export const getIBOrders = () => api.get('/trading/ib/orders').then(r => r.data)
export const placeOrder = (payload) => api.post('/trading/order', payload).then(r => r.data)
export const cancelOrder = (id) => api.delete(`/trading/order/${id}`).then(r => r.data)
export const getTradeHistory = (limit = 100) =>
  api.get('/trading/history', { params: { limit } }).then(r => r.data)

export default api
