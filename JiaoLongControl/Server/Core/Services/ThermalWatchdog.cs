using System.Timers;
using JiaoLongControl.Server.Interop;
using log4net;

namespace JiaoLongControl.Server.Core.Services;

/// <summary>
/// 过温看门狗(硬件安全架构 L3)。
///
/// 设计要点 —— 它必须"有始有终":
/// 写风扇转速会置位 0xB20 手动掩码, 把风扇踢出 EC 自动温控曲线,
/// 这是全项目唯一"软件能绕过"的硬件保护(见 docs/08_硬件安全架构.md)。
/// 因此看门狗若只管"触发时拉满"而不管释放, 它自己就会变成新的风险源
/// (进程一旦崩溃, 风扇被永久钉死在手动模式)。所以:
///   触发 → 置手动最大转速 + EcGuard 心跳接管(EcGuard 负责崩溃后恢复);
///   回落 → 必须显式 RemoveFanSpeed 交还 EC 自动模式 + EcGuard.NoteReleased()。
///
/// 阈值默认 98℃ 持续 10s(比常见的 95℃ 更不容易在高负载时误触发),
/// 回落 92℃ 持续 30s 后释放。全部阈值可在 config.yaml 的 Safety 节调整。
/// </summary>
public static class ThermalWatchdog
{
    private static readonly ILog Logger = LogManager.GetLogger(typeof(ThermalWatchdog));
    private static readonly object Lock = new();

    // 与 System.Threading.Timer 重名, 此处显式限定
    private static System.Timers.Timer? _timer;
    private static bool _started;
    private static bool _engaged;
    private static double _highSeconds;
    private static double _lowSeconds;

    private const int PollIntervalMs = 2000;

    /// <summary>强制风速(寄存器单位 100 RPM)。58 = 5800 RPM, 与官方 fastestMode 上限一致。</summary>
    private const byte MaxFanByte = 58;

    /// <summary>看门狗当前是否已接管风扇。</summary>
    public static bool IsEngaged
    {
        get { lock (Lock) return _engaged; }
    }

    public static void Start()
    {
        lock (Lock)
        {
            if (_started)
                return;
            _started = true;
            _timer = new System.Timers.Timer(PollIntervalMs)
            {
                AutoReset = true,
            };
            _timer.Elapsed += (_, _) => Tick();
            _timer.Start();
        }

        Logger.Info($"过温看门狗已启动(轮询 {PollIntervalMs}ms, 最大风速 {MaxFanByte * 100} RPM)");
    }

    public static void Stop()
    {
        lock (Lock)
        {
            _timer?.Stop();
            _timer?.Dispose();
            _timer = null;
            _started = false;
        }
    }

    private static void Tick()
    {
        try
        {
            var safety = Bridge.Instance.Config?.Safety;
            if (safety == null)
                return;

            var engage = false;
            var release = false;
            string reason = "";

            lock (Lock)
            {
                if (!safety.ThermalWatchdogEnabled)
                {
                    // 用户关闭看门狗时必须释放, 否则风扇会被永久钉在手动最大转速
                    if (_engaged)
                    {
                        release = true;
                        reason = "看门狗已被用户关闭";
                    }
                    _highSeconds = 0;
                    _lowSeconds = 0;
                }
                else
                {
                    var temp = ReadCpuTempC();
                    if (temp.HasValue)
                    {
                        if (!_engaged)
                        {
                            _highSeconds = temp.Value >= safety.ThermalWatchdogTempC
                                ? _highSeconds + PollIntervalMs / 1000.0
                                : 0;

                            if (_highSeconds >= Math.Max(1, safety.ThermalWatchdogSustainS))
                            {
                                engage = true;
                                _highSeconds = 0;
                                reason = $"CPU {temp.Value:F0}℃ ≥ {safety.ThermalWatchdogTempC}℃ 已持续 {safety.ThermalWatchdogSustainS}s";
                            }
                        }
                        else
                        {
                            _lowSeconds = temp.Value <= safety.ThermalWatchdogReleaseC
                                ? _lowSeconds + PollIntervalMs / 1000.0
                                : 0;

                            if (_lowSeconds >= Math.Max(1, safety.ThermalWatchdogReleaseS))
                            {
                                release = true;
                                _lowSeconds = 0;
                                reason = $"温度已回落至 {temp.Value:F0}℃ 并持续 {safety.ThermalWatchdogReleaseS}s";
                            }
                        }
                    }
                }
            }

            if (engage)
                Engage(reason);
            else if (release)
                Release(reason);
        }
        catch (Exception ex)
        {
            Logger.Warn("过温看门狗轮询异常: " + ex.Message);
        }
    }

    private static void Engage(string reason)
    {
        try
        {
            var fan = Bridge.Instance.Fan;
            if (!fan.IsInitialized)
            {
                Logger.Warn($"过温看门狗欲介入但风扇驱动未初始化, 本次跳过: {reason}");
                return;
            }

            var res = fan.SetFanSpeed(MaxFanByte);
            if (!res.Success)
            {
                Logger.Error($"过温看门狗强制最大风速失败: {res.Message} (原因: {reason})");
                return;
            }

            lock (Lock) _engaged = true;

            Logger.Warn($"过温看门狗已介入: {reason} → 强制 {MaxFanByte * 100} RPM(手动模式, 已由 EcGuard 接管心跳)");
            Bridge.Instance.NotifyWeb("{\"type\":\"thermal-watchdog\",\"engaged\":true}");
        }
        catch (Exception ex)
        {
            Logger.Error("过温看门狗介入异常: " + ex.Message, ex);
        }
    }

    private static void Release(string reason)
    {
        try
        {
            Bridge.Instance.Fan.RemoveFanSpeed();
            EcGuard.NoteReleased();

            lock (Lock) _engaged = false;

            Logger.Info($"过温看门狗已交还 EC 自动温控: {reason}");
            Bridge.Instance.NotifyWeb("{\"type\":\"thermal-watchdog\",\"engaged\":false}");
        }
        catch (Exception ex)
        {
            Logger.Error("过温看门狗释放异常(风扇可能仍停留在手动模式!): " + ex.Message, ex);
        }
    }

    /// <summary>读取 CPU 温度(℃); 读取失败或明显异常返回 null, 不参与判定。</summary>
    private static double? ReadCpuTempC()
    {
        try
        {
            var res = Bridge.Instance.CPU.GetCPUThermometer();
            if (!res.Success || res.Data == null)
                return null;

            var v = Convert.ToDouble(res.Data);
            // 0 与 >120 均非可信读数(WMI 失败时会回落到 byte.MaxValue=255)
            if (v <= 0 || v > 120)
                return null;

            return v;
        }
        catch
        {
            return null;
        }
    }
}
