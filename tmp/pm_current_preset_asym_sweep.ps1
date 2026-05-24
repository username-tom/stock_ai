$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:8000'

function Get-LatestReportId {
  $reportsResp = Invoke-RestMethod -Uri "$baseUrl/api/backtest/reports"
  $reports = @()

  if ($reportsResp -is [System.Array]) {
    $reports = @($reportsResp)
  }
  elseif ($null -ne $reportsResp.reports) {
    $reports = @($reportsResp.reports)
  }

  if ($reports.Count -eq 0) {
    throw 'No backtest reports found. Run at least one sandbox backtest first.'
  }

  return [int](($reports | Sort-Object id -Descending | Select-Object -First 1).id)
}

$reportId = Get-LatestReportId
Write-Host "Using baseline report id: $reportId"

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

Write-Host 'Current PM preset (kept unchanged for this sweep):'
Write-Host ("  market_sentiment_strategies: {0}" -f (($current.market_sentiment_strategies | ConvertTo-Json -Compress)))
Write-Host ("  stop_loss_pct={0}, take_profit_pct={1}, hold_positions_overnight={2}, sentiment_bucket_persistence={3}" -f $current.stop_loss_pct, $current.take_profit_pct, $current.hold_positions_overnight, $current.sentiment_bucket_persistence)

$profiles = @(
  @{ name='sym_b90_s90'; buy=90; sell=90 },
  @{ name='asym_b80_s90'; buy=80; sell=90 },
  @{ name='asym_b70_s90'; buy=70; sell=90 },
  @{ name='asym_b60_s90'; buy=60; sell=90 },
  @{ name='asym_b50_s90'; buy=50; sell=90 },
  @{ name='asym_b40_s90'; buy=40; sell=90 },
  @{ name='asym_b90_s80'; buy=90; sell=80 },
  @{ name='asym_b90_s70'; buy=90; sell=70 },
  @{ name='asym_b90_s60'; buy=90; sell=60 },
  @{ name='asym_b90_s50'; buy=90; sell=50 },
  @{ name='asym_b90_s40'; buy=90; sell=40 },
  @{ name='asym_b80_s60'; buy=80; sell=60 },
  @{ name='asym_b60_s80'; buy=60; sell=80 }
)

function Invoke-FillRun([double]$buyFill, [double]$sellFill, [string]$profileName) {
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
    profile = $profileName
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

$raw = @()

foreach ($p in $profiles) {
  Write-Host ("Running profile={0} buy={1} sell={2}" -f $p.name, $p.buy, $p.sell)
  $raw += Invoke-FillRun -buyFill ([double]$p.buy) -sellFill ([double]$p.sell) -profileName ([string]$p.name)
}

$ranked = @($raw | Sort-Object score -Descending)

$buyPinned = @(
  $raw |
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
  $raw |
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

$outRaw = 'tmp/pm_current_preset_asym_raw.json'
$outRanked = 'tmp/pm_current_preset_asym_ranked.json'
$outPinnedBuy = 'tmp/pm_current_preset_asym_buy90_curve.json'
$outPinnedSell = 'tmp/pm_current_preset_asym_sell90_curve.json'
$outMeta = 'tmp/pm_current_preset_asym_meta.json'

$raw | ConvertTo-Json -Depth 8 | Set-Content -Path $outRaw -Encoding UTF8
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
  run_count = $raw.Count
  pm_settings_used = [pscustomobject]@{
    stop_loss_pct = [double]$current.stop_loss_pct
    take_profit_pct = [double]$current.take_profit_pct
    hold_positions_overnight = [bool]$current.hold_positions_overnight
    sentiment_bucket_persistence = [int]$current.sentiment_bucket_persistence
    market_sentiment_strategies = $current.market_sentiment_strategies
  }
} | ConvertTo-Json -Depth 10 | Set-Content -Path $outMeta -Encoding UTF8

Write-Host ''
Write-Host 'Top profiles by score:'
$ranked | Select-Object -First 8 | Format-Table profile,buy_fill_pct,sell_fill_pct,total_return_pct,sharpe_ratio,max_drawdown_pct,win_rate_pct,total_trades,score -AutoSize | Out-String | Write-Host

Write-Host "Saved: $outRaw"
Write-Host "Saved: $outRanked"
Write-Host "Saved: $outPinnedBuy"
Write-Host "Saved: $outPinnedSell"
Write-Host "Saved: $outMeta"
