@echo off
title AI Web Console  -  http://127.0.0.1:3000
cd /d "%~dp0"

rem If the server is already running, just open the browser (with a visible message)
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Server is already running - opening browser...
    echo To stop the server, run off.bat
    start "" "http://127.0.0.1:3000"
    ping -n 4 127.0.0.1 >nul
    exit /b 0
)

rem Install dependencies on first run
if not exist "node_modules" (
    echo First run - installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed.
        pause
        exit /b 1
    )
)

rem Open the browser after ~2 seconds (server runs in this window)
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://127.0.0.1:3000"

echo AI Web Console running at:  http://127.0.0.1:3000
echo Close this window or run off.bat to stop.
echo.
node server\index.js
echo.
echo Server stopped.
pause
