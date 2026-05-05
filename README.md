# Stock AI

A full-stack algorithmic trading and market analytics platform. Real-time market data, interactive charting, financial news, backtesting, automated strategy execution, and live/paper trading via Interactive Brokers.

---

## Features

| Feature | Description |
|---|---|
| **Dashboard** | Scrollable watchlist grid, intraday/historical price chart with technical indicators, and tabbed navigation for overview, movers, news, and earnings. |
| **Watchlist** | Add/remove/reorder symbols via drag-and-drop. Persisted to localStorage. Scrollable grid with live price cards showing price, % change, day high/low, sentiment badge, and buy/hold/sell signal. |
| **Live Quotes & Charts** | Quotes from Yahoo Finance v8 API with TTL in-memory and disk cache. Intraday chart distinguishes pre-market, regular session, and after-hours. 11 time-range options (1D to Max). Yahoo Finance-style dark theme with green/red direction coloring. |
| **Technical Indicators** | Bollinger Bands, Fast MA, Slow MA, RSI, and MACD — individually togglable overlays rendered in stacked Recharts panels with synchronized hover cursor across all sub-panels. |
| **Gainers & Losers** | Top 25 daily movers. Hover for a rich tooltip (price, volume, market cap, sentiment, signal). Click a symbol to open its Yahoo Finance page. Click a row to expand an inline 1D/2D/5D chart dropdown fetched on demand. Refreshes every 5 min during market hours. |
| **Financial News** | Curated feed of Watchlist News and Market News. Initial load: 50 articles. Scroll to lazy-load 25 more at a time. Noise-filtered. Earnings items are separated into their own dedicated tab. |
| **Earnings Tab** | Dedicated dashboard tab for upcoming earnings. Events split into *Reporting Today* (red) and *Upcoming* (amber) sections. Urgency colour-coding: red = today, amber = tomorrow/this week, muted = later. Shows related tickers and source. Refreshes every 15 min. |
| **Skeleton Loading** | All loading states use animated pulse skeleton blocks. Price chart uses a shimmer SVG placeholder. |
| **Symbol Search** | Shared autocomplete component used across Portfolio, Backtest, and Trading panels. Searches 8,000+ tickers by prefix or company name with debounced suggestions. |
| **Sentiment & Signals** | Stock list BUY/SELL/HOLD badges prefer the engine-derived `last_signal` (marked ⚡) when a strategy has run, falling back to quote-based heuristics otherwise. |
| **Backtesting** | Run backtests across yfinance, Stooq, and IB data. Results: equity curve, trade log, Sharpe ratio, max drawdown, win rate. |
| **Custom Scripts** | Write and validate Python trading strategies in-browser using pandas/numpy in a sandboxed executor. Collapsible script editor with title, description, and default parameters. |
| **Report Generation** | Auto-generates HTML reports with embedded charts after every backtest. Accessible via the Reports page (with search/filter) or at /reports/. |
| **Portfolio (Simulated Trading)** | Full portfolio simulation with per-symbol fund allocation, automated strategy execution, and trade recording. Export/import/reset of the full simulation state. |
| **Portfolio Overview** | Stat cards (total funds, equity, unrealised/realised P&L), dynamic allocation pie chart with bottom legend, position breakdown table, and analytics charts. |
| **Portfolio Analytics** | Cumulative realised P&L (area chart), daily buy/sell volume (bar chart), realised P&L by symbol (horizontal bar), and win/loss ratio (donut + stats). |
| **Position Detail Chart** | Each sandbox stock detail panel shows a live 1D candlestick chart above the strategy card. Chart starts at 07:30 ET (2 h pre-market), includes a dashed prev-close line, an amber vertical market-open line at 09:30 ET, volume bars, and a hover crosshair with OHLCV tooltip. Implemented as pure SVG — no charting library invariant risk. |
| **Automated Strategy Engine** | Background engine ticks every 60 seconds during market hours (09:20–16:00 ET). Uses the last non-zero signal for trade decisions and writes the current-bar signal to `last_signal` for display. BUY orders consume both allocated funds and unallocated account balance. Per-symbol enable/disable toggle with live ON/OFF status in the sidebar. Start/Stop All Engines toolbar button. |
| **Market Hours Gating** | Engine and polling respect market hours. A 10-minute pre-open window (09:20 ET) allows strategies to warm up before the open. |
| **Market Status Indicator** | Top-right market badge and live ticker bar derive open/closed state from Yahoo Finance intraday quote metadata, with a clock-based fallback so the indicator is correct during regular trading hours even when Yahoo returns ambiguous state. |
| **Paper & Live Trading** | Connect to IB TWS/Gateway for paper simulation or live order execution via ib_insync. Toggle between modes at runtime. |
| **Real-time Prices** | WebSocket endpoint streams live price updates at a configurable interval. |
| **Frontend Error Logging** | Runtime JS errors and unhandled promise rejections are forwarded to the Vite dev-server terminal for easy debugging. Chart render errors are caught by a React error boundary and logged to the browser console with full stack traces. |

