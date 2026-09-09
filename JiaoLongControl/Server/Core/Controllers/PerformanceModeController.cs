using System.Runtime.InteropServices;
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Services;
using JiaoLongControl.Server.Core.Utils;
using JiaoLongControl.Server.Interop;

namespace JiaoLongControl.Server.Core.Controllers
{
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public class PerformanceModeController
    {
        public CommandResult Get()
        {
            var mode = MethodServices.GetValue<SystemPerMode>(MethodName.SystemPerMode);
            if (mode == SystemPerMode.Unknow)
                return new CommandResult(false, "读取失败");

            // 三档标准模式之上叠加自定义功耗态(命令 23 子状态):
            // 自定义开启时呈现为 CustomMode, 前端胶囊第 4 段随之点亮
            if (mode is SystemPerMode.BalanceMode or SystemPerMode.PerformanceMode or SystemPerMode.QuietMode)
            {
                var custom = MethodServices.GetValue<CPUPower>(MethodName.CPUPower);
                if (custom == CPUPower.OpenState)
                    mode = SystemPerMode.CustomMode;
            }

            return new CommandResult(true, "获取成功", mode);
        }

        public CommandResult Set(SystemPerMode mode)
        {
            bool res;
            switch (mode)
            {
                case SystemPerMode.CustomMode:
                    // 自定义模式: 不改 EC 档位, 仅打开自定义功耗子状态
                    // (SPL/SPPT/温度墙的具体数值由 CPU 页下发, 存于 EC 命令 23)
                    res = MethodServices.SetValue(MethodName.CPUPower, CPUPower.OpenState);
                    break;

                case SystemPerMode.BalanceMode or SystemPerMode.PerformanceMode or SystemPerMode.QuietMode:
                    res = MethodServices.SetValue(MethodName.SystemPerMode, mode);
                    if (res)
                    {
                        // 切回标准档位时关闭自定义功耗子状态, 避免自定义 SPL/SPPT 继续覆盖预设语义
                        MethodServices.SetValue(MethodName.CPUPower, CPUPower.CloseState);
                        SyncPowerPlan(mode);
                    }
                    break;

                default:
                    // AirPlaneMode 不在此补全: 它依赖命令 9(显卡模式, 写后需重启) 组合,
                    // 作为"模式热切换"不安全, 独显/混合切换保留在设置页(GPUDirectConnection)
                    return new CommandResult(false, "不支持的模式");
            }

            return new CommandResult(res, res ? "设置成功" : "设置失败");
        }

        private static void SyncPowerPlan(SystemPerMode mode)
        {
            try
            {
                var app = Bridge.Instance.Config?.App;
                if (app == null || !app.SyncWindowsPowerPlan)
                    return;
                PowerPlanHelper.ApplyForMode(mode);
            }
            catch
            {
                // 配置不可读时不阻塞模式切换
            }
        }
    }
}
