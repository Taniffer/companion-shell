$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$stopFlag = Join-Path $bridgeRoot 'data/stop.flag'
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag }
$launcher = Join-Path $bridgeRoot 'launch.vbs'
if (-not (Test-Path -LiteralPath $launcher)) { throw '请先通过 Codex 运行 scripts/install.ps1' }
$task = Get-ScheduledTask -TaskName 'Codex Feishu Bridge' -ErrorAction SilentlyContinue
if ($task -and @($task.Actions | Where-Object { $_.Arguments -eq ('"' + $launcher + '"') }).Count -eq 1) {
    Enable-ScheduledTask -InputObject $task | Out-Null
    Start-ScheduledTask -InputObject $task
} else {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $launcher + '"') -WindowStyle Hidden
}
Write-Output '桥接已启动。'
