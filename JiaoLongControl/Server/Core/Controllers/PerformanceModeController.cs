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
        private static readonly log4net.ILog Logger =
            log4net.LogManager.GetLogger(typeof(PerformanceModeController));

        public CommandResult Get()
        {
            // 必须按 byte 读: GetValue<T> 读失败时返回的默认值随 T 而变 —— T=byte 才是 255,
            // T=SystemPerMode 会落到 default = 0 = BalanceMode。按枚举读时下面这行判失败
            // 永远不成立, 通道坏掉也会报"游戏档"(假绿)。同款写法见 CpuController/FanController。
            var raw = MethodServices.GetValue<byte>(MethodName.SystemPerMode);
            if (raw == (byte)SystemPerMode.Unknow)
                return new CommandResult(false, "读取失败");

            var mode = (SystemPerMode)raw;
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

        /// <summary>关自定义子状态后, "等 EC 落定"的轮询步长与步数上限。</summary>
        private const int CustomExitPollMs = 50;
        private const int CustomExitPollSteps = 5;

        /// <summary>回读不一致时, 补写一次前的等待时间。</summary>
        private const int ReassertDelayMs = 150;

        public CommandResult Set(SystemPerMode mode)
        {
            switch (mode)
            {
                case SystemPerMode.CustomMode:
                    // 自定义模式: 不改 EC 档位, 仅打开自定义功耗子状态
                    // (SPL/SPPT/温度墙的具体数值由 CPU 页下发, 存于 EC 命令 23)
                    {
                        var opened = MethodServices.SetValue(MethodName.CPUPower, CPUPower.OpenState);
                        return new CommandResult(opened, opened ? "设置成功" : "设置失败");
                    }

                case SystemPerMode.BalanceMode or SystemPerMode.PerformanceMode or SystemPerMode.QuietMode:
                    // 顺序即语义(2026-10-06 修): **先关自定义功耗子状态, 再写固件档位**。
                    //
                    // 日志证据(2026-10-06.log:331-335; 注意日志不记录写入载荷, "写入 8(办公)"
                    // 是由紧随的 QuietMode 事件**推断**的, 不是日志原文):
                    //   20:38:39,993 写入 8 → 40,018 写入 23 → 40,021 写入 23
                    //   → 40,024 事件 QuietMode → 40,042 事件 BalanceMode
                    // 该文件里"自定义确实开着时关 23"共 5 簇, 全部服从同一条规律:
                    // 关 23 会把固件档位退回**进入自定义前的那一档**(19:00 两次退回 Performance、
                    // 20:38 退回 Balance), 且只有退回值 ≠ 刚写入值时才补抛一次档位事件 ——
                    // 于是刚写好的档位被顶掉, 前端"写后独立回读"读到的是被退回的那一档,
                    // 表现为切换失败 / 胶囊弹回游戏。反过来, 5 簇里"退回值 = 刚写入值"的两簇
                    // (01:37、20:39) 没有第二次事件, 与上述规律一致; "本来就已关再关"的 6 簇
                    // 是无状态跃迁, 均无后续事件, 所以重复关是安全的。
                    // 参考(只是顺序意图): 官方在热键事件路径里也是先收敛自定义、再刷新档位表现
                    // (decompiled/main.cs:2182-2184; 其中 SetAP_PerformaceMode 仅刷 UI)。
                    var hadCustom = CloseCustomOverrideBeforeModeWrite();
                    if (!MethodServices.SetValue(MethodName.SystemPerMode, mode))
                        return new CommandResult(false, "设置失败");

                    var mismatch = ReassertIfNotApplied(mode, hadCustom);
                    // 电源计划联动跟"用户点了什么"走, 不跟回读走 —— 默认关闭, 影响有限。
                    SyncPowerPlan(mode);
                    // 命令已被接受但回读没看到目标档位: 按契约**不报失败**。
                    // "命令被接受但回读未确认"记为 accepted(不算成功、也不算失败), 权威判据是
                    // 前端自己"写后独立重读"; 若这里返回 false, 前端会走 failed 分支并**跳过**
                    // 那次独立回读(mode.ts:191 的 if (accepted)), 把一次未确认报成确定的失败
                    // 且回滚到没有新鲜读数支撑的档位。契约见 AGENTS.md §模式约定。
                    return new CommandResult(
                        true,
                        mismatch ? "命令已被接受，但回读未确认（读数过期或固件未采纳）" : "设置成功");
            }

            // AirPlaneMode 不在此补全: 它依赖命令 9(显卡模式, 写后需重启) 组合,
            // 作为"模式热切换"不安全, 独显/混合切换保留在设置页(GPUDirectConnection)
            return new CommandResult(false, "不支持的模式");
        }

        /// <summary>
        /// 若自定义功耗子状态可能开着, 先关掉它, 并等 EC **真的报告已关**再返回。
        ///
        /// 三个坑, 都别再踩:
        /// 1. 不看 `SetValue` 返回值: 写入被令牌桶/通道吃掉时仍按"已关"继续, 修复就静默退化成
        ///    旧顺序(先写 8 再关 23)。CPUPower 恰是最容易被吃掉的桶 —— 开一次自定义写 4 次,
        ///    而单命令突发容量只有 5(HwWriteGate)。
        /// 2. 按枚举读: 读失败时默认值是 0 = CloseState, 会被当成"本来就已关"而跳过整个关闭。
        ///    一律按 byte 读(255 = 读不到), 且"读不到"必须当作"可能还开着"。
        /// 3. 盲等固定时长: 实测 EC 落定约 11~67ms(关 23 到补抛档位事件的间隔), 但有界轮询才
        ///    能在慢的时候真的等到、快的时候不多等。
        /// </summary>
        /// <returns>是否执行过"关闭"动作(供补写前多等一拍作参考)。</returns>
        private static bool CloseCustomOverrideBeforeModeWrite()
        {
            try
            {
                var raw = MethodServices.GetValue<byte>(MethodName.CPUPower);
                // 只有明确读到"已关"才跳过; 明确开着或读不到(255)都执行一次幂等关闭。
                if (raw != (byte)CPUPower.Unknow && raw != (byte)CPUPower.OpenState)
                    return false;

                if (!MethodServices.SetValue(MethodName.CPUPower, CPUPower.CloseState))
                    Logger.Warn("关闭自定义功耗子状态未被接受(写入闸门或通道异常), 仍继续写档位");

                for (var step = 0; step < CustomExitPollSteps; step++)
                {
                    Thread.Sleep(CustomExitPollMs);
                    if (MethodServices.GetValue<byte>(MethodName.CPUPower) != (byte)CPUPower.OpenState)
                        return true;
                }

                Logger.Warn(
                    $"关闭自定义功耗子状态后 {CustomExitPollSteps * CustomExitPollMs}ms 内仍读到 OpenState, " +
                    "档位写入可能被顶回(见 docs/KNOWN_ISSUES.md 第二轮回归)");
                return true;
            }
            catch (Exception ex)
            {
                // 读/写异常不阻塞切档: 档位写入本身仍会执行, 结果交前端独立回读判定
                Logger.Warn($"关闭自定义功耗子状态异常(继续切档): {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// 回读确认; **只有明确读到别的档位**才补写一次。
        ///
        /// 三态不得混淆(与前端 mode store 同一口径):
        /// - 回读到目标档位         → 不补写;
        /// - 回读到别的档位(被顶回) → 隔一拍补写一次(补写本身被拒只记 WARN, 不改判据);
        /// - 回读失败/未知(255)     → 这次读不能当判据, 也不补写。
        /// 注意: 补写是"尽力收敛", 不是成功判据 —— 判据永远是前端那次独立回读。
        /// 另: 补写会把并发的真实 Fn 按键"改回"用户点的档(last-writer-wins), 有意如此。
        /// </summary>
        /// <returns>true = 回读明确看到与目标不一致(调用方按 accepted 语义表述, 不报失败)。</returns>
        private static bool ReassertIfNotApplied(SystemPerMode mode, bool hadCustom)
        {
            var observed = ReadBackMode();
            if (observed == null || observed == mode) return false;

            Logger.Warn($"档位写入未被采纳: 期望 {mode}, 回读到 {observed} → 补写一次");
            // 退出自定义覆盖的余波需要更长一点才落定, 多给一拍
            Thread.Sleep(hadCustom ? ReassertDelayMs : CustomExitPollMs);
            if (!MethodServices.SetValue(MethodName.SystemPerMode, mode))
            {
                Logger.Warn("档位补写未被接受(写入闸门或通道异常)");
                return true;
            }

            observed = ReadBackMode();
            return observed != null && observed != mode;
        }

        /// <summary>回读固件档位。读不到或读到未知值(255)返回 null —— 不当作"已生效"。</summary>
        private static SystemPerMode? ReadBackMode()
        {
            try
            {
                // 必须按 byte 读: T=SystemPerMode 时读失败的默认值是 0(BalanceMode)而不是 255,
                // 那会让"读失败"被当成"读到游戏档", 进而误判成功或触发多余的补写。
                var raw = MethodServices.GetValue<byte>(MethodName.SystemPerMode);
                return raw == (byte)SystemPerMode.Unknow ? null : (SystemPerMode)raw;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// 镜像固件已完成的档位切换(供 Fn 热键使用)。
        ///
        /// 与 <see cref="Set"/> 的关键区别: <b>不写命令 8</b>。
        /// 固件在档位变化时会抛出 HID_EVENT20 事件 15; 若在事件处理里再写命令 8,
        /// 就会触发下一次事件, 形成 事件 → Set → 事件 的自激循环(按一次连切十几次)。
        /// **"不写命令 8"才是防自激的根据** —— 这里改口是因为旧注释那句"命令 23 不会触发
        /// 事件 15"与 2026-10-06 的日志不符: 该文件里"自定义确实开着时关 23"的 5 簇中, 有 3 簇
        /// 在关 23 之后补抛了一次档位事件(见 Set 的注释与 docs/KNOWN_ISSUES.md 第二轮回归)。
        /// 但"本来就已关再关"的 6 簇是无状态跃迁、均无后续事件, 所以这里的收敛写本身不构成自激。
        ///
        /// ⚠️ 待查: 若"关 23 会把档位退回进入自定义前那一档"成立, Fn 路径在自定义态下按热键
        /// 就会缺少纠正手段(本方法按约定不能写命令 8)。需真机在自定义态按一次 Fn+Q 看是否出现
        /// 两个事件、最终停在哪一档, 再决定要不要补收敛 —— 见 docs/KNOWN_ISSUES.md 第 24 项
        /// 「模式切换的失败路径」。(引用一律写条目号而非行号: 文档一改行号就漂。)
        /// </summary>
        public void ApplyMirrored(SystemPerMode mode)
        {
            try
            {
                // 自定义功耗子状态会覆盖标准档的 SPL/SPPT 语义, 镜像到标准档时关闭它。
                // 读失败时按 byte 读才是 255, 按枚举读会得到 0(CloseState) 而漏掉关闭。
                var custom = MethodServices.GetValue<byte>(MethodName.CPUPower);
                if (custom == (byte)CPUPower.OpenState)
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
