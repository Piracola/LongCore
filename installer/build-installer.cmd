@echo off
rem ============================================================
rem LongCore 安装器一键构建:
rem   1. 前端构建 → bin\publish\WebRoot
rem   2. dotnet publish → bin\publish
rem   3. Inno Setup 编译 → installer\Output\LongCore-<ver>-setup.exe
rem 前置: Node 22 / .NET 8 SDK / Inno Setup 6 (iscc 在 PATH 或默认安装位置)
rem 可选: 把 WebView2 引导器与 .NET 8 桌面运行时离线包放到 installer\ 目录,
rem       文件名: MicrosoftEdgeWebview2Setup.exe / windowsdesktop-runtime-8.0-win-x64.exe
rem ============================================================
cd /d "%~dp0.." || exit /b 1

echo [1/3] Frontend build...
pushd JiaoLongControl\Client
call npm ci || (popd & goto :fail)
call npm run build || (popd & goto :fail)
popd

echo.
echo [2/3] Backend publish (framework-dependent, win-x64)...
"C:\Users\NullCola\.dotnet\dotnet.exe" publish JiaoLongControl\JiaoLongControl.csproj -c Release -r win-x64 --self-contained false -o bin\publish
if errorlevel 1 goto :fail

echo.
echo [3/3] Inno Setup compile...
set ISCC=iscc
where iscc >nul 2>nul || set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
    echo [HINT] Inno Setup 6 not found. winget install -e --id JRSoftware.InnoSetup --scope user
    goto :fail
)
rem 6.7+ 精简掉了简体中文语言文件, 缺失会导致编译中止
if not exist "%ISCC%\..\Languages\ChineseSimplified.isl" (
    echo [WARN] ChineseSimplified.isl missing - installer will build english-only or abort.
)
"%ISCC%" installer\LongCore.iss
if errorlevel 1 goto :fail

echo.
echo DONE: installer\Output\LongCore-setup.exe
pause
exit /b 0

:fail
echo.
echo [FAILED] See output above.
pause
exit /b 1
