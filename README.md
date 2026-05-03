# Stock AI

A full-stack algorithmic trading and market analytics platform. Real-time market data, interactive charting, financial news, backtesting, and live/paper trading via Interactive Brokers.

---

## Features

| Feature | Description |
|---|---|
| **Dashboard** | Scrollable watchlist grid, intraday/historical price chart with technical indicators, and tabbed navigation for overview, movers, and news. |
| **Watchlist** | Add/remove/reorder symbols via drag-and-drop. Persisted to localStorage. Fixed-height scrollable grid with live price cards showing price, % change, day high/low. |
| **Live Quotes and Charts** | Quotes from Yahoo Finance v8 API with TTL in-memory and disk cache. Intraday chart distinguishes pre-market, regular session, and after-hours. 11 time-range options (1D to Max). |
| **Technical Indicators** | Bollinger Bands, Fast MA, Slow MA, RSI, and MACD - individually togglable overlays rendered in stacked Recharts panels. |
| **Gainers and Losers** | Top daily movers from a liquid large-cap universe. Refreshes every 5 min while market is open; polling pauses when closed. Eye icon on each row toggles watchlist membership instantly. |
| **Financial News** | Curated feed split into: Upcoming Earnings (next 30 days for watchlist symbols), Watchlist News, and Market News. Initial load: 50 articles. Scroll to lazy-load 25 more at a time via animated chevron indicator. Noise-filtered. |
| **Earnings Notifications** | Upcoming earnings dates for watchlist symbols surface as amber alert cards at the top of the News tab. |
| **Skeleton Loading** | All loading states use animated pulse skeleton blocks. Price chart uses a shimmer SVG placeholder. |
| **Symbol Search** | Search 8,000+ tickers by prefix or company name, with debounced autocomplete. |
| **Backtesting** | Run backtests across yfinance, Stooq, and IB data. Results: equity curve, trade log, Sharpe ratio, max drawdown, win rate. |
| **Custom Scripts** | Write and validate Python trading strategies in-browser using pandas/numpy in a sandboxed executor. |
| **Report Generation** | Auto-generates HTML reports with embedded charts after every backtest. Accessible via the Reports page or at /reports/. |
| **Simulated Trading** | Place buy/sell orders at any fill price with no broker needed. All trades stored in SQLite. |
| **Paper and Live Trading** | Connect to IB TWS/Gateway for paper simulation or live order execution via ib_insync. |
| **Real-time Prices** | WebSocket endpoint streams live price updates at a configurable interval. |

---

## Architecture

`
stock_ai/
+-- backend/
|   +-- app/
|   |   +-- main.py              FastAPI app, CORS, startup cache pre-warm
|   |   +-- config.py            Settings via .env
|   |   +-- database.py          SQLite + SQLAlchemy async
|   |   +-- models/              Trade, BacktestReport, CustomScript
|   |   +-- routers/             trading, backtest, market_data, scripts, ws
|   |   +-- services/
|   |       +-- market_service.py    Quotes, history, movers, news (Yahoo Finance v8, TTL-cached)
|   |       +-- ib_service.py        Interactive Brokers (ib_insync)
|   |       +-- backtester.py        Backtest engine (pandas)
|   |       +-- data_provider.py     Historical OHLCV (yfinance / Stooq / IB)
|   |       +-- reporter.py          HTML report generator (matplotlib)
|   |       +-- script_executor.py   Sandboxed Python script runner
|   |       +-- symbol_registry.py   Local ticker/company search index
|   |       +-- strategies/          SMA Crossover, RSI, Bollinger Bands, MACD
|   +-- tests/
|   +-- requirements.txt
|   +-- Dockerfile
|   +-- .env.example
+-- frontend/
|   +-- src/
|   |   +-- api/client.js              Axios API helpers
|   |   +-- hooks/useWatchlist.js      Watchlist state, persistence, toggle, drag
|   |   +-- utils/marketHours.js       isMarketHours(), deriveMarketOpen()
|   |   +-- components/
|   |       +-- Dashboard.jsx               Top-level shell: queries, tab routing
|   |       +-- dashboard/
|   |       |   +-- QuoteCard.jsx           Price card with shimmer skeleton
|   |       |   +-- WatchlistPanel.jsx      Scrollable grid, edit/add/drag UI
|   |       |   +-- PriceChartPanel.jsx     Chart + period selector + indicators
|   |       |   +-- MoversTab.jsx           Gainers and Losers with watchlist toggle
|   |       |   +-- NewsTab.jsx             Lazy-loaded news feed with earnings
|   |       +-- charts/
|   |       |   +-- SubplotChart.jsx        Price + RSI + MACD stacked chart
|   |       |   +-- indicators.js           BB, MA, RSI, MACD calculations
|   |       +-- Layout.jsx
|   |       +-- LivePriceTicker.jsx
|   |       +-- BacktestPanel.jsx
|   |       +-- ReportsPanel.jsx
|   |       +-- ScriptsPanel.jsx
|   |       +-- TradingPanel.jsx
|   +-- Dockerfile
|   +-- nginx.conf
+-- docker-compose.yml
`

