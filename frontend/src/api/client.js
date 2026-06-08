import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

// Market data
export const getQuote = (symbol) => api.get(`/market-data/quote/${symbol}`).then(r => r.data)
export const getTopOfBook = (symbol) => api.get(`/market-data/top-of-book/${symbol}`).then(r => r.data)
export const getBulkQuotes = (symbols) =>
  api.get('/market-data/bulk-quotes', { params: { symbols: symbols.join(',') } }).then(r => r.data)
export const getSymbolSectors = (symbols) =>
  api.get('/market-data/sectors', { params: { symbols: symbols.join(',') } }).then(r => r.data)
export const getHistory = (symbol, period = '1y', interval = '1d') =>
  api.get(`/market-data/history/${symbol}`, { params: { period, interval } }).then(r => r.data)
export const getMovers = (topN = 10, force = false) =>
  api.get('/market-data/movers', { params: { top_n: topN, ...(force ? { force: true } : {}) } }).then(r => r.data)
export const getNews = (symbols, force = false) =>
  api.get('/market-data/news', { params: { symbols: symbols.join(','), ...(force ? { force: true } : {}) } }).then(r => r.data)
export const getEarnings = (watchlist = [], force = false) =>
  api.get('/market-data/earnings', { params: { ...(watchlist.length ? { symbols: watchlist.join(',') } : {}), ...(force ? { force: true } : {}) } }).then(r => r.data)
export const searchSymbols = (q, limit = 8) =>
  api.get('/market-data/search', { params: { q, limit } }).then(r => r.data)
export const getExternalSentiment = (symbol, force = false) =>
  api.get(`/market-data/sentiment/${symbol}`, { params: force ? { force: true } : {} }).then(r => r.data)
export const getBulkExternalSentiment = (symbols, force = false) =>
  api.get('/market-data/sentiment', { params: { symbols: symbols.join(','), ...(force ? { force: true } : {}) } }).then(r => r.data)

// Backtest
export const getStrategies = () => api.get('/backtest/strategies').then(r => r.data)
export const runBacktest = (payload) => api.post('/backtest/run', payload).then(r => r.data)
export const runSentimentBacktest = (payload) => api.post('/backtest/run-sentiment', payload).then(r => r.data)
export const runSandboxBacktest = (payload) => api.post('/backtest/run-sandbox', payload).then(r => r.data)
export const warmIntradayCache = (payload) => api.post('/backtest/cache/warm-intraday', payload).then(r => r.data)
export const getIntradayCacheCoverage = (symbol, dataSource = 'auto') =>
  api.get('/backtest/cache/intraday-coverage', { params: { symbol, data_source: dataSource } }).then(r => r.data)
export const getBacktestIbVerificationStatus = (limit = 50) =>
  api.get('/backtest/cache/ib-verification-status', { params: { limit } }).then(r => r.data)
export const getReports = ({ page = 1, pageSize = 50 } = {}) =>
  api.get('/backtest/reports', { params: { page, page_size: pageSize } }).then(r => r.data)
export const getReport = (id) => api.get(`/backtest/reports/${id}`).then(r => r.data)
export const deleteReport = (id) => api.delete(`/backtest/reports/${id}`).then(r => r.data)
export const offloadAllReports = ({ offset = 0, batchSize = 100 } = {}) =>
  api.post('/backtest/reports/offload-all', null, { params: { offset, batch_size: batchSize } }).then(r => r.data)

