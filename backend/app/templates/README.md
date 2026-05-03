# Custom Strategy Templates

This directory contains template custom scripts that replicate the functionality of the basic strategies included in the backtesting system. These templates can be used as starting points for creating your own custom trading strategies.

## Available Templates

### 1. Basic Template (`basic_template.py`)
A simple template showing the basic structure for custom trading scripts. Use this as a starting point for creating your own strategies.

**Features:**
- Shows required function structure
- Includes parameter handling examples
- Documents available DataFrame columns
- Provides simple example logic

### 2. Moving Average Crossover (`moving_average_crossover_template.py`)
Replicates the SMA/EMA crossover strategy.

**Parameters:**
- `fast_period` (default: 10) - Period for fast moving average
- `slow_period` (default: 30) - Period for slow moving average  
- `ma_type` (default: "SMA") - Type of moving average ("SMA" or "EMA")

**Strategy Logic:**
- Buy when fast MA crosses above slow MA
- Sell when fast MA crosses below slow MA
- Only triggers on actual crossovers (not continuous signals)

### 3. RSI Strategy (`rsi_strategy_template.py`)
Replicates the RSI mean-reversion strategy.

**Parameters:**
- `period` (default: 14) - RSI calculation period
- `oversold` (default: 30.0) - Oversold threshold for buy signals
- `overbought` (default: 70.0) - Overbought threshold for sell signals

**Strategy Logic:**
- Buy when RSI drops below oversold level
- Sell when RSI rises above overbought level
- Only triggers on level crossings (not continuous signals)

### 4. MACD Strategy (`macd_strategy_template.py`)
Replicates the MACD (Moving Average Convergence Divergence) strategy.

**Parameters:**
- `fast_period` (default: 12) - Fast EMA period
- `slow_period` (default: 26) - Slow EMA period
- `signal_period` (default: 9) - Signal line EMA period

**Strategy Logic:**
- Buy when MACD line crosses above signal line
- Sell when MACD line crosses below signal line
- Includes MACD histogram calculation

### 6. Combined Strategy (`combined_strategy_template.py`)
Combines MACD, Bollinger Bands, and RSI. Any of the three strategies can independently trigger a buy signal. A `signal_source` column records which strategy triggered each trade, and the matching strategy's sell condition is prioritised for the exit. A configurable stop-loss acts as a universal safeguard.

**Parameters:**
- `macd_fast` (default: 12) - MACD fast EMA period
- `macd_slow` (default: 26) - MACD slow EMA period
- `macd_signal` (default: 9) - MACD signal line EMA period
- `bb_period` (default: 20) - Bollinger Bands SMA/std period
- `bb_std_dev` (default: 2.0) - Bollinger Bands std-dev multiplier
- `rsi_period` (default: 14) - RSI look-back period
- `rsi_oversold` (default: 30.0) - RSI buy threshold
- `rsi_overbought` (default: 70.0) - RSI sell threshold
- `stop_loss_pct` (default: 5.0) - Unrealised loss % that forces a sell (0 = disabled)

**Strategy Logic:**
- **Buy**: first of MACD crossover-up / BB lower-band touch / RSI oversold fires
- **Sell (priority 1 – stop-loss)**: close ≤ entry × (1 − stop_loss_pct / 100)
- **Sell (priority 2 – primary exit)**: the exit condition of the strategy that entered the trade
- **Sell (priority 3 – fallback)**: any of the three strategy sell conditions fires
- `signal_source` column values: `"macd"`, `"bb"`, `"rsi"` (buy), `"macd_exit"`, `"bb_exit"`, `"rsi_exit"`, `"stop_loss"`, `"fallback_exit"` (sell)

### 5. Bollinger Bands Strategy (`bollinger_bands_template.py`)
Replicates the Bollinger Bands mean-reversion strategy.

**Parameters:**
- `period` (default: 20) - Period for moving average and standard deviation
- `std_dev` (default: 2.0) - Standard deviation multiplier for bands

**Strategy Logic:**
- Buy when price closes below lower Bollinger Band
- Sell when price closes above upper Bollinger Band
- Includes percentage position within bands

## How to Use Templates

### 1. Copy Template Code
1. Open the desired template file
2. Copy the entire code content
3. Paste into the Scripts panel in the Stock AI frontend

### 2. Customize Parameters
Modify the `get_default_params()` function to change default values:

```python
def get_default_params() -> dict:
    return {
        "fast_period": 5,    # Changed from 10
        "slow_period": 20,   # Changed from 30
        "ma_type": "EMA"     # Changed from "SMA"
    }
```

### 3. Modify Strategy Logic
Edit the `generate_signals()` function to implement your custom logic:

```python
def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    df = df.copy()
    
    # Your custom strategy logic here
    # Must return DataFrame with 'signal' column
    # Signal values: +1 (buy), -1 (sell), 0 (hold)
    
    return df
```

## Script Requirements

### Required Functions
- `generate_signals(df, **params)` - Main strategy logic (required)
- `get_default_params()` - Default parameter values (optional but recommended)

### Available Imports
- `pandas as pd`
- `numpy as np`
- `math`
- `statistics`

### DataFrame Columns
Input DataFrame contains OHLCV data:
- `Open` - Opening price
- `High` - Highest price
- `Low` - Lowest price
- `Close` - Closing price
- `Volume` - Trading volume

### Signal Convention
The `signal` column must contain:
- `+1` - Buy signal
- `-1` - Sell signal  
- `0` - Hold/No action

## Tips for Custom Strategies

### 1. Handle Missing Data
```python
# Fill NaN values before calculations
df["indicator"] = df["Close"].rolling(20).mean().fillna(0)
```

### 2. Avoid Look-Ahead Bias
```python
# Use shift() to prevent using future data
df["prev_close"] = df["Close"].shift(1)
```

### 3. Signal Filtering
```python
# Only trigger on changes to avoid continuous signals
df["prev_signal"] = df["signal"].shift(1).fillna(0)
df["signal_change"] = (df["signal"] != df["prev_signal"]) & (df["signal"] != 0)
df.loc[~df["signal_change"], "signal"] = 0
```

### 4. Parameter Validation
```python
def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    period = max(1, int(params.get("period", 14)))  # Ensure positive integer
    threshold = max(0, float(params.get("threshold", 30.0)))  # Ensure positive float
```

## Testing Your Strategy

1. Create or modify a template in the Scripts panel
2. Click "Validate Script" to check for syntax errors
3. Run a backtest to evaluate performance
4. Review results in the Reports panel
5. Iterate and improve your strategy

## Example: Combining Indicators

```python
def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    df = df.copy()
    
    # Calculate multiple indicators
    sma_20 = df["Close"].rolling(20).mean()
    rsi = calculate_rsi(df["Close"], 14)
    
    # Combine conditions
    df["signal"] = 0
    
    # Buy: Price above SMA AND RSI oversold
    buy_condition = (df["Close"] > sma_20) & (rsi < 30)
    df.loc[buy_condition, "signal"] = 1
    
    # Sell: Price below SMA OR RSI overbought  
    sell_condition = (df["Close"] < sma_20) | (rsi > 70)
    df.loc[sell_condition, "signal"] = -1
    
    return df
```