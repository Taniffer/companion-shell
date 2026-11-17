@echo off
powershell.exe -NoProfile -Command "$s=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'CompanionMVP/settings.json') -Raw -Encoding UTF8|ConvertFrom-Json; & $s.nodePath --no-warnings (Join-Path $s.appRoot 'src/doctor.mjs')"
pause
