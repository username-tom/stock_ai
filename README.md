# Stock AI – Automated Trading Platform

A full-stack automated stock trading platform with Interactive Brokers integration, backtesting engine, report generation, and a modern dark-theme UI.

## Screenshots

### Dashboard
![Dashboard](https://github.com/user-attachments/assets/2d7aa234-e4c5-4c93-8c9c-d37426102160)

### Backtesting
![Backtest](https://github.com/user-attachments/assets/3fff5064-b8b9-4682-8443-15ddd2dc51ca)

### Trading
![Trading](https://github.com/user-attachments/assets/7574045f-b9ea-43c1-a3e1-839640d6ed87)

---

## Features

| Feature | Description |
|---|---|
| **Backtesting** | Run strategies against historical data. Supports yfinance (default), Stooq, and Interactive Brokers as data sources. Equity curve, trade log, Sharpe ratio, max drawdown, win rate. |
| **Custom Scripts** | Write and validate custom Python trading strategies in-browser. Scripts define `generate_signals(df, **params)` using pandas/numpy in a sandboxed executor. |
| **Report Generation** | Auto-generates HTML reports with embedded charts after every backtest. Accessible via the Reports page or served statically at `/reports/`. |
| **Simulated Trading** | Place buy/sell orders at any fill price — no broker connection needed. All trades stored in SQLite. |
| **Paper Trading (IB)** | Connect to IB TWS/Gateway in paper-trading mode for real market simulation. |
| **Live Trading (IB)** | Connect to IB TWS/Gateway live for real order execution. |
| **Live Quotes & Charts** | Dashboard shows live price quotes, an intraday/historical price chart, and a market movers screen (top gainers/losers). Data sourced from the Yahoo Finance v8 API with a TTL cache. |
| **Symbol Search** | Search 8,000+ tickers by symbol prefix or company name via the local symbol registry. |
| **Real-time Prices** | WebSocket endpoint streams live price updates (configurable interval). |
| **Nice UI** | React 18 + Vite + TailwindCSS dark theme with Recharts interactive charts. |

---

## Architecture

```
stock_ai/
├── backend/                  # Python / FastAPI
│   ├── app/
│   │   ├── main.py           # FastAPI app, CORS, startup
│   │   ├── config.py         # Settings via .env
│   │   ├── database.py       # SQLite + SQLAlchemy async
│   │   ├── models/           # ORM models: Trade, BacktestReport, CustomScript
│   │   ├── routers/          # REST endpoints: trading, backtest, market_data, scripts, ws
│   │   └── services/
│   │       ├── ib_service.py       # Interactive Brokers (ib_insync)
│   │       ├── backtester.py       # Backtest engine (pandas)
│   │       ├── data_provider.py    # Historical OHLCV fetcher (yfinance / Stooq / IB)
│   │       ├── market_service.py   # Live quotes & history via Yahoo Finance v8 API (TTL-cached)
│   │       ├── reporter.py         # HTML report generator (matplotlib)
│   │       ├── script_executor.py  # Sandboxed Python script runner
│   │       ├── symbol_registry.py  # Local ticker/company name search index
│   │       └── strategies/         # SMA Crossover, RSI, Bollinger Bands, MACD
│   ├── tests/                # pytest unit tests (45 tests)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── frontend/                 # React 18 / Vite
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api/client.js     # Axios API helpers
│   │   └── components/
│   │       ├── Layout.jsx          # App shell, navigation
│   │       ├── Dashboard.jsx       # Watchlist, live price chart, market movers
│   │       ├── LivePriceTicker.jsx # Real-time price ticker bar
│   │       ├── BacktestPanel.jsx   # Strategy config + results
│   │       ├── ReportsPanel.jsx    # Saved backtest reports
│   │       ├── ScriptsPanel.jsx    # Custom Python script editor & validator
│   │       ├── TradingPanel.jsx    # IB connect/orders/history
│   │       └── charts/             # EquityChart, PriceChart (Recharts)
│   ├── Dockerfile
│   └── nginx.conf
└── docker-compose.yml
```

---

## Quick Start

### Option A – Docker Compose (recommended)

```bash
cp backend/.env.example backend/.env
# Edit backend/.env if needed (IB_HOST, IB_PORT, TRADING_MODE)

docker-compose up --build
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:8000/docs

### Option B – Local development

**Backend**
```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

**Frontend**
```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

---

## Interactive Brokers Setup

1. Install [TWS](https://www.interactivebrokers.com/en/trading/tws.php) or [IB Gateway](https://www.interactivebrokers.com/en/trading/ibgateway.php).
2. Enable **API connections** in TWS: *Edit → Global Configuration → API → Settings*
   - ☑ Enable ActiveX and Socket Clients
   - Socket port: **7497** (paper) / **7496** (live)
   - ☑ Allow connections from localhost
3. Set `.env` accordingly:
   ```
   IB_HOST=127.0.0.1
   IB_PORT=7497       # 7497 = paper, 7496 = live
   TRADING_MODE=paper
   ```
4. Click **Connect IB** on the Trading page.

> **Note:** All features except paper/live trading work without IB.
> Simulated mode and backtesting use yfinance data by default.

---

## Trading Strategies

| Strategy | Type | Key Parameters |
|---|---|---|
| **SMA/EMA Crossover** | Trend following | `fast_period`, `slow_period`, `ma_type` (SMA/EMA) |
| **RSI** | Mean reversion | `period`, `oversold`, `overbought` |
| **Bollinger Bands** | Mean reversion | `period`, `std_dev` |
| **MACD** | Trend following | `fast_period`, `slow_period`, `signal_period` |

---

## Custom Scripts

The **Scripts** page lets you write Python strategies that run inside a sandboxed executor. Scripts must define:

```python
def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """Add a 'signal' column: +1 buy, -1 sell, 0 hold."""
    ...
```

An optional `get_default_params() -> dict` function can supply default parameter values.

Allowed imports: `pandas` (as `pd`), `numpy` (as `np`), `math`, `statistics`.

Once saved, a script can be selected from the Backtest page in place of any built-in strategy.

---

## API Reference

Full interactive docs at **http://localhost:8000/docs** (Swagger UI).

Key endpoints:

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/backtest/strategies` | List available built-in strategies |
| GET | `/api/backtest/data-sources` | List supported data sources and availability |
| POST | `/api/backtest/run` | Run a backtest (built-in strategy or custom script) |
| GET | `/api/backtest/reports` | List saved reports |
| GET | `/api/backtest/reports/{id}` | Get full report detail |
| DELETE | `/api/backtest/reports/{id}` | Delete a report |
| POST | `/api/trading/order` | Place an order |
| GET | `/api/trading/history` | Trade history |
| POST | `/api/trading/ib/connect` | Connect to IB |
| GET | `/api/trading/ib/status` | IB connection status |
| GET | `/api/trading/ib/positions` | IB open positions |
| GET | `/api/market-data/quote/{symbol}` | Latest quote (cached 60 s) |
| GET | `/api/market-data/bulk-quotes` | Quotes for multiple symbols (`?symbols=AAPL,MSFT`) |
| GET | `/api/market-data/history/{symbol}` | OHLCV history (cached 15 min) |
| GET | `/api/market-data/search` | Search symbols by prefix or company name |
| GET | `/api/market-data/movers` | Top daily gainers and losers (cached 5 min) |
| GET | `/api/scripts` | List saved custom scripts |
| POST | `/api/scripts` | Create a custom script |
| GET | `/api/scripts/template` | Fetch the default script template |
| GET | `/api/scripts/{id}` | Get a script by ID |
| PUT | `/api/scripts/{id}` | Update a script |
| DELETE | `/api/scripts/{id}` | Delete a script |
| POST | `/api/scripts/{id}/validate` | Validate a saved script |
| POST | `/api/scripts/validate` | Validate script code without saving |
| WS | `/ws/prices` | Real-time price stream |

---

## Running Tests

```bash
cd backend
pytest tests/ -v
```

45 unit tests covering the backtesting engine, all four strategies, and the data provider.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IB_HOST` | `127.0.0.1` | TWS / IB Gateway host |
| `IB_PORT` | `7497` | TWS / IB Gateway port |
| `IB_CLIENT_ID` | `1` | API client ID |
| `TRADING_MODE` | `paper` | `paper` or `live` |
| `DATABASE_URL` | `sqlite+aiosqlite:///./stock_ai.db` | Database URL |
| `CORS_ORIGINS` | `http://localhost:5173,...` | Allowed CORS origins |
| `REPORTS_DIR` | `reports_output` | Directory for HTML reports |

---

## Tech Stack

**Backend:** Python 3.11+, FastAPI, SQLAlchemy (async), SQLite, ib_insync, yfinance, pandas, numpy, matplotlib, reportlab, httpx

**Frontend:** React 18, Vite, TailwindCSS, Recharts, React Query, React Router, Axios, Heroicons