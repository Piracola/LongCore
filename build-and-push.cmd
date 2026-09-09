@echo off
rem LongCore M0: build backend + push to Piracola/LongCore
rem Run this from YOUR OWN terminal (double-click also works).
cd /d "I:\JBCode\AI Tools\jiaolong16pro\LongCore"

echo ============================================
echo  [1/4] Backend build (dotnet build Release)
echo ============================================
"C:\Users\NullCola\.dotnet\dotnet.exe" build JiaoLongControl\JiaoLongControl.csproj -c Release
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
"C:\Users\NullCola\.dotnet\dotnet.exe" run --project ProtocolCodecTest\ProtocolCodecTest.csproj -c Release --
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
git push origin upstream/master:master upstream/future:future "upstream/Linux/X86-64:Linux/X86-64" "upstream/windows/X86-64-v8.9.8:windows/X86-64-v8.9.8" --tags

echo.
echo ============================================
echo  DONE. github.com/Piracola/LongCore now has the full code and history.
echo ============================================
pause
