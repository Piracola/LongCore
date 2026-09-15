using System.Collections.Concurrent;
using JiaoLongControl.Server.Core.Models;
using log4net;

namespace JiaoLongControl.Server.Core.Services;

/// <summary>
/// 硬件写入安全闸门 (Hardware Write Gate)。
///
/// <para>目的: 让上层的任何 bug 都无法把硬件推入不可逆的危险状态。</para>
///
/// <para>位置: 所有 WMI/EC 状态下发都经由 <see cref="MethodServices.SetValue(MethodName, object)"/>
/// 及其 byte[] 重载, 该方法是全项目唯一的 WMI/EC 写入出口, 因此闸门挂在此处即等于
/// 全通道覆盖, 无需改动任何调用点。</para>
///
/// <para>四道闸:</para>
/// <list type="number">
///   <item>命令白名单 —— 只允许已验证的命令码下发, 杜绝"命令码算错写到别的寄存器"。</item>
///   <item>载荷值域 —— 按命令/子命令校验取值, 超范围直接拒绝。
///         <b>刻意不做静默钳制</b>: 静默改写会掩盖 bug, 让"下发了错误的值"变成看不见的事;
///         拒绝 + 告警才能让问题暴露。</item>
///   <item>写入限流 —— 令牌桶, 掐断自激循环 / 事件风暴导致的高频连写下发。
///         (Fn 热键 bug 正是这一类: 事件→写→事件 闭环, 一次按键连写十几次。)</item>
///   <item>审计日志 —— 每次下发与每次拒绝均留痕, 事后可复盘。</item>
/// </list>
///
/// <para>逃生舱: 配置 <c>Safety.WriteGateEnabled = false</c> 可整体停用拦截(仅保留日志),
/// 用于本闸门范围表判断有误时的紧急放行, 无需重新编译。</para>
/// </summary>
public static class HwWriteGate
{
    private static readonly ILog Logger = LogManager.GetLogger(typeof(HwWriteGate));

    // ── 1. 命令白名单 ────────────────────────────────────────────────
    // 取自全仓库 SetValue 调用点的实测枚举; 未被任何代码写入的命令一律拒绝。
    // 命令码覆盖 EC 的电源/灯效/键盘等关键寄存器, 写错地址后果不可预测。
    private static readonly HashSet<MethodName> WritableCommands = new()
    {
        MethodName.SystemPerMode,          // 8   性能模式
        MethodName.GpuMode,                // 9   显卡模式(混合/独显直连)
        MethodName.Ambientlight,           // 15  LOGO 灯
        MethodName.RGBKeyboardMode,        // 16  键盘灯效模式
        MethodName.RGBKeyboardColor,       // 17  键盘灯效颜色
        MethodName.RGBKeyboardBrightness,  // 18  键盘灯效亮度
        MethodName.MaxFanSpeedSwitch,      // 20  强冷开关
        MethodName.CPUPower,               // 23  CPU 功耗子系统(子协议见下)
    };

    // ── 2a. 单字节命令的值域 ──────────────────────────────────────────
    // 仅列入有明确证据的范围; 无证据者不做猜测, 只受白名单与限流约束。
    private static readonly Dictionary<MethodName, (byte Min, byte Max, string Name)> SingleRanges = new()
    {
        // SystemPerMode: 0/1/2 三档。3=CustomMode 是本项目新增的本地逻辑态,
        // 固件命令 8 不认识它 —— 下发 3 属于协议越界, 必须拦。
        [MethodName.SystemPerMode] = (0, 2, "性能模式"),
        // GpuMode 枚举: HybridMode=0 / DiscreteMode=1
        [MethodName.GpuMode] = (0, 1, "显卡模式"),
        // ResultState: OFF=0 / ON=1
        [MethodName.Ambientlight] = (0, 1, "LOGO 灯"),
        // RGBKeyboardBrightnessLevel: Level_0..Level_3
        [MethodName.RGBKeyboardBrightness] = (0, 3, "键盘亮度"),
        // bool 开关
        [MethodName.MaxFanSpeedSwitch] = (0, 1, "强冷开关"),
    };

    // ── 2b. CPUPower(23) 子命令值域 ──────────────────────────────────
    // 载荷为 [子命令, 值] 两字节; 单字节形式为 CloseState/OpenState 枚举。
    // 范围来源: 本项目 JiaoLongConfig 的 [ConfigRange] + docs/02_协议手册.md §6。
    private static readonly Dictionary<byte, (byte Min, byte Max, string Name)> CpuPowerRanges = new()
    {
        [(byte)CPUPower.CloseState] = (0, 0, "关闭自定义功耗"),
        [(byte)CPUPower.OpenState] = (0, 0, "打开自定义功耗"),
        [(byte)CPUPower.LongPower] = (5, 120, "SPL 长时功耗 (W)"),
        [(byte)CPUPower.ShortPower] = (5, 150, "SPPT 短时功耗 (W)"),
        // 温度墙上限 105 是硬件自身的保护线, 不允许软件把它顶得更高
        [(byte)CPUPower.CpuTempWallState] = (60, 105, "CPU 温度墙 (°C)"),
    };

