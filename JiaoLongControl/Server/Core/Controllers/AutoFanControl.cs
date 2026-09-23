using System.Runtime.InteropServices;
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Utils;
using JiaoLongControl.Server.Interop;
using log4net;

namespace JiaoLongControl.Server.Core.Controllers;

public enum FanType
{
    CPU,
    GPU
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public class AutoFanControl : IDisposable
{
    private volatile bool _isRunning;

    /// <summary>上一次控制循环的时间戳(TickCount64), 用于把滤波时间常数换算成实际的采样间隔。</summary>
    private long _lastLoopTickMs;
    private readonly ILog Logger = LogManager.GetLogger(typeof(AutoFanControl));
    private CancellationTokenSource? _cts;
    private Task? _controlTask;
    private const int IntervalMs = 1000;
    
    private const int RPM_UNIT_DIVISOR = 100; // 1 unit = 100 RPM
    private const int MAX_FAN_BYTE = 58;      // 58 * 100 = 5800 RPM (官方 fastestMode 上限)
    // 下限不再是 0: 手动模式下风扇停转会绕开 EC 自身温控, Blding64 护栏会硬性拒绝 0,
    // 曲线若算出 0 只会静默失败。统一以 1500 RPM 为全应用手动转速下限
    // (与默认曲线最低点、配置 ManualFanSpeed 默认值一致)。
    private const int MIN_FAN_BYTE = 15;       // 15 * 100 = 1500 RPM

    // ── 转速斜坡 ─────────────────────────────────────────────────────
    // 这不是调参旋钮, 而是"防单帧野值打满转速"的限幅器: 真机实测温度秒级变化
    // p99=5℃、最大 9℃, 而热质量决定真实水温不可能这样跳。限幅器与温控参数解耦,
    // 因为让用户去调"每秒最多变多少 RPM"只会把问题从温度域挪到转速域, 更难理解。
    //
    // 降温方向每秒最多退一格(100 RPM), 让高温状态多保持一会儿。升温方向**不设限**:
    // 真实的温度爬升必须能立刻追上, 安全优先于安静; 单帧野值由跟踪器和不灵敏带负责挡。
    private const int MaxRampDownBytePerSec = 1;

    // ── 温度跟踪参数 ─────────────────────────────────────────────────
    // 一次控制循环里同时维护两个跟踪器(见 UpdateTrackers), 都是双向一阶低通, 区别只在时间常数:
    //   Attack  —— 时间常数小(默认 5 秒), 用于**升速判定并直接给出升速目标**;
    //   Release —— 时间常数大(默认 60 秒), 用于**降速目标**, 也是"保持高转速"的时间来源。
    // 两者都取自同一个 1 秒温度读数。单帧野值(实测最大 +9℃/秒)由时间常数挡,
    // 持续漂移由下面两个门槛挡。
    private int AttackTimeConstantS => Math.Clamp(Bridge.Instance.Config.Fan.TempAttackS, 2, 60);
    private int ReleaseTimeConstantS => Math.Clamp(Bridge.Instance.Config.Fan.TempReleaseS, 10, 300);

    // 不灵敏带是**不对称**的, 且两个方向都从同一个用户旋钮换算:
    // 升速门槛 ≈ 0.6×, 降速门槛 ≈ 1.6×(至少比升速门槛多 1℃)。
    // 方向不对称正是"进入高转速后即使温度下降也保持更久"的直接实现 —— 升速只需
    // 确认 3℃ 的真实升温, 降速却要等温度从上次决策点回落 8℃。一个旋钮仍然只讲一件事
    // ("多大变化才算变化"), 用户不必理解两个数。
    private float RiseGateC => Math.Max(2f, MathF.Round(HysteresisC * 0.6f, MidpointRounding.AwayFromZero));
    private float FallGateC => Math.Max(RiseGateC + 1f, MathF.Round(HysteresisC * 1.6f, MidpointRounding.AwayFromZero));
    private float HysteresisC => Math.Clamp(Bridge.Instance.Config.Fan.TempHysteresisC, 0, 15);

    private class FanState
    {
        /// <summary>慢速降温跟踪值 —— 查曲线用的就是它, 日志里的温度也是它。</summary>
        public float ReleaseTemp { get; set; } = -1f;

        /// <summary>快速升温跟踪值 —— 只参与"是否允许升速"的判定。</summary>
        public float AttackTemp { get; set; } = -1f;

        /// <summary>上一次真正写入硬件后所锚定的温度(决策温度), 用于温度域不灵敏带。</summary>
        public float LastDecisionTemp { get; set; } = float.NaN;

        /// <summary>实际写入硬件的转速格数(-1 = 本进程尚未写过)。</summary>
        public int LastAppliedByte { get; set; } = -1;

        /// <summary>
        /// 降温方向的目标缓存。每次写出后与硬件实际值对齐, 因此在"不灵敏带挂起"期间
        /// 它不会累积出一个与硬件相反的请求。
        /// </summary>
        public int ReleaseRequestByte { get; set; } = -1;
    }
    
    private readonly Dictionary<FanType, FanState> _states = new()
    {
        { FanType.CPU, new FanState() },
        { FanType.GPU, new FanState() }
    };

    public CommandResult IsRunning()
    {
        return new CommandResult(_isRunning, _isRunning ? "自动风扇控制正在运行" : "自动风扇控制没有在运行中", _isRunning);
    }

    public CommandResult Start()
    {
        if (_isRunning)
            return new CommandResult(true, "自动风扇控制已经运行中");
        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        _controlTask = Task.Factory.StartNew(
            () => ControlLoop(token),
            token,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default
        );
        Thread.Sleep(50);
        return new CommandResult(true, "自动风扇控制启动");
    }

    public CommandResult Stop()
    {
        if (!_isRunning)
            return new CommandResult(!_isRunning, "自动风扇控制没有在运行中");
        Logger.Info("Auto Fan Control stopping...");
        _cts?.Cancel();
        try
        {
            _controlTask?.Wait(2000);
        }
        catch (AggregateException) { }
        catch (Exception ex)
        {
            Logger.Error(ex.Message);
        }
        finally
        {
            _isRunning = false;
        }
        return new CommandResult(_isRunning, "自动风扇控制已停止");
    }

    private void ControlLoop(CancellationToken token)
    {
        _isRunning = true;
        Logger.Info("Auto Fan Control started with Cross-Cooling Algorithm.");
        
        lock (_states)
        {
            _states[FanType.CPU] = new FanState();
            _states[FanType.GPU] = new FanState();
        }

        try
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    // 采样周期用真实经过时间: 循环里还有两次 WMI 读取, 标称 1000ms 会漂,
                    // 而时间常数按秒定义, 用标称值会让滤波强度随负载变化。
                    var nowMs = Environment.TickCount64;
                    if (nowMs < _lastLoopTickMs) _lastLoopTickMs = nowMs;
                    var elapsedS = _lastLoopTickMs == 0 ? 1.0 : (nowMs - _lastLoopTickMs) / 1000.0;
                    _lastLoopTickMs = nowMs;

                    var fanCfg = Bridge.Instance.Config.Fan;
                    float rawCpuTemp = Convert.ToSingle(Bridge.Instance.CPU.GetCPUThermometer().Data);
                    var (cpuRelease, cpuAttack) = UpdateTrackers(FanType.CPU, rawCpuTemp, elapsedS);

                    var gpuTempResult = Bridge.Instance.NvidiaGpu.GetGpuTemperature();
                    // 读不到独显温度时沿用 GPU 自己的上一次跟踪值, 不要回退成 CPU 温度:
                    // 本机 CPU 单调 80~86℃, 一旦回退, 只接一路 GPU 风扇也会被 CPU 拽到高转速,
                    // 与"各自跟随自己温度"的设计相互抵消。(实测日志中该分支从未触发。)
                    float rawGpuTemp = gpuTempResult.Success
                        ? Convert.ToSingle(gpuTempResult.Data)
                        : GetReleaseTemp(FanType.GPU);
                    var (gpuRelease, gpuAttack) = UpdateTrackers(FanType.GPU, rawGpuTemp, elapsedS);

                    if (fanCfg.FanCurveMerge)
                    {
                        // 两风扇取同一目标: 转速相同 → 音高相同 → 拍频(beating)消失。
                        // 取两路各自"降温跟踪值"中更热的一路作为共同决策温度, 于是两个
                        // 风扇在同一温度锚点上做同一次判断, 不灵敏带不会各走各的。
                        if (cpuRelease >= gpuRelease)
                        {
                            ProcessAndApplyFanSpeed(FanType.CPU, cpuRelease, cpuAttack);
                            ProcessAndApplyFanSpeed(FanType.GPU, cpuRelease, cpuAttack);
                        }
                        else
                        {
                            ProcessAndApplyFanSpeed(FanType.CPU, gpuRelease, gpuAttack);
                            ProcessAndApplyFanSpeed(FanType.GPU, gpuRelease, gpuAttack);
                        }
                    }
                    else
                    {
                        // 各自跟随自己的温度。原先这里有一条 0.85 的"共享热管交叉同步":
                        // 冷的一侧会被热的一侧拖上去 —— 实测 GPU 56℃ 时 GPU 风扇被顶到
                        // 3400 RPM, 而它按自己的曲线只需 1500~1800 RPM。那是纯软件引入、
                        // 零散热收益的噪音源, 两个不同转速叠加出的拍频也正是
                        // "噪音一直在变"里最难忍的那部分。
                        ProcessAndApplyFanSpeed(FanType.CPU, cpuRelease, cpuAttack);
                        ProcessAndApplyFanSpeed(FanType.GPU, gpuRelease, gpuAttack);
                    }

                    Task.Delay(IntervalMs, token).Wait(token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Logger.Error($"ControlLoop Error: {ex.Message}");
                    Thread.Sleep(2000);
                }
            }
        }
        finally
        {
            _isRunning = false;
            Logger.Info("Auto Fan Control stopped.");
        }
    }
    
    /// <summary>GPU 读不到温度时的回退值: 慢跟踪值(它会随时间收敛到真实温度, 不是冻结值)。</summary>
    private float GetReleaseTemp(FanType type)
    {
        lock (_states)
        {
            var t = _states[type].ReleaseTemp;
            return t < 0 ? 0f : t;
        }
    }

    /// <summary>
    /// 一次控制循环里同时推进快/慢两个温度跟踪器, 返回 (降温值, 升温值)。
    ///
    /// 为什么是两个: 单一跟踪值无法同时满足"真实升温要跟得上"和"温度回落要多保持" ——
    /// 调快则抖动复发, 调慢则真实升温时掉队。拆开后, 快跟踪器只负责升速(追得上),
    /// 慢跟踪器只负责降速(退得慢), 两个方向互不牵制。
    /// 注意两个跟踪器自身都是对称的: 不对称性只由 ProcessAndApplyFanSpeed 里的两个门槛提供。
    /// </summary>
    private (float Release, float Attack) UpdateTrackers(FanType type, float rawTemp, double elapsedS)
    {
        FanState state;
        lock (_states) { state = _states[type]; }

        if (state.ReleaseTemp < 0)
        {
            state.ReleaseTemp = rawTemp;
            state.AttackTemp = rawTemp;
        }
        else
        {
            // 一阶低通, 系数由时间常数换算: 采样周期相对时间常数很小时 a ≈ dt/τ。
            // dt 用真实经过时间而不是标称 1000ms —— 循环里还有两次 WMI 读取,
            // 实际周期会漂, 用标称值会让时间常数随负载变化。
            // 两个跟踪器都是双向一阶低通, 区别只在时间常数 —— 这是刻意的:
            // 曾试过让慢跟踪器走"只升不降的包络"(温度下降时按固定速率衰减), 结论是更差:
            // 它不跟随真实温度回落到新水平, 风扇长期停在比曲线要求更高的转速上,
            // 离线重放里散热赤字反而更大。真正负责"保持高转速"的是两个门槛, 不是跟踪器本身。
            var dt = (float)Math.Clamp(elapsedS, 0.02, 5.0);
            var aAttack = Math.Clamp(dt / AttackTimeConstantS, 0f, 1f);
            var aRelease = Math.Clamp(dt / ReleaseTimeConstantS, 0f, 1f);
            state.AttackTemp += aAttack * (rawTemp - state.AttackTemp);
            state.ReleaseTemp += aRelease * (rawTemp - state.ReleaseTemp);
        }

        return (state.ReleaseTemp, state.AttackTemp);
    }
    /// <summary>
    /// 决定这一次循环要不要写硬件, 要写就写哪一个转速。
    ///
    /// 规则(顺序即优先级):
    ///   1) 升速: 快跟踪值比锚点高出 RiseGateC 就写, 目标取快跟踪值对应的曲线点。
    ///      升速不受斜坡限制 —— 真升温必须追得上, 安全优先于安静。
    ///   2) 降速: 降温跟踪值比锚点低 FallGateC 才写, 且只走"请求值"(每秒最多退一格),
    ///      并且只在请求值低于硬件实际值时才执行。绝不用原始目标直接写硬件: 挂起期间
    ///      缓存的目标会与硬件实际值反向, 一恢复调整就会把转速写反(离线重放抓到过)。
    ///   3) 两个门槛都不满足时不写硬件, 并把请求值收敛到硬件实际值。
    /// 不灵敏带直接以温度为锚点, 因此与曲线陡峭程度无关(旧实现在转速域设死区, 曲线一改就失效)。
    /// </summary>
    private void ProcessAndApplyFanSpeed(FanType type, float releaseTemp, float attackTemp)
    {
        FanState state;
        lock (_states) { state = _states[type]; }

        // 冷启动: 直接落到曲线值, 不做渐变 —— 开机的第一秒没有历史可言。
        if (state.LastAppliedByte < 0)
        {
            var initial = Math.Clamp(CalculateFanSpeed(releaseTemp, type), MIN_FAN_BYTE, MAX_FAN_BYTE);
            ApplyFanSpeed(type, initial, releaseTemp);
            return;
        }

        // 每秒最多退一格(100 RPM): 降温方向的"慢"由跟踪器负责, 这里只补一道限速,
        // 保证温度骤降也不会把转速一次砍下去。只在请求值仍高于曲线目标时才退 ——
        // 请求值永远追赶目标, 不因挂起而与目标脱节。
        var releaseTarget = CalculateFanSpeed(releaseTemp, type);
        if (state.ReleaseRequestByte > releaseTarget)
        {
            state.ReleaseRequestByte = Math.Max(
                releaseTarget,
                state.ReleaseRequestByte - MaxRampDownBytePerSec);
        }

        // 不对称双闩锁, 锚点是"上次写硬件那一刻的降温跟踪值":
        //   升速 —— 只要快跟踪值比锚点高出一个升速门槛就走, 目标**直接取快跟踪值**。
        //          这一条是保证"风扇至少不低于曲线要求"的关键: 转速由慢跟踪值主导会让
        //          风扇长期欠冷(离线重放实测进入负载起初 19 分钟转速比曲线要求低 400~900 RPM)。
        //   降速 —— 要等降温跟踪值比锚点低一个(更大的)降速门槛, 再经每秒一格的请求值执行。
        var anchor = state.LastDecisionTemp;
        var newByte = state.LastAppliedByte;

        if (attackTemp - anchor >= RiseGateC)
        {
            newByte = Math.Max(
                Math.Clamp(CalculateFanSpeed(attackTemp, type), MIN_FAN_BYTE, MAX_FAN_BYTE),
                state.LastAppliedByte);
        }
        else if (anchor - releaseTemp >= FallGateC && state.ReleaseRequestByte < state.LastAppliedByte)
        {
            newByte = Math.Max(state.ReleaseRequestByte, MIN_FAN_BYTE);
        }

        if (newByte == state.LastAppliedByte)
        {
            // 不灵敏带内不写硬件, 但把请求值收敛到硬件实际值 —— 否则"挂起期间累计的
            // 目标差"会在恢复调整的那一刻被一次性补写出去。
            state.ReleaseRequestByte = state.LastAppliedByte;
            return;
        }

        ApplyFanSpeed(type, newByte, releaseTemp);
    }

    /// <summary>唯一的硬件写入点。写入成功后刷新决策温度锚点, 不灵敏带因此重新起算。</summary>
    private void ApplyFanSpeed(FanType type, int speedByte, float decisionTemp)
    {
        var rpm = speedByte * RPM_UNIT_DIVISOR;
        if (type == FanType.CPU)
        {
            Bridge.Instance.Fan.CpuFanSetSpeed((byte)speedByte);
            Logger.Info($"CPU Temp: {decisionTemp:F1}°C | CPU Fan Applied: {rpm} RPM");
        }
        else
        {
            Bridge.Instance.Fan.GpuFanSetSpeed((byte)speedByte);
            Logger.Info($"GPU Temp: {decisionTemp:F1}°C | GPU Fan Applied: {rpm} RPM");
        }

        lock (_states)
        {
            var state = _states[type];
            state.LastDecisionTemp = decisionTemp;
            state.LastAppliedByte = speedByte;
            state.ReleaseRequestByte = speedByte;
        }
    }
    /// <summary>按温度查曲线换成转速格数。曲线缺失时退回最低转速而不是 25 格(2500)。</summary>
    private static int CalculateFanSpeed(float currentTemp, FanType type)
    {
        var config = Bridge.Instance.Config.Fan;
        List<FanPoint> configPoints = type == FanType.CPU ? config.CpuFanCurve : config.GpuFanCurve;
        if (configPoints == null || configPoints.Count == 0)
            return MIN_FAN_BYTE;
            
        var sortedPoints = configPoints.OrderBy(p => p.temp).ToList();
        double targetRpm;
        if (currentTemp <= sortedPoints.First().temp)
        {
            targetRpm = sortedPoints.First().speed;
        }
        else if (currentTemp >= sortedPoints.Last().temp)
        {
            targetRpm = sortedPoints.Last().speed;
        }
        else
        {
            targetRpm = sortedPoints.First().speed;
            for (int i = 0; i < sortedPoints.Count - 1; i++)
            {
                var p1 = sortedPoints[i];
                var p2 = sortedPoints[i + 1];

                if (currentTemp >= p1.temp && currentTemp <= p2.temp)
                {
                    double ratio = (currentTemp - p1.temp) / (double)(p2.temp - p1.temp);
                    targetRpm = p1.speed + (p2.speed - p1.speed) * ratio;
                    break;
                }
            }
        }
        int targetByte = (int)Math.Round(targetRpm / RPM_UNIT_DIVISOR);
        return Math.Clamp(targetByte, MIN_FAN_BYTE, MAX_FAN_BYTE);
    }

    public void Dispose()
    {
        Stop();
        _cts?.Dispose();
    }
}