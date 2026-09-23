using JiaoLongControl.Server.Core.Models;
using log4net;
using log4net.Appender;
using log4net.Core;
using log4net.Repository.Hierarchy;

namespace JiaoLongControl.Server.Core.Utils;

/// <summary>
/// 运行期日志策略。解决的问题: 实测一天 5.7 万行日志里 98.4% 是 CommandResult 的
/// DEBUG 行(每次 WMI/EC 读取、每次前端 IPC 调用都写一行), 而真正有用的控制侧信息
/// —— AutoFanControl 转速、ThermalWatchdog、EcGuard、HwWriteGate 拦截 —— 只占 1.4%。
/// 5.7 万行意味着约 27 次/秒的同步写盘。
///
/// 三个旋钮对应 LogSection: 记录级别、是否记录数据读取、攒批落盘间隔。
/// 全部支持运行期生效(设置页保存即改, 无需重启)。
/// </summary>
public static class LogRuntime
{
    /// <summary>由 Bridge 读取配置后设置。默认关闭: 安静是安全的默认值。</summary>
    public static volatile bool VerboseCommandLog;

    private const string BufferName = "LongCoreBuffer";

    private static System.Threading.Timer? _flushTimer;
    private static int _flushSeconds = -1;
    private static bool _hookInstalled;

    // 缓冲层包裹 FileAppender 后, 需要记住被包裹者才能干净地还原。
    private static FileAppender? _wrappedFile;

    public static void Apply(LogSection? log)
    {
        log ??= new LogSection();
        VerboseCommandLog = log.CommandDebug;

        string applied;
        try
        {
            var level = ParseLevel(log.Level);
            applied = level.Name;

            if (log.FlushIntervalS <= 0)
            {
                // 每条立即落盘: 回到 log4net 默认行为, 缓冲层整体摘除。
                DisableBuffering();
            }
            else
            {
                ConfigureBuffering(log.FlushIntervalS);
            }

            if (LogManager.GetRepository() is Hierarchy repo)
            {
                repo.Root.Level = level;
                // Threshold 与 Root.Level 同时设置: 前者作用于 appender 侧,
                // 即使某天有人把 <root level> 改回 DEBUG 也不会漏进来。
                foreach (var appender in repo.GetAppenders())
                {
                    if (appender is AppenderSkeleton skeleton)
                        skeleton.Threshold = level;
                }
                repo.RaiseConfigurationChanged(EventArgs.Empty);
            }
        }
        catch (Exception ex)
        {
            // 日志配置出错绝不能拖垮程序 —— 这是日志系统本身的铁律。
            try { LogManager.GetLogger(typeof(LogRuntime)).Warn($"日志配置应用失败, 保持原状: {ex.Message}"); }
            catch { /* 连日志都不可用时静默 */ }
            return;
        }

        try
        {
            LogManager.GetLogger(typeof(LogRuntime))
                .Info($"日志策略: 级别={applied}, 数据读取日志={(log.CommandDebug ? "开" : "关")}, " +
                      (log.FlushIntervalS <= 0 ? "落盘=每条立即" : $"落盘=每 {log.FlushIntervalS}s 攒批(WARN 及以上立即)"));
        }
        catch { /* 忽略 */ }
    }

    /// <summary>把缓冲层里尚未落盘的行强制写出。发生 WARN/ERROR 时由钩子自动调用。</summary>
    public static void Flush()
    {
        // 快路径: 没有缓冲层时什么都不用做。缺了这句, 每条 DEBUG 日志都会
        // 走一遍 GetAppenders() 与两次类型判断 —— 正是要消除的那种开销。
        if (_wrappedFile == null)
            return;

        try
        {
            foreach (var appender in LogManager.GetRepository().GetAppenders())
            {
                // log4net 3.4 的 Flush() 只在 BufferingAppenderSkeleton 上无参重载,
                // FileAppender/AppenderSkeleton 只有 Flush(int)。
                if (appender is BufferingAppenderSkeleton buffered)
                    buffered.Flush();
                else if (appender is AppenderSkeleton skeleton)
                    skeleton.Flush(Timeout.Infinite);
            }
        }
        catch { /* 刷盘失败不应影响调用方 */ }
    }

