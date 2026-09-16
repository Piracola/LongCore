# Jiaolong 16Pro (MRID6) ACPI WMI read-only probe
# Protocol: InData[32]; InData[1]=MethodType(250=Get, 251=Set); InData[3]=CommandCode; args start at [4]
# Returns: OutData[4..7] holds the value (16-bit little endian)

$ErrorActionPreference = 'Continue'
$OutFile = "I:\JBCode\AI Tools\jiaolong16pro\probe\10_wmi_get_probe.txt"

$Commands = @(
    @{ Code = 8;  Name = 'SystemPerMode';         Desc = 'Performance mode 0=Balance 1=Performance 2=Quiet' },
    @{ Code = 9;  Name = 'GPUMode';               Desc = '0=Hybrid 1=Discrete' },
    @{ Code = 10; Name = 'RGBKeyboardStatus';     Desc = 'Keyboard backlight on/off' },
    @{ Code = 11; Name = 'FnLock';                Desc = 'FnLock state' },
    @{ Code = 12; Name = 'TPLock';                Desc = 'Touchpad lock' },
    @{ Code = 13; Name = 'CPUGPUFanSpeed';        Desc = 'CPU/GPU fan speed' },
    @{ Code = 14; Name = 'GPUFanSpeed_NotUse';    Desc = 'GPU fan (unused)' },
    @{ Code = 15; Name = 'Ambientlight';          Desc = 'Ambient light' },
    @{ Code = 16; Name = 'RGBKeyboardMode';       Desc = 'Keyboard light mode' },
    @{ Code = 17; Name = 'RGBKeyboardColor';      Desc = 'Keyboard light color' },
    @{ Code = 18; Name = 'RGBKeyboardBrightness'; Desc = 'Keyboard brightness' },
    @{ Code = 19; Name = 'SystemAcType';          Desc = '1=TypeC 2=Barrel' },
    @{ Code = 20; Name = 'MaxFanSpeedSwitch';     Desc = 'Cooler boost switch' },
    @{ Code = 21; Name = 'MaxFanSpeed';           Desc = 'Cooler boost state' },
    @{ Code = 22; Name = 'CPUThermometer';        Desc = 'CPU temp wall' },
    @{ Code = 23; Name = 'CPUPower';              Desc = 'CPU power SPL/SPPT' }
)

function Invoke-MiCommand {
    param([int]$MethodType, [int]$CommandCode)

    $inData = [byte[]]::new(32)
    $inData[1] = [byte]$MethodType
    $inData[3] = [byte]$CommandCode

    $path = "MICommonInterface.InstanceName='ACPI\PNP0C14\MIFS_0'"
    $mo = New-Object System.Management.ManagementObject("root\WMI", $path, $null)
    $prm = $mo.GetMethodParameters("MiInterface")
    $prm["InData"] = [byte[]]$inData
    $out = $mo.InvokeMethod("MiInterface", $prm, $null)

    $od = [byte[]]$out.Properties["OutData"].Value
    return @{
        ReturnValue = $out.Properties["ReturnValue"].Value
        OutData     = $od
        Reserved    = $out.Properties["Reserved"].Value
    }
}

function Format-HexBytes {
    param([byte[]]$b)
    if ($null -eq $b) { return '(null)' }
    return (($b | ForEach-Object { $_.ToString('X2') }) -join ' ')
}

$L = New-Object System.Collections.ArrayList
[void]$L.Add("=== Jiaolong16Pro MRID6 WMI READ-ONLY PROBE  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===")
$cs = Get-CimInstance Win32_ComputerSystem
$bs = Get-CimInstance Win32_BIOS
[void]$L.Add("Model: $($cs.Model)   BIOS: $($bs.SMBIOSBIOSVersion)")
[void]$L.Add("")
[void]$L.Add(("{0,-24} {1,-5} {2,-6} {3,-6} {4}" -f 'NAME', 'CODE', 'RET', 'RSVD', 'OUTDATA'))
[void]$L.Add(("-" * 120))

foreach ($c in $Commands) {
    try {
        $r = Invoke-MiCommand -MethodType 250 -CommandCode $c.Code
        $hex = Format-HexBytes $r.OutData
        $decoded = ''
        if ($r.OutData -and $r.OutData.Length -ge 8) {
            $v16a = ($r.OutData[5] -shl 8) + $r.OutData[4]
            $v16b = ($r.OutData[7] -shl 8) + $r.OutData[6]
            $decoded = "  | b4=$($r.OutData[4]) b5=$($r.OutData[5]) b6=$($r.OutData[6]) b7=$($r.OutData[7]) u16a=$v16a u16b=$v16b"
        }
        [void]$L.Add(("{0,-24} {1,-5} {2,-6} {3,-6} {4}{5}" -f $c.Name, $c.Code, $r.ReturnValue, $r.Reserved, $hex, $decoded))
    } catch {
        [void]$L.Add(("{0,-24} {1,-5} ERROR: {2}" -f $c.Name, $c.Code, $_.Exception.Message))
    }
    [void]$L.Add("    # " + $c.Desc)
}

[void]$L.Add("")
[void]$L.Add("=== Extended: scan command codes 0..40 (Get) ===")
for ($code = 0; $code -le 40; $code++) {
    try {
        $r = Invoke-MiCommand -MethodType 250 -CommandCode $code
        $od = $r.OutData
        if ($od -and $od.Length -ge 8) {
            $nz = ($od | Where-Object { $_ -ne 0 }).Count
            $mark = ''
            if ($nz -gt 0) { $mark = '   <== HAS DATA' }
            [void]$L.Add(("  code={0,-3} ret={1,-6} rsvd={2,-6} out={3}{4}" -f $code, $r.ReturnValue, $r.Reserved, (Format-HexBytes $od), $mark))
        } else {
            $len = 0
            if ($od) { $len = $od.Length }
            [void]$L.Add(("  code={0,-3} ret={1,-6} out=(len={2})" -f $code, $r.ReturnValue, $len))
        }
    } catch {
        [void]$L.Add(("  code={0,-3} ERROR {1}" -f $code, $_.Exception.Message))
    }
}

Set-Content -Path $OutFile -Value $L -Encoding UTF8
