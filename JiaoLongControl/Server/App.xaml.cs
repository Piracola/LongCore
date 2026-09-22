using System.Diagnostics;
using System.Reflection;
using System.Windows;
using JiaoLongControl.Server.Interop;
using JiaoLongControl.Server.Core.Utils;
using log4net;
using log4net.Config;

namespace JiaoLongControl.Server
{
    public partial class App : Application
    {
        private static Mutex? _mutex;
        private readonly ILog Logger = LogManager.GetLogger(typeof(App));

        /// <summary>启动耗时计时。冷启动白屏排查用：各阶段打点见 App.OnStartup 与 MainWindow。</summary>
        internal static readonly Stopwatch StartupClock = Stopwatch.StartNew();

        /// <summary>应用版本（AssemblyMetadata AppVersion），版本变化时才清理 WebView2 磁盘缓存。</summary>
        internal static string Version { get; private set; } = "0.0.0";

        protected override void OnStartup(StartupEventArgs e)
        {
            XmlConfigurator.Configure();
            const string appName = "LongCore_Main_Instance";
            bool createdNew;
            _mutex = new Mutex(true, appName, out createdNew);
            if (!createdNew)
            {
                MessageBox.Show("程序已在运行中。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
                Current.Shutdown();
                return;
            }

            var version = "0.0.0";
            foreach (var attr in Assembly.GetExecutingAssembly()
                         .GetCustomAttributes<AssemblyMetadataAttribute>())
            {
                if (attr.Key == "AppVersion")
                {
                    version = attr.Value ?? "0.0.0";
                    break;
                }
            }

            Version = version;
            ConfigSerializer.Initialize(version);
            Logger.Info($"启动计时: 配置装载完成 {StartupClock.ElapsedMilliseconds}ms");

            // 全局异常兜底：任何未处理异常都记录日志，避免闪退后无迹可查
            AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            {
                Logger.Fatal("AppDomain 未处理异常（应用即将终止）: " +
                             (args.ExceptionObject as Exception)?.ToString(), args.ExceptionObject as Exception);
                Cleanup();
            };

            // UI 线程（Dispatcher）未处理异常：记录日志并阻止闪退
            DispatcherUnhandledException += (_, e) =>
            {
                Logger.Error("UI 线程未处理异常: " + e.Exception, e.Exception);
                e.Handled = true;
            };

            TaskScheduler.UnobservedTaskException += (_, e) =>
            {
                Logger.Error("未观察到的 Task 异常: " + e.Exception, e.Exception);
                e.SetObserved();
            };

            AppDomain.CurrentDomain.ProcessExit += (_, __) => Cleanup();

            base.OnStartup(e);

            // EC 护栏: 若上次运行硬崩溃时手动风扇模式仍接管 EC, 尽早恢复自动模式。
            // Bridge.Instance 首次访问会构造驱动实例, 放后台线程避免阻塞窗口启动。
            Task.Run(() => Core.Services.EcGuard.RecoverIfNeeded());

            // 冷启动优化: 提前发起 WebView2 环境创建(最贵的一次串行等待), 让它与下面的启动工作重叠
            _ = JiaoLongControl.Server.MainWindow.EnsureEnvironmentTask();

            // Fn 热键监听(HID_EVENT20): 接管性能模式切换键, 其余键保持固件默认。
            // 订阅 root\WMI 事件在冷启动时可能耗时数百毫秒到数秒 —— 放后台线程, 不再阻塞窗口创建,
            // 否则用户看到的就是"点了图标半天不出窗口"。热键在界面出现前也不存在被按的可能。
            Task.Run(() =>
            {
                try
                {
                    Bridge.Instance.Hotkey.Start();
                }
                catch (Exception ex)
                {
                    Logger.Error("热键监听启动异常: " + ex.Message, ex);
                }
            });

            // 过温看门狗(L3 保护): CPU ≥98℃ 持续 10s 强制风扇最大转速, 回落 92℃ 持续 30s 后
            // 显式交还 EC 自动温控(只拉满不释放会让看门狗自身变成风险源)
            Core.Services.ThermalWatchdog.Start();

            Task.Run(async () =>
            {
                var updater = new InnoUpdater(version);
                await updater.CheckForUpdatesAsync();
            });

            var mainWindow = new MainWindow();
            bool startInTray = Environment.GetCommandLineArgs()
                .Any(arg => arg.Equals("--boot", StringComparison.OrdinalIgnoreCase)) &&
                Bridge.Instance.Config.App.BootMinimized;

            if (!startInTray)
            {
                mainWindow.Show();
                Logger.Info($"启动计时: 主窗口已显示 {StartupClock.ElapsedMilliseconds}ms");
            }
        }

        protected override void OnExit(ExitEventArgs e)
        {
            Cleanup();
            base.OnExit(e);
        }

        private void Cleanup()
        {
            try
            {
                Core.Services.EcGuard.MarkProcessExiting();
                // 仅在手动风扇仍接管 EC 时恢复自动模式, 避免每次退出都无谓写 EC
                if (Core.Services.EcGuard.IsEngaged)
                    Bridge.Instance.Fan.RemoveFanSpeed();
                Bridge.Instance.Dispose();
            }
            catch (Exception ex)
            {
                Logger.Error("Cleanup failed: " + ex.Message, ex);
            }
        }
    }
}