$ErrorActionPreference='Stop'
$installRoot=Join-Path $env:LOCALAPPDATA 'CompanionMVP'
$settingsPath=Join-Path $installRoot 'settings.json'
if(-not (Test-Path -LiteralPath $settingsPath)){& (Join-Path $PSScriptRoot 'install.ps1') -NoOpen}
$settings=Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8|ConvertFrom-Json
$healthy=$false
try{$check=Invoke-RestMethod -Uri 'http://127.0.0.1:47471/api/health' -TimeoutSec 3;$healthy=$check.ok -and $check.service -eq 'companion-workbench'}catch{}
if(-not $healthy){& (Join-Path $settings.bridgeRoot 'scripts/start.ps1');for($attempt=0;$attempt -lt 30;$attempt++){try{$check=Invoke-RestMethod -Uri 'http://127.0.0.1:47471/api/health' -TimeoutSec 2;if($check.ok -and $check.service -eq 'companion-workbench'){$healthy=$true;break}}catch{};Start-Sleep -Seconds 1}}
if(-not $healthy){throw '工作台暂未启动，请运行“诊断伴随.cmd”查看连接。'}
$tray=Join-Path $settings.appRoot 'scripts/tray.ps1'
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-STA','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$tray+'"')) -WindowStyle Hidden
& $settings.nodePath --no-warnings (Join-Path $settings.appRoot 'src/main.mjs')
