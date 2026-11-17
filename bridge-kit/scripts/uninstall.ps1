$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'stop.ps1')
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$task = Get-ScheduledTask -TaskName 'Codex Feishu Bridge' -ErrorAction SilentlyContinue
if ($task -and @($task.Actions | Where-Object { $_.Arguments -eq ('"' + (Join-Path $bridgeRoot 'launch.vbs') + '"') }).Count -eq 1) {
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
}
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Feishu Bridge.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
Write-Output '已取消登录自启动。程序、加密配置和会话数据保留，可自行备份或删除。'
