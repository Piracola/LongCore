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
///
/// 两个旋钮对应 LogSection: 记录级别、是否记录数据读取。
/// 全部支持运行期生效(设置页保存即改, 无需重启)。
///
/// 为什么不攒批: 0.1.4 曾在这里加过一层"攒批落盘"(把 FileAppender 从 root 摘下来包进
/// BufferingForwardingAppender, 并置 ImmediateFlush=false, 再挂一个定时器去刷)。
/// 实测该层在日志量低时会静默吞掉整段运行日志 —— 包括过温看门狗介入这类安全事件,
/// 且不报错、不崩溃、日志文件里只留下启动头两行, 十几天无人察觉。攒批想省的那点磁盘写,
/// 早已由"关掉数据读取明细"这条实现(它砍掉了 98% 的行)。故回到 log4net 默认行为:
/// 逐条同步落盘。安全信息只有真的在盘上才算数 —— 崩溃后要看的恰恰是最后那几行。
/// </summary>
public static class LogRuntime
{
    /// <summary>由 Bridge 读取配置后设置。默认关闭: 安静是安全的默认值。</summary>
    public static volatile bool VerboseCommandLog;

    public static void Apply(LogSection? log)
    {
        log ??= new LogSection();
        VerboseCommandLog = log.CommandDebug;

        string applied;
        try
        {
            var level = ParseLevel(log.Level);
            applied = level.Name;

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
                .Info($"日志策略: 级别={applied}, 数据读取日志={(log.CommandDebug ? "开" : "关")}, 落盘=每条立即");
        }
        catch { /* 忽略 */ }
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
