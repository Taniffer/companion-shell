param([switch]$NoStart, [switch]$NoConfigure, [switch]$InPlace)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$installRoot = if ($InPlace) { $packageRoot } else { Join-Path $env:LOCALAPPDATA 'CodexFeishuBridge' }
if ($installRoot -ne $packageRoot) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    foreach ($entry in @('src','scripts','skills','.codex-plugin','runtime','node_modules','package.json','package-lock.json','README.md','INSTALL.md','configure.cmd','start.cmd','stop.cmd')) {
        $source = Join-Path $packageRoot $entry
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $installRoot -Recurse -Force }
    }
}
$nodePath = Join-Path $installRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
& $nodePath (Join-Path $installRoot 'src/setup.mjs')
if ($LASTEXITCODE -ne 0) { throw '首次安装需由 Codex 桌面端运行，以获得桌面连接配置。' }
if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'node_modules/@larksuiteoapi/node-sdk'))) {
    Push-Location $installRoot
    try { & npm.cmd ci --ignore-scripts; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' } } finally { Pop-Location }
}
New-Item -ItemType Directory -Path (Join-Path $installRoot 'data') -Force | Out-Null
$launcherPath = Join-Path $installRoot 'launch.vbs'
$quotedNode = $nodePath.Replace('"','""')
$quotedMain = (Join-Path $installRoot 'src/main.mjs').Replace('"','""')
$quotedRoot = $installRoot.Replace('"','""')
$launcher = @"
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = "$quotedRoot"
If files.FileExists("$quotedRoot\data\stop.flag") Then WScript.Quit 0
shell.Run "explorer.exe codex://", 0, False
delay = 2000
Do While Not files.FileExists("$quotedRoot\data\stop.flag")
  started = Timer
  result = shell.Run(Chr(34) & "$quotedNode" & Chr(34) & " --no-warnings " & Chr(34) & "$quotedMain" & Chr(34), 0, True)
  If result = 42 Then WScript.Quit 0
  RecordExit result
  If files.FileExists("$quotedRoot\data\stop.flag") Then WScript.Quit 0
  If Timer - started > 120 Then delay = 2000
  WScript.Sleep delay
  If delay < 60000 Then delay = delay * 2
Loop
Sub RecordExit(code)
  On Error Resume Next
  logPath = "$quotedRoot\logs\guardian.log"
  If files.FileExists(logPath) Then
    If files.GetFile(logPath).Size > 2000000 Then
      If files.FileExists(logPath & ".1") Then files.DeleteFile logPath & ".1"
      files.MoveFile logPath, logPath & ".1"
    End If
  End If
  Set output = files.OpenTextFile(logPath, 8, True)
  output.WriteLine CStr(Now) & " child_exit=" & CStr(code)
  output.Close
End Sub
"@
[IO.File]::WriteAllText($launcherPath,$launcher,[Text.Encoding]::Unicode)
& (Join-Path $installRoot 'scripts/register-autostart.ps1')
if (-not $NoConfigure) { & (Join-Path $installRoot 'scripts/configure.ps1') }
if (-not $NoStart) { & (Join-Path $installRoot 'scripts/start.ps1') }
Write-Output "Installed: $installRoot"
Write-Output '已配置登录自动启动和每分钟恢复；守护进程退出后由 Windows 重新拉起。'
