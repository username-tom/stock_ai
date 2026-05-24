#define MyAppName "Stock AI"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "tomwu"
#define MyAppURL "https://github.com/tomwu/stock_ai"
#define MyAppExeName "StockAiLauncher.exe"

[Setup]
AppId={{F8A5F1C0-7B3F-4A8B-9E8C-31E0A5D6D9C1}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\Stock AI
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=no
OutputDir=..\dist\installer
OutputBaseFilename=StockAI-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
RestartIfNeededByRun=yes
UsePreviousAppDir=no
UninstallDisplayIcon={app}\launcher\{#MyAppExeName}

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: checkedonce
Name: "installprereqs"; Description: "Install Docker Desktop now (recommended)"; Flags: checkedonce

[Files]
Source: "..\docker-compose.yml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\backend\**"; DestDir: "{app}\backend"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "**\__pycache__\*;**\*.pyc;**\.venv\*;**\venv\*;**\.pytest_cache\*;**\tests\*"
Source: "..\frontend\**"; DestDir: "{app}\frontend"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "**\node_modules\*;**\dist\*;**\*.log;**\.vite\*"
Source: "..\launcher\StockAiLauncher\bin\Release\net8.0-windows\win-x64\publish\*"; DestDir: "{app}\launcher"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-prereqs.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion

[Icons]
Name: "{group}\Stock AI Launcher"; Filename: "{app}\launcher\{#MyAppExeName}"
Name: "{commondesktop}\Stock AI Launcher"; Filename: "{app}\launcher\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\install-prereqs.ps1"" -InstallDockerDesktop"; Description: "Install Docker Desktop now"; Tasks: installprereqs; Flags: postinstall nowait runhidden
Filename: "{app}\launcher\{#MyAppExeName}"; Description: "Launch Stock AI now"; Flags: postinstall nowait skipifsilent
