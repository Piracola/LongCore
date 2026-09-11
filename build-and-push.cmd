@echo off
rem LongCore M0: build backend + push to Piracola/LongCore
rem Run this from YOUR OWN terminal (double-click also works).
setlocal
cd /d "%~dp0"

rem 兜底: 个别宿主环境(无 SystemRoot/PROGRAMDATA)会让 NuGet 恢复直接崩溃
if not defined SystemRoot set "SystemRoot=C:\Windows"
if not defined windir set "windir=C:\Windows"
if not defined PROGRAMDATA set "PROGRAMDATA=C:\ProgramData"

rem Prefer user-level dotnet, fall back to PATH
set "DOTNET=C:\Users\NullCola\.dotnet\dotnet.exe"
if not exist "%DOTNET%" set "DOTNET=dotnet"

echo ============================================
echo  [1/4] Backend build (dotnet build Release)
echo ============================================
"%DOTNET%" build JiaoLongControl\JiaoLongControl.csproj -c Release
if errorlevel 1 (
    echo.
    echo [FAILED] Backend build failed. Paste the error above to the AI.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  [2/4] Protocol regression tests (golden samples)
echo ============================================
"%DOTNET%" run --project ProtocolCodecTest\ProtocolCodecTest.csproj -c Release
if errorlevel 1 (
    echo.
    echo [FAILED] Protocol tests failed. Paste the error above to the AI.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  [3/4] First push of main branch to Piracola/LongCore
echo ============================================
git push -u origin main
if errorlevel 1 (
    echo.
    echo [FAILED] Push failed. If a browser login popup appeared, finish it and rerun. Or paste the error to the AI.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  [4/4] Sync remaining upstream branches and tags
echo ============================================
rem 注意: 首次推送时远程尚无同名分支, git 无法猜测 refname, 必须用完全限定 refspec
git push origin refs/remotes/upstream/master:refs/heads/master refs/remotes/upstream/future:refs/heads/future "refs/remotes/upstream/Linux/X86-64:refs/heads/Linux/X86-64" "refs/remotes/upstream/windows/X86-64-v8.9.8:refs/heads/windows/X86-64-v8.9.8" --tags

echo.
echo ============================================
echo  DONE. github.com/Piracola/LongCore now has the full code and history.
echo ============================================
pause
