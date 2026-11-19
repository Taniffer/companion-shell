param([Parameter(Mandatory=$true)][string]$AppRoot)
$ErrorActionPreference='Stop'
$trayPath=[IO.Path]::GetFullPath((Join-Path $AppRoot 'scripts/tray.ps1'))
$escaped=[Regex]::Escape($trayPath)
$pattern='(?i)(?:^|\s)-File\s+(?:"'+$escaped+'"|'+$escaped+'(?:\s|$))'
$processes=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object {$_.CommandLine -match $pattern})
if(-not $processes.Count){return}
$signal=$null
try{
    $signal=[Threading.EventWaitHandle]::OpenExisting('Local\CompanionMVPTray.Stop')
    $signal.Set()|Out-Null
}catch [Threading.WaitHandleCannotBeOpenedException]{
    # The legacy tray has no shutdown channel. It can be replaced when no editor is open.
}finally{if($signal){$signal.Dispose()}}
foreach($item in $processes){
    $process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if(-not $process){continue}
    if($process.WaitForExit(2500)){continue}
    $verified=Get-CimInstance Win32_Process -Filter ('ProcessId='+$item.ProcessId) -ErrorAction SilentlyContinue
    if(-not $verified -or $verified.CommandLine -notmatch $pattern){continue}
    $process.Refresh()
    if($process.MainWindowHandle -ne 0){
        throw '记一下窗口仍在编辑或无法保存。请保留内容并关闭该窗口后更新。'
    }
    Stop-Process -Id $item.ProcessId -ErrorAction Stop
}
