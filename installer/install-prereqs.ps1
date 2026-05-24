param(
    [switch]$InstallDockerDesktop
)

$ErrorActionPreference = 'Stop'

function Test-DockerAvailable {
    try {
        $null = & docker version 2>$null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

if (Test-DockerAvailable) {
    Write-Host 'Docker is already available.'
    exit 0
}

if (-not $InstallDockerDesktop) {
    Write-Host 'Docker is missing. Re-run the installer and choose the Docker Desktop task, or install it manually.'
    exit 1
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Start-Process 'https://www.docker.com/products/docker-desktop/'
    exit 1
}

Write-Host 'Installing Docker Desktop with winget...'
$arguments = @(
    'install'
    '-e'
    '--id'
    'Docker.DockerDesktop'
    '--accept-package-agreements'
    '--accept-source-agreements'
)

$process = Start-Process -FilePath winget -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) {
    Write-Host ("winget exited with code {0}." -f $process.ExitCode)
    exit $process.ExitCode
}

if (-not (Test-DockerAvailable)) {
    Write-Host 'Docker Desktop installed, but Docker is not ready yet. A reboot may be required.'
    exit 3010
}

Write-Host 'Docker Desktop is ready.'
exit 0
