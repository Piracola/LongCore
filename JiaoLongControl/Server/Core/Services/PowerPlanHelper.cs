using System.Diagnostics;
using JiaoLongControl.Server.Core.Models;
using log4net;

namespace JiaoLongControl.Server.Core.Services
{
    /// <summary>
    /// Windows 电源计划联动: 性能模式切换时同步 powercfg 计划
    /// (办公→节电, 游戏→平衡, 狂飙→高性能; 自定义模式不联动)。
    /// 失败永不阻塞模式设置 —— powercfg 不可用/计划被删时静默跳过。
    /// </summary>
    public static class PowerPlanHelper
    {
        private static readonly ILog Logger = LogManager.GetLogger(typeof(PowerPlanHelper));

        private const string BalancedGuid = "381b4222-f694-41f0-9685-ff5bb260df2e";
        private const string HighPerformanceGuid = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";
        private const string PowerSaverGuid = "a1841308-3541-4fab-bc81-f71556f20b4a";

        public static void ApplyForMode(SystemPerMode mode)
        {
            var guid = mode switch
            {
                SystemPerMode.PerformanceMode => HighPerformanceGuid,
                SystemPerMode.QuietMode => PowerSaverGuid,
                SystemPerMode.BalanceMode => BalancedGuid,
                _ => null, // CustomMode 等不联动
            };
            if (guid == null)
                return;

            try
            {
                using var proc = Process.Start(new ProcessStartInfo("powercfg", $"/setactive {guid}")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                if (proc == null)
                    return;
                proc.WaitForExit(3000);
                // OEM 机上「高性能」等计划 GUID 常不存在, 退出码非 0 仅记日志
                if (proc.HasExited && proc.ExitCode != 0)
                    Logger.Debug($"powercfg /setactive {guid} 退出码 {proc.ExitCode} (计划可能不存在)");
            }
            catch (Exception ex)
            {
                Logger.Debug($"powercfg 联动失败: {ex.Message}");
            }
        }
    }
}
