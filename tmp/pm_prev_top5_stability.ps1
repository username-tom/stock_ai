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
  @{ name='trend-strictfills'; map=$trendMap; stop_loss_pct=1.0; take_profit_pct=3.0; hold_positions_overnight=$false; sentiment_bucket_persistence=3; sim_buy_fill_rate_pct=100.0; sim_sell_fill_rate_pct=100.0 },
  @{ name='trend-base'; map=$trendMap; stop_loss_pct=1.0; take_profit_pct=3.0; hold_positions_overnight=$false; sentiment_bucket_persistence=3; sim_buy_fill_rate_pct=90.0; sim_sell_fill_rate_pct=90.0 },
  @{ name='meanrev-swing'; map=$meanRevMap; stop_loss_pct=1.5; take_profit_pct=4.0; hold_positions_overnight=$true; sentiment_bucket_persistence=5; sim_buy_fill_rate_pct=90.0; sim_sell_fill_rate_pct=90.0 }
)

function Invoke-ScenarioRun([hashtable]$s) {
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
  return [pscustomobject]@{
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

$raw = @()

try {
  for ($rep = 1; $rep -le 3; $rep++) {
    foreach ($s in $scenarios) {
      Write-Host "Running repeat=$rep scenario=$($s.name)"
      $r = Invoke-ScenarioRun -s $s
      $raw += [pscustomobject]@{
        repeat = $rep
        scenario = $r.scenario
        report_id = $r.report_id
        total_return_pct = $r.total_return_pct
        sharpe_ratio = $r.sharpe_ratio
        max_drawdown_pct = $r.max_drawdown_pct
        win_rate_pct = $r.win_rate_pct
        annualized_return_pct = $r.annualized_return_pct
        total_trades = $r.total_trades
        score = $r.score
      }
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
        runs = $n
        avg_total_return_pct = [math]::Round([double]$avgReturn, 4)
        avg_sharpe_ratio = [math]::Round([double]$avgSharpe, 4)
        avg_max_drawdown_pct = [math]::Round([double]$avgDd, 4)
        avg_win_rate_pct = [math]::Round([double]$avgWin, 4)
        avg_annualized_return_pct = [math]::Round([double]$avgAnn, 4)
        avg_total_trades = [math]::Round([double]$avgTrades, 2)
        avg_score = [math]::Round([double]$avgScore, 4)
        std_score = [math]::Round([double]$stdScore, 4)
      }
    }
)

$ranked = @($summary | Sort-Object avg_score -Descending)
$out1 = 'tmp/pm_prev_top5_stability_raw.json'
$out2 = 'tmp/pm_prev_top5_stability_ranked.json'
$raw | ConvertTo-Json -Depth 8 | Set-Content -Path $out1 -Encoding UTF8
$ranked | ConvertTo-Json -Depth 8 | Set-Content -Path $out2 -Encoding UTF8

$ranked | Format-Table scenario,runs,avg_total_return_pct,avg_sharpe_ratio,avg_max_drawdown_pct,avg_win_rate_pct,avg_total_trades,avg_score,std_score -AutoSize | Out-String | Write-Host
Write-Host "Saved: $out1"
Write-Host "Saved: $out2"