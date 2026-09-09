@echo off
rem Start JDownloader 2 with the portable JRE in tools\jre (no installation needed).
rem Keep the GUI running: captcha dialogs are shown there.
setlocal
set "ROOT=%~dp0.."
set "JAVA=%ROOT%\tools\jre\bin\javaw.exe"
set "JAR=%ROOT%\tools\jd2\JDownloader.jar"

if not exist "%JAVA%" (
  echo [start-jd2] JRE not found: %JAVA%
  echo             Run: powershell -ExecutionPolicy Bypass -File scripts\fetch-tools.ps1
  pause
  exit /b 1
)
if not exist "%JAR%" (
  echo [start-jd2] JDownloader.jar not found: %JAR%
  echo             Run: powershell -ExecutionPolicy Bypass -File scripts\fetch-tools.ps1
  pause
  exit /b 1
)

cd /d "%ROOT%\tools\jd2"
start "JDownloader 2" "%JAVA%" -Xmx1024m -jar "%JAR%"
echo [start-jd2] launched. API: http://127.0.0.1:3128/help
endlocal
