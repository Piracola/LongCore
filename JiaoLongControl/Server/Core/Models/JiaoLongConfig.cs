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
    public LogSection Log { get; set; } = new();
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

    [ConfigComment("界面主题: light / dark / system (默认跟随系统)")]
    public string Theme { get; set; } = "system";

    [ConfigComment("切换性能模式时联动 Windows 电源计划(powercfg): 办公→节电 游戏→平衡 狂飙→高性能")]
    public bool SyncWindowsPowerPlan { get; set; } = true;

    [ConfigComment("接管 Fn 性能模式热键(HID_EVENT20 事件15): 镜像固件已切换的档位并显示 OSD")]
    public bool HotkeyEnabled { get; set; } = true;
}

/// <summary>
/// CPU 功耗参数 —— 只有一套（原"均衡/性能/节能/自定义"四张方案表已废除）。
///
/// 语义: 固件三档（办公/游戏/狂飙）由 EC 自己的功耗表管理, 本应用不改其参数;
/// 用户要自己定功耗就走这一套 —— 首页「自定义」与 CPU 页共用同一份,
/// 应用时先打开命令 23 自定义功耗子状态, 再下发 SPL/SPPT/温度墙/最大频率。
/// </summary>
public class CpuSection
{
    [ConfigComment("自定义功耗参数（首页「自定义」与 CPU 页共用，持久化保存）")]
    public CpuPowerData Custom { get; set; } = new();
}

