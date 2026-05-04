export const PIE_COLORS = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6']

export const CUSTOM_SCRIPT_KEY = '__custom_script__'
export const TEMPLATE_SCRIPT_KEY = '__template__'

export const STRATEGY_PARAM_UI = {
  sma_crossover: [
    { key: 'fast_period', label: 'Fast Period', type: 'number', default: 10 },
    { key: 'slow_period', label: 'Slow Period', type: 'number', default: 30 },
    { key: 'ma_type', label: 'MA Type', type: 'select', options: ['SMA', 'EMA'], default: 'SMA' },
  ],
  rsi: [
    { key: 'period', label: 'RSI Period', type: 'number', default: 14 },
    { key: 'oversold', label: 'Oversold Level', type: 'number', default: 30 },
    { key: 'overbought', label: 'Overbought Level', type: 'number', default: 70 },
  ],
  bollinger_bands: [
    { key: 'period', label: 'Period', type: 'number', default: 20 },
    { key: 'std_dev', label: 'Std Dev', type: 'number', default: 2.0, step: 0.1 },
  ],
}
