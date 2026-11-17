$ErrorActionPreference='Stop'
$installRoot=Join-Path $env:LOCALAPPDATA 'CompanionMVP'
$settings=Get-Content -LiteralPath (Join-Path $installRoot 'settings.json') -Raw -Encoding UTF8|ConvertFrom-Json
$statusPath=Join-Path $settings.bridgeRoot 'data/status.json'
if(Test-Path -LiteralPath $statusPath){$status=Get-Content -LiteralPath $statusPath -Raw|ConvertFrom-Json;if($status.active -gt 0){throw '还有工作在执行，请等完成后再撤回接入。'}}
& (Join-Path $settings.bridgeRoot 'scripts/stop.ps1')
& $settings.nodePath --no-warnings (Join-Path $settings.appRoot 'scripts/check-detach.mjs') $settings.bridgeRoot
if($LASTEXITCODE -ne 0){& (Join-Path $settings.bridgeRoot 'scripts/start.ps1');throw '还有本地工作或回执尚未落地，本次没有撤回接入；原运行已恢复。'}
$mainPath=Join-Path $settings.bridgeRoot 'src/main.mjs'
$text=[IO.File]::ReadAllText($mainPath)
$utf8=New-Object Text.UTF8Encoding($false)
& $settings.nodePath --no-warnings (Join-Path $settings.appRoot 'scripts/patch-bridge.mjs') $mainPath --disable
if($LASTEXITCODE -ne 0){& (Join-Path $settings.bridgeRoot 'scripts/start.ps1');throw '兼容入口发生变化，本次未继续撤回。'}
$path=Join-Path $settings.bridgeRoot 'config.local.json'
$config=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
$config.PSObject.Properties.Remove('companion')
[IO.File]::WriteAllText($path,($config|ConvertTo-Json -Depth 40),$utf8)
& (Join-Path $settings.bridgeRoot 'scripts/start.ps1')
Write-Output '已恢复原桥接。登记资料、记忆与成果版本均保留在本机，未删除。'
