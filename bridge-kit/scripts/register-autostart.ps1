$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'Codex Feishu Bridge'
$launcherPath = Join-Path $bridgeRoot 'launch.vbs'
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and @($existing.Actions | Where-Object { $_.Arguments -eq ('"' + $launcherPath + '"') }).Count -ne 1) {
    throw 'A different bridge installation already owns this scheduled task.'
}
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32/wscript.exe') -Argument ('"' + $launcherPath + '"') -WorkingDirectory $bridgeRoot
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $taskUser),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Restores the local Codex Feishu bridge every minute while the user is logged in.' -Force | Out-Null
# Explicit start enables the task, so install -NoStart never starts it later.
Disable-ScheduledTask -TaskName $taskName | Out-Null
# Replace only this installation's old login shortcut.
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Feishu Bridge.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    if ($shortcut.Arguments -eq ('"' + $launcherPath + '"')) { Remove-Item -LiteralPath $shortcutPath }
}
Write-Output 'Registered login startup and one-minute recovery in Windows Task Scheduler.'
