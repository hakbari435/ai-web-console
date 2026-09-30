@echo off
title AI Web Console - STOP
set PORT=3000

rem Find the process listening on the app port and kill it
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not %errorlevel%==0 (
    echo Server is not running - nothing to stop.
    ping -n 4 127.0.0.1 >nul
    exit /b 0
)

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    taskkill /f /pid %%p >nul 2>&1
)

echo Server stopped successfully.
ping -n 4 127.0.0.1 >nul
