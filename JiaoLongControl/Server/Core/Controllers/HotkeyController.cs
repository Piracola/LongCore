using System.Management;
using System.Runtime.InteropServices;
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Utils;
using JiaoLongControl.Server.Interop;
using log4net;

namespace JiaoLongControl.Server.Core.Controllers;

/// <summary>
/// Fn 热键监听: 订阅 root\WMI 的 HID_EVENT20 事件(协议见 docs/02_协议手册.md §7)。
/// 当前仅接管"性能模式切换"键(事件 15): 固件自行完成档位切换并把目标档位放在 EventDetail[2],
/// 本类只做镜像(弹 OSD + 通知前端), 绝不回写档位 —— 详见 MirrorPerformanceMode。
/// 其余 Fn 键不拦截, 保持固件默认行为。
/// 配置开关 App.HotkeyEnabled(默认开)。
/// </summary>
[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public class HotkeyController : IDisposable
{
    private static readonly ILog Logger = LogManager.GetLogger(typeof(HotkeyController));

    // EventDetail 载荷: [0]=类型(1=热键) [1]=事件名 [2]=数值
    private const byte PayloadTypeHotkey = 1;
    private const byte EventPerformanceModeKey = 15; // WMIEventName 15 = 性能模式切换

    private ManagementEventWatcher? _watcher;
    private volatile bool _running;
    private readonly object _startLock = new();

    // 热键事件去重: 同一次按键可能被 WMI 重复投递, 同一档位窗口内只处理一次
    private const int MirrorDedupMs = 400;
    private byte _lastMirrorMode = 0xFF;
    private DateTime _lastMirrorUtc = DateTime.MinValue;

    public CommandResult IsRunning()
    {
        return new CommandResult(_running, _running ? "热键监听运行中" : "热键监听未启动", _running);
    }

    public CommandResult Start()
    {
        lock (_startLock)
        {
            if (_running)
                return new CommandResult(true, "热键监听已运行中");
            try
            {
                // HID_EVENT20 注册在 root\WMI(非默认 root\cimv2), 见 decompiled/main.cs
                _watcher = new ManagementEventWatcher("root\\WMI", "SELECT * FROM HID_EVENT20");
                _watcher.EventArrived += OnEventArrived;
                _watcher.Start();
                _running = true;
                Logger.Info("HID_EVENT20 热键监听已启动");
                return new CommandResult(true, "热键监听已启动");
            }
            catch (Exception ex)
            {
                Logger.Error("热键监听启动失败: " + ex.Message, ex);
                DisposeWatcher();
                return new CommandResult(false, "热键监听启动失败: " + ex.Message);
            }
        }
    }

    public CommandResult Stop()
    {
        lock (_startLock)
        {
            DisposeWatcher();
            _running = false;
            return new CommandResult(true, "热键监听已停止");
        }
    }

    private void DisposeWatcher()
    {
        if (_watcher == null)
            return;
        try
        {
            _watcher.EventArrived -= OnEventArrived;
            _watcher.Stop();
            _watcher.Dispose();
        }
        catch (Exception ex)
        {
            Logger.Warn("热键监听释放异常: " + ex.Message);
        }
        _watcher = null;
    }

    private void OnEventArrived(object sender, EventArrivedEventArgs e)
    {
        try
        {
            if (e.NewEvent.Properties["EventDetail"]?.Value is not byte[] detail || detail.Length < 3)
                return;
            if (detail[0] != PayloadTypeHotkey)
                return;

            byte name = detail[1];
            if (name != EventPerformanceModeKey)
                return; // 其余 Fn 键保持固件默认行为

            if (!IsHotkeyEnabled())
                return;

            // detail[2] = 固件已经切换到的目标档位。
            // 协议事实(见 decompiled/main.cs:2177 官方实现): 按热键时固件"自己"就把档位切好了,
            // 事件只是把结果回传。客户端必须只镜像该值。
            MirrorPerformanceMode(detail[2]);
        }
        catch (Exception ex)
        {
            Logger.Error("热键事件处理失败: " + ex.Message, ex);
        }
    }

    private static bool IsHotkeyEnabled()
    {
        try
        {
            return Bridge.Instance.Config.App.HotkeyEnabled;
        }
        catch
        {
            return true; // 配置不可读时保持默认开启
        }
    }

    /// <summary>
    /// 镜像固件已完成的档位切换 —— 只更新本进程的表现层, 绝不回写 EC 档位。
    ///
    /// 为什么不能回写: 档位由固件持有, 每次档位变化固件都会抛出 HID_EVENT20 事件 15。
    /// 旧实现收到事件后调用 PerformanceMode.Set(next) 去写命令 8, 该写入又让固件再抛一次事件,
    /// 于是形成 事件 → Set → 事件 的自激循环 —— 这就是"按一次连切十几次"的恶性 bug 根因。
    ///
    /// 旧实现还完全忽略了 detail[2] 携带的目标档位(自行从当前档推算下一档),
    /// 而官方实现正是以该值为准(见 decompiled/main.cs:2177)。
    /// </summary>
    /// <param name="mode">事件 detail[2] 携带的目标档位(命令 8 语义: 0 平衡 / 1 高性能 / 2 静音)。</param>
    private void MirrorPerformanceMode(byte mode)
    {
        // 命令 8 只有三档; 3=自定义 是本项目的本地逻辑态, 固件不会回传
        if (mode != (byte)SystemPerMode.BalanceMode &&
            mode != (byte)SystemPerMode.PerformanceMode &&
            mode != (byte)SystemPerMode.QuietMode)
        {
            Logger.Warn($"热键事件携带未知档位 {mode}, 已忽略");
            return;
        }

        // 去重: 同一次按键可能被 WMI 重复投递, 同一档位窗口内只处理一次, 避免 OSD 闪烁
        var now = DateTime.UtcNow;
        if (mode == _lastMirrorMode && (now - _lastMirrorUtc).TotalMilliseconds < MirrorDedupMs)
            return;
        _lastMirrorMode = mode;
        _lastMirrorUtc = now;

        var target = (SystemPerMode)mode;

        // 收敛自定义功耗子状态(只写命令 23, 不写命令 8 —— 见方法注释)并联动 Windows 电源计划
        Bridge.Instance.PerformanceMode.ApplyMirrored(target);

        ShowOsd(ModeName(target));
        // 通知前端同步模式胶囊(浏览器直连无 WebView 时静默跳过)
        Bridge.Instance.NotifyWeb(
            "{\"type\":\"mode-changed\",\"mode\":" + mode + "}");

        Logger.Info($"热键镜像性能模式: → {target}");
    }

    private static string ModeName(SystemPerMode mode) => mode switch
    {
        SystemPerMode.PerformanceMode => "高性能",
        SystemPerMode.BalanceMode => "平衡",
        SystemPerMode.QuietMode => "静音",
        SystemPerMode.CustomMode => "自定义",
        _ => mode.ToString(),
    };

    private static void ShowOsd(string modeName)
    {
        try
        {
            ModeOsdWindow.ShowMode($"性能模式 · {modeName}");
        }
        catch (Exception ex)
        {
            Logger.Warn("OSD 显示失败: " + ex.Message);
        }
    }

    public void Dispose()
    {
        Stop();
    }
}
