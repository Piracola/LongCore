using System.Management;
using System.Runtime.InteropServices;
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Utils;
using JiaoLongControl.Server.Interop;
using log4net;

namespace JiaoLongControl.Server.Core.Controllers;

/// <summary>
/// Fn 热键监听: 订阅 root\WMI 的 HID_EVENT20 事件(协议见 docs/02_协议手册.md §7)。
/// 当前仅接管"性能模式切换"键(事件 15): 循环 高性能→平衡→静音 并弹 OSD;
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
            // detail[2] 为数值(亮度档位等), 当前接管的事件均不需要
            if (name != EventPerformanceModeKey)
                return; // 其余 Fn 键保持固件默认行为

            if (!IsHotkeyEnabled())
                return;

            CyclePerformanceMode();
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
    /// 标准三档循环: 高性能(1) → 平衡(0) → 静音(2) → 高性能。
    /// 当前处于自定义(3)时, 从高性能重新开始循环。
    /// </summary>
    private void CyclePerformanceMode()
    {
        var order = new[]
        {
            SystemPerMode.PerformanceMode,
            SystemPerMode.BalanceMode,
            SystemPerMode.QuietMode,
        };

        byte current;
        try
        {
            var res = Bridge.Instance.PerformanceMode.Get();
            current = res.Success && res.Data is SystemPerMode m
                ? (byte)m
                : (byte)SystemPerMode.PerformanceMode;
        }
        catch
        {
            current = (byte)SystemPerMode.PerformanceMode;
        }

        // 自定义/未知档 → IndexOf = -1 → +1 = 0 → 归位高性能
        var idx = Array.IndexOf(order, (SystemPerMode)current);
        var next = order[(idx + 1) % order.Length];

        var setRes = Bridge.Instance.PerformanceMode.Set(next);
        Logger.Info($"热键切换性能模式: {current} → {next} ({(setRes.Success ? "成功" : setRes.Message)})");

        if (setRes.Success)
        {
            ShowOsd(ModeName(next));
            // 通知前端同步模式胶囊(浏览器直连无 WebView 时静默跳过)
            Bridge.Instance.NotifyWeb(
                "{\"type\":\"mode-changed\",\"mode\":" + (byte)next + "}");
        }
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
