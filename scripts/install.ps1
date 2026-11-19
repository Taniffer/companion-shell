param([string]$BridgeRoot,[switch]$NoOpen,[switch]$KeepNativeSessions,[ValidateRange(1024,65535)][int]$UiPort=47471,[ValidateRange(1024,65535)][int]$MobilePort=47472)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$installRoot=Join-Path $env:LOCALAPPDATA 'CompanionMVP'
$appRoot=Join-Path $installRoot 'app'
$dataRoot=Join-Path $installRoot 'data'
if (-not $BridgeRoot) {
    $existing=Get-ScheduledTask -TaskName 'Codex Feishu Bridge' -ErrorAction SilentlyContinue
    if ($existing) { $BridgeRoot=@($existing.Actions)[0].WorkingDirectory }
}
if (-not $BridgeRoot) { throw '请先配置现有的 Codex 飞书桥接，或用 -BridgeRoot 指定目录。' }
$BridgeRoot=[IO.Path]::GetFullPath($BridgeRoot)
$bridgeMain=Join-Path $BridgeRoot 'src/main.mjs'
$bridgeConfig=Join-Path $BridgeRoot 'config.local.json'
$node=Join-Path $BridgeRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node=(Get-Command node.exe -ErrorAction Stop).Source }
foreach ($path in @($bridgeMain,$bridgeConfig,(Join-Path $BridgeRoot 'scripts/start.ps1'),(Join-Path $BridgeRoot 'scripts/stop.ps1'))) { if (-not (Test-Path -LiteralPath $path)) { throw '指定目录不是已配置的 Codex 飞书桥接。' } }
$dependenciesReady=$true
$requiredDependencies=(Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json).dependencies
foreach($dependency in $requiredDependencies.PSObject.Properties){$installedPackage=Join-Path $sourceRoot ('node_modules/'+$dependency.Name+'/package.json');if(-not(Test-Path -LiteralPath $installedPackage)){$dependenciesReady=$false;break};try{if((Get-Content -LiteralPath $installedPackage -Raw -Encoding UTF8|ConvertFrom-Json).version -ne $dependency.Value){$dependenciesReady=$false;break}}catch{$dependenciesReady=$false;break}}
if (-not $dependenciesReady) { Push-Location $sourceRoot;try { & npm.cmd ci --omit=dev --no-fund;if($LASTEXITCODE -ne 0){throw '依赖安装未完成。'} } finally { Pop-Location } }
$backupRoot=Join-Path $installRoot ('backups/'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backupRoot -Force|Out-Null
if(Test-Path -LiteralPath (Join-Path $appRoot 'src/addon.mjs')){Copy-Item -LiteralPath $appRoot -Destination (Join-Path $backupRoot 'app') -Recurse -Force}
if(Test-Path -LiteralPath (Join-Path $installRoot 'settings.json')){Copy-Item -LiteralPath (Join-Path $installRoot 'settings.json') -Destination (Join-Path $backupRoot 'settings.json')}
# Wait for current work instead of interrupting the user's running requests.
$deadline=(Get-Date).AddMinutes(10)
while (-not $KeepNativeSessions -and (Get-Date) -lt $deadline) {
    $statusPath=Join-Path $BridgeRoot 'data/status.json'
    $active=0
    if(Test-Path -LiteralPath $statusPath){try{$active=(Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8|ConvertFrom-Json).active}catch{$active=1}}
    if($active -eq 0){break}
    Write-Output '等待当前飞书工作完成，再接入工作台……'
    Start-Sleep -Seconds 5
}
if($KeepNativeSessions){$active=0;Write-Output '保留 Codex 原生会话，仅重启本机桥接；仍需按原生规则完成授权。'}
if($active -ne 0){throw '现有工作仍在执行，本次没有停止桥接。稍后重新运行安装即可。'}
Copy-Item -LiteralPath $bridgeMain -Destination (Join-Path $backupRoot 'main.mjs')
Copy-Item -LiteralPath $bridgeConfig -Destination (Join-Path $backupRoot 'config.local.json')
$originalMain=[IO.File]::ReadAllText($bridgeMain)
$config=Get-Content -LiteralPath $bridgeConfig -Raw -Encoding UTF8|ConvertFrom-Json
$pattern='(?m)^const bridge\s*=\s*new Bridge\([^\r\n]+\);\r?$'
if(-not $originalMain.Contains('// BEGIN COMPANION_MVP_ADDON') -and -not [regex]::IsMatch($originalMain,$pattern)){throw '现有桥接入口发生变化，未修改原文件；需要更新兼容接入。'}
& (Join-Path $PSScriptRoot 'stop-tray.ps1') -AppRoot $appRoot
& (Join-Path $BridgeRoot 'scripts/stop.ps1')
# Copy the whole personal data set only after all writers are stopped.
if(Test-Path -LiteralPath $dataRoot){Copy-Item -LiteralPath $dataRoot -Destination (Join-Path $backupRoot 'data') -Recurse -Force}
try {
New-Item -ItemType Directory -Path $appRoot,$dataRoot -Force | Out-Null
$sameSource=[IO.Path]::GetFullPath($sourceRoot).TrimEnd('\') -eq [IO.Path]::GetFullPath($appRoot).TrimEnd('\')
if (-not $sameSource) {
    foreach ($directory in @('src','web','scripts','node_modules','dist','docs','vendor')) { $path=Join-Path $sourceRoot $directory;if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination $appRoot -Recurse -Force} }
    foreach ($name in @('package.json','package-lock.json','README.md','LICENSE','NOTICE.md')) { $path=Join-Path $sourceRoot $name;if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination (Join-Path $appRoot $name) -Force} }
}
$settings=@{bridgeRoot=$BridgeRoot;dataDir=$dataRoot;nodePath=$node;appRoot=$appRoot}
$utf8=New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $installRoot 'settings.json'),($settings|ConvertTo-Json -Depth 10),$utf8)
[IO.File]::WriteAllText((Join-Path $appRoot 'companion.local.json'),($settings|ConvertTo-Json -Depth 10),$utf8)

    foreach($name in @('bridge.sqlite','bridge.sqlite-wal','bridge.sqlite-shm')){$path=Join-Path $BridgeRoot ('data/'+$name);if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination (Join-Path $backupRoot $name)}}
    & $node --no-warnings (Join-Path $appRoot 'scripts/patch-bridge.mjs') $bridgeMain
    if($LASTEXITCODE -ne 0){throw '桥接兼容接入没有完成。'}
    $addon=@{module=(Join-Path $appRoot 'src/addon.mjs');dataDir=$dataRoot;uiPort=$UiPort;mobilePort=$MobilePort;mobileHost='0.0.0.0'}
    $config|Add-Member -NotePropertyName companion -NotePropertyValue $addon -Force
    [IO.File]::WriteAllText($bridgeConfig,($config|ConvertTo-Json -Depth 40),$utf8)
    & $node --check $bridgeMain
    if($LASTEXITCODE -ne 0){throw '桥接入口验证未通过。'}
    & (Join-Path $BridgeRoot 'scripts/start.ps1')
    $ready=$false
    for($attempt=0;$attempt -lt 45;$attempt++){
        try{$health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$UiPort+'/api/health') -TimeoutSec 2;if($health.ok -and $health.service -eq 'companion-workbench'){$ready=$true;break}}catch{}
        Start-Sleep -Seconds 1
    }
    if(-not $ready){throw '工作台尚未成功启动。'}
    Write-Output '伴随工作台已接入；原飞书会话、配对和登录启动设置已保留。'
    if(-not $NoOpen){& $node --no-warnings (Join-Path $appRoot 'src/main.mjs')}
} catch {
    $message=$_.Exception.Message
    & (Join-Path $BridgeRoot 'scripts/stop.ps1')
    Copy-Item -LiteralPath (Join-Path $backupRoot 'main.mjs') -Destination $bridgeMain -Force
    Copy-Item -LiteralPath (Join-Path $backupRoot 'config.local.json') -Destination $bridgeConfig -Force
    # V2 adds tables without removing prior data. Keep any newly committed mobile records on rollback.
    # The cold data snapshot remains available in the backup for explicit disaster recovery.
    $previousApp=Join-Path $backupRoot 'app'
    if(Test-Path -LiteralPath $previousApp){foreach($item in Get-ChildItem -LiteralPath $previousApp -Force){Copy-Item -LiteralPath $item.FullName -Destination $appRoot -Recurse -Force}}
    if(Test-Path -LiteralPath (Join-Path $backupRoot 'settings.json')){Copy-Item -LiteralPath (Join-Path $backupRoot 'settings.json') -Destination (Join-Path $installRoot 'settings.json') -Force}
    $restoreConfig=Get-Content -LiteralPath $bridgeConfig -Raw -Encoding UTF8|ConvertFrom-Json
    if($restoreConfig.companion){& $node --no-warnings (Join-Path $sourceRoot 'scripts/patch-bridge.mjs') $bridgeMain}else{& $node --no-warnings (Join-Path $sourceRoot 'scripts/patch-bridge.mjs') $bridgeMain --disable}
    & (Join-Path $BridgeRoot 'scripts/start.ps1')
    throw ('接入没有完成，原桥接已恢复：'+$message)
}
