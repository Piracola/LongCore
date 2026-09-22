@echo off
rem LongCore build - double-click me.
rem Opens an interactive menu. Optional CLI flags pass through to build.ps1.
rem build.ps1 MUST stay UTF-8 with BOM so Windows PowerShell 5.1 can parse Chinese.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set "EC=%ERRORLEVEL%"
if not "%EC%"=="0" (
    echo.
    echo [FAILED] build.ps1 exited with code %EC%
    pause
)
exit /b %EC%
