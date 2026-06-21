@echo off
setlocal
cd /d "%~dp0"
echo.
echo   DivX AVI Player - local server
echo   -------------------------------
echo   Serving:  %CD%
echo   URL:      http://localhost:8000/
echo.
echo   (The browser will open automatically. If not, open the URL above.)
echo   Press Ctrl+C in this window to stop the server.
echo.

start "" http://localhost:8000/

py -3 -m http.server 8000
if errorlevel 1 (
  echo py launcher failed; trying 'python'...
  python -m http.server 8000
)

endlocal
