@echo off
rem LongCore build - double-click me.
rem Opens an interactive menu. Optional CLI flags pass through to build.ps1.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
exit /b %errorlevel%
