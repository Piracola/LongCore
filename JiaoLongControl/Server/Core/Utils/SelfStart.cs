using JiaoLongControl.Server.Interop;

namespace JiaoLongControl.Server.Core.Utils;

public class SelfStart
{
    public SelfStart()
    {
        var bridge = Bridge.Instance;
        if (bridge.Config.App.BootAdvancedFanControlSystem) Fan();
        if (bridge.Config.App.BootAdvancedCPUSystem) CPU();
        if (bridge.Config.App.BootAdvancedGPUSystem) GPU();
        if (bridge.Config.App.BootSetRyzenSumCurveOptimizerAll)
            bridge.RyzenSmu.SetCurveOptimizerAll(bridge.Config.Smu.CurveOptimizerAll);
        if (bridge.Config.App.BootKeyboardGradient) bridge.KeyboardGradient.Start();
    }

    /// <summary>
    /// 应用内风扇曲线接管。两个条件都满足才启动:
    ///   · BootAdvancedFanControlSystem —— 开机自启意图;
    ///   · Fan.Enabled —— 用户在曲线页保留的总开关(关掉服务会置 false, 避免下次开机被强行拉起)。
    /// 与上游的关键差别: 曲线接管不再限定"自定义档位"。
    /// 固件三档(办公/游戏/狂飙)的 EC 温控表在低负载区压得极低、临近温度墙才跳变,
    /// 表现为"平时很静、95℃ 才猛拉"; 要让风扇随温度平缓跟随, 必须由应用接管。
    /// 接管后 EC 自身温控曲线会被 0xB20 手动掩码绕开, 兜底仅剩 ThermalWatchdog(默认 98℃/10s 拉满)
    /// 与 EcGuard(崩溃后恢复自动模式), 二者均默认开启。
    /// </summary>
    private void Fan()
    {
        var bridge = Bridge.Instance;
        if (!bridge.Config.Fan.Enabled)
            return;
        bridge.AutoFan.Start();
    }

    private void CPU()
    {
        var bridge = Bridge.Instance;
        var cpu = bridge.Config.Cpu.Custom;
        // 必须先打开自定义功耗子状态(命令 23 = OpenState), 否则下面三个写入会被 EC 拒绝。
        // 官方 SetSP_CustomMode 把 SPL/SPPT/温度墙 的写入严格包在 if (m == OpenState) 内。
        bridge.CPU.SetCustomMode(true);
        bridge.CPU.SetCpuLongPower(cpu.CpuLongPower);
        bridge.CPU.SetCpuShortPower(cpu.CpuShortPower);
        bridge.CPU.SetCPUTempWall(cpu.CpuTempWall);
        bridge.Power.SetCPUMaxFrequency(cpu.CpuMaxFrequency);
        if (cpu.CpuTurbo)
            bridge.Power.EnableTurbo();
        else
            bridge.Power.DisableTurbo();
    }

    private void GPU()
    {
        var bridge = Bridge.Instance;
        var gpu = bridge.Config.Gpu;
        bridge.NvidiaGpu.LockGpuClock(gpu.GpuClock);
        bridge.NvidiaGpu.LockMemoryClock(gpu.MemoryClock);
        // bridge.NvidiaGpu.SetPowerLimit(gpu.PowerLimit);
        // if (gpu.CoreClockOffset != 0 || gpu.MemoryClockOffset != 0)
            // bridge.NvidiaGpu.ApplyClockOffsets(gpu.CoreClockOffset, gpu.MemoryClockOffset);
        // if (gpu.VoltageBoostPercent > 0)
            // bridge.NvidiaGpu.SetVoltageBoostPercent(gpu.VoltageBoostPercent);
    }
}