---

## Architecture

```
stock_ai/
├── backend/
│   └── app/
│       ├── main.py                   # FastAPI entry point; CORS, startup cache pre-warm, engine scheduler
│       ├── config.py                 # Settings loaded from .env
│       ├── database.py               # SQLite + SQLAlchemy async engine; schema auto-migration
│       ├── models/
│       │   ├── trade.py              # Manual trade orders
│       │   ├── strategy.py           # Strategy definitions
│       │   ├── report.py             # BacktestReport model
│       │   ├── custom_script.py      # CustomScript model
│       │   ├── sandbox.py            # SandboxAccount, SandboxPosition, SandboxTrade
│       ├── routers/
│       │   ├── market_data.py        # Quotes, history, movers, news, symbol search
│       │   ├── backtest.py           # Backtest execution, report list/detail/delete
│       │   ├── scripts.py            # Custom strategy script CRUD and sandboxed validation
│       │   ├── trading.py            # Manual order placement and IB connection management
│       │   ├── sandbox.py            # Portfolio CRUD, manual trades, analytics, engine control
│       │   ├── ws.py                 # WebSocket real-time price stream
│       │   ├── settings.py           # App settings endpoints
│       │   ├── ollama_chat.py        # (If present) LLM chat integration
│       │   └── sandbox_router/
│       │       ├── account.py        # Portfolio account endpoints
│       │       ├── engine.py         # Engine state/toggle endpoints
│       │       ├── positions.py      # Portfolio positions CRUD
│       │       ├── snapshot.py       # Export/import/reset endpoints
│       │       └── trades.py         # Trade history endpoints
│       ├── services/
│       │   ├── market_service.py     # Yahoo Finance v8 quotes, history, movers, news (TTL-cached)
│       │   ├── ib_service.py         # Interactive Brokers integration (ib_insync)
│       │   ├── backtester.py         # Vectorised backtest engine (pandas)
│       │   ├── sandbox_engine.py     # Automated strategy execution scheduler; per-symbol enable/disable
│       │   ├── data_provider.py      # Historical OHLCV (yfinance / Stooq / IB)
│       │   ├── reporter.py           # HTML report generator (matplotlib)
│       │   ├── report_charts.py      # Chart rendering for reports
│       │   ├── script_executor.py    # Sandboxed Python script runner (restricted builtins)
│       │   ├── symbol_registry.py    # Local 8,000+ ticker/company prefix search index
│       │   ├── portfolio_manager.py  # Portfolio logic and analytics
│       │   ├── local_storage.py      # Local file storage helpers
│       │   └── strategies/
│       │       ├── base.py           # Strategy base class
│       │       ├── bollinger.py      # Bollinger Bands strategy
│       │       ├── macd.py           # MACD strategy
│       │       ├── moving_avg.py     # SMA/EMA Crossover strategy
│       │       ├── rsi.py            # RSI strategy
│       │       └── __init__.py
│
├── frontend/
│   └── src/
│       ├── api/
│       │   └── client.js             # Axios wrappers for all backend endpoints
│       ├── hooks/
│       │   └── useWatchlist.js       # Watchlist state, localStorage persistence, toggle, drag-and-drop
│       ├── utils/
│       │   ├── marketHours.js        # Market hours logic (isMarketHours, deriveMarketOpen)
│       │   └── sentiment.js          # Quote sentiment/signal helpers
│       └── components/
│           ├── Layout.jsx            # App shell with nav
│           ├── Dashboard.jsx         # Main dashboard page
│           ├── BacktestPanel.jsx     # Backtest form, results, equity chart
│           ├── ReportsPanel.jsx      # Saved report list with search and filter
│           ├── ScriptsPanel.jsx      # Custom script editor, validator, CRUD
│           ├── TradingPanel.jsx      # Manual order form, IB connection, trade history
│           ├── SandboxPanel.jsx      # Portfolio shell (export, import, reset, Start/Stop All Engines)
│           ├── LivePriceTicker.jsx   # Scrolling live price ticker bar
│           ├── dashboard/
│           │   ├── QuoteCard.jsx         # Price card with sentiment and signal badges
│           │   ├── WatchlistPanel.jsx    # Scrollable grid, add/edit/drag UI
│           │   ├── PriceChartPanel.jsx   # Chart with period selector and indicator toggles
│           │   ├── MoversTab.jsx         # Top 25 gainers/losers; hover tooltip, Yahoo links, expand chart
│           │   ├── NewsTab.jsx           # Lazy-loaded news feed (general + watchlist news)
│           │   └── EarningsTab.jsx       # Dedicated earnings tab; urgency colour-coded cards
│           ├── charts/
│           │   ├── SubplotChart.jsx      # Stacked price + RSI + MACD panels
│           │   ├── PriceChart.jsx        # General OHLCV line chart
│           │   ├── CandlestickChart.jsx  # Pure-SVG 1D candlestick chart
│           │   ├── EquityChart.jsx       # Equity curve chart for backtest results
│           │   └── indicators.js         # Client-side BB, MA, RSI, MACD calculations
│           ├── shared/
│           │   └── SymbolAutocomplete.jsx  # Debounced symbol search input
│           └── sandbox/
│               ├── sandboxConstants.js     # PIE_COLORS, CUSTOM_SCRIPT_KEY, STRATEGY_PARAM_UI
│               ├── sandboxHelpers.js       # Formatting and helpers
│               ├── StrategySelector.jsx    # Strategy dropdown, parameter editor, script picker
│               ├── StockListItem.jsx       # Sidebar row with engine ON/OFF indicator
│               ├── TradeRow.jsx            # Row in the trade history table
│               ├── PieTooltipContent.jsx   # Custom Recharts tooltip for the allocation pie
│               ├── PortfolioOverview.jsx   # Overview page (stat cards, pie chart, analytics)
│               ├── PositionDetail.jsx      # Position detail (1D candlestick chart, summary, trades)
│               └── SandboxSidebar.jsx      # Left sidebar (account summary + stock list)
│
├── docker-compose.yml
└── README.md
```

