namespace JiaoLongControl.Server.Core.Models;

using YamlDotNet.Serialization;

public class JiaoLongConfig
{
    public string Version { get; set; } = "";
    public AppSection App { get; set; } = new();
    public CpuSection Cpu { get; set; } = new();
    public GpuSection Gpu { get; set; } = new();
    public FanSection Fan { get; set; } = new();
    public SmuSection Smu { get; set; } = new();
    public SafetySection Safety { get; set; } = new();
}

/// <summary>
/// 硬件安全相关开关。详见 docs/08_硬件安全架构.md。
/// 这些开关存在的意义: 安全阀值判断有误时, 用户可不重新编译就放行,
/// 否则"安全机制"本身会变成故障源。
/// </summary>
public class SafetySection
{
    [ConfigComment("硬件写入闸门: 校验命令白名单/取值范围/写入频率。误拦截时置 false 紧急放行(仅保留日志)")]
    public bool WriteGateEnabled { get; set; } = true;

    [ConfigComment("过温看门狗: CPU 达到触发温度并持续指定秒数时强制风扇最大转速, 回落后交还 EC 自动温控。建议保持开启")]
    public bool ThermalWatchdogEnabled { get; set; } = true;

    [ConfigComment("过温看门狗触发温度 (℃)")]
    [ConfigRange(80, 105)]
    public int ThermalWatchdogTempC { get; set; } = 98;

    [ConfigComment("触发需持续的秒数 (避免瞬时尖峰误触发)")]
    [ConfigRange(3, 60)]
    public int ThermalWatchdogSustainS { get; set; } = 10;

    [ConfigComment("释放温度 (℃): 回落到该值并持续释放秒数后, 交还 EC 自动温控")]
    [ConfigRange(60, 100)]
    public int ThermalWatchdogReleaseC { get; set; } = 92;

    [ConfigComment("释放需持续的秒数")]
    [ConfigRange(5, 300)]
    public int ThermalWatchdogReleaseS { get; set; } = 30;
}

public class AppSection
{
    [ConfigComment("开机后最小化到托盘")]
    public bool BootMinimized { get; set; }

    [ConfigComment("开机自动启动高级风扇控制系统")]
    public bool BootAdvancedFanControlSystem { get; set; }

    [ConfigComment("开机自动启动高级CPU系统")]
    public bool BootAdvancedCPUSystem { get; set; }

    [ConfigComment("开机自动启动高级GPU系统")]
    public bool BootAdvancedGPUSystem { get; set; }

    [ConfigComment("开机自动设置Ryzen SMU Curve Optimizer All")]
    public bool BootSetRyzenSumCurveOptimizerAll { get; set; }

    [ConfigComment("开机自动开启键盘渐变")]
    public bool BootKeyboardGradient { get; set; }

    [ConfigComment("界面主题: light / dark / system (默认跟随系统)")]
    public string Theme { get; set; } = "system";

    [ConfigComment("切换性能模式时联动 Windows 电源计划(powercfg): 静音→节电 平衡→平衡 高性能→高性能")]
    public bool SyncWindowsPowerPlan { get; set; } = true;

    [ConfigComment("接管 Fn 性能模式热键(HID_EVENT20 事件15): 镜像固件已切换的档位并显示 OSD")]
    public bool HotkeyEnabled { get; set; } = true;
}

public class CpuSection
{
    [ConfigComment("当前选中档位: default / performance / saving / custom")]
    public string CpuProfile { get; set; } = "default";

    [ConfigComment("默认档位参数")]
    public CpuProfileData Default { get; set; } = new()
    {
        CpuLongPower = 45, CpuShortPower = 65, CpuTempWall = 80, CpuMaxFrequency = 4400
    };

    [ConfigComment("高性能档位参数")]
    public CpuProfileData Performance { get; set; } = new()
    {
        CpuLongPower = 65, CpuShortPower = 90, CpuTempWall = 95, CpuMaxFrequency = 4700
    };

    [ConfigComment("节能档位参数")]
    public CpuProfileData Saving { get; set; } = new()
    {
        CpuLongPower = 30, CpuShortPower = 45, CpuTempWall = 75, CpuMaxFrequency = 3200
    };

    [ConfigComment("自定义档位参数")]
    public CpuProfileData Custom { get; set; } = new();
    
    [YamlIgnore]
    public CpuProfileData Active => CpuProfile switch
    {
        "performance" => Performance,
        "saving" => Saving,
        "custom" => Custom,
        _ => Default
    };
}

public class CpuProfileData
{
    [ConfigComment("CPU长期功率限制 (W)")]
    [ConfigRange(5, 120)]
    public byte CpuLongPower { get; set; } = 45;

    [ConfigComment("CPU短期功率限制 (W)")]
    [ConfigRange(5, 150)]
    public byte CpuShortPower { get; set; } = 55;

    [ConfigComment("CPU温度墙 (℃)")]
    [ConfigRange(60, 105)]
    public byte CpuTempWall { get; set; } = 95;

