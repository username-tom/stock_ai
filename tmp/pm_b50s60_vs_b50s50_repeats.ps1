$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:8000'
$runsPerCondition = 5

$metaPath = 'tmp/pm_current_preset_asym_meta.json'
if (-not (Test-Path $metaPath)) {
  throw "Missing $metaPath. Run the asymmetry sweep first."
}

$meta = Get-Content -Path $metaPath -Raw | ConvertFrom-Json
$baselineReportId = [int]$meta.baseline_report_id
$report = Invoke-RestMethod -Uri "$baseUrl/api/backtest/reports/$baselineReportId"
$state = Invoke-RestMethod -Uri "$baseUrl/api/sandbox/manager/state"
$current = $state.settings

$symbols = @($report.parameters.symbols)
if ($symbols.Count -eq 0) {
  throw "Report $baselineReportId does not include parameters.symbols"
}

$startDate = [string]$report.start_date
$endDate = [string]$report.end_date
$initialCapital = [double]$report.initial_capital
$commission = 0.001
$dataSource = 'auto'
$dayTrade = $true
$useSentimentRouting = $true
$allocationMode = 'equal'
$useSharedPool = $true
$perPositionMinPct = 0.0
$perPositionMaxPct = 20.0

if ($null -ne $report.parameters) {
  if ($null -ne $report.parameters.commission) { $commission = [double]$report.parameters.commission }
  if ($null -ne $report.parameters.data_source) { $dataSource = [string]$report.parameters.data_source }
  if ($null -ne $report.parameters.day_trade) { $dayTrade = [bool]$report.parameters.day_trade }
  if ($null -ne $report.parameters.use_sentiment_routing) { $useSentimentRouting = [bool]$report.parameters.use_sentiment_routing }
  if ($null -ne $report.parameters.allocation_mode) { $allocationMode = [string]$report.parameters.allocation_mode }
  if ($null -ne $report.parameters.use_shared_pool) { $useSharedPool = [bool]$report.parameters.use_shared_pool }
  if ($null -ne $report.parameters.per_position_min_pct) { $perPositionMinPct = [double]$report.parameters.per_position_min_pct }
  if ($null -ne $report.parameters.per_position_max_pct) { $perPositionMaxPct = [double]$report.parameters.per_position_max_pct }
}

$conditions = @(
  @{ name = 'B50-S60'; buy = 50.0; sell = 60.0 },
  @{ name = 'B50-S50'; buy = 50.0; sell = 50.0 }
)

function Invoke-ConditionRun([hashtable]$condition, [int]$repeatIndex) {
  $payload = @{
    start_date = $startDate
    end_date = $endDate
    initial_capital = $initialCapital
    commission = $commission
    data_source = $dataSource
    day_trade = $dayTrade
    symbols = $symbols
    use_sentiment_routing = $useSentimentRouting
    allocation_mode = $allocationMode
    use_shared_pool = $useSharedPool
    per_position_min_pct = $perPositionMinPct
    per_position_max_pct = $perPositionMaxPct
    sim_buy_fill_rate_pct = [double]$condition.buy
    sim_sell_fill_rate_pct = [double]$condition.sell
  }

  $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/backtest/run-sandbox" -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 12)
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
    condition = [string]$condition.name
    repeat = [int]$repeatIndex
    buy_fill_pct = [double]$condition.buy
    sell_fill_pct = [double]$condition.sell
    report_id = [int]$resp.id
    total_return_pct = [double]$m.total_return_pct
    sharpe_ratio = [double]$m.sharpe_ratio
    max_drawdown_pct = [double]$m.max_drawdown_pct
    win_rate_pct = [double]$m.win_rate_pct
    annualized_return_pct = [double]$m.annualized_return_pct
    total_trades = [int]$m.total_trades
    score = $score
  }
}

function Get-StdDev([double[]]$values) {
  if ($values.Count -le 1) { return 0.0 }
  $mean = ($values | Measure-Object -Average).Average
  $sumSq = 0.0
  foreach ($v in $values) {
    $d = $v - $mean
    $sumSq += $d * $d
  }
  return [math]::Sqrt($sumSq / ($values.Count - 1))
}

