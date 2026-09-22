namespace JiaoLongControl.Server.Core.Services;

/// <summary>
/// SMU setter 值域闸门（v4 §8.6 / Phase 1）。
/// PawnIO 路径不经过 <see cref="HwWriteGate"/>，本闸是 Server 侧第二道防线。
/// 前端 writeGate.ts 是一致性校验，不得作为唯一防线。
/// </summary>
public static class SmuWriteGate
{
    public readonly record struct Range(double Min, double Max, bool RejectZero, string Name);

    /// <summary>与 Client writeGate.ts SMU_RANGES / ZERO_UNWRITABLE 对齐。</summary>
    public static readonly Dictionary<string, Range> Ranges = new()
    {
        ["StapmLimit"] = new(0, 200, true, "STAPM 长期功耗上限 (W)"),
        ["StapmTime"] = new(0, 3600, true, "STAPM 时间窗口 (s)"),
        ["FastLimit"] = new(0, 200, true, "Fast 瞬时功耗上限 (W)"),
        ["SlowLimit"] = new(0, 200, true, "Slow 持续功耗上限 (W)"),
        ["SlowTime"] = new(0, 3600, true, "Slow 功耗时间窗口 (s)"),
        ["PptLimitRsmu"] = new(0, 200, true, "PPT 功耗限制 RSMU (W)"),
        ["VrmCurrentMp1"] = new(0, 300000, true, "VRM 持续电流 MP1 (mA)"),
        ["VrmCurrentRsmu"] = new(0, 300000, true, "VRM 持续电流 RSMU (mA)"),
        ["EdcLimitMp1"] = new(0, 300000, true, "EDC 瞬间电流 MP1 (mA)"),
        ["EdcLimitRsmu"] = new(0, 300000, true, "EDC 瞬间电流 RSMU (mA)"),
        ["TempLimitMp1"] = new(40, 100, false, "温度墙 MP1 (°C)"),
        ["TempLimitRsmu"] = new(40, 100, false, "温度墙 RSMU (°C)"),
        ["PboScalar"] = new(1, 10, false, "PBO 倍率"),
        ["OcClk"] = new(-500, 500, false, "超频核心频率偏移 (MHz)"),
        ["OcVolt"] = new(0, 1550, false, "超频核心电压 (mV)"),
        ["CurveOptimizerAll"] = new(-30, 0, false, "全核电压偏移"),
        ["CurveOptimizerPerCore"] = new(-30, 0, false, "逐核电压偏移"),
        // Server 端 arg = (coreIdx << 8) | (mhz & 0xFF)：>255 会被静默截断
        ["PerCoreOcClk"] = new(0, 255, false, "逐核超频频率偏移 (MHz)"),
    };

    public static bool TryValidate(string key, double value, out string? reason)
    {
        reason = null;
        if (!Ranges.TryGetValue(key, out var r))
        {
            reason = $"未知 SMU 参数 {key}";
            return false;
        }

        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            reason = $"{r.Name} 值无效";
            return false;
        }

        if (r.RejectZero && value == 0)
        {
            reason = $"{r.Name} 值为 0（多为读取失败），已阻止写入";
            return false;
        }

        if (value < r.Min || value > r.Max)
        {
            reason = $"{r.Name} 值 {value} 超出安全范围 {r.Min}~{r.Max}";
            return false;
        }

        return true;
    }
}