public class CpuPowerData
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
    public uint CpuMaxFrequency { get; set; } = 5400;

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
    // 应用内风扇曲线总开关, 也是"跨重启记住用户意图"的载体:
    // 用户在风扇曲线页关掉服务后置 false, 下次启动就不会被 BootAdvancedFanControlSystem 重新拉起。
    // 默认 false: "让软件接管风扇"会绕开 EC 自身温控曲线, 属于需要用户明确选择的接管,
    // 不宜作为升级默认值。想启用请在风扇曲线页打开开关(或把此项置 true)。
    [ConfigComment("应用内风扇曲线接管风扇(三档模式下同样生效; 关闭则交还 EC 固件温控)")]
    public bool Enabled { get; set; } = false;

    // 2026-09-23 起默认开启: 两个风扇不同转速会产生拍频(beating),
    // 主观上是"周期起伏的嗡嗡声", 比同响度的稳态噪音难受得多。
    // 合并后两风扇取同一目标转速, 音高一致, 拍频消失。
    [ConfigComment("合并CPU/GPU风扇曲线(两风扇同转速, 消除不同转速产生的拍频调制)")]
    public bool FanCurveMerge { get; set; } = true;

    // ── 温度跟踪参数 (2026-09-23 重做) ───────────────────────────────
    // 旧实现是"非对称一阶低通 + 300 RPM 死区 + 对称斜坡", 实测无效: 用户仍报告
    // 70~90℃ 之间转速被反复调整。用真机日志(09-23 21:02~21:32, 1789 个 1 秒样本)
    // 离线重放后定位到三个独立原因, 这三个旋钮分别对应其中之一:
    //
    //   1) 旧低通本身就是噪声放大器。系数 0.25/0.12 的时间常数只有 3~7 秒,
    //      而温度计每秒抖动 ±2℃(实测 |dT| 均值 0.71℃/s, p99=5℃/s —— 这个量级的
    //      变化在热质量面前不可能是真实温度)。于是平滑值摆幅约 ±3℃, 比原始读数还大。
    //      → TempAttackS / TempReleaseS: 时间常数升到秒级, 摆幅压到 1℃ 以内。
    //
    //   2) 散热器不需要被"每 1℃"驱动。死区卡在最终 RPM 上, 挡得住 100 RPM 的抖动,
    //      挡不住"被低通放大后的 ±3℃ × 曲线斜率" = ±400 RPM。
    //      → TempHysteresisC: 改成在**温度域**设不灵敏带, 与曲线斜率无关。
    //
    //   3) 对称斜坡(升 600 / 降 600 RPM/秒)让降温方向同样激进。
    //      → 代码内改为升 1100 / 降 100 RPM/秒: 升温追得上, 降温一次只退一格。
    //
    // 两个跟踪器都从同一个 1 秒温度读数出发, 且都是双向低通, 区别只在时间常数:
    // 快跟踪器决定"允不允许升速"并直接给出升速目标; 慢跟踪器给出降速目标(经每秒一格限速),
    // 同时也是"保持高转速"的时间来源。两个门槛(RiseGateC / FallGateC)由 TempHysteresisC 换算。

    // 时间常数(秒)。升级器要快: 它是唯一能在真实升温时把转速顶上去的路径,
    // 慢了会拿散热换安静。5 秒对 1 秒采样足够压掉单帧尖峰(单帧 +9℃ 只让它动 1.8℃),
    // 而持续升温能在 20 秒内累积过门槛。
    [ConfigComment("升温跟踪时间常数 (秒): 越小跟随越快, 越大越能压掉瞬时温度尖峰")]
    [ConfigRange(2, 60)]
    public int TempAttackS { get; set; } = 5;

    // 降温器要慢, 这是"进入高转速后即使温度下降也保持更久"的主要实现。
    // 它同时是计算转速所用的温度: 温度回落时它缓慢逼近真实值, 转速随之缓慢下退;
    // 60 秒意味着温度掉 6℃ 也只退约 1℃ 对应的转速。实测该延迟不带来额外温升
    // (跟踪值与真值的均值偏差仅 +0.15℃), 因为它只在降温方向滞后。
    [ConfigComment("降温跟踪时间常数 (秒): 越大风扇在高转速保持越久, 噪音越平稳")]
    [ConfigRange(10, 300)]
    public int TempReleaseS { get; set; } = 60;

    // 不灵敏带直接以温度为单位, 因此与曲线陡峭程度无关 —— 换一条更陡的曲线也不会
    // 退回"每秒微调"。这是一个不对称带的宽度: 升速用约 0.6 倍(默认 3℃), 降速用约
    // 1.6 倍(默认 8℃), 于是"上得快、下得慢"由同一个旋钮表达。
    // 口径提醒: 本注释的 366 → 11 次来自 19 分钟窗口; KNOWN_ISSUES 6 的 88 → 3 次来自
    // 28.5 分钟窗口 —— 两组不是同一段数据, 引用时请连窗口与样本一起引, 不要混用数字。
    // 离线重放(19 分钟真实负载): 该默认值下写入 366 → 11 次、方向反转 0 次,
    // 平均每 79 秒才动一次风扇, 且相对曲线要求的平均欠冷只有 150 RPM。
    // 注意: 噪音档位(NoiseTolerance)会覆盖此值 —— 安静 8℃ / 均衡 5℃ / 强冷 3℃。
    // 保留本项是为了手动微调与向后兼容; 选了档位时以档位为准。
    [ConfigComment("温度不灵敏带 (℃): 温度变化不足此值时不调整转速 (0=关闭; 选了噪音档位时被档位覆盖)")]
    [ConfigRange(0, 15)]
    public int TempHysteresisC { get; set; } = 5;

    // 下限 1500 RPM: 手动模式下转速 0 会让风扇停转并绕开 EC 温控(唯一现实的硬件损伤路径),
    // 后端 Blding64 护栏亦硬性拒绝 0。上限 5800 RPM = 官方 fastestMode_FanSpeed_MaxValue(58×100)。
    // 上限 5800 与前端 FAN_MAX_RPM(constants/index.ts) 及驱动侧 FanSpeedRawMax(Blding64) 保持一致:
    // 6800 只是寄存器可写范围, 超过 5800 的写入会被驱动护栏拒绝, 属"范围多处声明"的隐患。
    // 噪音忍耐度: 一个旋钮同时驱动曲线缩放 / 不灵敏带 / 安全下限阈值三件事。
    // 为什么要三件一起动, 而不是只缩放曲线: 离线重放(中等负载, 6 seed 平均)显示
    // 只动曲线缩放时, 安全下限(88℃→4500)会把安静档顶回高转速, 档位差异被抹平;
    // 只动不灵敏带则几乎不改变响度(32.6 / 33.0 / 32.8 dBA), 只改变写入次数(21/14/9)。
    // 三件同动后: 安静 32.1 dBA / 均衡 32.8 / 强冷 34.1, 且 90℃ 低档秒数 75 / 0 / 0。
    // 数值口径: 1.0 档与出厂行为一致, 因此升级不会改变既有体验。
    [ConfigComment("噪音忍耐度: 0=安静(转速更低更稳) 1=均衡(出厂) 2=强冷(转速更高更凉)")]
    [ConfigRange(0, 2)]
    public int NoiseTolerance { get; set; } = 1;

    // 默认曲线: 噪声与性能的折中。
    // 目标不是"最安静", 而是把温度压在 CPU 温度墙(默认 95℃)以下, 避免到墙才猛拉 ——
    // 那正是 EC 固件表的老毛病(低温区压得极低, 91℃ 后才跳变)。
    // 依据: 官方控制台三档转速区间 静音 22-35 / 平衡 35-50 / 狂飙 50-58 (×100 RPM);
    // 本曲线 70℃ 起越过 2500 RPM, 90℃ 前已到 5100, 全程留出升温余量。
    public List<FanPoint> CpuFanCurve { get; set; } = new()
    {
        // 2026-09-23 调整: 本机实测工作温度常驻 77~86℃, 原曲线在 70~85℃ 的斜率是
        // 97~180 RPM/℃, 配合 1℃ 的温度分辨率, 每 1℃ 抖动就跨过 EC 的 100 RPM 整数格
        // —— 用户主观感受为"噪音一直在变"。这里把该段斜率压到 60~80 RPM/℃,
        // 并把 85℃ 从 4200 降到 3600(实测 85℃ 时并不需要那么快), 90℃ 留给急停段。
        new() { temp = 60, speed = 1500 }, new() { temp = 65, speed = 1800 },
        new() { temp = 70, speed = 2600 }, new() { temp = 75, speed = 3000 },
        new() { temp = 80, speed = 3300 }, new() { temp = 85, speed = 3600 },
        new() { temp = 90, speed = 4500 }, new() { temp = 95, speed = 5800 },
    };

    // GPU 曲线整体比 CPU 低一档: GPU 允许更热(这里 87℃ 才封顶),
    // 低温段刻意不激进, 避免轻载游戏时双风扇一起吵。
    public List<FanPoint> GpuFanCurve { get; set; } = new()
    {
        // 2026-09-23 调整: 中温段原本 120~180 RPM/℃ 过陡。本机 GPU 实测仅 52~57℃,
        // 按自己的曲线只需 1500~1800 RPM —— 过去它被 0.85 交叉同步拖到 3400 RPM,
        // 那个耦合已移除, 于是这段斜率不再需要为"陪 CPU 一起响"服务。
        new() { temp = 60, speed = 1500 }, new() { temp = 65, speed = 2000 },
        new() { temp = 70, speed = 2800 }, new() { temp = 75, speed = 3000 },
        new() { temp = 80, speed = 3600 }, new() { temp = 84, speed = 5000 },
        new() { temp = 87, speed = 5800 },
    };
}