function Summarize-Condition($rows) {
  $returns = @($rows | ForEach-Object { [double]$_.total_return_pct })
  $scores = @($rows | ForEach-Object { [double]$_.score })

  $avgReturn = ($returns | Measure-Object -Average).Average
  $stdReturn = Get-StdDev -values $returns
  $avgScore = ($scores | Measure-Object -Average).Average
  $stdScore = Get-StdDev -values $scores

  $sortedReturns = @($returns | Sort-Object)
  $medianReturn = if ($sortedReturns.Count % 2 -eq 1) {
    $sortedReturns[[int][math]::Floor($sortedReturns.Count / 2)]
  } else {
    $i = [int]($sortedReturns.Count / 2)
    ($sortedReturns[$i - 1] + $sortedReturns[$i]) / 2.0
  }

  return [pscustomobject]@{
    condition = $rows[0].condition
    runs = $rows.Count
    avg_total_return_pct = [math]::Round([double]$avgReturn, 4)
    std_total_return_pct = [math]::Round([double]$stdReturn, 4)
    median_total_return_pct = [math]::Round([double]$medianReturn, 4)
    min_total_return_pct = [math]::Round([double]($returns | Measure-Object -Minimum).Minimum, 4)
    max_total_return_pct = [math]::Round([double]($returns | Measure-Object -Maximum).Maximum, 4)
    avg_score = [math]::Round([double]$avgScore, 4)
    std_score = [math]::Round([double]$stdScore, 4)
  }
}

$raw = @()

foreach ($condition in $conditions) {
  for ($i = 1; $i -le $runsPerCondition; $i++) {
    Write-Host ("Running {0} repeat {1}/{2}" -f $condition.name, $i, $runsPerCondition)
    $raw += Invoke-ConditionRun -condition $condition -repeatIndex $i
  }
}

$summary = @(
  $raw |
    Group-Object condition |
    ForEach-Object {
      $rows = @($_.Group)
      Summarize-Condition -rows $rows
    }
)

$a = @($raw | Where-Object { $_.condition -eq 'B50-S60' })
$b = @($raw | Where-Object { $_.condition -eq 'B50-S50' })

$aReturns = @($a | ForEach-Object { [double]$_.total_return_pct })
$bReturns = @($b | ForEach-Object { [double]$_.total_return_pct })

$aMean = ($aReturns | Measure-Object -Average).Average
$bMean = ($bReturns | Measure-Object -Average).Average
$aStd = Get-StdDev -values $aReturns
$bStd = Get-StdDev -values $bReturns

$meanDiff = [double]$aMean - [double]$bMean
$pooledStd = 0.0
if (($aReturns.Count + $bReturns.Count) -gt 2) {
  $num = ((($aReturns.Count - 1) * $aStd * $aStd) + (($bReturns.Count - 1) * $bStd * $bStd))
  $den = (($aReturns.Count + $bReturns.Count) - 2)
  if ($den -gt 0) {
    $pooledStd = [math]::Sqrt($num / $den)
  }
}

$cohensD = if ($pooledStd -gt 0) { $meanDiff / $pooledStd } else { 0.0 }

# Non-parametric superiority estimate: fraction of pairwise comparisons where B50-S60 return > B50-S50 return.
$wins = 0
$ties = 0
$totalPairs = 0
foreach ($x in $aReturns) {
  foreach ($y in $bReturns) {
    $totalPairs += 1
    if ($x -gt $y) { $wins += 1 }
    elseif ($x -eq $y) { $ties += 1 }
  }
}
$superiority = if ($totalPairs -gt 0) { ($wins + 0.5 * $ties) / $totalPairs } else { 0.0 }

$comparison = [pscustomobject]@{
  compared = 'B50-S60_vs_B50-S50'
  runs_per_condition = $runsPerCondition
  mean_return_diff_pct = [math]::Round([double]$meanDiff, 4)
  cohens_d_return = [math]::Round([double]$cohensD, 4)
  superiority_prob = [math]::Round([double]$superiority, 4)
}

$outRaw = 'tmp/pm_b50s60_vs_b50s50_raw.json'
$outSummary = 'tmp/pm_b50s60_vs_b50s50_summary.json'

$raw | ConvertTo-Json -Depth 8 | Set-Content -Path $outRaw -Encoding UTF8
[pscustomobject]@{
  generated_at = (Get-Date).ToString('s')
  baseline_report_id = $baselineReportId
  pm_settings_used = [pscustomobject]@{
    stop_loss_pct = [double]$current.stop_loss_pct
    take_profit_pct = [double]$current.take_profit_pct
    hold_positions_overnight = [bool]$current.hold_positions_overnight
    sentiment_bucket_persistence = [int]$current.sentiment_bucket_persistence
    market_sentiment_strategies = $current.market_sentiment_strategies
  }
  summary_by_condition = $summary
  comparison = $comparison
} | ConvertTo-Json -Depth 10 | Set-Content -Path $outSummary -Encoding UTF8

Write-Host ''
Write-Host 'Summary by condition:'
$summary | Format-Table condition,runs,avg_total_return_pct,std_total_return_pct,median_total_return_pct,min_total_return_pct,max_total_return_pct,avg_score,std_score -AutoSize | Out-String | Write-Host

Write-Host 'Comparison:'
$comparison | Format-List | Out-String | Write-Host

Write-Host "Saved: $outRaw"
Write-Host "Saved: $outSummary"
