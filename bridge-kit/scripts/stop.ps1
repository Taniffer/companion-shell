$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path (Join-Path $bridgeRoot 'data') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $bridgeRoot 'data/stop.flag') -Value 'Stopped by user'
$launcher = Join-Path $bridgeRoot 'launch.vbs'
$task = Get-ScheduledTask -TaskName 'Codex Feishu Bridge' -ErrorAction SilentlyContinue
if ($task -and @($task.Actions | Where-Object { $_.Arguments -eq ('"' + $launcher + '"') }).Count -eq 1) {
    Disable-ScheduledTask -InputObject $task | Out-Null
    Stop-ScheduledTask -InputObject $task
}
$statusPath = Join-Path $bridgeRoot 'data/status.json'
if (Test-Path -LiteralPath $statusPath) {
    $bridgeStatus = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($bridgeStatus.pid)" -ErrorAction SilentlyContinue
    if ($bridgeProcess -and $bridgeProcess.CommandLine -like ('*' + $bridgeRoot + '*src*main.mjs*')) {
        Stop-Process -Id $bridgeProcess.ProcessId -ErrorAction SilentlyContinue
    }
}
Write-Output '桥接已停止。start.cmd 可恢复；当前 stop.flag 会阻止登录时重启。'
