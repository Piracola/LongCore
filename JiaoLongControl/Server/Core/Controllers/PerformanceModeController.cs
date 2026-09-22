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

            // 显式装箱为 int：避免 object Data 携带枚举时 JSON 写成 {}
            return new CommandResult(true, "获取成功", (int)mode);
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

        /// <summary>
        /// 镜像固件已完成的档位切换(供 Fn 热键使用)。
        ///
        /// 与 <see cref="Set"/> 的关键区别: <b>不写命令 8</b>。
        /// 固件在档位变化时会抛出 HID_EVENT20 事件 15; 若在事件处理里再写命令 8,
        /// 就会触发下一次事件, 形成 事件 → Set → 事件 的自激循环(按一次连切十几次)。
        /// 因此这里只做两件安全的事: 收敛自定义功耗子状态(命令 23) + 联动 Windows 电源计划。
        /// </summary>
        public void ApplyMirrored(SystemPerMode mode)
        {
            try
            {
                // 自定义功耗子状态会覆盖标准档的 SPL/SPPT 语义, 镜像到标准档时关闭它。
                // 命令 23 不会触发事件 15(官方也在同一事件处理里写命令 23, 见 decompiled/main.cs:2182), 故安全。
                var custom = MethodServices.GetValue<CPUPower>(MethodName.CPUPower);
                if (custom == CPUPower.OpenState)
                    MethodServices.SetValue(MethodName.CPUPower, CPUPower.CloseState);
            }
            catch
            {
                // 子状态收敛失败不阻塞镜像
            }

            SyncPowerPlan(mode);
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
