@echo off
title Body Composition app - keep this window open
cd /d "%~dp0"

echo.
echo   Body Composition app
echo   --------------------
echo   Open http://localhost:8742 in Chrome once it says "running".
echo   Keep this window OPEN. Closing it stops the app.
echo.

:loop
node server.mjs
echo.
echo   Server stopped. Restarting in 3 seconds...
echo   (close this window if you meant to stop it)
timeout /t 3 /nobreak >nul
goto loop
