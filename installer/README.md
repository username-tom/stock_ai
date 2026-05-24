# Windows Installer

This folder contains the Windows wizard installer for Stock AI.

## What it does

- Installs the repo files into `Program Files\Stock AI`
- Places the self-contained launcher in `launcher\StockAiLauncher.exe`
- Adds Start Menu and optional desktop shortcuts
- Can trigger a Docker Desktop install using `winget`
- The launcher starts Docker Desktop if it is installed but not running
- The launcher checks GitHub releases and supports auto-update or manual-update mode

## Build order

1. Publish the launcher:

```powershell
dotnet publish launcher/StockAiLauncher/StockAiLauncher.csproj -c Release -r win-x64 --self-contained true
```

2. Open `installer/StockAI.iss` in Inno Setup and compile it, or run `installer/build.ps1`.

The installer expects the published launcher output at:

`launcher/StockAiLauncher/bin/Release/net8.0-windows/win-x64/publish/`

If Inno Setup is installed in the default location, `installer/build.ps1` will compile the wizard automatically after publishing the launcher.
