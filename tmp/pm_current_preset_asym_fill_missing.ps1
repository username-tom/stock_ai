$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:8000'
$outRaw = 'tmp/pm_current_preset_asym_raw.json'
$outRanked = 'tmp/pm_current_preset_asym_ranked.json'
$outPinnedBuy = 'tmp/pm_current_preset_asym_buy90_curve.json'
$outPinnedSell = 'tmp/pm_current_preset_asym_sell90_curve.json'
$outMeta = 'tmp/pm_current_preset_asym_meta.json'

if (-not (Test-Path $outRaw)) {
  throw "Missing $outRaw. Run initial sweep first."
}
if (-not (Test-Path $outMeta)) {
  throw "Missing $outMeta. Run initial sweep first."
}

$existing = @()
$rawText = Get-Content -Path $outRaw -Raw
if (-not [string]::IsNullOrWhiteSpace($rawText)) {
  $parsed = $rawText | ConvertFrom-Json
  if ($parsed -is [System.Array]) {
    $existing = @($parsed)
  }
  elseif ($null -ne $parsed) {
    $existing = @($parsed)
  }
}

$meta = (Get-Content -Path $outMeta -Raw | ConvertFrom-Json)
$reportId = [int]$meta.baseline_report_id
$report = Invoke-RestMethod -Uri "$baseUrl/api/backtest/reports/$reportId"
$state = Invoke-RestMethod -Uri "$baseUrl/api/sandbox/manager/state"
$current = $state.settings

$symbols = @($report.parameters.symbols)
if ($symbols.Count -eq 0) {
  throw "Report $reportId does not include parameters.symbols"
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

$fillValues = @(90, 80, 70, 60, 50, 40)
$allPairs = @()
foreach ($b in $fillValues) {
  foreach ($s in $fillValues) {
    $allPairs += [pscustomobject]@{ buy = [double]$b; sell = [double]$s }
  }
}

$existingMap = @{}
foreach ($r in $existing) {
  $key = "B$([int]$r.buy_fill_pct)-S$([int]$r.sell_fill_pct)"
  $existingMap[$key] = $true
}

$missingPairs = @()
foreach ($p in $allPairs) {
  $key = "B$([int]$p.buy)-S$([int]$p.sell)"
  if (-not $existingMap.ContainsKey($key)) {
    $missingPairs += $p
  }
}

Write-Host "Existing cells: $($existing.Count)"
Write-Host "Missing cells to run: $($missingPairs.Count)"

function Invoke-FillRun([double]$buyFill, [double]$sellFill) {
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
    profile = ("grid_b{0}_s{1}" -f [int]$buyFill, [int]$sellFill)
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

$newRows = @()
foreach ($p in $missingPairs) {
  Write-Host ("Running missing cell B{0}-S{1}" -f [int]$p.buy, [int]$p.sell)
  $newRows += Invoke-FillRun -buyFill $p.buy -sellFill $p.sell
}

$combined = @($existing + $newRows)
$combined = @(
  $combined |
    Sort-Object -Property @{ Expression = 'buy_fill_pct'; Descending = $true }, @{ Expression = 'sell_fill_pct'; Descending = $true }
)

$ranked = @($combined | Sort-Object score -Descending)

$buyPinned = @(
  $combined |
    Where-Object { $_.buy_fill_pct -eq 90 -and $_.sell_fill_pct -ne 90 } |
    Sort-Object sell_fill_pct -Descending |
    ForEach-Object {
      [pscustomobject]@{
        sell_fill_pct = $_.sell_fill_pct
        total_return_pct = $_.total_return_pct
        sharpe_ratio = $_.sharpe_ratio
        max_drawdown_pct = $_.max_drawdown_pct
        score = $_.score
      }
    }
)

$sellPinned = @(
  $combined |
    Where-Object { $_.sell_fill_pct -eq 90 -and $_.buy_fill_pct -ne 90 } |
    Sort-Object buy_fill_pct -Descending |
    ForEach-Object {
      [pscustomobject]@{
        buy_fill_pct = $_.buy_fill_pct
        total_return_pct = $_.total_return_pct
        sharpe_ratio = $_.sharpe_ratio
        max_drawdown_pct = $_.max_drawdown_pct
        score = $_.score
      }
    }
)

$combined | ConvertTo-Json -Depth 8 | Set-Content -Path $outRaw -Encoding UTF8
$ranked | ConvertTo-Json -Depth 8 | Set-Content -Path $outRanked -Encoding UTF8
$buyPinned | ConvertTo-Json -Depth 8 | Set-Content -Path $outPinnedBuy -Encoding UTF8
$sellPinned | ConvertTo-Json -Depth 8 | Set-Content -Path $outPinnedSell -Encoding UTF8

[pscustomobject]@{
  generated_at = (Get-Date).ToString('s')
  baseline_report_id = [int]$reportId
  baseline_name = [string]$report.name
  start_date = $startDate
  end_date = $endDate
  symbols = $symbols
  initial_capital = $initialCapital
  run_count = $combined.Count
  pm_settings_used = [pscustomobject]@{
    stop_loss_pct = [double]$current.stop_loss_pct
    take_profit_pct = [double]$current.take_profit_pct
    hold_positions_overnight = [bool]$current.hold_positions_overnight
    sentiment_bucket_persistence = [int]$current.sentiment_bucket_persistence
    market_sentiment_strategies = $current.market_sentiment_strategies
  }
} | ConvertTo-Json -Depth 10 | Set-Content -Path $outMeta -Encoding UTF8

Write-Host "Added new cells: $($newRows.Count)"
Write-Host "Total cells now: $($combined.Count)"
Write-Host "Saved: $outRaw"
Write-Host "Saved: $outRanked"
Write-Host "Saved: $outPinnedBuy"
Write-Host "Saved: $outPinnedSell"
Write-Host "Saved: $outMeta"
