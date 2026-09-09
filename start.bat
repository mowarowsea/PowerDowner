@echo off
rem Entry point for LocalLauncher.
rem
rem   command:     start.bat
rem   cwd:         C:/Users/seamo/PowerDowner
rem   health_url:  http://127.0.0.1:3939/api/health
rem   stop_command: scripts\stop-jd2.cmd      (only needed if the launcher hard-kills node)
rem
rem PowerDowner starts aria2 and JDownloader (headless) by itself and stops them again on
rem SIGINT/SIGTERM, so nothing else has to be registered with the launcher.
cd /d "%~dp0"
call npm start
