# 温度通道对比采样脚本（研究层，只读，不写硬件）
#
# 用法（需管理员）:
#   pwsh -File research\tools\sample-temp-channels.ps1 -Samples 180 -DelayMs 700
#
# 同时读取三条 CPU 温度通道，输出 CSV 到 research\probe\20_temp_channel_compare.csv：
#   EC      —— WMI MICommonInterface 命令 22（整数℃，当前风扇在用的那条）
#   Tctl    —— LibreHardwareMonitor Core (Tctl/Tdie)（0.1℃，走 SMU）
#   CcdMax  —— LibreHardwareMonitor CCDs Max (Tdie)（热点峰值）
#
# 为什么三条要同时读：EC 经 WMI/ACPI 固件上报，LHM 直读 SMU 寄存器，是两条独立路径。
# 若大幅跳变在两条上都同步出现 → 那是真实温度变化；只在一条上出现 → 才是噪声。
# 这个"两条独立通道互证"的办法能在没有真值的情况下把信号和噪声分开。

param(
    [int]$Samples = 180,
    [int]$DelayMs = 700,
    [string]$OutFile = (Join-Path $PSScriptRoot '..\probe\20_temp_channel_compare.csv')
)

$ErrorActionPreference = 'Stop'

# 无 .NET SDK 时直接从 NuGet 缓存加载 LHM 程序集（与主仓同版本 0.9.6）
$dllCandidates = @(
    (Join-Path $PSScriptRoot '..\..\vendor\.nuget-packages\librehardwaremonitorlib\0.9.6\runtimes\win-x64\lib\net8.0\LibreHardwareMonitorLib.dll'),
    (Join-Path $env:USERPROFILE '.nuget\packages\librehardwaremonitorlib\0.9.6\runtimes\win-x64\lib\net8.0\LibreHardwareMonitorLib.dll')
)
$dll = $dllCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $dll) { throw "找不到 LibreHardwareMonitorLib.dll，请先还原 NuGet 包" }
Add-Type -Path $dll

$computer = New-Object LibreHardwareMonitor.Hardware.Computer
$computer.IsCpuEnabled = $true
$computer.Open()

$mo = New-Object System.Management.ManagementObject(
    "root\WMI", "MICommonInterface.InstanceName='ACPI\PNP0C14\MIFS_0'", $null)
$prm = $mo.GetMethodParameters('MiInterface')
$in = [byte[]]::new(32); $in[1] = 250; $in[3] = 22

$rows = @()
Write-Host "采样 $Samples 组，约 $([Math]::Round($Samples * ($DelayMs + 300) / 1000)) 秒…"
for ($i = 0; $i -lt $Samples; $i++) {
    $prm['InData'] = $in
    $out = $mo.InvokeMethod('MiInterface', $prm, $null)
    $od = [byte[]]$out.Properties['OutData'].Value
    $ecv = [double]$od[4]

    $tctl = $null; $ccd = $null
    foreach ($hw in $computer.Hardware) {
        if ($hw.HardwareType -ne [LibreHardwareMonitor.Hardware.HardwareType]::Cpu) { continue }
        $hw.Update()
        foreach ($s in $hw.Sensors) {
            if ($s.SensorType -eq [LibreHardwareMonitor.Hardware.SensorType]::Temperature) {
                if ($s.Name -eq 'Core (Tctl/Tdie)') { $tctl = [double]$s.Value }
                if ($s.Name -eq 'CCDs Max (Tdie)') { $ccd = [double]$s.Value }
            }
        }
        break
    }
    $rows += [PSCustomObject]@{ EC = $ecv; Tctl = $tctl; CcdMax = $ccd }
    Start-Sleep -Milliseconds $DelayMs
}
$computer.Close()

$rows | Export-Csv -Path $OutFile -NoTypeInformation -Encoding UTF8
Write-Host "已写入 $OutFile（$($rows.Count) 行）"

function Stats($name, $xs) {
    $n = $xs.Count
    $mean = ($xs | Measure-Object -Average).Average
    $d = @(); for ($i = 1; $i -lt $n; $i++) { $d += [Math]::Abs([double]$xs[$i] - [double]$xs[$i - 1]) }
    $sd = $d | Sort-Object
    $ss = 0; foreach ($x in $xs) { $ss += ([double]$x - $mean) * ([double]$x - $mean) }
    $line = "{0,-20} range {1,5:N1}~{2,5:N1}  mean {3,6:N2}  sd {4,5:N2}  |dT| avg {5,5:N2} p99 {6,5:N2} max {7,4:N1}  spikes {8,3}  distinct {9,4}" -f `
        $name, ($xs | Measure-Object -Minimum).Minimum, ($xs | Measure-Object -Maximum).Maximum, `
    $mean, [Math]::Sqrt($ss / ($n - 1)), (($d | Measure-Object -Average).Average), `
    $sd[[Math]::Min($sd.Count - 1, [Math]::Floor($sd.Count * 0.99))], `
    ($d | Measure-Object -Maximum).Maximum, ($d | Where-Object { $_ -gt 3 }).Count, `
    ($xs | Where-Object { $_ -ne $null } | Sort-Object -Unique).Count
    Write-Host $line
}
Write-Host ""
Stats 'EC(22) int C'  ($rows | ForEach-Object { $_.EC })
Stats 'LHM Tctl/Tdie' ($rows | ForEach-Object { $_.Tctl })
Stats 'LHM CCDs Max'  ($rows | ForEach-Object { $_.CcdMax })