---

## Changelog

### Recent updates

#### Features added
- **Earnings Tab** — Earnings news is now separated from the News tab into a dedicated *Earnings* dashboard tab. Events are split into *Reporting Today* and *Upcoming Earnings* sections with urgency-based colour coding (red for today, amber for this week, muted for later).
- **1D Candlestick Chart in Position Detail** — Each sandbox stock detail panel now shows a live 1D candlestick chart above the strategy card. The chart is implemented as pure SVG with no third-party charting library.
  - Starts at 07:30 ET (2 hours of pre-market data)
  - Amber dashed vertical line marks the regular session open at 09:30 ET
  - Dashed horizontal line shows the previous session close price
  - Volume bars rendered as a background layer
  - Hover crosshair with floating OHLCV tooltip
  - React error boundary catches any render error and logs the full stack trace to the browser console
- **Engine signal aligned with stock list badges** — The BUY/SELL/HOLD badge on each stock list row now uses the engine-derived `last_signal` value (marked ⚡) when a strategy has run at least once, rather than a generic quote heuristic.

#### Bugs fixed
- **Sandbox engine not executing trades** — The engine was only acting on a same-bar signal crossover event (`signal.diff()`), which is almost always zero. It now uses the last non-zero signal for trade decisions while writing the current-bar signal to `last_signal` for display.
- **`last_signal` not updating after each engine tick** — Engine now correctly persists `last_signal`, `last_run_at`, and `engine_error` to the database after every tick regardless of whether a trade was placed.
- **BUY orders ignoring unallocated account funds** — BUY logic now consumes both the position's allocated funds and any unallocated account balance, matching expected paper-trading behaviour.
- **Market status showing "Closed" during market hours** — The market-open indicator and live ticker were reading Yahoo Finance quote metadata from daily candle requests, which frequently returns `CLOSED`. Quote fetching now uses 1-day/1-minute intraday requests, and the client-side `deriveMarketOpen()` helper falls back to the system clock when Yahoo returns an ambiguous state.
- **Custom script double-execution** — Script validation and execution were sharing the same compile/exec path, causing scripts to run twice on validation. The execution path is now deduplicated.