---

## Quick Start

### Option A - Docker Compose (recommended)

`ash
cp backend/.env.example backend/.env
docker-compose up --build
`

- Frontend: http://localhost:3000
- Backend API + Swagger: http://localhost:8000/docs

### Option B - Local development

Backend:
`ash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
`

Frontend:
`ash
cd frontend
npm install
npm run dev
`

---

## Interactive Brokers Setup

1. Install TWS or IB Gateway.
2. Enable socket API connections in TWS settings.
3. Set in backend/.env:
   IB_HOST=127.0.0.1
   IB_PORT=7497
   TRADING_MODE=paper
4. Click Connect IB on the Trading page.

All features except paper/live trading work without an IB connection.

---

## Trading Strategies

| Strategy | Type | Key Parameters |
|---|---|---|
| SMA/EMA Crossover | Trend following | fast_period, slow_period, ma_type |
| RSI | Mean reversion | period, oversold, overbought |
| Bollinger Bands | Mean reversion | period, std_dev |
| MACD | Trend following | fast_period, slow_period, signal_period |

---

## Custom Scripts

Scripts must define:

`python
def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    # Add a signal column: +1 buy, -1 sell, 0 hold
    ...
`

Optional: get_default_params() -> dict for default values.

Allowed imports: pandas, numpy, math, statistics.

---

## API Reference

Full interactive docs at http://localhost:8000/docs

| Method | Path | Description |
|---|---|---|
| GET | /api/health | Health check |
| GET | /api/market-data/quote/{symbol} | Latest quote (cached 60s) |
| GET | /api/market-data/bulk-quotes | Quotes for multiple symbols (?symbols=AAPL,MSFT) |
| GET | /api/market-data/history/{symbol} | OHLCV history (cached 15 min) |
| GET | /api/market-data/movers | Top daily gainers and losers (cached 5 min) |
| GET | /api/market-data/news | Financial news feed (?symbols=AAPL,MSFT; cached 15 min) |
| GET | /api/market-data/search | Search symbols by prefix or company name |
| GET | /api/backtest/strategies | List built-in strategies |
| GET | /api/backtest/data-sources | List supported data sources |
| POST | /api/backtest/run | Run a backtest |
| GET | /api/backtest/reports | List saved reports |
| GET | /api/backtest/reports/{id} | Full report detail |
| DELETE | /api/backtest/reports/{id} | Delete a report |
| POST | /api/trading/order | Place an order |
| GET | /api/trading/history | Trade history |
| POST | /api/trading/ib/connect | Connect to IB |
| GET | /api/trading/ib/status | IB connection status |
| GET | /api/trading/ib/positions | IB open positions |
| GET | /api/scripts | List saved custom scripts |
| POST | /api/scripts | Create a custom script |
| GET | /api/scripts/template | Default script template |
| GET | /api/scripts/{id} | Get script by ID |
| PUT | /api/scripts/{id} | Update a script |
| DELETE | /api/scripts/{id} | Delete a script |
| POST | /api/scripts/{id}/validate | Validate a saved script |
| POST | /api/scripts/validate | Validate script code without saving |
| WS | /ws/prices | Real-time price stream |

---

## Running Tests

`ash
cd backend
pytest tests/ -v
`

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| IB_HOST | 127.0.0.1 | TWS / IB Gateway host |
| IB_PORT | 7497 | Port (7497 paper, 7496 live) |
| IB_CLIENT_ID | 1 | API client ID |
| TRADING_MODE | paper | paper or live |
| DATABASE_URL | sqlite+aiosqlite:///./stock_ai.db | Database connection |
| CORS_ORIGINS | http://localhost:5173,... | Allowed CORS origins |
| REPORTS_DIR | reports_output | Directory for HTML reports |

---

## Tech Stack

Backend: Python 3.11+, FastAPI, SQLAlchemy (async), SQLite, ib_insync, yfinance, pandas, numpy, matplotlib, reportlab, httpx

Frontend: React 18, Vite, TailwindCSS, Recharts, TanStack Query, React Router, Axios, Heroicons