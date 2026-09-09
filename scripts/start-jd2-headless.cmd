@echo off
rem Start JDownloader 2 with no GUI at all: no window, no tray icon, no clipboard
rem monitoring and no balloon notifications. -Djava.awt.headless=true is enough --
rem JDownloader gates all of that on GraphicsEnvironment.isHeadless().
rem
rem PowerDowner normally starts JD2 itself (config jd2.autoStart). This script is the
rem manual escape hatch. Stop it with scripts\stop-jd2.cmd -- there is no window to close.
rem
rem Trade-off: headless JD2 cannot show captcha dialogs. PowerDowner detects that and
rem hands those downloads to its own browser route instead.
setlocal
set "ROOT=%~dp0.."
set "JAVA=%ROOT%\tools\jre\bin\javaw.exe"
set "JAR=%ROOT%\tools\jd2\JDownloader.jar"

if not exist "%JAVA%" (
  echo [start-jd2-headless] JRE not found: %JAVA%
  echo                      Run: powershell -ExecutionPolicy Bypass -File scripts\fetch-tools.ps1
  pause
  exit /b 1
)
if not exist "%JAR%" (
  echo [start-jd2-headless] JDownloader.jar not found: %JAR%
  echo                      Run: powershell -ExecutionPolicy Bypass -File scripts\fetch-tools.ps1
  pause
  exit /b 1
)

cd /d "%ROOT%\tools\jd2"
start "JDownloader 2 (headless)" "%JAVA%" -Djava.awt.headless=true -Xmx1024m -jar "%JAR%"
echo [start-jd2-headless] launched. Nothing will appear on screen.
echo [start-jd2-headless] API check: http://127.0.0.1:3128/jd/version
echo [start-jd2-headless] first run auto-updates and can take a few minutes.
endlocal
