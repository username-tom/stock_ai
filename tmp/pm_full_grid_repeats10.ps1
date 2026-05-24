$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:8000'
$runsPerCombo = 10
$fillValues = @(90, 80, 70, 60, 50, 40)

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

function Invoke-FillRun([double]$buyFill, [double]$sellFill, [int]$repeatIndex) {
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
    sim_buy_fill_rate_pct = [double]$buyFill
    sim_sell_fill_rate_pct = [double]$sellFill
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
    combo = ("B{0}-S{1}" -f [int]$buyFill, [int]$sellFill)
    repeat = [int]$repeatIndex
    buy_fill_pct = [double]$buyFill
    sell_fill_pct = [double]$sellFill
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

function Summarize-Combo($rows) {
  $returns = @($rows | ForEach-Object { [double]$_.total_return_pct })
  $scores = @($rows | ForEach-Object { [double]$_.score })

  $n = $rows.Count
  $meanRet = [double](($returns | Measure-Object -Average).Average)
  $stdRet = [double](Get-StdDev -values $returns)
  $semRet = if ($n -gt 0) { $stdRet / [math]::Sqrt($n) } else { 0.0 }
  $ciRet = 1.96 * $semRet

  $meanScore = [double](($scores | Measure-Object -Average).Average)
  $stdScore = [double](Get-StdDev -values $scores)
  $semScore = if ($n -gt 0) { $stdScore / [math]::Sqrt($n) } else { 0.0 }
  $ciScore = 1.96 * $semScore

  return [pscustomobject]@{
    combo = [string]$rows[0].combo
    buy_fill_pct = [double]$rows[0].buy_fill_pct
    sell_fill_pct = [double]$rows[0].sell_fill_pct
    runs = $n
    avg_total_return_pct = [math]::Round($meanRet, 4)
    std_total_return_pct = [math]::Round($stdRet, 4)
    ci95_return_low = [math]::Round($meanRet - $ciRet, 4)
    ci95_return_high = [math]::Round($meanRet + $ciRet, 4)
    avg_score = [math]::Round($meanScore, 4)
    std_score = [math]::Round($stdScore, 4)
    ci95_score_low = [math]::Round($meanScore - $ciScore, 4)
    ci95_score_high = [math]::Round($meanScore + $ciScore, 4)
    avg_sharpe_ratio = [math]::Round([double](($rows | Measure-Object sharpe_ratio -Average).Average), 4)
    avg_max_drawdown_pct = [math]::Round([double](($rows | Measure-Object max_drawdown_pct -Average).Average), 4)
    avg_win_rate_pct = [math]::Round([double](($rows | Measure-Object win_rate_pct -Average).Average), 4)
    avg_total_trades = [math]::Round([double](($rows | Measure-Object total_trades -Average).Average), 2)
  }
}

$raw = @()
$totalRuns = $fillValues.Count * $fillValues.Count * $runsPerCombo
$runIndex = 0

foreach ($buy in $fillValues) {
  foreach ($sell in $fillValues) {
    for ($rep = 1; $rep -le $runsPerCombo; $rep++) {
      $runIndex += 1
      Write-Host ("[{0}/{1}] Running B{2}-S{3} repeat {4}/{5}" -f $runIndex, $totalRuns, $buy, $sell, $rep, $runsPerCombo)
      $raw += Invoke-FillRun -buyFill ([double]$buy) -sellFill ([double]$sell) -repeatIndex $rep
    }
  }
}

$summary = @(
  $raw |
    Group-Object combo |
    ForEach-Object {
      $rows = @($_.Group)
      Summarize-Combo -rows $rows
    }
)

$rankedByMean = @($summary | Sort-Object avg_total_return_pct -Descending)
$rankedByConfidence = @($summary | Sort-Object ci95_return_low -Descending)

$outRaw = 'tmp/pm_full_grid_repeats10_raw.json'
$outSummary = 'tmp/pm_full_grid_repeats10_summary.json'
$outRankMean = 'tmp/pm_full_grid_repeats10_ranked_mean.json'
$outRankConf = 'tmp/pm_full_grid_repeats10_ranked_ci_low.json'

$raw | ConvertTo-Json -Depth 8 | Set-Content -Path $outRaw -Encoding UTF8
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $outSummary -Encoding UTF8
$rankedByMean | ConvertTo-Json -Depth 8 | Set-Content -Path $outRankMean -Encoding UTF8
$rankedByConfidence | ConvertTo-Json -Depth 8 | Set-Content -Path $outRankConf -Encoding UTF8

Write-Host ''
Write-Host 'Top 10 by mean return:'
$rankedByMean | Select-Object -First 10 | Format-Table combo,runs,avg_total_return_pct,std_total_return_pct,ci95_return_low,ci95_return_high,avg_score -AutoSize | Out-String | Write-Host

Write-Host 'Top 10 by confidence floor (CI low):'
$rankedByConfidence | Select-Object -First 10 | Format-Table combo,runs,avg_total_return_pct,ci95_return_low,ci95_return_high,std_total_return_pct -AutoSize | Out-String | Write-Host

Write-Host "Saved: $outRaw"
Write-Host "Saved: $outSummary"
Write-Host "Saved: $outRankMean"
Write-Host "Saved: $outRankConf"