    [ConfigComment("CPU最大频率 (MHz)")]
    [ConfigRange(2000, 6000)]
    public uint CpuMaxFrequency { get; set; } = 4800;

    [ConfigComment("CPU睿频开关")]
    public bool CpuTurbo { get; set; } = true;
}

public class GpuSection
{
    [ConfigComment("GPU核心频率 (MHz)")]
    public int GpuClock { get; set; }

    [ConfigComment("GPU显存频率 (MHz)")]
    public int MemoryClock { get; set; } = 100;

    [ConfigComment("GPU功率限制 (W)")]
    public int PowerLimit { get; set; } = 140;

    [ConfigComment("核心频率偏移 (MHz, 负值为降频)")]
    public int CoreClockOffset { get; set; }

    [ConfigComment("显存频率偏移 (MHz)")]
    public int MemoryClockOffset { get; set; }

    [ConfigComment("核心电压提升 (%)")]
    public int VoltageBoostPercent { get; set; }
}

public class FanSection
{
    [ConfigComment("合并CPU/GPU风扇曲线")]
    public bool FanCurveMerge { get; set; }

    // 下限 1500 RPM: 手动模式下转速 0 会让风扇停转并绕开 EC 温控(唯一现实的硬件损伤路径),
    // 后端 Blding64 护栏亦硬性拒绝 0。上限 5800 RPM = 官方 fastestMode_FanSpeed_MaxValue(58×100)。
    [ConfigComment("手动风扇转速 (RPM)")]
    [ConfigRange(1500, 6800)]
    public int ManualFanSpeed { get; set; } = 1500;

    public List<FanPoint> CpuFanCurve { get; set; } = new()
    {
        new() { temp = 60, speed = 1500 }, new() { temp = 65, speed = 2104 },
        new() { temp = 70, speed = 2778 }, new() { temp = 75, speed = 3158 },
        new() { temp = 80, speed = 3365 }, new() { temp = 86, speed = 3607 },
        new() { temp = 91, speed = 3849 }, new() { temp = 94, speed = 4828 },
        new() { temp = 97, speed = 5415 }, new() { temp = 100, speed = 5800 },
    };

    public List<FanPoint> GpuFanCurve { get; set; } = new()
    {
        new() { temp = 60, speed = 3000 }, new() { temp = 65, speed = 4000 },
        new() { temp = 70, speed = 4800 }, new() { temp = 75, speed = 5000 },
        new() { temp = 80, speed = 5400 }, new() { temp = 87, speed = 5800 },
    };
}

public class FanPoint
{
    [ConfigComment("温度 (℃)")]
    public int temp { get; set; }

    [ConfigComment("转速 (RPM)")]
    public int speed { get; set; }
}

public class SmuSection
{
    [ConfigComment("STAPM限制 (W)")]
    public int StapmLimit { get; set; }

    [ConfigComment("STAPM时间 (s)")]
    public int StapmTime { get; set; }

    [ConfigComment("快速功耗限制 (W)")]
    public int FastLimit { get; set; }

    [ConfigComment("慢速功耗限制 (W)")]
    public int SlowLimit { get; set; }

    [ConfigComment("慢速功耗时间 (s)")]
    public int SlowTime { get; set; }

    [ConfigComment("PPT限制 (RSMU, W)")]
    public int PptLimitRsmu { get; set; }

    [ConfigComment("VRM电流 MP1 (A)")]
    public int VrmCurrentMp1 { get; set; }

    [ConfigComment("VRM电流 RSMU (A)")]
    public int VrmCurrentRsmu { get; set; }

    [ConfigComment("TDC限制 MP1 (A)")]
    public int TdcLimitMp1 { get; set; }

    [ConfigComment("TDC限制 RSMU (A)")]
    public int TdcLimitRsmu { get; set; }

    [ConfigComment("EDC限制 MP1 (A)")]
    public int EdcLimitMp1 { get; set; }

    [ConfigComment("EDC限制 RSMU (A)")]
    public int EdcLimitRsmu { get; set; }

    [ConfigComment("温度限制 MP1 (℃)")]
    public int TempLimitMp1 { get; set; }

    [ConfigComment("温度限制 RSMU (℃)")]
    public int TempLimitRsmu { get; set; }

    [ConfigComment("PBO Scalar")]
    public int PboScalar { get; set; }

    [ConfigComment("超频频率 (MHz)")]
    public int OcClk { get; set; }

    [ConfigComment("超频电压 (mV)")]
    public int OcVolt { get; set; }

    // Curve Optimizer 全核偏移。负=降压(降压过度只会不稳/卡顿/开不了机, 不伤硬件);
    // 正=加压, 在散热与功耗受限的笔记本上无收益, 却会推高发热与电迁移风险, 故禁正偏移。
    // -30 取 AMD 常见下限; -25 以下应在 UI 另行警示。后端 RyzenSmuController 亦硬性拒绝越界。
    [ConfigComment("Curve Optimizer All (负值为降压, 范围 -30~0)")]
    [ConfigRange(-30, 0)]
    public int CurveOptimizerAll { get; set; }
}
