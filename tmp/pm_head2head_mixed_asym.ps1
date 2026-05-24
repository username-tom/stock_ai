$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:8000'
$reportId = 145
$repeats = 3

$report = Invoke-RestMethod -Uri "$baseUrl/api/backtest/reports/$reportId"
$state = Invoke-RestMethod -Uri "$baseUrl/api/sandbox/manager/state"
$orig = $state.settings

$symbols = @($report.parameters.symbols)
$startDate = $report.start_date
$endDate = $report.end_date
$initialCapital = [double]$report.initial_capital

$baselineMap = $orig.market_sentiment_strategies
$trendMap = @{ crash='rsi'; bearish='rsi'; neutral='macd'; bullish='sma_crossover'; euphoric='sma_crossover' }

$candidates = @(
  @{ name='baseline-tight'; map=$baselineMap; stop_loss_pct=0.8; take_profit_pct=2.5; hold_positions_overnight=$false; sentiment_bucket_persistence=5 },
  @{ name='trend-base'; map=$trendMap; stop_loss_pct=1.0; take_profit_pct=3.0; hold_positions_overnight=$false; sentiment_bucket_persistence=3 },
  @{ name='trend-swing'; map=$trendMap; stop_loss_pct=1.5; take_profit_pct=4.0; hold_positions_overnight=$true; sentiment_bucket_persistence=5 }
)

# Action 1: mixed symmetric assumptions (buy=sell).
$phase1Profiles = @(
  @{ name='sym_90'; buy=90; sell=90 },
  @{ name='sym_80'; buy=80; sell=80 },
  @{ name='sym_70'; buy=70; sell=70 },
  @{ name='sym_60'; buy=60; sell=60 },
  @{ name='sym_50'; buy=50; sell=50 },
  @{ name='sym_40'; buy=40; sell=40 }
)

# Action 2: asymmetric assumptions (sell fixed high, buy degraded).
$phase2Profiles = @(
  @{ name='asym_b90_s90'; buy=90; sell=90 },
  @{ name='asym_b80_s90'; buy=80; sell=90 },
  @{ name='asym_b70_s90'; buy=70; sell=90 },
  @{ name='asym_b60_s90'; buy=60; sell=90 },
  @{ name='asym_b50_s90'; buy=50; sell=90 },
  @{ name='asym_b40_s90'; buy=40; sell=90 }
)

