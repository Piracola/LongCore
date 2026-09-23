using System.Runtime.InteropServices;
using JiaoLongControl.Server.Core.Controllers;
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Utils;
using Microsoft.Web.WebView2.Core;

namespace JiaoLongControl.Server.Interop
{
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public class Bridge : IDisposable
    {
        private static readonly log4net.ILog Logger =
            log4net.LogManager.GetLogger(typeof(Bridge));

        public static Bridge Instance { get; } = new();

        private CoreWebView2? _webView;
        private const int SaveIntervalMs = 5000;

        private readonly object _configLock = new();
        private Timer _saveTimer;
        internal JiaoLongConfig Config { get; private set; } = null!;

        public Bridge()
        {
            Config = ConfigSerializer.Load();
            // 日志策略在配置就绪后立即生效。放在 Bridge 构造函数里而不是 App.OnStartup:
            // ConfigSerializer.Load() 本身就会写日志(越界收敛等), 尽早应用才能覆盖它。
            LogRuntime.Apply(Config.Log);
            _saveTimer = new Timer(
                _ => FlushIfDirty(),
                null,
                SaveIntervalMs,
                SaveIntervalMs);
        }
        
        public void ApplyConfig(JiaoLongConfig config)
        {
            lock (_configLock)
            {
                Config = config;
            }

            // 设置页保存后即时生效, 无需重启(改日志级别却要重启是很糟的体验)。
            LogRuntime.Apply(config?.Log);

            try
            {
                _webView?.PostWebMessageAsJson("{\"type\":\"config-changed\"}");
            }
            catch (Exception ex)
            {
                Logger.Warn($"config-changed 通知失败: {ex.Message}");
            }
        }
        internal void FlushIfDirty()
        {
            try
            {
                string memoryYaml;
                lock (_configLock)
                {
                    memoryYaml = ConfigSerializer.Serialize(Config);
                }

                var diskYaml = ConfigSerializer.ReadFileContent();
                if (diskYaml != memoryYaml)
                {
                    lock (_configLock)
                    {
                        ConfigSerializer.Save(Config);
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.Warn($"配置差异落盘失败: {ex.Message}");
            }
        }

        public void InitWebView(CoreWebView2 webView)
        {
            _webView = webView;
        }

        public CpuController CPU { get; } = new();
        public FanController Fan { get; } = new();
        public GpuController GPU { get; } = new();
        public LogoLightController LogoLight { get; } = new();
        public KeyboardController Keyboard { get; } = new();
        public PerformanceModeController PerformanceMode { get; } = new();
        public ConfigController ConfigCtrl { get; } = new();
        public AutoStartController AutoStart { get; } = new();
        public AutoFanControl AutoFan { get; } = new();
        public KeyboardGradientController KeyboardGradient { get; } = new();
        public PowerController Power { get; } = new();
        public NvidiaGpuController NvidiaGpu { get; } = new();
        public RyzenSmuController RyzenSmu { get; } = new();
        public SystemInfoController SystemInfo { get; } = new();
        public HotkeyController Hotkey { get; } = new();

        /// <summary>向前端推送 WebView 消息(如 mode-changed)。浏览器直连/未就绪时静默跳过。</summary>
        internal void NotifyWeb(string json)
        {
            try
            {
                _webView?.PostWebMessageAsJson(json);
            }
            catch (Exception ex)
            {
                Logger.Warn($"Web 通知失败: {ex.Message}");
            }
        }

        public void Dispose()
        {
            _saveTimer?.Dispose();
            _saveTimer = null!;   // Dispose 后不再使用, 仅切断 Timer 引用
            FlushIfDirty();
            Hotkey.Dispose();
            CPU.Dispose();
            Fan.Dispose();
            AutoFan.Dispose();
            KeyboardGradient.Dispose();
            RyzenSmu.Dispose();
            NvidiaGpu.Dispose();
        }
    }
}