// Trading
export const getIBStatus = () => api.get('/trading/ib/status').then(r => r.data)
export const connectIB = () => api.post('/trading/ib/connect').then(r => r.data)
export const disconnectIB = () => api.post('/trading/ib/disconnect').then(r => r.data)
export const setIBMode = (mode) => api.post('/trading/ib/mode', { mode }).then(r => r.data)
export const getIBAccount = () => api.get('/trading/ib/account').then(r => r.data)
export const getIBPositions = () => api.get('/trading/ib/positions').then(r => r.data)
export const getIBOrders = () => api.get('/trading/ib/orders').then(r => r.data)
export const resetIBPaperPortfolio = () => api.post('/trading/ib/paper/reset').then(r => r.data)
export const placeOrder = (payload) => api.post('/trading/order', payload).then(r => r.data)
export const cancelOrder = (id) => api.delete(`/trading/order/${id}`).then(r => r.data)
export const getTradeHistory = (limit = 100, mode = undefined) =>
  api.get('/trading/history', { params: { limit, ...(mode ? { mode } : {}) } }).then(r => r.data)

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
export const chatWithScriptAI = (messages) =>
  fetch('/api/scripts/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })

export default api

// Settings
export const getSettings = () => api.get('/settings').then(r => r.data)
export const updateSettings = (payload) => api.patch('/settings', payload).then(r => r.data)

// Sandbox
export const getSandboxAccount = (profile = undefined) =>
  api.get('/sandbox/account', { params: profile ? { profile } : {} }).then(r => r.data)
export const addSandboxFunds = (amount) => api.post('/sandbox/account/add-funds', { amount }).then(r => r.data)
export const withdrawSandboxFunds = (amount) => api.post('/sandbox/account/withdraw-funds', { amount }).then(r => r.data)
export const repairSandboxFunds = () => api.post('/sandbox/account/repair-funds').then(r => r.data)
export const getSandboxFundEvents = (limit = 200) => api.get('/sandbox/account/fund-events', { params: { limit } }).then(r => r.data)
export const getSandboxPositions = (profile = undefined) =>
  api.get('/sandbox/positions', { params: profile ? { profile } : {} }).then(r => r.data)
export const getSandboxLearnerInsights = (symbols) =>
  api.get('/sandbox/learner/insights', { params: { symbols: symbols.join(',') } }).then(r => r.data)
export const addSandboxSymbol = (payload) => api.post('/sandbox/positions', payload).then(r => r.data)
export const updateSandboxPosition = (symbol, payload) => api.patch(`/sandbox/positions/${symbol}`, payload).then(r => r.data)
export const bulkUpdateSandboxStrategy = (strategy_name) => api.patch('/sandbox/positions-bulk-strategy', { strategy_name }).then(r => r.data)
export const bulkUpdateSandboxAllocationCap = (payload) => api.patch('/sandbox/positions-bulk-allocation-cap', payload).then(r => r.data)
export const removeSandboxSymbol = (symbol) => api.delete(`/sandbox/positions/${symbol}`).then(r => r.data)
export const getSandboxTrades = (symbol, limit = 200, profile = undefined) =>
  api.get('/sandbox/trades', { params: { symbol, limit, ...(profile ? { profile } : {}) } }).then(r => r.data)
export const placeSandboxTrade = (payload) => api.post('/sandbox/trade', payload).then(r => r.data)
export const getSandboxIBMode = () => api.get('/sandbox/ib-mode').then(r => r.data)
export const setSandboxIBMode = (mode) => api.post('/sandbox/ib-mode', { mode }).then(r => r.data)
export const exportSandbox = () => api.get('/sandbox/export', { responseType: 'blob' }).then(r => r)
export const importSandbox = (file) => {
  const form = new FormData()
  form.append('file', file)
  return api.post('/sandbox/import', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
}
export const resetSandbox = () => api.post('/sandbox/reset').then(r => r.data)
export const resetSandboxSoft = () => api.post('/sandbox/reset-soft').then(r => r.data)
export const getSandboxAnalytics = (profile = undefined) =>
  api.get('/sandbox/analytics', { params: profile ? { profile } : {} }).then(r => r.data)
export const getSandboxRealizedMetrics = (profile = undefined) =>
  api.get('/sandbox/realized-metrics', { params: profile ? { profile } : {} }).then(r => r.data)
export const getSandboxEngineState = () => api.get('/sandbox/engine/state').then(r => r.data)
export const toggleAllSandboxEngines = () => api.post('/sandbox/engine/toggle-all').then(r => r.data)
export const toggleSandboxEngine = (symbol) => api.post(`/sandbox/engine/toggle/${symbol}`).then(r => r.data)

// Portfolio Manager
export const getPortfolioManagerState = () => api.get('/sandbox/manager/state').then(r => r.data)
export const updatePortfolioManagerSettings = (payload) => api.patch('/sandbox/manager/settings', payload).then(r => r.data)
export const getPortfolioManagerActivityLog = ({ page = 1, pageSize = 100, day = undefined } = {}) =>
  api.get('/sandbox/manager/activity-log', { params: { page, page_size: pageSize, ...(day ? { day } : {}) } }).then(r => r.data)
export const togglePortfolioManager = () => api.post('/sandbox/manager/toggle').then(r => r.data)
export const resetCrashShutdown = () => api.post('/sandbox/manager/reset-crash').then(r => r.data)
