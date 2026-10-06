using System.Runtime.InteropServices;
using System.Text;
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

    /// <summary>
    /// 上一拍的风扇配置指纹。变化 = 用户在曲线页/设置页改了控制律用到的东西,
    /// 当拍就要按新配置重算一次(见 ProcessAndApplyFanSpeed 的 configChanged 分支)。
    /// </summary>
    private string _lastFanConfigFingerprint = string.Empty;
    private readonly ILog Logger = LogManager.GetLogger(typeof(AutoFanControl));
    private CancellationTokenSource? _cts;
    private Task? _controlTask;
    private const int IntervalMs = 1000;
    
    private const int RPM_UNIT_DIVISOR = 100; // 1 unit = 100 RPM
    private const int MAX_FAN_BYTE = 58;      // 58 * 100 = 5800 RPM (官方 fastestMode 上限)
    // 下限不再是 0: 风扇停转会绕开 EC 自身温控, Blding64 护栏会硬性拒绝 0,
    // 曲线若算出 0 只会静默失败。统一以 1500 RPM 为全应用转速下限
    // (与默认曲线最低点、前端 FAN_MIN_RPM 一致)。
    private const int MIN_FAN_BYTE = 15;       // 15 * 100 = 1500 RPM

    // ── 转速斜坡 ─────────────────────────────────────────────────────
    // 这不是调参旋钮, 而是"防单帧野值打满转速"的限幅器: 真机实测温度秒级变化
    // p99=5℃、最大 9℃, 而热质量决定真实水温不可能这样跳。限幅器与温控参数解耦,
    // 因为让用户去调"每秒最多变多少 RPM"只会把问题从温度域挪到转速域, 更难理解。
    //
    // 降温方向每秒最多退一格(100 RPM), 让高温状态多保持一会儿。升温方向**不设限**:
    // 真实的温度爬升必须能立刻追上, 安全优先于安静; 单帧野值由跟踪器和不灵敏带负责挡。
    private const int MaxRampDownBytePerSec = 1;

    // ── 噪音忍耐度三档 ────────────────────────────────────────────────
    // 一个旋钮同时驱动三件事: 曲线缩放、不灵敏带、安全下限阈值。
    // 只缩放曲线不够 —— 安全下限若不跟着动, 安静档会被下限顶回高转速, 档位形同虚设。
    // 数值来自 research/tools/fan_replay.py 离线重放(中等负载, 6 seed 平均):
    //   安静 32.1 dBA / 均衡 32.8 / 强冷 34.1; 90℃ 低档秒数 75 / 0 / 0。
    // 下限是"绕过不灵敏带的硬地板", 只在高温段生效, 与曲线缩放是叠加关系。
    private enum NoiseTier { Quiet, Balanced, Performance }

    /// <summary>曲线整体缩放。安静档压低全程转速, 强冷档抬高。</summary>
    private static float CurveScaleFor(NoiseTier t) => t switch
    {
        NoiseTier.Quiet => 0.85f,
        NoiseTier.Performance => 1.12f,
        _ => 1.0f,
    };

    /// <summary>不灵敏带宽度(℃)。安静档带更宽 → 写入次数从 14 降到 9, 转速更少变动。</summary>
    private static float HysteresisFor(NoiseTier t) => t switch
    {
        NoiseTier.Quiet => 8f,
        NoiseTier.Performance => 3f,
        _ => 5f,
    };

    /// <summary>安全下限表(温度℃, 转速格)。绕过不灵敏带, 温度到此转速必不低于此值。</summary>
    private static readonly (float TempC, int Byte)[] FloorTableQuiet =
        { (92f, 48), (95f, 56) };
    private static readonly (float TempC, int Byte)[] FloorTableBalanced =
        { (88f, 45), (91f, 50), (94f, 56) };
    private static readonly (float TempC, int Byte)[] FloorTablePerformance =
        { (86f, 45), (89f, 50), (92f, 56) };

    private static (float TempC, int Byte)[] FloorTableFor(NoiseTier t) => t switch
    {
        NoiseTier.Quiet => FloorTableQuiet,
        NoiseTier.Performance => FloorTablePerformance,
        _ => FloorTableBalanced,
    };

    // 退出滞回: 已生效的下限要解除, 需回落到「进入阈值 − 2℃」, 否则温度在阈值附近
    // 抖动会让下限反复进出, 那正是"转速一直在变"最难忍的形态。
    private const float FloorReleaseC = 2f;

    // ── 偏离存活期 ────────────────────────────────────────────────────
    // 转速持续高出当前曲线要求的幅度与时长上限 —— 超过就允许进入降速段, 不再干等
    // "比锚点低 FallGateC"。来历与口径见 InSustainedExcess 的注释:
    // 尖峰后温度平住时, 温度域的两个门槛都永远不满足, 高转速会永久停在那里。
    private const int ExcessReleaseBytes = 8;          // 8 格 = 800 RPM
    private const int ExcessReleaseSustainMs = 60_000; // 持续 60 秒

    private static NoiseTier CurrentTier()
    {
        var v = Bridge.Instance.Config.Fan.NoiseTolerance;
        return v switch { <= 0 => NoiseTier.Quiet, >= 2 => NoiseTier.Performance, _ => NoiseTier.Balanced };
    }

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
    // 门槛按当前档位取值: 档位表里的 HysteresisFor 覆盖配置里的 TempHysteresisC,
    // 因为噪音档位必须同时移动"带宽度"和"下限阈值"才能真的改变噪音, 单独挪一个无效。
    // 用户若在设置页手动改过 TempHysteresisC, 仍以档位为准 —— 档位是更上层的意图表达。
    private float RiseGateC => Math.Max(2f, MathF.Round(HysteresisFor(CurrentTier()) * 0.6f, MidpointRounding.AwayFromZero));
    private float FallGateC => Math.Max(RiseGateC + 1f, MathF.Round(HysteresisFor(CurrentTier()) * 1.6f, MidpointRounding.AwayFromZero));

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

        /// <summary>
        /// 是否已进入"降速段"。降速门槛(FallGateC)只负责判定"可以开始降了",
        /// 一旦进入, 就每秒退一格直到追上曲线 —— 见 ProcessAndApplyFanSpeed。
        /// 没有这个标志时, 每一格都要重新等一次门槛(锚点随每次写出刷新),
        /// 实际退化成"每 FallGateC 度才降 100 RPM"。
        /// </summary>
        public bool Descending { get; set; }

        /// <summary>
        /// "转速持续高出曲线"的起算时刻(TickCount64; 0 = 当前没有超限)。见 InSustainedExcess。
        /// </summary>
        public long ExcessSinceMs { get; set; }
    }
    
    private readonly Dictionary<FanType, FanState> _states = new()
    {
        { FanType.CPU, new FanState() },
        { FanType.GPU, new FanState() }
    };

    /// <summary>
    /// 曲线服务是否在运行。**这是查询: 恒 Success = true, 运行态在 Data。**
    /// 契约: `CommandResult.Success` 只表达"这次查询/命令本身成不成功", 业务取值一律进 Data;
    /// **不要**把运行态塞进 Success —— 2026-10-06 修过一次。前端 `useAppliedFeatures.readOne`
    /// 把 `Success !== true` 当"读取失败", `judgeRemoval` 又要求 state === 'ok', 于是旧写法
    /// (`Success = _isRunning`) 让看板 fan.curve 行在曲线没跑(正常态)时显示"读取失败",
    /// 点「移除」时三步真下发却判"未确认移除成功" —— 两个方向都是假红。
    /// 同族第二处(FanController.GetMaxFanSpeedSwitch)一并修; 见 docs/UI重构_最终方案_v4.md §14.11。
    /// </summary>
    public CommandResult IsRunning()
    {
        return new CommandResult(true, _isRunning ? "自动风扇控制正在运行" : "自动风扇控制没有在运行中", _isRunning);
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

    /// <summary>
    /// 停止自动风扇控制。三态语义, 三态都要保住(2026-10-06 修, 别再写反):
    ///   1. 本来就没在跑              → Success = true (幂等, 调用方可以无脑调用)
    ///   2. 真停成功(循环已在 2s 内退出) → Success = true
    ///   3. 2s 内没退出来(循环卡在硬件读取, 或异常分支的 2s 退避里) → Success = false, Message 如实说明
    /// 旧实现把 finally 之后的 _isRunning 当返回值, 于是「真停成功」报 false、「本来没跑」报 true,
    /// 语义正好反了: 前端按 Success 判步骤成败, 于是停止这一步判 failed、后续撤 0xB20 掩码
    /// 与落盘 Fan.Enabled=false 永不执行 —— EC 温控接不回来, 风扇停在最后一次写入的转速上。
    /// 返回值只是命令侧证据: 调用方仍须独立回读 IsRunning() 才敢动掩码(useFanCurveEditor/useAppliedFeatures)。
    /// </summary>
    public CommandResult Stop()
    {
        if (!_isRunning)
            return new CommandResult(true, "自动风扇控制没有在运行中");
        Logger.Info("Auto Fan Control stopping...");
        _cts?.Cancel();

        var task = _controlTask;
        var exited = task == null;
        if (task != null)
        {
            try
            {
                // Wait(timeout) 返回 true = 任务在超时内结束; false = 控制循环还活着
                exited = task.Wait(2000);
            }
            catch (AggregateException ex)
            {
                // 循环以异常结束: 任务确实已退出(服务停了), 但原因要记下来
                exited = true;
                Logger.Error($"Auto Fan Control loop faulted: {ex.InnerException?.Message ?? ex.Message}");
            }
            catch (Exception ex)
            {
                Logger.Error(ex.Message);
            }
        }

        if (!exited)
        {
            // 循环没退出来 = 它随时可能再写硬件。这里**绝不能**清 _isRunning 装成已停:
            // 调用方一旦误以为停成功就会去撤手动掩码, 而曲线下一拍又把掩码写回来。
            Logger.Warn("Auto Fan Control stop timed out: control loop still running.");
            return new CommandResult(false, "自动风扇控制停止超时：控制循环仍在运行，请重试", _isRunning);
        }

        _isRunning = false;
        return new CommandResult(true, "自动风扇控制已停止");
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
                    // 配置热改(曲线页拖动即存盘)必须当拍生效 —— 见 ProcessAndApplyFanSpeed 的
                    // configChanged 分支。指纹只覆盖控制律真正用到的项, 改日志级别之类不会触发。
                    var fingerprint = FanConfigFingerprint();
                    var configChanged = !string.Equals(
                        fingerprint, _lastFanConfigFingerprint, StringComparison.Ordinal);
                    _lastFanConfigFingerprint = fingerprint;

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
                            ProcessAndApplyFanSpeed(FanType.CPU, cpuRelease, cpuAttack, configChanged);
                            ProcessAndApplyFanSpeed(FanType.GPU, cpuRelease, cpuAttack, configChanged);
                        }
                        else
                        {
                            ProcessAndApplyFanSpeed(FanType.CPU, gpuRelease, gpuAttack, configChanged);
                            ProcessAndApplyFanSpeed(FanType.GPU, gpuRelease, gpuAttack, configChanged);
                        }
                    }
                    else
                    {
                        // 各自跟随自己的温度。原先这里有一条 0.85 的"共享热管交叉同步":
                        // 冷的一侧会被热的一侧拖上去 —— 实测 GPU 56℃ 时 GPU 风扇被顶到
                        // 3400 RPM, 而它按自己的曲线只需 1500~1800 RPM。那是纯软件引入、
                        // 零散热收益的噪音源, 两个不同转速叠加出的拍频也正是
                        // "噪音一直在变"里最难忍的那部分。
                        ProcessAndApplyFanSpeed(FanType.CPU, cpuRelease, cpuAttack, configChanged);
                        ProcessAndApplyFanSpeed(FanType.GPU, gpuRelease, gpuAttack, configChanged);
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
    ///   2) 降速: 降温跟踪值比锚点低 FallGateC 才**进入降速段**; 进入之后每秒最多退一格
    ///      (ReleaseRequestByte), 一直退到当前温度对应的曲线目标为止。
    ///      只走请求值、且只在请求值低于硬件实际值时才写 —— 绝不用原始目标直接写硬件:
    ///      挂起期间缓存的目标会与硬件实际值反向, 一恢复调整就会把转速写反(离线重放抓到过)。
    ///   3) 两个门槛都不满足且不在降速段时不写硬件, 并把请求值收敛到硬件实际值。
    /// 不灵敏带直接以温度为锚点, 因此与曲线陡峭程度无关(旧实现在转速域设死区, 曲线一改就失效)。
    /// </summary>
    private void ProcessAndApplyFanSpeed(
        FanType type, float releaseTemp, float attackTemp, bool configChanged)
    {
        FanState state;
        lock (_states) { state = _states[type]; }

        // 冷启动: 直接落到曲线值, 不做渐变 —— 开机的第一秒没有历史可言。
        if (state.LastAppliedByte < 0)
        {
            var initial = Math.Clamp(CalculateFanSpeed(releaseTemp, type), MIN_FAN_BYTE, MAX_FAN_BYTE);
            ApplyFanSpeed(type, initial, releaseTemp, releaseTemp);
            return;
        }

        var releaseTarget = CalculateFanSpeed(releaseTemp, type);
        var anchor = state.LastDecisionTemp;
        var newByte = state.LastAppliedByte;
        // 本拍查曲线用的是哪个温度。降速段用慢跟踪值, 升速段用快跟踪值 ——
        // 两者在升温过程中能差好几度, 日志必须把它写出来, 否则"日志温度 80℃ 却给了 4500 RPM"
        // 看上去就是"曲线不生效"(实际是快跟踪值已经到 86℃)。
        var curveTemp = releaseTemp;

        if (configChanged)
        {
            // 配置刚被改过(曲线页拖动即存盘): **当拍**就按新配置重算一次, 不等两个门槛。
            // 为什么必须这样: 温度平稳时升速门槛要看"升 3℃"、降速门槛要看"降 8℃", 两个都不满足,
            // 旧实现可以几分钟不写一次硬件 —— 用户在曲线页把点拖下去或拖上来, 看到的是"毫无反应"。
            // 这是"曲线设定不生效"里最直接的一条(2026-10-06 日志: 20:39:44~20:42:52 三分钟里
            // 用户正在编辑曲线, 而控制循环一次都没写过硬件)。
            // 目标取**快**跟踪值对应的曲线点, 与升速分支同一口径 —— 不用滞后的慢跟踪值把转速
            // 压过头。写不写仍由下面"值真的变了才写"统一判定, 安全下限也照旧叠加。
            newByte = Math.Clamp(CalculateFanSpeed(attackTemp, type), MIN_FAN_BYTE, MAX_FAN_BYTE);
            curveTemp = attackTemp;
            state.Descending = false;
        }
        else if (attackTemp - anchor >= RiseGateC)
        {
            // 升速: 目标**直接取快跟踪值**。这一条是保证"风扇至少不低于曲线要求"的关键:
            // 转速由慢跟踪值主导会让风扇长期欠冷(离线重放实测进入负载起初 19 分钟转速比
            // 曲线要求低 400~900 RPM)。升速一旦发生, 降速段立刻结束。
            newByte = Math.Max(
                Math.Clamp(CalculateFanSpeed(attackTemp, type), MIN_FAN_BYTE, MAX_FAN_BYTE),
                state.LastAppliedByte);
            curveTemp = attackTemp;
            state.Descending = false;
        }
        else
        {
            // 降速段的**入口**有两条判据, 满足其一即可(所以"进入高转速后即使温度下降也保持更久"):
            //   a) 慢跟踪值比上次决策点低一个门槛 —— 原有的温度域不灵敏带;
            //   b) **偏离存活期**: 转速持续高出当前曲线要求 ExcessReleaseBytes 以上达
            //      ExcessReleaseSustainMs —— 见下面注释, 这是 2026-10-06 补的那条。
            if (anchor - releaseTemp >= FallGateC || InSustainedExcess(state, releaseTarget))
                state.Descending = true;

            if (state.Descending)
            {
                // 降速段的**执行**: 从"不高于硬件实际值"起步, 每秒最多退一格, 且不低于
                // 当前温度对应的曲线目标。这里不能要求本拍也满足降温门槛 —— 每次写出都会
                // 刷新锚点(ApplyFanSpeed), 那样每退一格都要再等一个 FallGateC 的温度,
                // 实测退化成"每 8℃ 才降 100 RPM"(2026-10-06 日志: 86.0℃/5100 → 77.8℃/5000
                // → 69.8℃/4900 → 61.8℃/4800), 用户看到的就是"曲线设了也不生效"。
                var from = Math.Min(state.ReleaseRequestByte, state.LastAppliedByte);
                state.ReleaseRequestByte = Math.Max(
                    releaseTarget,
                    Math.Max(from - MaxRampDownBytePerSec, MIN_FAN_BYTE));

                // 只在请求值真的低于硬件实际值时才写: 温度回升时请求值会被曲线目标顶高,
                // 那就什么都不做, 绝不拿一个已经反向的请求值去写硬件。
                if (state.ReleaseRequestByte < state.LastAppliedByte)
                    newByte = state.ReleaseRequestByte;
            }
        }

        // 安全下限: 绕过不灵敏带的硬地板。上面的闩锁负责"平时不动", 这里负责"到了就必须动"。
        // 用快跟踪值判断 —— 它追得上升温; 若用慢跟踪值, 下限会比真实温度晚一拍。
        // 退出要低 2℃: 否则温度在阈值上下抖动时下限反复进出, 转速跟着反复跳。
        newByte = ApplySafetyFloor(type, attackTemp, newByte);

        if (newByte == state.LastAppliedByte)
        {
            // 不灵敏带内不写硬件, 但把请求值收敛到硬件实际值 —— 否则"挂起期间累计的
            // 目标差"会在恢复调整的那一刻被一次性补写出去。
            state.ReleaseRequestByte = state.LastAppliedByte;
            return;
        }

        ApplyFanSpeed(type, newByte, releaseTemp, curveTemp);
    }

    /// <summary>安全下限。温度到阈值就锁住最低转速, 不受不灵敏带与降速限速约束。</summary>
    private int ApplySafetyFloor(FanType type, float attackTemp, int newByte)
    {
        var table = FloorTableFor(CurrentTier());
        var floor = 0;
        int applied;
        lock (_states) { applied = _states[type].LastAppliedByte; }

        // 进入: 取所有已越过阈值里最高的一档
        foreach (var (tempC, b) in table)
            if (attackTemp >= tempC && b > floor) floor = b;

        // 保持: 已在生效的下限, 要回落到「阈值 − 2℃」以下才解除, 避免阈值附近反复进出
        foreach (var (tempC, b) in table)
            if (b <= applied && attackTemp >= tempC - FloorReleaseC && b > floor) floor = b;

        return floor > newByte ? Math.Min(floor, MAX_FAN_BYTE) : newByte;
    }

    /// <summary>
    /// 唯一的硬件写入点。写入成功后刷新决策温度锚点, 不灵敏带因此重新起算。
    /// </summary>
    /// <param name="decisionTemp">决策锚点(慢跟踪值) —— 也是日志里的 "Temp" 字段, 回放工具按它读。</param>
    /// <param name="curveTemp">本拍查曲线实际使用的温度。与锚点不同时(升速段)附在日志尾部,
    /// 让"日志温度 vs 实际给转"可核对 —— 缺了这一段, 升速段看上去就像曲线没生效。</param>
    private void ApplyFanSpeed(FanType type, int speedByte, float decisionTemp, float curveTemp)
    {
        var rpm = speedByte * RPM_UNIT_DIVISOR;
        var curveNote = Math.Abs(curveTemp - decisionTemp) >= 0.5f
            ? $" | 查表温度: {curveTemp:F1}°C"
            : "";
        if (type == FanType.CPU)
        {
            Bridge.Instance.Fan.CpuFanSetSpeed((byte)speedByte);
            Logger.Info($"CPU Temp: {decisionTemp:F1}°C | CPU Fan Applied: {rpm} RPM{curveNote}");
        }
        else
        {
            Bridge.Instance.Fan.GpuFanSetSpeed((byte)speedByte);
            Logger.Info($"GPU Temp: {decisionTemp:F1}°C | GPU Fan Applied: {rpm} RPM{curveNote}");
        }

        lock (_states)
        {
            var state = _states[type];
            state.LastDecisionTemp = decisionTemp;
            state.LastAppliedByte = speedByte;
            state.ReleaseRequestByte = speedByte;
        }
    }
    /// <summary>
    /// 风扇配置指纹 —— 只覆盖控制律真正读到的项(两条曲线 / 噪音档 / 合并开关 / 两个时间常数)。
    /// 不用求稳定哈希: 它只用于"有没有变"的一次相等比较, 拼字符串最直白、也最难写错。
    /// 改日志级别、GPU 参数之类的保存不会改动这个指纹, 因此不会引起多余的风扇写入。
    /// </summary>
    private static string FanConfigFingerprint()
    {
        var fan = Bridge.Instance.Config.Fan;
        var sb = new StringBuilder();
        sb.Append(fan.NoiseTolerance).Append('|')
            .Append(fan.FanCurveMerge ? '1' : '0').Append('|')
            .Append(fan.TempAttackS).Append('|')
            .Append(fan.TempReleaseS).Append('|');
        foreach (var p in fan.CpuFanCurve ?? new List<FanPoint>())
            sb.Append(p.temp).Append(':').Append(p.speed).Append(',');
        sb.Append(';');
        foreach (var p in fan.GpuFanCurve ?? new List<FanPoint>())
            sb.Append(p.temp).Append(':').Append(p.speed).Append(',');
        return sb.ToString();
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
                    // 手改 config.yaml 可能造出重复或倒序的温度点: 分母为 0 会算出 NaN, 而
                    // (int)Math.Round(NaN) 是 ECMA 未定义行为(x64 上落到 int.MinValue → 被 Clamp
                    // 成最低转速 1500, 风扇会毫无理由地掉下来)。跳过退化段即可。
                    if (p2.temp <= p1.temp) continue;
                    double ratio = (currentTemp - p1.temp) / (double)(p2.temp - p1.temp);
                    targetRpm = p1.speed + (p2.speed - p1.speed) * ratio;
                    break;
                }
            }
        }
        // 噪音档位在这里生效: 缩放曲线输出。安静档把全程转速压低约 15%, 强冷档抬高 12%。
        // 放在查表之后再缩放(而不是把温度偏移后查表), 因为曲线是分段线性的, 温度偏移会
        // 让"膝盖"的位置跟着移动, 反而破坏原本标定过的形状。
        var scaledRpm = targetRpm * CurveScaleFor(CurrentTier());
        int targetByte = (int)Math.Round(scaledRpm / RPM_UNIT_DIVISOR);
        return Math.Clamp(targetByte, MIN_FAN_BYTE, MAX_FAN_BYTE);
    }

    /// <summary>
    /// 偏离存活期: 转速是否已经"长期高于当前曲线要求"。是则允许进入降速段。
    ///
    /// 为什么需要它(2026-10-06): 升速目标取**快**跟踪值, 降速锚点却是**慢**跟踪值。
    /// 10 秒尖峰能让快跟踪值冲到 93.6℃ → 5600 RPM, 而慢跟踪值只到 ~87℃; 温度回到 86℃ 平住
    /// 之后 anchor 也停在 86℃, "比锚点低 FallGateC(8℃)"永远不成立 —— 风扇会**永久**高出曲线
    /// 1200 RPM, 模型里 900 秒一次硬件都不写。那正是用户说的"在设定温度区间给不出对应转速"。
    /// 先试过的"把当前转速反查成温度再比门槛"方案, 在 95℃ 尖峰下只有 7.6℃ < 8℃, 盖不住这个
    /// 最常见的尖峰高度, 故改成"偏离幅度 + 持续时间"这一条。
    ///
    /// 口径说明(免得被 AGENTS.md 那条"不要在转速域设死区"误伤): 这不是死区, 不做抖动抑制 ——
    /// 抖动由温度域不灵敏带负责; 这里量的是"风扇比曲线要求吵多少"(以 RPM 计, 因为用户听到的
    /// 就是 RPM 差), 且要求**持续**超限, 瞬时尖峰不受影响。它只可能让转速更早降下来, 不可能
    /// 让它升上去, 所以不引入新的过温风险; 过温兜底仍是安全下限表 + 98℃/10s 看门狗。
    /// 调参口径: 8 格 = 800 RPM、持续 60 秒。想更贴近曲线就调小, 想更"保持"就调大。
    /// </summary>
    private static bool InSustainedExcess(FanState state, int releaseTarget)
    {
        if (state.LastAppliedByte - releaseTarget < ExcessReleaseBytes)
        {
            state.ExcessSinceMs = 0;
            return false;
        }

        var nowMs = Environment.TickCount64;
        if (state.ExcessSinceMs == 0)
        {
            state.ExcessSinceMs = nowMs;
            return false;
        }

        return nowMs - state.ExcessSinceMs >= ExcessReleaseSustainMs;
    }

    public void Dispose()
    {
        Stop();
        _cts?.Dispose();
    }
}