import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

// Market data
export const getQuote = (symbol) => api.get(`/market-data/quote/${symbol}`).then(r => r.data)
export const getBulkQuotes = (symbols) =>
  api.get('/market-data/bulk-quotes', { params: { symbols: symbols.join(',') } }).then(r => r.data)
export const getHistory = (symbol, period = '1y', interval = '1d') =>
  api.get(`/market-data/history/${symbol}`, { params: { period, interval } }).then(r => r.data)
export const getMovers = (topN = 10) =>
  api.get('/market-data/movers', { params: { top_n: topN } }).then(r => r.data)
export const getNews = (symbols) =>
  api.get('/market-data/news', { params: { symbols: symbols.join(',') } }).then(r => r.data)
export const searchSymbols = (q, limit = 8) =>
  api.get('/market-data/search', { params: { q, limit } }).then(r => r.data)

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

// Custom Scripts
export const getScripts = () => api.get('/scripts').then(r => r.data)
export const getScript = (id) => api.get(`/scripts/${id}`).then(r => r.data)
export const getScriptTemplate = () => api.get('/scripts/template').then(r => r.data)
export const getScriptStorageInfo = () => api.get('/scripts/storage-info').then(r => r.data)
export const getBuiltinTemplates = () => api.get('/scripts/builtin-templates').then(r => r.data)
export const createScript = (payload) => api.post('/scripts', payload).then(r => r.data)
export const updateScript = (id, payload) => api.put(`/scripts/${id}`, payload).then(r => r.data)
export const deleteScript = (id) => api.delete(`/scripts/${id}`).then(r => r.data)
export const validateScript = (id) => api.post(`/scripts/${id}/validate`).then(r => r.data)
export const validateScriptCode = (payload) => api.post('/scripts/validate', payload).then(r => r.data)

export default api
