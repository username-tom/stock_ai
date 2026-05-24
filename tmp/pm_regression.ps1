$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:8000'
$targetReportId = 145

$latest = Invoke-RestMethod -Uri "$baseUrl/api/backtest/reports/$targetReportId"
$state = Invoke-RestMethod -Uri "$baseUrl/api/sandbox/manager/state"
$orig = $state.settings

$symbols = @($latest.parameters.symbols)
$startDate = $latest.start_date
$endDate = $latest.end_date
$initialCapital = [double]$latest.initial_capital

$baselineMap = $orig.market_sentiment_strategies
$trendMap = @{
  crash = 'rsi'; bearish = 'rsi'; neutral = 'macd'; bullish = 'sma_crossover'; euphoric = 'sma_crossover'
}
$meanRevMap = @{
  crash = 'stoch_rsi'; bearish = 'stochastic'; neutral = 'bollinger_bands'; bullish = 'rsi'; euphoric = 'williams_r'
}

$riskProfiles = @(
  @{ name = 'tight'; stop_loss_pct = 0.8; take_profit_pct = 2.5; hold_positions_overnight = $false; sentiment_bucket_persistence = 5; sim_buy_fill_rate_pct = 90; sim_sell_fill_rate_pct = 90 },
  @{ name = 'base'; stop_loss_pct = 1.0; take_profit_pct = 3.0; hold_positions_overnight = $false; sentiment_bucket_persistence = 3; sim_buy_fill_rate_pct = 90; sim_sell_fill_rate_pct = 90 },
  @{ name = 'swing'; stop_loss_pct = 1.5; take_profit_pct = 4.0; hold_positions_overnight = $true; sentiment_bucket_persistence = 5; sim_buy_fill_rate_pct = 90; sim_sell_fill_rate_pct = 90 },
  @{ name = 'strictfills'; stop_loss_pct = 1.0; take_profit_pct = 3.0; hold_positions_overnight = $false; sentiment_bucket_persistence = 3; sim_buy_fill_rate_pct = 100; sim_sell_fill_rate_pct = 100 }
)

$strategyFamilies = @(
  @{ name = 'baseline'; map = $baselineMap },
  @{ name = 'trend'; map = $trendMap },
  @{ name = 'meanrev'; map = $meanRevMap }
)

$results = @()

try {
  foreach ($fam in $strategyFamilies) {
    foreach ($risk in $riskProfiles) {
      $scenarioName = "{0}-{1}" -f $fam.name, $risk.name
      Write-Host "Running scenario: $scenarioName"

      $pmPatch = @{
        market_sentiment_strategies = $fam.map
        stop_loss_pct = $risk.stop_loss_pct
        take_profit_pct = $risk.take_profit_pct
        hold_positions_overnight = $risk.hold_positions_overnight
        sentiment_bucket_persistence = $risk.sentiment_bucket_persistence
      }

      Invoke-RestMethod -Method Patch -Uri "$baseUrl/api/sandbox/manager/settings" -ContentType 'application/json' -Body ($pmPatch | ConvertTo-Json -Depth 10) | Out-Null

      $req = @{
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
        sim_buy_fill_rate_pct = $risk.sim_buy_fill_rate_pct
        sim_sell_fill_rate_pct = $risk.sim_sell_fill_rate_pct
      }

      $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/backtest/run-sandbox" -ContentType 'application/json' -Body ($req | ConvertTo-Json -Depth 10)
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
        scenario = $scenarioName
        report_id = $resp.id
        total_return_pct = [double]$m.total_return_pct
        sharpe_ratio = [double]$m.sharpe_ratio
        max_drawdown_pct = [double]$m.max_drawdown_pct
        win_rate_pct = [double]$m.win_rate_pct
        annualized_return_pct = [double]$m.annualized_return_pct
        total_trades = [int]$m.total_trades
        score = $score
        map = $fam.name
        risk = $risk.name
        hold_positions_overnight = [bool]$risk.hold_positions_overnight
        stop_loss_pct = [double]$risk.stop_loss_pct
        take_profit_pct = [double]$risk.take_profit_pct
        bucket_persistence = [int]$risk.sentiment_bucket_persistence
        sim_buy_fill_rate_pct = [double]$risk.sim_buy_fill_rate_pct
        sim_sell_fill_rate_pct = [double]$risk.sim_sell_fill_rate_pct
      }
    }
  }
}
finally {
  Write-Host 'Restoring PM baseline settings...'
  $restorePatch = @{
    market_sentiment_strategies = $orig.market_sentiment_strategies
    stop_loss_pct = [double]$orig.stop_loss_pct
    take_profit_pct = [double]$orig.take_profit_pct
    hold_positions_overnight = [bool]$orig.hold_positions_overnight
    sentiment_bucket_persistence = [int]$orig.sentiment_bucket_persistence
  }
  Invoke-RestMethod -Method Patch -Uri "$baseUrl/api/sandbox/manager/settings" -ContentType 'application/json' -Body ($restorePatch | ConvertTo-Json -Depth 10) | Out-Null
}

$ranked = $results | Sort-Object -Property score -Descending

$outDir = 'tmp'
if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

$resultsPath = Join-Path $outDir 'pm_regression_results.json'
$summaryPath = Join-Path $outDir 'pm_regression_summary.json'

$results | ConvertTo-Json -Depth 12 | Set-Content -Path $resultsPath -Encoding UTF8

[pscustomobject]@{
  baseline_report_id = $targetReportId
  runs = $results.Count
  best = $ranked[0]
  top5 = @($ranked | Select-Object -First 5)
} | ConvertTo-Json -Depth 12 | Set-Content -Path $summaryPath -Encoding UTF8

Write-Host "Saved full results: $resultsPath"
Write-Host "Saved summary: $summaryPath"
Get-Content $summaryPath