---

## Quick Start


### Option A — Docker Compose (recommended)

#### 1. Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- (Optional) [Git](https://git-scm.com/) to clone the repository

#### 2. Clone the repository (if you haven't already)
```bash
git clone https://github.com/username-tom/stock_ai.git
cd stock_ai
```

#### 3. Copy environment file and start containers
```bash
cp backend/.env.example backend/.env
docker-compose up --build
```

#### 4. Access the app
- Frontend: http://localhost:3000
- Backend API + Swagger: http://localhost:8000/docs

### Option B — Local development (untested)

**Backend:**
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

---

## Portfolio (Simulated Trading)

The Portfolio tab lets you simulate a full trading portfolio without a broker connection:

1. **Add funds** — deposit simulated cash into the account.
2. **Add stocks** — assign a symbol, allocate funds, and choose a strategy.
3. **Automated engine** — the background engine ticks every 60 seconds during market hours, runs the assigned strategy on 1-minute intraday data, and records BUY/SELL trades automatically.
4. **Manual trades** — place trades at any time regardless of market hours.
5. **Overview** — the portfolio summary header opens a home screen with:
   - Stat cards: total funds, equity, unrealised P&L, realised P&L
   - Allocation pie chart: each symbol's slice = market value of shares + remaining allocated cash
   - Position breakdown table: shares, market value, undeployed cash, allocation %, unrealised and realised P&L
   - Analytics charts: cumulative P&L over time, daily trade volume, per-symbol P&L, win/loss ratio
6. **Export / Import / Reset** — snapshot the full simulation state to JSON or wipe and start fresh.

When connected to IB in paper or live mode, the Portfolio tab switches to reflect the IB account instead of the simulation.

---

## Interactive Brokers Setup

1. Install TWS or IB Gateway.
2. Enable socket API connections in TWS settings.
3. Set in `backend/.env`:
   ```
   IB_HOST=127.0.0.1
   IB_PORT=7497
   TRADING_MODE=paper
   ```
4. Click **Connect IB** on the Trading page.

All features except paper/live order execution work without an IB connection.

---

## Trading Strategies

| Strategy | Type | Key Parameters |
|---|---|---|
| SMA/EMA Crossover | Trend following | fast_period, slow_period, ma_type |
| RSI | Mean reversion | period, oversold, overbought |
| Bollinger Bands | Mean reversion | period, std_dev |
| MACD | Trend following | fast_period, slow_period, signal_period |

Strategies are selectable in both Backtest and Portfolio panels. Custom Python scripts can also be assigned to portfolio positions.

---

## Custom Scripts

Scripts must define:

```python
def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    # Add a 'signal' column: +1 buy, -1 sell, 0 hold
    ...
```

Optional: `get_default_params() -> dict` for default parameter values.

Allowed imports: `pandas`, `numpy`, `math`, `statistics`.

---

## API Reference


Full interactive docs at http://localhost:8000/docs

| Method | Path | Description |
|---|---|---|
| GET | /api/health | Health check |

**Market Data**
| GET | /api/market-data/quote/{symbol} | Latest quote (cached 60s) |
| GET | /api/market-data/bulk-quotes | Quotes for multiple symbols (?symbols=AAPL,MSFT) |
| GET | /api/market-data/history/{symbol} | OHLCV history (cached 15 min) |
| GET | /api/market-data/movers | Top daily gainers and losers (cached 5 min) |
| GET | /api/market-data/news | Financial news feed (?symbols=...; cached 15 min) |
| GET | /api/market-data/earnings | Upcoming earnings (cached 15 min) |
| GET | /api/market-data/search | Search symbols by prefix or company name |

**Backtesting**
| GET | /api/backtest/strategies | List built-in strategies |
| GET | /api/backtest/data-sources | List supported data sources |
| POST | /api/backtest/run | Run a backtest |
| GET | /api/backtest/reports | List saved reports |
| GET | /api/backtest/reports/{id} | Full report detail |
| DELETE | /api/backtest/reports/{id} | Delete a report |

