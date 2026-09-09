using System.IO;
using System.Text.Json;
using log4net;

namespace JiaoLongControl.Server.Core.Services;

/// <summary>
/// EC 直写安全护栏：进程硬崩溃(断电/强杀/未捕获异常终止)后，
/// EC 可能停留在手动风扇模式(0xB20 掩码位被置位、转速被钉死)。
/// 运行期间通过心跳文件留下"手动模式存活"证据；
/// 下次启动时若心跳已过期且证据存在 → 立即恢复 EC 风扇自动模式。
/// 干净退出由 App.Cleanup() 的 RemoveFanSpeed 负责恢复并清除证据文件。
/// </summary>
public static class EcGuard
{
    private class GuardState
    {
        public bool Manual { get; set; }
        public DateTime HeartbeatUtc { get; set; }
        public int Pid { get; set; }
    }

    private static readonly ILog Logger = LogManager.GetLogger(typeof(EcGuard));
    private static readonly object Lock = new();
    private static Timer? _heartbeatTimer;
    private static bool _engaged;
    private static bool _exiting;

    /// <summary>心跳写入周期。</summary>
    private const int HeartbeatIntervalMs = 5000;

    /// <summary>心跳超过该时长视为上一个进程已死亡(允许丢 3 拍)。</summary>
    private static readonly TimeSpan StaleThreshold = TimeSpan.FromSeconds(20);

    private static string StatePath =>
        Path.Combine(ConfigSerializer.ConfigDir, "ec_guard.json");

    /// <summary>手动风扇模式已接管 EC(置位 0xB20 掩码)时调用。幂等。</summary>
    public static void NoteEngaged()
    {
        lock (Lock)
        {
            if (_exiting)
                return;
            if (_engaged)
            {
                TouchStateFile();
                return;
            }

            _engaged = true;
            WriteStateFile();
            _heartbeatTimer ??= new Timer(
                _ => TouchStateFile(),
                null,
                HeartbeatIntervalMs,
                HeartbeatIntervalMs);
            Logger.Info("EC 护栏: 手动风扇模式已接管, 心跳护栏启动");
        }
    }

    /// <summary>已恢复 EC 自动模式(0xB20 清零)时调用。幂等。</summary>
    public static void NoteReleased()
    {
        lock (Lock)
        {
            _engaged = false;
            _heartbeatTimer?.Dispose();
            _heartbeatTimer = null;
            TryDeleteStateFile();
            if (Logger.IsInfoEnabled && !_exiting)
                Logger.Info("EC 护栏: 已恢复自动模式, 心跳护栏解除");
        }
    }

    /// <summary>进程退出路径: 停心跳, 之后的恢复交给 Cleanup()。</summary>
    public static void MarkProcessExiting()
    {
        lock (Lock)
        {
            _exiting = true;
            _heartbeatTimer?.Dispose();
            _heartbeatTimer = null;
        }
    }

    /// <summary>
    /// 启动恢复: 若上次运行崩溃时手动模式仍接管 EC(心跳过期),
    /// 立即恢复风扇自动模式。应在驱动就绪后尽早调用。
    /// </summary>
    public static void RecoverIfNeeded()
    {
        GuardState? state;
        lock (Lock)
        {
            state = ReadStateFile();
        }

        if (state is not { Manual: true })
        {
            TryDeleteStateFile();
            return;
        }

        var age = DateTime.UtcNow - state.HeartbeatUtc;
        var sameProcessStillAlive = state.Pid == Environment.ProcessId && age < StaleThreshold;
        if (sameProcessStillAlive)
            return;

        if (age < StaleThreshold)
        {
            // 心跳未过期 → 可能是另一个实例正在接管, 不动 EC
            Logger.Info($"EC 护栏: 检测到活跃心跳(Pid={state.Pid}, {age.TotalSeconds:F0}s), 跳过恢复");
            return;
        }

        Logger.Warn($"EC 护栏: 上次运行疑似崩溃退出(心跳过期 {age.TotalSeconds:F0}s, Pid={state.Pid}), 恢复风扇自动模式");
        try
        {
            var fan = Interop.Bridge.Instance.Fan;
            if (fan.IsInitialized)
            {
                fan.RemoveFanSpeed();
                Logger.Warn("EC 护栏: 风扇自动模式已恢复");
            }
            else
            {
                Logger.Error("EC 护栏: 驱动未初始化, 无法恢复(将在下次启动重试)");
                return;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("EC 护栏: 恢复失败: " + ex.Message, ex);
            return;
        }

        lock (Lock)
        {
            TryDeleteStateFile();
        }
    }

    private static void TouchStateFile()
    {
        lock (Lock)
        {
            if (_engaged)
                WriteStateFile();
        }
    }

    private static void WriteStateFile()
    {
        try
        {
            Directory.CreateDirectory(ConfigSerializer.ConfigDir);
            var state = new GuardState
            {
                Manual = true,
                HeartbeatUtc = DateTime.UtcNow,
                Pid = Environment.ProcessId,
            };
            File.WriteAllText(StatePath, JsonSerializer.Serialize(state));
        }
        catch (Exception ex)
        {
            Logger.Warn("EC 护栏: 心跳写入失败: " + ex.Message);
        }
    }

    private static GuardState? ReadStateFile()
    {
        try
        {
            if (!File.Exists(StatePath))
                return null;
            return JsonSerializer.Deserialize<GuardState>(File.ReadAllText(StatePath));
        }
        catch (Exception ex)
        {
            Logger.Warn("EC 护栏: 心跳读取失败: " + ex.Message);
            return null;
        }
    }

    private static void TryDeleteStateFile()
    {
        try
        {
            if (File.Exists(StatePath))
                File.Delete(StatePath);
        }
        catch (Exception ex)
        {
            Logger.Warn("EC 护栏: 证据文件清理失败: " + ex.Message);
        }
    }
}