    // ── 3. 限流: 令牌桶 ──────────────────────────────────────────────
    /// <summary>单命令突发容量: 允许一次拖拽/连续调节的短时密集写入。</summary>
    private const int PerCommandBurst = 5;
    /// <summary>单命令稳态补充速率(次/秒): 自激循环通常是数十次/秒, 会被掐断。</summary>
    private const double PerCommandRefillPerSec = 3.0;
    /// <summary>全局突发容量。</summary>
    private const int GlobalBurst = 20;
    /// <summary>全局稳态补充速率(次/秒)。</summary>
    private const double GlobalRefillPerSec = 10.0;

    private sealed class Bucket
    {
        public double Tokens;
        public long LastTick = Environment.TickCount64;
    }

    private static readonly ConcurrentDictionary<MethodName, Bucket> PerCommand = new();
    private static readonly Bucket Global = new() { Tokens = GlobalBurst };

    /// <summary>逃生舱开关。默认开启; 置 false 后只记日志不拦截。</summary>
    public static volatile bool Enabled = true;

    /// <summary>
    /// 校验一次写入。返回是否允许下发。
    /// </summary>
    /// <param name="method">目标命令码。</param>
    /// <param name="values">载荷字节(单值或 [子命令, 值])。</param>
    /// <param name="reason">被拒原因; 允许时为 null。</param>
    public static bool TryValidate(MethodName method, byte[] values, out string? reason)
    {
        reason = null;

        // —— 闸 1: 命令白名单 ——
        if (!WritableCommands.Contains(method))
        {
            reason = $"命令码 {(byte)method} ({method}) 不在可写白名单内";
            return Reject(method, values, reason);
        }

        // —— 闸 2: 载荷值域 ——
        if (method == MethodName.CPUPower)
        {
            if (values.Length == 1)
            {
                // 单字节形式只允许 CloseState(0)/OpenState(1) 两个子状态枚举
                if (values[0] != (byte)CPUPower.CloseState && values[0] != (byte)CPUPower.OpenState)
                {
                    reason = $"CPUPower 单字节载荷只允许 0(关闭)/1(打开), 实收 {values[0]}";
                    return Reject(method, values, reason);
                }
            }
            else if (values.Length >= 2)
            {
                if (!CpuPowerRanges.TryGetValue(values[0], out var r))
                {
                    reason = $"CPUPower 未知子命令 {values[0]}";
                    return Reject(method, values, reason);
                }
                if (values[1] < r.Min || values[1] > r.Max)
                {
                    reason = $"{r.Name} 值 {values[1]} 超出安全范围 {r.Min}~{r.Max}";
                    return Reject(method, values, reason);
                }
                // 子状态之外的值写入前必须先 OpenState, 由上层负责; 此处只做值域守门
            }
        }
        else if (values.Length == 1 &&
                 SingleRanges.TryGetValue(method, out var sr) &&
                 (values[0] < sr.Min || values[0] > sr.Max))
        {
            reason = $"{sr.Name} 值 {values[0]} 超出安全范围 {sr.Min}~{sr.Max}";
            return Reject(method, values, reason);
        }

        // —— 闸 3: 限流 ——
        var now = Environment.TickCount64;
        if (!Consume(Global, now, GlobalBurst, GlobalRefillPerSec))
        {
            reason = $"全局写入频率超限(>{GlobalRefillPerSec:0.#}次/秒稳态, 突发上限 {GlobalBurst})";
            return Reject(method, values, reason);
        }

        var bucket = PerCommand.GetOrAdd(method, _ => new Bucket { Tokens = PerCommandBurst });
        if (!Consume(bucket, now, PerCommandBurst, PerCommandRefillPerSec))
        {
            reason = $"命令 {method} 写入频率超限(>{PerCommandRefillPerSec:0.#}次/秒稳态, 突发上限 {PerCommandBurst})";
            return Reject(method, values, reason);
        }

        // —— 闸 4: 审计 ——
        if (Logger.IsDebugEnabled)
            Logger.Debug($"HW写入 {method}({(byte)method}) <- [{string.Join(",", values)}]");

        return true;
    }

    /// <summary>配置加载后由外部设置逃生舱开关。</summary>
    public static void Configure(bool enabled) => Enabled = enabled;

    private static bool Reject(MethodName method, byte[] values, string reason)
    {
        Logger.Warn($"HW写入闸门拦截: {reason} | 命令={method}({(byte)method}) 载荷=[{string.Join(",", values)}]");
        if (!Enabled)
        {
            Logger.Warn("HW写入闸门已停用(WriteGateEnabled=false), 本次放行 —— 该值未经安全校验, 风险自负");
            return true;
        }
        return false;
    }

    private static bool Consume(Bucket b, long now, int burst, double refillPerSec)
    {
        lock (b)
        {
            var elapsedSec = (now - b.LastTick) / 1000.0;
            if (elapsedSec > 0)
            {
                b.Tokens = Math.Min(burst, b.Tokens + elapsedSec * refillPerSec);
                b.LastTick = now;
            }

            if (b.Tokens < 1.0)
                return false;

            b.Tokens -= 1.0;
            return true;
        }
    }
}
