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

# Head-to-head candidates from prior work.
$candidates = @(
  @{ name='baseline-tight'; map=$baselineMap; stop_loss_pct=0.8; take_profit_pct=2.5; hold_positions_overnight=$false; sentiment_bucket_persistence=5 },
  @{ name='trend-tight'; map=$trendMap; stop_loss_pct=0.8; take_profit_pct=2.5; hold_positions_overnight=$false; sentiment_bucket_persistence=5 },
  @{ name='baseline-base'; map=$baselineMap; stop_loss_pct=1.0; take_profit_pct=3.0; hold_positions_overnight=$false; sentiment_bucket_persistence=3 },
  @{ name='trend-swing'; map=$trendMap; stop_loss_pct=1.5; take_profit_pct=4.0; hold_positions_overnight=$true; sentiment_bucket_persistence=5 },
  @{ name='trend-base'; map=$trendMap; stop_loss_pct=1.0; take_profit_pct=3.0; hold_positions_overnight=$false; sentiment_bucket_persistence=3 }
)

$fillRates = @(90, 80, 70, 60, 50, 40)

function Invoke-ScenarioRun([hashtable]$scenario, [double]$fillRate) {
  $pmPatch = @{
    market_sentiment_strategies = $scenario.map
    stop_loss_pct = [double]$scenario.stop_loss_pct
    take_profit_pct = [double]$scenario.take_profit_pct
    hold_positions_overnight = [bool]$scenario.hold_positions_overnight
    sentiment_bucket_persistence = [int]$scenario.sentiment_bucket_persistence
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
    sim_buy_fill_rate_pct = [double]$fillRate
    sim_sell_fill_rate_pct = [double]$fillRate
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
  return [pscustomobject]@{
    scenario = $scenario.name
    fill_rate_pct = [double]$fillRate
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

$raw = @()

try {
  foreach ($scenario in $candidates) {
    foreach ($fillRate in $fillRates) {
      Write-Host "Running scenario=$($scenario.name) fill_rate=$fillRate"
      $raw += Invoke-ScenarioRun -scenario $scenario -fillRate $fillRate
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

$summary = @(
  $raw |
    Group-Object scenario |
    ForEach-Object {
      $rows = @($_.Group)
      $n = $rows.Count
      $avgReturn = ($rows | Measure-Object total_return_pct -Average).Average
      $avgSharpe = ($rows | Measure-Object sharpe_ratio -Average).Average
      $avgDd = ($rows | Measure-Object max_drawdown_pct -Average).Average
      $avgWin = ($rows | Measure-Object win_rate_pct -Average).Average
      $avgAnn = ($rows | Measure-Object annualized_return_pct -Average).Average
      $avgTrades = ($rows | Measure-Object total_trades -Average).Average
      $avgScore = ($rows | Measure-Object score -Average).Average
      $minScore = ($rows | Measure-Object score -Minimum).Minimum
      $maxScore = ($rows | Measure-Object score -Maximum).Maximum
      $minReturn = ($rows | Measure-Object total_return_pct -Minimum).Minimum
      $maxDdWorst = ($rows | Sort-Object max_drawdown_pct | Select-Object -First 1).max_drawdown_pct

      $stdScore = 0.0
      if ($n -gt 1) {
        $mean = [double]$avgScore
        $sumSq = 0.0
        foreach ($r in $rows) {
          $d = ([double]$r.score) - $mean
          $sumSq += $d * $d
        }
        $stdScore = [math]::Sqrt($sumSq / ($n - 1))
      }

      [pscustomobject]@{
        scenario = $_.Name
        tested_fill_rates = ($rows | Sort-Object fill_rate_pct -Descending | ForEach-Object { [int]$_.fill_rate_pct }) -join ','
        avg_total_return_pct = [math]::Round([double]$avgReturn, 4)
        avg_sharpe_ratio = [math]::Round([double]$avgSharpe, 4)
        avg_max_drawdown_pct = [math]::Round([double]$avgDd, 4)
        avg_win_rate_pct = [math]::Round([double]$avgWin, 4)
        avg_annualized_return_pct = [math]::Round([double]$avgAnn, 4)
        avg_total_trades = [math]::Round([double]$avgTrades, 2)
        avg_score = [math]::Round([double]$avgScore, 4)
        std_score = [math]::Round([double]$stdScore, 4)
        worst_case_score = [math]::Round([double]$minScore, 4)
        worst_case_return_pct = [math]::Round([double]$minReturn, 4)
        worst_case_drawdown_pct = [math]::Round([double]$maxDdWorst, 4)
      }
    }
)

$ranked = @($summary | Sort-Object avg_score -Descending)
$outRaw = 'tmp/pm_fillrate_sweep_raw.json'
$outRanked = 'tmp/pm_fillrate_sweep_ranked.json'
$raw | ConvertTo-Json -Depth 8 | Set-Content -Path $outRaw -Encoding UTF8
$ranked | ConvertTo-Json -Depth 8 | Set-Content -Path $outRanked -Encoding UTF8

Write-Host "Fill-rate robustness ranking:"
$ranked | Format-Table scenario,avg_total_return_pct,avg_sharpe_ratio,avg_max_drawdown_pct,avg_win_rate_pct,avg_total_trades,avg_score,std_score,worst_case_return_pct,worst_case_drawdown_pct -AutoSize | Out-String | Write-Host
Write-Host "Saved: $outRaw"
Write-Host "Saved: $outRanked"