**Trading (IB and Simulated)**
| POST | /api/trading/order | Place an order |
| DELETE | /api/trading/order/{ib_order_id} | Cancel an order (IB only) |
| GET | /api/trading/history | Trade history |
| GET | /api/trading/history/export | Export trade history (CSV/JSON) |
| POST | /api/trading/ib/connect | Connect to IB |
| POST | /api/trading/ib/disconnect | Disconnect from IB |
| GET | /api/trading/ib/status | IB connection status |
| GET | /api/trading/ib/account | IB account summary |
| GET | /api/trading/ib/positions | IB open positions |
| GET | /api/trading/ib/orders | IB open orders |
| POST | /api/trading/ib/mode | Set IB mode (paper/live) |

**Custom Scripts**
| GET | /api/scripts | List saved custom scripts |
| POST | /api/scripts | Create a custom script |
| GET | /api/scripts/template | Default script template |
| GET | /api/scripts/builtin-templates | List built-in script templates |
| GET | /api/scripts/{script_id} | Get script by ID |
| PUT | /api/scripts/{script_id} | Update a script |
| DELETE | /api/scripts/{script_id} | Delete a script |
| POST | /api/scripts/validate | Validate script code without saving |
| POST | /api/scripts/{script_id}/validate | Validate a saved script |

**Sandbox Portfolio (Simulated Trading)**
| GET | /api/sandbox/account | Portfolio account summary |
| POST | /api/sandbox/account/add-funds | Add simulated funds |
| POST | /api/sandbox/account/withdraw-funds | Withdraw simulated funds |
| GET | /api/sandbox/account/fund-events | List fund and allocation events |
| POST | /api/sandbox/account/repair-funds | Rebuild account/position state from event log |
| GET | /api/sandbox/positions | List all portfolio positions |
| POST | /api/sandbox/positions | Add a symbol to the portfolio |
| PATCH | /api/sandbox/positions/{symbol} | Update position (allocation, strategy, engine toggle) |
| DELETE | /api/sandbox/positions/{symbol} | Remove a symbol |
| PATCH | /api/sandbox/positions-bulk-strategy | Set strategy for all positions |
| POST | /api/sandbox/trade | Place a manual trade |
| GET | /api/sandbox/trades | Trade history (optionally filtered by symbol) |
| GET | /api/sandbox/analytics | Portfolio analytics (P&L, volume, win/loss, etc.) |

**Engine & Portfolio Manager**
| GET | /api/sandbox/engine/state | Engine status and per-symbol state |
| POST | /api/sandbox/engine/toggle/{symbol} | Enable/disable engine for one symbol |
| POST | /api/sandbox/engine/toggle-all | Start all (if any stopped) or stop all engines |
| GET | /api/sandbox/ib-mode | Current IB mode (paper/live) |
| POST | /api/sandbox/ib-mode | Switch IB mode |
| GET | /api/sandbox/manager/state | Portfolio manager state |
| PATCH | /api/sandbox/manager/settings | Update portfolio manager settings |
| POST | /api/sandbox/manager/toggle | Toggle portfolio manager on/off |

**Sandbox Export/Import/Reset**
| GET | /api/sandbox/export | Export full portfolio snapshot as JSON |
| POST | /api/sandbox/import | Import a portfolio snapshot |
| POST | /api/sandbox/reset | Reset the entire portfolio simulation |
| POST | /api/sandbox/reset-soft | Reset portfolio counters, keep symbols/strategies |

**Settings**
| GET | /api/settings | Get current backend settings |
| PATCH | /api/settings | Update backend settings |

**WebSocket**
| WS | /ws/prices | Real-time price stream |

---

## Running Tests

```bash
cd backend
pytest tests/ -v
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| IB_HOST | 127.0.0.1 | TWS / IB Gateway host |
| IB_PORT | 7497 | Port (7497 paper, 7496 live) |
| IB_CLIENT_ID | 1 | API client ID |
| TRADING_MODE | paper | `paper` or `live` |
| DATABASE_URL | sqlite+aiosqlite:///./stock_ai.db | Database connection |
| CORS_ORIGINS | http://localhost:5173,... | Allowed CORS origins |
| REPORTS_DIR | reports_output | Directory for HTML reports |

---

## Tech Stack

**Backend:** Python 3.11+, FastAPI, SQLAlchemy (async), SQLite, ib_insync, yfinance, pandas, numpy, matplotlib, httpx, python-multipart

**Frontend:** React 18, Vite, TailwindCSS, Recharts, TanStack Query, React Router, Axios, Heroicons