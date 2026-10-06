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
        private EventWaitHandle? _quitEvent;
        private MainWindow? _mainWindow;
        private bool _startupOk;
        private readonly ILog Logger = LogManager.GetLogger(typeof(App));

        /// <summary>安装器用它请求正在运行的实例优雅退出(见 --quit 处理)。</summary>
        internal const string QuitEventName = "LongCore_Quit_Request";

        /// <summary>启动耗时计时。冷启动白屏排查用：各阶段打点见 App.OnStartup 与 MainWindow。</summary>
        internal static readonly Stopwatch StartupClock = Stopwatch.StartNew();

        /// <summary>应用版本（AssemblyMetadata AppVersion），版本变化时才清理 WebView2 磁盘缓存。</summary>
        internal static string Version { get; private set; } = "0.0.0";

        protected override void OnStartup(StartupEventArgs e)
        {
            XmlConfigurator.Configure();

            // 安装器用: "LongCore.exe --quit" 只负责让正在运行的实例优雅退出
            // (走 EcGuard 恢复 + 驱动卸载, 而不是被强杀留下半挂起的驱动), 本进程随即结束。
            if (e.Args.Any(a => a.Equals("--quit", StringComparison.OrdinalIgnoreCase)))
            {
                RequestRunningInstanceExit();
                Current.Shutdown();
                return;
            }

            const string appName = "LongCore_Main_Instance";
            bool createdNew;
            _mutex = new Mutex(true, appName, out createdNew);
            if (!createdNew)
            {
                MessageBox.Show("程序已在运行中。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
                Current.Shutdown();
                return;
            }

            StartQuitRequestWatcher();

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

            _ = StartupWatchdogAsync();

            bool startInTray;
            MainWindow mainWindow;
            try
            {
                startInTray = Environment.GetCommandLineArgs()
                    .Any(arg => arg.Equals("--boot", StringComparison.OrdinalIgnoreCase)) &&
                    Bridge.Instance.Config.App.BootMinimized;

                // startInTray 决定构造期建不建 WebView: 隐藏窗口里 HwndHost 没有 HWND, 建了也初始化不了
                mainWindow = new MainWindow(startInTray);
                _mainWindow = mainWindow;
            }
            catch (Exception ex)
            {
                // 绝不能让这里悄悄失败: 否则进程活着、没有窗口、没有托盘图标, 还占着互斥体,
                // 用户只会看到"程序已在运行中", 安装器也停不掉它。
                Logger.Fatal("启动失败(窗口未能创建), 进程退出: " + ex, ex);
                try
                {
                    MessageBox.Show(
                        "LongCore 启动失败：\n" + ex.Message + "\n\n硬件驱动可能被上一次运行的进程占用，请重启电脑后重试。",
                        "LongCore",
                        MessageBoxButton.OK,
                        MessageBoxImage.Error);
                }
                catch
                {
                }
                Current.Shutdown();
                return;
            }

            if (startInTray)
            {
                // 自启隐藏启动: 不给用户弹窗, 但立刻在屏幕外把界面真正加载好再挂起 ——
                // 用户点托盘时只剩"恢复位置 + Show + Resume", 而不是等一次完整冷启动(~1s)。
                mainWindow.StartOffScreenPrewarm();
            }
            else
            {
                mainWindow.Show();
                Logger.Info($"启动计时: 主窗口已显示 {StartupClock.ElapsedMilliseconds}ms");
            }

            _startupOk = true;
        }

        /// <summary>
        /// 启动看门狗: Bridge/驱动初始化有可能【永久阻塞】(典型场景: 驱动被上一次运行的进程强杀后
        /// 留在半挂起状态, DeviceIoControl 永不返回)。那种情况下进程既没有窗口也没有托盘图标,
        /// 用户只会在再次启动时看到"程序已在运行中"。这里兜底给出可见提示并结束进程 ——
        /// 至少让问题可见, 并把互斥体放掉(否则安装器也停不掉这个实例)。
        /// </summary>
        private async Task StartupWatchdogAsync()
        {
            await Task.Delay(TimeSpan.FromSeconds(40));
            if (_startupOk)
                return;
            Logger.Fatal("启动超时: 40s 内窗口未创建(Bridge/驱动初始化被阻塞?), 强制结束进程");
            try
            {
                MessageBox.Show(
                    "LongCore 启动超时：硬件驱动可能仍被上一次运行的进程占用。\n\n请重启电脑后重试。",
                    "LongCore",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
            }
            catch
            {
                // UI 线程可能已阻塞, 弹窗失败也要退出
            }
            Environment.Exit(1); // UI 线程已不可用, 不能走 Current.Shutdown()
        }

        /// <summary>监听外部退出请求(安装器 --quit), 派发到 UI 线程, 走与托盘「退出」相同的路径。</summary>
        private void StartQuitRequestWatcher()
        {
            try
            {
                _quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
                var waiter = new Thread(() =>
                {
                    try
                    {
                        _quitEvent.WaitOne();
                    }
                    catch
                    {
                        return;
                    }
                    Logger.Info("收到外部退出请求(--quit), 优雅退出中");
                    try
                    {
                        Dispatcher.BeginInvoke(new Action(() => _mainWindow?.ExitFromOutside()));
                    }
                    catch
                    {
                        // 退出中 Dispatcher 可能已关闭
                    }
                })
                {
                    IsBackground = true,
                    Name = "QuitRequestWatcher"
                };
                waiter.Start();
            }
            catch (Exception ex)
            {
                Logger.Warn("退出请求监听启动失败: " + ex.Message);
            }
        }

        /// <summary>--quit 模式: 给正在运行的实例发退出信号(没在运行则什么也不做)。</summary>
        private void RequestRunningInstanceExit()
        {
            try
            {
                if (EventWaitHandle.TryOpenExisting(QuitEventName, out var evt))
                {
                    using (evt)
                        evt.Set();
                    Logger.Info("--quit: 已请求正在运行的实例退出");
                }
                else
                {
                    Logger.Info("--quit: 没有正在运行的实例");
                }
            }
            catch (Exception ex)
            {
                Logger.Warn("--quit 请求失败: " + ex.Message);
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