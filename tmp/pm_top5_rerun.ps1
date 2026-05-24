$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:8000'
$reportId = 145

$report = Invoke-RestMethod -Uri "$baseUrl/api/backtest/reports/$reportId"
$state = Invoke-RestMethod -Uri "$baseUrl/api/sandbox/manager/state"
$orig = $state.settings

$symbols = @($report.parameters.symbols)
$startDate = $report.start_date
$endDate = $report.end_date
$initialCapital = [double]$report.initial_capital

$baselineMap = $orig.market_sentiment_strategies
$trendMap = @{ crash='rsi'; bearish='rsi'; neutral='macd'; bullish='sma_crossover'; euphoric='sma_crossover' }
$meanRevMap = @{ crash='stoch_rsi'; bearish='stochastic'; neutral='bollinger_bands'; bullish='rsi'; euphoric='williams_r' }

$scenarios = @(
  @{ name='baseline-tight'; map=$baselineMap; stop_loss_pct=0.8; take_profit_pct=2.5; hold_positions_overnight=$false; sentiment_bucket_persistence=5; sim_buy_fill_rate_pct=90.0; sim_sell_fill_rate_pct=90.0 },
  @{ name='trend-tight'; map=$trendMap; stop_loss_pct=0.8; take_profit_pct=2.5; hold_positions_overnight=$false; sentiment_bucket_persistence=5; sim_buy_fill_rate_pct=90.0; sim_sell_fill_rate_pct=90.0 },
  @{ name='trend-base'; map=$trendMap; stop_loss_pct=1.0; take_profit_pct=3.0; hold_positions_overnight=$false; sentiment_bucket_persistence=3; sim_buy_fill_rate_pct=90.0; sim_sell_fill_rate_pct=90.0 },
  @{ name='trend-strictfills'; map=$trendMap; stop_loss_pct=1.0; take_profit_pct=3.0; hold_positions_overnight=$false; sentiment_bucket_persistence=3; sim_buy_fill_rate_pct=100.0; sim_sell_fill_rate_pct=100.0 },
  @{ name='meanrev-swing'; map=$meanRevMap; stop_loss_pct=1.5; take_profit_pct=4.0; hold_positions_overnight=$true; sentiment_bucket_persistence=5; sim_buy_fill_rate_pct=90.0; sim_sell_fill_rate_pct=90.0 }
)

$results = @()

try {
  foreach ($s in $scenarios) {
    Write-Host "Running: $($s.name)"

    $pmPatch = @{
      market_sentiment_strategies = $s.map
      stop_loss_pct = [double]$s.stop_loss_pct
      take_profit_pct = [double]$s.take_profit_pct
      hold_positions_overnight = [bool]$s.hold_positions_overnight
      sentiment_bucket_persistence = [int]$s.sentiment_bucket_persistence
    }

    Invoke-RestMethod -Method Patch -Uri "$baseUrl/api/sandbox/manager/settings" -ContentType 'application/json' -Body ($pmPatch | ConvertTo-Json -Depth 8) | Out-Null

    $payload = @{
      start_date = $startDate
      end_date = $endDate
      initial_capital = $initialCapital
      commission = 0.001
      data_source = 'auto'
      day_trade = $true
      symbols = $symbols
      use_sentiment_routing = $true
      allocation_mode = 'equal'
      use_shared_pool = $true
      per_position_min_pct = 0.0
      per_position_max_pct = 20.0
      sim_buy_fill_rate_pct = [double]$s.sim_buy_fill_rate_pct
      sim_sell_fill_rate_pct = [double]$s.sim_sell_fill_rate_pct
    }

    $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/backtest/run-sandbox" -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 10)
    $m = $resp.metrics

    $score = [math]::Round(
      ([double]$m.total_return_pct) +
      (0.75 * [double]$m.sharpe_ratio) +
      (0.05 * [double]$m.win_rate_pct) +
      (0.10 * [double]$m.annualized_return_pct) -
      (0.40 * [math]::Abs([double]$m.max_drawdown_pct)),
      4
    )

    $results += [pscustomobject]@{
      scenario = $s.name
      report_id = $resp.id
      total_return_pct = [double]$m.total_return_pct
      sharpe_ratio = [double]$m.sharpe_ratio
      max_drawdown_pct = [double]$m.max_drawdown_pct
      win_rate_pct = [double]$m.win_rate_pct
      annualized_return_pct = [double]$m.annualized_return_pct
      total_trades = [int]$m.total_trades
      score = $score
    }
  }
}
finally {
  $restore = @{
    market_sentiment_strategies = $orig.market_sentiment_strategies
    stop_loss_pct = [double]$orig.stop_loss_pct
    take_profit_pct = [double]$orig.take_profit_pct
    hold_positions_overnight = [bool]$orig.hold_positions_overnight
    sentiment_bucket_persistence = [int]$orig.sentiment_bucket_persistence
  }
  Invoke-RestMethod -Method Patch -Uri "$baseUrl/api/sandbox/manager/settings" -ContentType 'application/json' -Body ($restore | ConvertTo-Json -Depth 8) | Out-Null
}

$ranked = $results | Sort-Object score -Descending
$outPath = 'tmp/pm_top5_rerun_results.json'
$ranked | ConvertTo-Json -Depth 8 | Set-Content -Path $outPath -Encoding UTF8

$ranked | Format-Table -AutoSize | Out-String
Write-Host "Saved: $outPath"