public class FanPoint
{
    [ConfigComment("温度 (℃)")]
    public int temp { get; set; }

    [ConfigComment("转速 (RPM)")]
    public int speed { get; set; }
}

/// <summary>
/// 日志节。
/// 背景(仅供维护者, 用户可见文案见下): 旧行为下每次数据读取、每次前端调用都写一行
/// DEBUG, 实测一天 5.7 万行 / 6.4 MB(约 27 次/秒同步写盘), 其中 98.4% 出自
/// CommandResult 的构造函数; 而真正有用的控制侧信息(AutoFanControl 转速、看门狗、
/// EcGuard、HwWriteGate 拦截)只占 1.4%。故把"读取明细"与"控制日志"分开开关。
/// 这里曾经还有一个"攒批落盘间隔", 因低日志量下会静默吞掉安全事件而废除(见 LogRuntime)。
/// 注意: 下面 [ConfigComment] 的文字会直接写进 config.yaml 给用户看, 必须说人话;
/// 上述论证留在 XML 注释里, 不要搬进 ConfigComment。
/// </summary>
public class LogSection
{
    [ConfigComment("日志详细程度: DEBUG(详细) / INFO(常规) / WARN(精简) / ERROR(仅错误) / OFF(不记录)。改后立即生效")]
    public string Level { get; set; } = "INFO";

    // 单独开关而非只靠 Level: CommandResult 走的是 Debug, 一旦 Level=DEBUG 会立刻
    // 退回每天 5 万行; 而排查"某个读取为什么返回空"时又临时需要它。
    [ConfigComment("记录读取明细: 把每一次硬件数据读取都写进日志(体积的绝大部分来源), 仅在排查读数异常时打开")]
    public bool CommandDebug { get; set; } = false;
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

    // 逐核设置：只记录"上次成功应用的那套值"，供 SMU 页重启后把表单填回去。
    // **刻意不在启动时下发**（Decision 2026-09-24）：16 核 × 2 参数 = 32 条 SMU 命令，
    // 无人值守地开机写硬件，手误会被每次开机重放。要生效仍需用户在 SMU 页点「应用逐核设置」。
    // 长度 = 物理核心数；缺失/较短按 0 补齐，0 = 不偏移。
    [ConfigComment("逐核 Curve Optimizer 偏移 (负值为降压, 每核一项; 仅记录, 开机不下发)")]
    public List<int> PerCoreCurve { get; set; } = new();

    [ConfigComment("逐核超频频率偏移 (MHz, 每核一项; 仅记录, 开机不下发)")]
    public List<int> PerCoreOcClk { get; set; } = new();
}