function Invoke-BacktestRun([hashtable]$scenario, [double]$buyFill, [double]$sellFill) {
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
    sim_buy_fill_rate_pct = [double]$buyFill
    sim_sell_fill_rate_pct = [double]$sellFill
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

function Summarize-ByScenario($rows) {
  return @(
    $rows |
      Group-Object scenario |
      ForEach-Object {
        $g = @($_.Group)
        $n = $g.Count
        $avgReturn = ($g | Measure-Object total_return_pct -Average).Average
        $avgSharpe = ($g | Measure-Object sharpe_ratio -Average).Average
        $avgDd = ($g | Measure-Object max_drawdown_pct -Average).Average
        $avgWin = ($g | Measure-Object win_rate_pct -Average).Average
        $avgAnn = ($g | Measure-Object annualized_return_pct -Average).Average
        $avgTrades = ($g | Measure-Object total_trades -Average).Average
        $avgScore = ($g | Measure-Object score -Average).Average
        $minScore = ($g | Measure-Object score -Minimum).Minimum
        $minReturn = ($g | Measure-Object total_return_pct -Minimum).Minimum
        $worstDd = ($g | Sort-Object max_drawdown_pct | Select-Object -First 1).max_drawdown_pct

        $stdScore = 0.0
        if ($n -gt 1) {
          $mean = [double]$avgScore
          $sumSq = 0.0
          foreach ($r in $g) {
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
          worst_case_score = [math]::Round([double]$minScore, 4)
          worst_case_return_pct = [math]::Round([double]$minReturn, 4)
          worst_case_drawdown_pct = [math]::Round([double]$worstDd, 4)
        }
      }
  )
}

function Summarize-ByScenarioAndProfile($rows) {
  return @(
    $rows |
      Group-Object scenario, profile |
      ForEach-Object {
        $g = @($_.Group)
        $n = $g.Count
        $avgReturn = ($g | Measure-Object total_return_pct -Average).Average
        $avgSharpe = ($g | Measure-Object sharpe_ratio -Average).Average
        $avgDd = ($g | Measure-Object max_drawdown_pct -Average).Average
        $avgWin = ($g | Measure-Object win_rate_pct -Average).Average
        $avgTrades = ($g | Measure-Object total_trades -Average).Average
        $avgScore = ($g | Measure-Object score -Average).Average

        [pscustomobject]@{
          scenario = $g[0].scenario
          profile = $g[0].profile
          buy_fill_pct = $g[0].buy_fill_pct
          sell_fill_pct = $g[0].sell_fill_pct
          runs = $n
          avg_total_return_pct = [math]::Round([double]$avgReturn, 4)
          avg_sharpe_ratio = [math]::Round([double]$avgSharpe, 4)
          avg_max_drawdown_pct = [math]::Round([double]$avgDd, 4)
          avg_win_rate_pct = [math]::Round([double]$avgWin, 4)
          avg_total_trades = [math]::Round([double]$avgTrades, 2)
          avg_score = [math]::Round([double]$avgScore, 4)
        }
      }
  )
}

$phase1Raw = @()
$phase2Raw = @()

try {
  Write-Host "Phase1: mixed symmetric fill assumptions (x$repeats each)"
  foreach ($profile in $phase1Profiles) {
    for ($rep = 1; $rep -le $repeats; $rep++) {
      foreach ($scenario in $candidates) {
        Write-Host "Phase1 profile=$($profile.name) repeat=$rep scenario=$($scenario.name)"
        $r = Invoke-BacktestRun -scenario $scenario -buyFill ([double]$profile.buy) -sellFill ([double]$profile.sell)
        $phase1Raw += [pscustomobject]@{
          phase = 'phase1'
          repeat = $rep
          profile = $profile.name
          scenario = $scenario.name
          buy_fill_pct = [double]$profile.buy
          sell_fill_pct = [double]$profile.sell
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

  Write-Host "Phase2: asymmetric fill assumptions (sell fixed 90, x$repeats each)"
  foreach ($profile in $phase2Profiles) {
    for ($rep = 1; $rep -le $repeats; $rep++) {
      foreach ($scenario in $candidates) {
        Write-Host "Phase2 profile=$($profile.name) repeat=$rep scenario=$($scenario.name)"
        $r = Invoke-BacktestRun -scenario $scenario -buyFill ([double]$profile.buy) -sellFill ([double]$profile.sell)
        $phase2Raw += [pscustomobject]@{
          phase = 'phase2'
          repeat = $rep
          profile = $profile.name
          scenario = $scenario.name
          buy_fill_pct = [double]$profile.buy
          sell_fill_pct = [double]$profile.sell
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

$phase1Ranked = @(Summarize-ByScenario -rows $phase1Raw | Sort-Object avg_score -Descending)
$phase2Ranked = @(Summarize-ByScenario -rows $phase2Raw | Sort-Object avg_score -Descending)
$phase1ByProfile = @(
  Summarize-ByScenarioAndProfile -rows $phase1Raw |
    Sort-Object -Property @{ Expression = 'buy_fill_pct'; Descending = $true }, @{ Expression = 'scenario'; Descending = $false }
)
$phase2ByProfile = @(
  Summarize-ByScenarioAndProfile -rows $phase2Raw |
    Sort-Object -Property @{ Expression = 'buy_fill_pct'; Descending = $true }, @{ Expression = 'scenario'; Descending = $false }
)

$outP1Raw = 'tmp/pm_head2head_phase1_raw.json'
$outP1Rank = 'tmp/pm_head2head_phase1_ranked.json'
$outP1ByProfile = 'tmp/pm_head2head_phase1_by_profile.json'
$outP2Raw = 'tmp/pm_head2head_phase2_raw.json'
$outP2Rank = 'tmp/pm_head2head_phase2_ranked.json'
$outP2ByProfile = 'tmp/pm_head2head_phase2_by_profile.json'

$phase1Raw | ConvertTo-Json -Depth 8 | Set-Content -Path $outP1Raw -Encoding UTF8
$phase1Ranked | ConvertTo-Json -Depth 8 | Set-Content -Path $outP1Rank -Encoding UTF8
$phase1ByProfile | ConvertTo-Json -Depth 8 | Set-Content -Path $outP1ByProfile -Encoding UTF8
$phase2Raw | ConvertTo-Json -Depth 8 | Set-Content -Path $outP2Raw -Encoding UTF8
$phase2Ranked | ConvertTo-Json -Depth 8 | Set-Content -Path $outP2Rank -Encoding UTF8
$phase2ByProfile | ConvertTo-Json -Depth 8 | Set-Content -Path $outP2ByProfile -Encoding UTF8

Write-Host ""
Write-Host "Phase1 overall ranking:"
$phase1Ranked | Format-Table scenario,runs,avg_total_return_pct,avg_sharpe_ratio,avg_max_drawdown_pct,avg_win_rate_pct,avg_total_trades,avg_score,std_score,worst_case_return_pct,worst_case_drawdown_pct -AutoSize | Out-String | Write-Host

Write-Host "Phase2 overall ranking:"
$phase2Ranked | Format-Table scenario,runs,avg_total_return_pct,avg_sharpe_ratio,avg_max_drawdown_pct,avg_win_rate_pct,avg_total_trades,avg_score,std_score,worst_case_return_pct,worst_case_drawdown_pct -AutoSize | Out-String | Write-Host

Write-Host "Saved: $outP1Raw"
Write-Host "Saved: $outP1Rank"
Write-Host "Saved: $outP1ByProfile"
Write-Host "Saved: $outP2Raw"
Write-Host "Saved: $outP2Rank"
Write-Host "Saved: $outP2ByProfile"