using System.Diagnostics;
using JiaoLongControl.Server.Core.Models;

namespace JiaoLongControl.Server.Core.Services
{
    /// <summary>
    /// Windows 电源计划联动: 性能模式切换时同步 powercfg 计划
    /// (静音→节电, 平衡→平衡, 高性能→高性能; 自定义模式不联动)。
    /// 失败永不阻塞模式设置 —— powercfg 不可用/计划被删时静默跳过。
    /// </summary>
    public static class PowerPlanHelper
    {
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
            }
            catch
            {
                // 忽略: 计划不存在/权限不足时不影响硬件模式已生效
            }
        }
    }
}
