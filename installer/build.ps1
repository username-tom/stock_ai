param(
    [switch]$SkipInstallerCompile
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcherProject = Join-Path $repoRoot 'launcher\StockAiLauncher\StockAiLauncher.csproj'
$installerScript = Join-Path $PSScriptRoot 'StockAI.iss'

Write-Host 'Publishing launcher...'
dotnet publish $launcherProject -c Release -r win-x64 --self-contained true | Out-Host

if ($SkipInstallerCompile) {
    Write-Host 'Skipping installer compilation.'
    exit 0
}

$isccPath = $null
$cmd = Get-Command iscc.exe -ErrorAction SilentlyContinue
if ($cmd) {
    $isccPath = $cmd.Source
}

if (-not $isccPath) {
    $candidate = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    if (Test-Path $candidate) {
        $isccPath = $candidate
    }
}

if (-not $isccPath) {
    Write-Host 'Inno Setup compiler not found. Install Inno Setup or pass -SkipInstallerCompile.'
    exit 1
}

Write-Host 'Compiling installer...'
$process = Start-Process -FilePath $isccPath -ArgumentList @($installerScript) -Wait -PassThru -NoNewWindow
if ($process.ExitCode -ne 0) {
    exit $process.ExitCode
}
