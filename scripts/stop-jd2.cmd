@echo off
rem Stop JDownloader 2. A headless instance has no window and no tray icon, so the only
rem ways in are the local API and the PID. Try exitJD first (that also reaches a JD2 that
rem PowerDowner lost track of after a hard kill), then fall back to the recorded PID.
setlocal
set "PIDFILE=%~dp0..\data\jd2.pid"
powershell -NoProfile -Command "$api = 'http://127.0.0.1:3128'; try { Invoke-WebRequest -Uri ($api + '/system/exitJD') -TimeoutSec 10 -UseBasicParsing | Out-Null; Write-Host '[stop-jd2] exitJD sent' } catch { Write-Host '[stop-jd2] local API did not answer' }; $gone = $false; for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 1; try { Invoke-WebRequest -Uri ($api + '/jd/version') -TimeoutSec 3 -UseBasicParsing | Out-Null } catch { $gone = $true; break } }; if ($gone) { Write-Host '[stop-jd2] JDownloader stopped'; exit 0 }; $f = '%PIDFILE%'; if (Test-Path $f) { $p = (Get-Content $f -Raw).Trim(); if ($p) { Write-Host ('[stop-jd2] still up, killing PID ' + $p); Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue } } else { Write-Host '[stop-jd2] no PID file; kill javaw.exe by hand if it is still running' }"
endlocal
