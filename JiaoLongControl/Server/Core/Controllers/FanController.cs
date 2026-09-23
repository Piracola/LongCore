using System.Runtime.InteropServices;
using JiaoLongControl.Server.Core.Drivers;
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Services;
using JiaoLongControl.Server.Core.Utils;

namespace JiaoLongControl.Server.Core.Controllers;

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public class FanController : Blding64
{
    public CommandResult GetFanSpeed()
    {
        Tuple<int, int> CPUGPUFanSpeed = MethodServices.GetValue<Tuple<int, int>>(MethodName.CPUGPUFanSpeed);
        var fanSpeedInfo = new FanSpeedInfo
        {
            CPUFanSpeed = CPUGPUFanSpeed.Item2,
            GPUFanSpeed = CPUGPUFanSpeed.Item1
        };
        return new CommandResult(true, "获取成功", fanSpeedInfo);
    }

    public CommandResult SetFanSpeed(byte fanSpeed)
    {
        // Data 可能为 null(读取失败), 此时按"未开启强冷"处理, 不触发复位
        if (GetMaxFanSpeedSwitch().Data is bool maxSwitchOn && maxSwitchOn)
        {
            // 此处为兼容性设置，为避免官方控制台冲突设计。
            // 该方法标了 [Obsolete]（官方控制台会与我们抢同一个强冷开关），
            // 但正是为了避让官方控制台才必须调用它。局部抑制而非整类禁用:
            // 整类禁用会让本文件将来新增的过时调用一起静默。
#pragma warning disable CS0618
            SetMaxFanSpeedSwitch(false);
#pragma warning restore CS0618
        }

        if (IsInitialized)
        {
            // 两路均可能被安全护栏拒绝(转速 0 / 超出 EC 规格), 必须如实回传,
            // 否则前端会显示"设置成功"而 EC 实际未变。
            var okGpu = GpuFanSetSpeed(fanSpeed);
            var okCpu = CpuFanSetSpeed(fanSpeed);

            if (okCpu && okGpu)
                return new CommandResult(true, "设置成功");

            return new CommandResult(false,
                $"设置失败: 转速 {fanSpeed * 100} RPM 被安全护栏拒绝(详见日志)");
        }

        return new CommandResult(false, "设置失败");
    }

    // 有意隐藏基类同名方法: 先调用 base.RemoveFanSpeed() 交还 EC 自动模式,
    // 再包装成前端需要的 CommandResult。加 new 明确这是有意为之, 不是漏写 override。
    public new CommandResult RemoveFanSpeed()
    {
        if (IsInitialized)
        {
            base.RemoveFanSpeed();
            return new CommandResult(true, "设置成功");
        }

        return new CommandResult(false, "设置失败");
    }

    [Obsolete("不推荐使用SetMaxFanSpeedSwitch")]
    public bool SetMaxFanSpeedSwitch(bool maxFanSpeedSwitch)
    {
        return MethodServices.SetValue(MethodName.MaxFanSpeedSwitch, (byte)(maxFanSpeedSwitch ? 1 : 0));
    }

    public CommandResult GetMaxFanSpeedSwitch()
    {
        var res = MethodServices.GetValue<byte>(MethodName.MaxFanSpeedSwitch) == 1;
        return new CommandResult(res, "获取成功",res);
    }
}