    private static void ConfigureBuffering(int seconds)
    {
        if (_flushSeconds == seconds && _wrappedFile != null)
            return;

        DisableBuffering();

        if (LogManager.GetRepository() is not Hierarchy repo)
            return;

        var file = repo.GetAppenders().OfType<FileAppender>().FirstOrDefault();
        if (file == null)
            return;

        file.ImmediateFlush = false;

        var buffer = new BufferingForwardingAppender
        {
            Name = BufferName,
            Lossy = false,          // 缓冲满时丢日志不可接受: 宁可阻塞
            BufferSize = 512,
        };
        buffer.AddAppender(file);
        buffer.ActivateOptions();

        repo.Root.RemoveAppender(file);
        repo.Root.AddAppender(buffer);
        repo.RaiseConfigurationChanged(EventArgs.Empty);

        _wrappedFile = file;
        InstallFlushHook();
        // 刷盘钩子必须排在转发 appender **之后**: appender 按顺序执行, 排在前面时
        // 触发的那条 WARN 还没进缓冲区就先刷了一次盘, 随后进缓冲的 WARN 便留在内存里
        // —— 恰好丢掉它本要保护的那几行。每次重配缓冲后都把它挪回队尾。
        ReorderFlushHookLast(repo);
        StartFlushTimer(seconds);
        _flushSeconds = seconds;
    }

    private static void DisableBuffering()
    {
        StopFlushTimer();
        _flushSeconds = -1;

        var buffer = LogManager.GetRepository().GetAppenders()
            .OfType<BufferingForwardingAppender>()
            .FirstOrDefault(a => a.Name == BufferName);

        if (buffer != null && LogManager.GetRepository() is Hierarchy repo)
        {
            repo.Root.RemoveAppender(buffer);
            var inner = _wrappedFile ?? buffer.Appenders.OfType<FileAppender>().FirstOrDefault();
            if (inner != null)
            {
                inner.ImmediateFlush = true;   // 摘除缓冲后必须恢复逐条落盘
                repo.Root.AddAppender(inner);
            }
            buffer.RemoveAllAppenders();
            repo.RaiseConfigurationChanged(EventArgs.Empty);
        }

        _wrappedFile = null;
    }

    private static void ReorderFlushHookLast(Hierarchy repo)
    {
        var hook = repo.GetAppenders().OfType<FlushOnWarnAppender>().FirstOrDefault();
        if (hook == null)
            return;
        repo.Root.RemoveAppender(hook);
        repo.Root.AddAppender(hook);
        repo.RaiseConfigurationChanged(EventArgs.Empty);
    }

    private static void StartFlushTimer(int seconds)
    {
        StopFlushTimer();
        var period = TimeSpan.FromSeconds(seconds);
        _flushTimer = new System.Threading.Timer(_ => Flush(), null, period, period);
    }

    private static void StopFlushTimer()
    {
        var timer = Interlocked.Exchange(ref _flushTimer, null);
        timer?.Dispose();
    }

    /// <summary>
    /// WARN/ERROR 立即落盘。安全相关日志(ThermalWatchdog 介入、EcGuard 恢复、
    /// HwWriteGate 拦截)全在 WARN 及以上, 攒批不能以牺牲它们为代价 ——
    /// 崩溃后再看日志时, 缺失的恰恰是最需要的那几行。
    /// </summary>
    private static void InstallFlushHook()
    {
        if (_hookInstalled)
            return;
        _hookInstalled = true;

        if (LogManager.GetRepository() is not Hierarchy repo)
            return;

        var hook = new FlushOnWarnAppender { Name = "LongCoreFlushOnWarn" };
        hook.ActivateOptions();
        repo.Root.AddAppender(hook);   // Threshold 在 Apply 里随其它 appender 统一设置
        repo.RaiseConfigurationChanged(EventArgs.Empty);
    }

    /// <summary>
    /// 只做一件事: 遇到 WARN 及以上就把缓冲刷出去, 本身不产生任何输出。
    /// 走 appender 而非自建 logger, 因为 AppenderSkeleton 已经处理好了级别过滤、
    /// 异常吞噬与线程安全, 不必自己重写一遍。
    /// </summary>
    private sealed class FlushOnWarnAppender : AppenderSkeleton
    {
        protected override void Append(LoggingEvent loggingEvent)
        {
            // 必须显式限定: 嵌套类里裸写 Flush() 会解析到继承来的 Flush(int)。
            if (loggingEvent.Level >= Level.Warn)
                LogRuntime.Flush();
        }
    }

    private static Level ParseLevel(string? text) => (text ?? "").Trim().ToUpperInvariant() switch
    {
        "DEBUG" => Level.Debug,
        "WARN" => Level.Warn,
        "ERROR" => Level.Error,
        "FATAL" => Level.Fatal,
        "OFF" => Level.Off,
        _ => Level.Info,
    };
}
