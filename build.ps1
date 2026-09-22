# encoding: UTF-8 with BOM -- required by Windows PowerShell 5.1 (powershell.exe).
# Saving this file as UTF-8 no-BOM makes build.cmd fail at parse time on Chinese Windows.
# ============================================================
# LongCore 一键本地构建
# 双击 build.cmd 或直接 .\build.ps1  =>  出现菜单, 按数字选择
# 也可带参数静默执行(给自动化用):
#   .\build.ps1 -Full / -Frontend / -Backend / -TestOnly / -Installer
#   .\build.ps1 -Restore / -ForceInstall
# ============================================================
[CmdletBinding()]
param(
    [switch]$Frontend,
    [switch]$Backend,
    [switch]$TestOnly,
    [switch]$Installer,
    [switch]$Full,
    [switch]$Restore,
    [switch]$ForceInstall,
    [switch]$NoMenu
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

if (-not $env:SystemRoot)  { $env:SystemRoot = 'C:\Windows' }
if (-not $env:windir)      { $env:windir = 'C:\Windows' }
if (-not $env:PROGRAMDATA) { $env:PROGRAMDATA = 'C:\ProgramData' }

# NuGet 缓存位置：优先仓库内 vendor/（当前布局），回退到上一级目录（旧布局兼容）。
# 若都找不到，沿用 dotnet 默认缓存。
$NugetCandidates = @(
    (Join-Path $Root 'vendor\.nuget-packages'),
    (Join-Path (Split-Path $Root -Parent) '.nuget-packages')
)
foreach ($cand in $NugetCandidates) {
    if (Test-Path $cand) {
        $env:NUGET_PACKAGES = $cand
        Write-Host "NUGET_PACKAGES = $cand"
        break
    }
}

$Dotnet = 'C:\Users\NullCola\.dotnet\dotnet.exe'
if (-not (Test-Path $Dotnet)) { $Dotnet = 'dotnet' }

$Csproj      = Join-Path $Root 'JiaoLongControl\JiaoLongControl.csproj'
$ClientDir   = Join-Path $Root 'JiaoLongControl\Client'
$TestProj    = Join-Path $Root 'ProtocolCodecTest\ProtocolCodecTest.csproj'
$PublishDir  = Join-Path $Root 'bin\publish'
$WebRoot     = Join-Path $PublishDir 'WebRoot'
$AssetsJson  = Join-Path $Root 'JiaoLongControl\obj\project.assets.json'
$PublishRid  = 'win-x64'

function Write-Step([string]$msg) {
    Write-Host ''
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Fail([string]$msg) {
    Write-Host ''
    Write-Host "[FAILED] $msg" -ForegroundColor Red
    exit 1
}

# 资产文件里必须真的含本次 publish 的目标(例: net10.0-windows/win-x64)才能加 --no-restore。
# 任何不带 -r 的还原(IDE 自动还原 / dotnet restore / dotnet build / CI)都会把
# project.assets.json 重写成只含 "net10.0-windows" 的版本, 此时 publish --no-restore
# 会以 NETSDK1047 失败; 只判断"文件存在"就会踩这个坑。
function Test-AssetsTarget([string]$AssetsPath, [string]$Target) {
    if (-not $Target) { return $false }
    if (-not (Test-Path -LiteralPath $AssetsPath)) { return $false }
    try {
        $assets = Get-Content -Raw -LiteralPath $AssetsPath | ConvertFrom-Json
        if ($null -eq $assets.targets) { return $false }
        return [bool]($assets.targets.PSObject.Properties.Name -contains $Target)
    }
    catch {
        # 资产文件损坏或半写 => 视为不可用, 让 publish 自己还原
        return $false
    }
}

function Show-Menu {
    $exeOk = Test-Path (Join-Path $PublishDir 'LongCore.exe')
    $webOk = Test-Path (Join-Path $WebRoot 'index.html')
    $exeLabel = '未构建'
    $webLabel = '未构建'
    if ($exeOk) { $exeLabel = '已就绪' }
    if ($webOk) { $webLabel = '已就绪' }
    $ver = ''
    if (Test-Path $Csproj) {
        $m = Select-String -Path $Csproj -Pattern '<AppVersion>(.+?)</AppVersion>'
        if ($m) { $ver = $m.Matches[0].Groups[1].Value }
    }

    Write-Host ''
    Write-Host '============================================' -ForegroundColor DarkCyan
    Write-Host '  LongCore 构建菜单' -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor DarkCyan
    Write-Host "  仓库: $Root"
    if ($ver) { Write-Host "  版本: $ver" }
    Write-Host "  程序: $exeLabel    前端: $webLabel"
    Write-Host '--------------------------------------------'
    Write-Host '  [1] 完整构建            前端 + 后端 + 协议测试'
    Write-Host '  [2] 完整构建 + 安装器   再打 setup.exe'
    Write-Host '  [3] 只构建前端'
    Write-Host '  [4] 只构建后端'
    Write-Host '  [5] 只跑协议测试'
    Write-Host '  [6] 只打安装器 (用现有 bin\publish)'
    Write-Host '  [7] 全量 + 强制重装前端依赖 + 安装器'
    Write-Host '  [0] 退出'
    Write-Host '============================================' -ForegroundColor DarkCyan
}

# ---------- 菜单: 无 CLI 开关且允许交互时显示 ----------
$hasSwitch = $Frontend -or $Backend -or $TestOnly -or $Installer -or $Full
if (-not $hasSwitch -and -not $NoMenu) {
    while ($true) {
        Show-Menu
        $choice = Read-Host '输入数字后回车'
        if ($null -eq $choice) { continue }
        $choice = $choice.Trim()
        switch ($choice) {
            '1' { $Frontend=$true; $Backend=$true; $TestOnly=$true; break }
            '2' { $Frontend=$true; $Backend=$true; $TestOnly=$true; $Installer=$true; break }
            '3' { $Frontend=$true; break }
            '4' { $Backend=$true; break }
            '5' { $TestOnly=$true; break }
            '6' { $Installer=$true; break }
            '7' { $Frontend=$true; $Backend=$true; $TestOnly=$true; $Installer=$true; $ForceInstall=$true; break }
            '0' { Write-Host '已退出'; exit 0 }
            default {
                Write-Host '无效选项, 请重试' -ForegroundColor Yellow
                continue
            }
        }
        break
    }
}
elseif ($Full -and -not $hasSwitch) {
    $Frontend=$true; $Backend=$true; $TestOnly=$true
}

# -Full 与其他开关并存时也补齐默认全量
if ($Full) {
    $Frontend=$true; $Backend=$true; $TestOnly=$true
}

Write-Host '============================================'
Write-Host ' LongCore build'
Write-Host " Root: $Root"
Write-Host '============================================'

# ---------- Frontend ----------
if ($Frontend) {
    Write-Step "Frontend: npm ci + type-check + vite build -> $WebRoot"
    Push-Location $ClientDir
    try {
        $nodeModules = Join-Path $ClientDir 'node_modules'
        $lockFile    = Join-Path $ClientDir 'package-lock.json'
        $needInstall = $ForceInstall -or (-not (Test-Path $nodeModules))
        # node_modules 存在但关键 bin 缺失 = 半残状态(常见于 EPERM 中断)
        if (-not $needInstall) {
            $vueTscBin = Join-Path $nodeModules '.bin\vue-tsc.cmd'
            $viteBin   = Join-Path $nodeModules '.bin\vite.cmd'
            if (-not (Test-Path $vueTscBin) -or -not (Test-Path $viteBin)) {
                Write-Host '    (node_modules incomplete, reinstalling)'
                $needInstall = $true
            }
        }
        if (-not $needInstall -and (Test-Path $lockFile)) {
            $lockTime  = (Get-Item $lockFile).LastWriteTime
            $modTime   = (Get-Item $nodeModules).LastWriteTime
            $needInstall = $lockTime -gt $modTime
        }

        if ($needInstall) {
            Write-Host '    (installing dependencies)'
            # 半残目录会让 npm ci EPERM; 先删干净
            if (Test-Path $nodeModules) {
                cmd /c "rd /s /q `"$nodeModules`"" 2>$null
            }
            npm ci
            if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' }
        }
        else {
            Write-Host '    (node_modules up to date, skip npm ci)'
        }

        if (Test-Path $WebRoot) {
            Remove-Item $WebRoot -Recurse -Force
        }

        npm run build
        if ($LASTEXITCODE -ne 0) { Fail 'npm run build failed' }
    }
    finally {
        Pop-Location
    }
    if (-not (Test-Path (Join-Path $WebRoot 'index.html'))) {
        Fail "Frontend output missing: $WebRoot\index.html"
    }
}

# ---------- Backend ----------
if ($Backend) {
    Write-Step "Backend: dotnet publish -c Release -r $PublishRid -> $PublishDir"
    $publishArgs = @(
        'publish', $Csproj,
        '-c', 'Release',
        '-r', $PublishRid,
        '--self-contained', 'false',
        '-o', $PublishDir
    )
    # 目标键 = csproj 的 TargetFramework + RID, 例: net10.0-windows/win-x64
    $tfm = $null
    if (Test-Path $Csproj) {
        $tfmMatch = Select-String -Path $Csproj -Pattern '<TargetFramework>(.+?)</TargetFramework>'
        if ($tfmMatch) { $tfm = $tfmMatch.Matches[0].Groups[1].Value.Trim() }
    }
    $publishTarget = if ($tfm) { "$tfm/$PublishRid" } else { $null }
    if (-not $Restore -and (Test-AssetsTarget $AssetsJson $publishTarget)) {
        $publishArgs += '--no-restore'
        Write-Host '    (using --no-restore)'
    }
    else {
        Write-Host "    (assets file lacks '$publishTarget', publish will restore)"
    }
    & $Dotnet @publishArgs
    if ($LASTEXITCODE -ne 0) { Fail "dotnet publish failed (exit $LASTEXITCODE)" }
    if (-not (Test-Path (Join-Path $PublishDir 'LongCore.exe'))) {
        Fail "Backend output missing: $PublishDir\LongCore.exe"
    }
}

# ---------- Protocol tests ----------
if ($TestOnly) {
    Write-Step 'Protocol golden-sample tests'
    $testArgs = @('run', '--project', $TestProj, '-c', 'Release')
    if (-not $Restore -and (Test-Path (Join-Path $Root 'ProtocolCodecTest\obj\project.assets.json'))) {
        $testArgs += '--no-restore'
    }
    & $Dotnet @testArgs
    if ($LASTEXITCODE -ne 0) { Fail "Protocol tests failed (exit $LASTEXITCODE)" }
}

# ---------- Installer ----------
if ($Installer) {
    Write-Step 'Inno Setup installer'
    $isccCandidates = @(
        'iscc',
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ }

    $iscc = $null
    foreach ($c in $isccCandidates) {
        if ($c -eq 'iscc') {
            $cmd = Get-Command iscc -ErrorAction SilentlyContinue
            if ($cmd) { $iscc = $cmd.Source; break }
        }
        elseif (Test-Path $c) {
            $iscc = $c
            break
        }
    }
    if (-not $iscc) {
        Fail 'Inno Setup 6 not found. Install via: winget install -e --id JRSoftware.InnoSetup --scope user'
    }
    & $iscc (Join-Path $Root 'installer\LongCore.iss')
    if ($LASTEXITCODE -ne 0) { Fail "ISCC failed (exit $LASTEXITCODE)" }
}

Write-Host ''
Write-Host '============================================'
Write-Host ' DONE' -ForegroundColor Green
if ($Frontend)  { Write-Host "   Frontend: $WebRoot\" }
if ($Backend)   { Write-Host "   App:      $PublishDir\LongCore.exe" }
if ($TestOnly)  { Write-Host '   Tests:    protocol golden samples passed' }
if ($Installer) { Write-Host '   Setup:    installer\Output\' }
Write-Host '============================================'

# 菜单模式下按任意键再关窗口, 方便双击使用
if (-not $hasSwitch -and -not $NoMenu) {
    Write-Host ''
    Read-Host '按回车退出'
}
exit 0
