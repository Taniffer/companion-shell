param([string]$ScratchRoot)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
if(-not $ScratchRoot){$ScratchRoot=Join-Path $sourceRoot ('test/.runtime/install-'+[guid]::NewGuid().ToString('N'))}
$ScratchRoot=[IO.Path]::GetFullPath($ScratchRoot)
$allowedRoot=[IO.Path]::GetFullPath((Join-Path $sourceRoot 'test/.runtime')).TrimEnd('\')+'\'
if(-not $ScratchRoot.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Scratch must stay inside test/.runtime'}
$savedLocalAppData=$env:LOCALAPPDATA
$utf8=New-Object Text.UTF8Encoding($false)
function Write-TestFile($Path,$Text){[IO.File]::WriteAllText($Path,$Text,$utf8)}
function New-TestBridge($Name,$FailNew){
    $caseRoot=Join-Path $ScratchRoot $Name
    $bridgeRoot=Join-Path $caseRoot 'bridge'
    New-Item -ItemType Directory -Path (Join-Path $bridgeRoot 'src'),(Join-Path $bridgeRoot 'scripts'),(Join-Path $bridgeRoot 'data'),(Join-Path $caseRoot 'local/CompanionMVP/data') -Force|Out-Null
    $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
    $config=@{feishu=@{appId='cli_fixture';ownerOpenId='fixture-owner'};fixturePort=$port;fixtureFailNew=$FailNew}
    Write-TestFile (Join-Path $bridgeRoot 'config.local.json') ($config|ConvertTo-Json -Depth 5)
    Write-TestFile (Join-Path $bridgeRoot 'data/status.json') '{"active":0}'
    Write-TestFile (Join-Path $bridgeRoot 'src/main.mjs') "class Bridge{}`nconst bridge = new Bridge({});`n"
    Write-TestFile (Join-Path $bridgeRoot 'fixture-http.mjs') "import http from 'node:http';http.createServer((q,s)=>{s.setHeader('Content-Type','application/json');s.end(JSON.stringify({ok:true,service:'companion-workbench',version:'fixture'}));}).listen(Number(process.argv[2]),'127.0.0.1');"
    Write-TestFile (Join-Path $bridgeRoot 'scripts/start.ps1') @'
$ErrorActionPreference='Stop'
$fixtureRoot=Split-Path -Parent $PSScriptRoot
$fixtureConfig=Get-Content -LiteralPath (Join-Path $fixtureRoot 'config.local.json') -Raw|ConvertFrom-Json
if($fixtureConfig.companion -and $fixtureConfig.fixtureFailNew){throw 'Injected new-version startup failure'}
$fixtureNode=(Get-Command node.exe).Source
$fixtureProcess=Start-Process -FilePath $fixtureNode -ArgumentList @((Join-Path $fixtureRoot 'fixture-http.mjs'),[string]$fixtureConfig.fixturePort) -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'fixture.pid'),[string]$fixtureProcess.Id)
'@
    Write-TestFile (Join-Path $bridgeRoot 'scripts/stop.ps1') @'
$fixtureRoot=Split-Path -Parent $PSScriptRoot
$fixturePidPath=Join-Path $fixtureRoot 'fixture.pid'
if(Test-Path -LiteralPath $fixturePidPath){$fixtureProcessId=[int][IO.File]::ReadAllText($fixturePidPath);$fixtureProcess=Get-Process -Id $fixtureProcessId -ErrorAction SilentlyContinue;if($fixtureProcess -and $fixtureProcess.ProcessName -eq 'node'){$fixtureProcess|Stop-Process -Force}}
'@
    $env:LOCALAPPDATA=Join-Path $caseRoot 'local'
    $sentinel=Join-Path $env:LOCALAPPDATA 'CompanionMVP/data/retained.txt';Write-TestFile $sentinel 'CAPTURE_AND_MEMORY_MUST_SURVIVE'
    return @{bridge=$bridgeRoot;port=$port;sentinel=$sentinel;caseRoot=$caseRoot}
}
try{
    $success=New-TestBridge 'success' $false
    try{& (Join-Path $sourceRoot 'scripts/install.ps1') -BridgeRoot $success.bridge -NoOpen -UiPort $success.port -MobilePort ($success.port+1)
      if([IO.File]::ReadAllText($success.sentinel) -ne 'CAPTURE_AND_MEMORY_MUST_SURVIVE'){throw 'Data changed'}
      $backups=@(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'CompanionMVP/backups') -Directory)
      if(-not(Test-Path -LiteralPath (Join-Path $backups[0].FullName 'data/retained.txt'))){throw 'Cold data backup absent'}
      Write-Output 'PASS: real Windows installer, isolated successful install and cold data backup.'
    }finally{& (Join-Path $success.bridge 'scripts/stop.ps1')}
    $failure=New-TestBridge 'failure' $true
    try{$failed=$false;try{& (Join-Path $sourceRoot 'scripts/install.ps1') -BridgeRoot $failure.bridge -NoOpen -UiPort $failure.port -MobilePort ($failure.port+1)}catch{$failed=$true}
      if(-not $failed){throw 'Injected failure was not detected'}
      $restored=Get-Content -LiteralPath (Join-Path $failure.bridge 'config.local.json') -Raw|ConvertFrom-Json
      if($restored.companion){throw 'Configuration was not restored'}
      if([IO.File]::ReadAllText($failure.sentinel) -ne 'CAPTURE_AND_MEMORY_MUST_SURVIVE'){throw 'Rollback lost data'}
      Start-Sleep -Seconds 1
      $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$failure.port+'/api/health') -TimeoutSec 5
      if(-not $health.ok){throw 'Original fixture process was not restored'}
      Write-Output 'PASS: injected startup failure restored configuration, original process and retained data.'
    }finally{& (Join-Path $failure.bridge 'scripts/stop.ps1')}
}finally{$env:LOCALAPPDATA=$savedLocalAppData}
