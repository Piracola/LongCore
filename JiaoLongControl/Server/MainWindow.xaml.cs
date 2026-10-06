using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using JiaoLongControl.Server.Core.Utils;
using JiaoLongControl.Server.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;

namespace JiaoLongControl.Server
{
    public partial class MainWindow : Window
    {
        private static readonly log4net.ILog Logger =
            log4net.LogManager.GetLogger(typeof(MainWindow));

        // 虚拟主机名必须避开 *.local: Chromium 把 .local 当 mDNS 域(RFC 6762), 每次导航都要等
        // mDNS 解析超时 —— 实测固定 +2.0s, 与缓存/代理/协议/是否首次无关(app.local 导航到 DOM 就绪
        // 2144ms, app.localhost 只要 204ms)。.localhost 是 RFC 6761 保留域, Chromium 直接判为回环,
        // 完全不查网络。这两处必须同名, 所以只留一个来源。
        private const string VirtualHost = "app.localhost";
        private const string AppHostUrl = "https://" + VirtualHost + "/index.html";

        private Hardcodet.Wpf.TaskbarNotification.TaskbarIcon _taskbarIcon = null!;
        private string _webRoot = string.Empty;
        private WebView2? _webView;
        // 是否已销毁：仅表示 WebView 对象的有无，不能代表 CoreWebView2 已初始化完成。
        // CoreWebView2 是异步初始化的，因此判断"能否使用"必须看 SafeCore(_webView) 是否为 null。
        private bool _webViewDestroyed = true;
        private bool _allowClose;
        // 退出中：抑制退出阶段 ProcessFailed 等无意义日志/重建（浏览器进程被销毁时正常退出）
        private bool _isShuttingDown;
        // WebView 重建代次：异步初始化完成后需校验代次，避免旧任务的错误覆盖层/导航落到新 WebView 或已销毁的 UI 树
        private int _webViewGeneration;
        // 进程崩溃连续计数：渲染/GPU 进程崩溃先轻量 Reload，连续崩溃则整体重建
        private int _processFailCount;
        // 连续重建计数：自动重建超过上限则停止，避免进程反复崩溃时无限重建
        private int _recreateCount;
        private Grid? _errorOverlay;
        // 当前是否浅色主题: 由配置(App.Theme)解析, 前端切换主题时经 theme-changed 消息同步
        private bool _isLight;
        // 离屏预热: 自启隐藏启动时把窗口显示到屏幕外, 界面加载完后 Hide + Suspend 收回托盘;
        // 用户点托盘只需"恢复位置 + Show + Resume"。坐标取远小于任何虚拟桌面范围的负值。
        private const int OffScreenCoordinate = -32000;
        private bool _offScreenPrewarm; // 预热中/尚未被用户打开
        private bool _prewarmed;        // 已完成 Hide + Suspend 收尾
        private long _resumeAt;         // Resume 时刻, 用于测量"点击托盘 → 前端恢复渲染"
        // ProcessFailed 处理器引用：ConfigureWebView 订阅、DestroyWebView 注销，保证重建后旧回调不再触发
        private EventHandler<CoreWebView2ProcessFailedEventArgs>? _processFailedHandler;

        // 冷启动优化: WebView2 环境创建(拉起 msedgewebview2.exe、准备用户数据目录)是启动阶段最贵的
        // 串行等待之一。提前在 App.OnStartup 里发起, 与热键订阅/托盘/窗口创建重叠, 而不是等窗口
        // 显示后才发起。失败/超时由重试路径 ResetEnvironmentTask 丢弃, 不缓存故障任务。
        private static readonly object EnvLock = new();
        private static Task<CoreWebView2Environment>? _envTask;

        /// <summary>发起（或复用进行中的）WebView2 环境创建任务。</summary>
        internal static Task<CoreWebView2Environment> EnsureEnvironmentTask()
        {
            lock (EnvLock)
            {
                if (_envTask is { IsFaulted: false, IsCanceled: false })
                    return _envTask;

                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "JiaoLongControl",
                    "WebView2"
                );
                Directory.CreateDirectory(userDataFolder);
                // CoreWebView2Environment.CreateAsync 在 userDataFolder 被残留进程锁定时可能长时间挂起而非抛异常，
                // 调用方必须带超时（见 InitializeWebViewAsync）
                _envTask = CoreWebView2Environment.CreateAsync(null, userDataFolder);
                return _envTask;
            }
        }

        private static void ResetEnvironmentTask()
        {
            lock (EnvLock)
            {
                _envTask = null;
            }
        }

        public MainWindow(bool startHidden = false)
        {
            InitializeComponent();
            // 配置已在 App.OnStartup 初始化完成, 此处解析主题并先于 WebView 创建着色, 避免启动闪色
            _isLight = UiTheme.IsLight(Bridge.Instance.Config.App.Theme);
            ApplyThemeColors();
            InitializePaths();
            InitializeTray();

            // 自启隐藏(--boot)时窗口不会 Show, 构造期不建 WebView: 隐藏窗口里 HwndHost 还没有 HWND,
            // 此时发起 WebView2 初始化只会超时重试(3 次 × 15s)并留下一块错误遮罩, 用户点托盘图标时
            // 还得先销毁重建 —— "先白屏再加载"有一半来自这里。改为窗口首次显示(Loaded)时创建。
            Loaded += (_, _) => EnsureWebViewCreated();
            if (!startHidden)
                CreateWebView();

            Logger.Info($"启动计时: 主窗口构造完成 {App.StartupClock.ElapsedMilliseconds}ms");

            // 启动后立刻在后台恢复开机策略，不依赖窗口显示。
            // 注意：--boot 隐藏启动时 App.OnStartup 不会 Show 本窗口，Loaded 事件永远不触发，
            // 若把 SelfStart 放在 Loaded 里策略将永不应用。后台线程避免驱动加载/WMI 查询阻塞窗口显示。
            _ = RunSelfStartAsync();

            Closing += OnClosing;
            SystemEvents.PowerModeChanged += OnPowerModeChanged;
        }

        /// <summary>在后台应用开机自启策略，异常不外泄。</summary>
        private static async Task RunSelfStartAsync()
        {
            try
            {
                await Task.Run(() => new SelfStart());
            }
            catch (Exception ex)
            {
                Logger.Error("SelfStart 执行异常", ex);
            }
        }

        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            // 当系统从休眠/睡眠中恢复时，在后台重新应用开机策略
            if (e.Mode == PowerModes.Resume)
            {
                _ = Task.Run(() =>
                {
                    try
                    {
                        new SelfStart();
                    }
                    catch (Exception ex)
                    {
                        Logger.Error("恢复后 SelfStart 执行异常", ex);
                    }
                });
            }
        }

        #region 初始化

        /// <summary>
        /// 安全获取 CoreWebView2。
        /// 浏览器进程崩溃后，WebView2.CoreWebView2 属性 getter 会抛 InvalidOperationException
        /// （VerifyBrowserNotCrashed）而非返回 null，所有访问都必须经此封装。
        /// 初始化为 null 也代表"当前不可用"，调用方应据此重建而不是尝试 Resume。
        /// </summary>
        private static CoreWebView2? SafeCore(WebView2? view)
        {
            if (view == null)
                return null;
            try
            {
                return view.CoreWebView2;
            }
            catch
            {
                return null;
            }
        }

        private void InitializePaths()
        {
            var exeDir = Path.GetDirectoryName(
                Process.GetCurrentProcess().MainModule!.FileName!
            )!;

            _webRoot = Path.Combine(exeDir, "WebRoot");
        }

        private void CreateWebView()
        {
            // 存在未销毁的 WebView 时拒绝新建，避免重复创建。注意：_webViewDestroyed 为 false
            // 不代表 CoreWebView2 已可用，重建路径需先 DestroyWebView 再调用本方法。
            if (!_webViewDestroyed)
                return;

            int generation = ++_webViewGeneration;
            _processFailCount = 0;

            // 【坑】WebView2 是 HwndHost(独立子窗口), 绝不能在构造期把它设成 Hidden 再改回 Visible:
            // 隐藏期间 WPF 不会建(或会销毁)那个子窗口, 之后再切 Visible 内容永远画不出来 ——
            // 整窗只剩底色, 只有最小化+还原强制重建子窗口才恢复。空白期改用"同色遮": 窗口底色、
            // DefaultBackgroundColor、页面首帧底色三者都是主题色, 所以看不到白。
            _webView = new WebView2
            {
                DefaultBackgroundColor = DrawingColorFrom(UiTheme.Background(_isLight))
            };
            WebViewHost.Children.Clear();
            WebViewHost.Children.Add(_webView);

            _webViewDestroyed = false;

            Logger.Info($"启动计时: WebView 已创建 {App.StartupClock.ElapsedMilliseconds}ms");

            // fire-and-forget：内部已做异常处理与重试，绝不让启动阶段崩溃/白屏
            _ = InitializeWebViewAsync(_webView, generation);
        }

        /// <summary>窗口首次显示时创建 WebView（--boot 隐藏启动构造期不建, 见构造函数）。</summary>
        private void EnsureWebViewCreated()
        {
            try
            {
                if (_webViewDestroyed)
                    CreateWebView();
            }
            catch (Exception ex)
            {
                Logger.Error("创建 WebView 失败", ex);
            }
        }

        /// <summary>
        /// 初始化 WebView2 并加载前端页面。
        /// 环境创建失败（Runtime 缺失 / userDataFolder 被残留进程锁定等）时按递增间隔重试，
        /// 页面导航失败自动重试；最终失败显示带「重新加载」按钮的错误提示而不是静默白屏。
        /// 每步完成后校验 generation，若期间窗口被销毁或 WebView 被重建则立即放弃，防止操作旧实例。
        /// </summary>
        private async Task InitializeWebViewAsync(WebView2 view, int generation)
        {
            // 阶段一：创建 WebView2 环境（重启后首次冷启动较慢，或 userDataFolder 被上次残留进程锁定，
            // 递增重试给 WebView2 释放锁/完成初始化留出时间；加超时防止 CreateAsync 静默挂起导致死屏）
            bool envReady = false;
            for (int attempt = 1; attempt <= 3 && !envReady; attempt++)
            {
                try
                {
                    // 环境创建已在 App.OnStartup 提前发起（见 EnsureEnvironmentTask），这里只等结果。
                    // 超时/失败时丢弃该任务以便重试，避免把故障任务缓存住。
                    var envTask = EnsureEnvironmentTask();
                    var envDone = await Task.WhenAny(envTask, Task.Delay(TimeSpan.FromSeconds(15)));
                    if (envDone != envTask)
                    {
                        ResetEnvironmentTask();
                        throw new TimeoutException("WebView2 环境创建超时（userDataFolder 可能被残留进程锁定）");
                    }
                    var env = await envTask;

                    if (generation != _webViewGeneration || _webViewDestroyed)
                        return;

                    var initTask = view.EnsureCoreWebView2Async(env);
                    var initDone = await Task.WhenAny(initTask, Task.Delay(TimeSpan.FromSeconds(15)));
                    if (initDone != initTask)
                        throw new TimeoutException("WebView2 初始化超时");
                    await initTask;

                    if (generation != _webViewGeneration || _webViewDestroyed)
                        return;

                    ConfigureWebView(view, generation);
                    Bridge.Instance.InitWebView(SafeCore(view)!);
                    Logger.Info($"启动计时: WebView2 环境就绪 {App.StartupClock.ElapsedMilliseconds}ms");

                    envReady = true;
                }
                catch (Exception ex)
                {
                    Logger.Error($"WebView2 初始化失败（第 {attempt} 次）: {ex.Message}");
                    if (attempt < 3)
                    {
                        await Task.Delay(1500 * attempt); // 1.5s / 3s / 5s
                        if (generation != _webViewGeneration || _webViewDestroyed)
                            return;
                    }
                    else
                    {
                        if (generation == _webViewGeneration && !_webViewDestroyed)
                            ShowWebViewError($"界面初始化失败：{ex.Message}\n请确认已安装 Microsoft Edge WebView2 Runtime 后点击「重新加载」重试。");
                        return;
                    }
                }
            }

            if (!envReady)
                return;

            // 阶段二：页面导航 + 失败重试（最多 3 次）
            await RetryNavigationAsync(view, generation);

            // 升级安装会整目录替换 WebRoot 且资源名带内容哈希, 版本变化时清一次磁盘缓存,
            // 避免虚拟域名命中旧版 index.html 而引用到已不存在的旧资源。
            // 位置很关键: 放在导航之后 —— 既不再挡住首屏, 也保住了正常启动时的磁盘缓存。
            _ = ClearDiskCacheOnVersionChangeAsync(view, generation);
        }

        /// <summary>
        /// 仅当应用版本变化时清理 WebView2 磁盘缓存（只清 DiskCache, 不动 localStorage 与 Cookie）。
        ///
        /// 以前是每次启动都在导航前 await 清理, 代价有两份: ① 首屏白等一次清理(最长 3s 超时);
        /// ② 磁盘缓存里含已编译的 JS 代码缓存, 每次清空 = 每次冷启动都重新解析整套前端资源。
        /// </summary>
        private async Task ClearDiskCacheOnVersionChangeAsync(WebView2 view, int generation)
        {
            try
            {
                Directory.CreateDirectory(ConfigSerializer.ConfigDir);
                var marker = Path.Combine(ConfigSerializer.ConfigDir, "webview-cache-version.txt");
                var version = App.Version;
                if (File.Exists(marker) && File.ReadAllText(marker).Trim() == version)
                    return;

                var core = SafeCore(view);
                if (core == null || generation != _webViewGeneration || _webViewDestroyed)
                    return;

                var clearTask = core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
                if (await Task.WhenAny(clearTask, Task.Delay(TimeSpan.FromSeconds(10))) != clearTask)
                {
                    Logger.Warn("清理 WebView2 磁盘缓存超时, 下次启动重试");
                    return;
                }
                File.WriteAllText(marker, version);
                Logger.Info("应用版本变化: 已清理 WebView2 磁盘缓存");
            }
            catch (Exception ex)
            {
                Logger.Warn($"清理 WebView2 磁盘缓存失败: {ex.Message}");
            }
        }

        /// <summary>导航并等待 NavigationCompleted，返回是否成功</summary>
        private async Task<bool> NavigateWithTimeoutAsync(WebView2 view, int generation, TimeSpan timeout)
        {
            var core = SafeCore(view);
            if (core == null)
                return false;

            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler<CoreWebView2NavigationCompletedEventArgs> handler = (sender, e) =>
            {
                // 只响应本实例自己的导航事件，避免旧导航的完成事件误触超时结果
                if (ReferenceEquals(sender, core))
                    tcs.TrySetResult(e.IsSuccess && e.HttpStatusCode == 200);
            };
            core.NavigationCompleted += handler;
            try
            {
                view.Source = Directory.Exists(_webRoot)
                    ? new Uri(AppHostUrl)
                    : new Uri("http://localhost:5173");

                var finished = await Task.WhenAny(tcs.Task, Task.Delay(timeout)) == tcs.Task;
                return finished && tcs.Task.Result;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"导航异常: {ex.Message}");
                return false;
            }
            finally
            {
                // 若期间 WebView 已被销毁/浏览器进程崩溃，用 SafeCore 容错
                try
                {
                    var c = SafeCore(view);
                    if (c != null)
                        c.NavigationCompleted -= handler;
                }
                catch
                {
                }
            }
        }

        /// <summary>页面导航失败重试（最多 3 次）；供初始化与 Resume 恢复共用</summary>
        private async Task RetryNavigationAsync(WebView2 view, int generation)
        {
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                bool ok = await NavigateWithTimeoutAsync(view, generation, TimeSpan.FromSeconds(20));
                if (ok)
                {
                    Logger.Info($"启动计时: 页面导航完成 {App.StartupClock.ElapsedMilliseconds}ms");
                    return;
                }

                Logger.Warn($"WebView 页面加载失败，第 {attempt} 次重试");
                await Task.Delay(1000);

                if (generation != _webViewGeneration || _webViewDestroyed)
                    return;
            }

            if (generation == _webViewGeneration && !_webViewDestroyed)
                ShowWebViewError("界面加载失败，请点击「重新加载」重试。");
        }

        private void ConfigureWebView(WebView2 view, int generation)
        {
            // 初始化正常阶段可安全访问（刚 EnsureCoreWebView2Async 成功）
            var core = SafeCore(view);
            if (core == null)
                throw new InvalidOperationException("CoreWebView2 不可用");

            core.Settings.IsNonClientRegionSupportEnabled = true;
            core.WebMessageReceived += OnWebMessageReceived;

            // 子进程崩溃恢复。注意：崩溃后 CoreWebView2 属性 getter 会抛异常，
            // 因此回调内只用闭包捕获的 core/generation 判断，绝不访问 _webView.CoreWebView2
            _processFailedHandler = (sender, e) =>
            {
                try
                {
                    Dispatcher.BeginInvoke(() => HandleProcessFailed(sender, e, core, generation));
                }
                catch (Exception ex)
                {
                    // 应用退出中 Dispatcher 可能已关闭
                    Logger.Warn($"ProcessFailed 回调分发失败: {ex.Message}");
                }
            };
            core.ProcessFailed += _processFailedHandler;

            // 任何成功的导航都清掉错误覆盖层，并重置崩溃/重建计数
            core.NavigationCompleted += (sender, e) =>
            {
                // 只响应当前实例，防止旧 WebView 的回调误伤新实例
                if (generation != _webViewGeneration || _webViewDestroyed)
                    return;
                if (!ReferenceEquals(sender, core))
                    return;
                if (e.IsSuccess && e.HttpStatusCode == 200)
                {
                    _processFailCount = 0;
                    _recreateCount = 0;
                    RemoveErrorOverlay();
                    _ = FinishPrewarmAsync(); // 预热模式下: 界面已就绪, 收回托盘并挂起
                }
            };

            core.AddHostObjectToScript("bridge", Bridge.Instance);

            if (Directory.Exists(_webRoot))
            {
                core.SetVirtualHostNameToFolderMapping(
                    VirtualHost,
                    _webRoot,
                    CoreWebView2HostResourceAccessKind.Allow
                );
            }
        }

        /// <summary>
        /// WebView2 子进程崩溃处理（经 Dispatcher 转到 UI 线程执行，入参均为闭包捕获的稳定引用）。
        /// 浏览器进程退出必须整体重建；渲染/GPU 进程先轻量 Reload，连续崩溃再重建。
        /// </summary>
        private void HandleProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e, CoreWebView2 core, int generation)
        {
            try
            {
                // 退出阶段浏览器进程被销毁属正常，直接忽略
                if (_isShuttingDown)
                    return;
                // 只处理当前实例的崩溃，忽略旧 WebView 排队的事件
                if (generation != _webViewGeneration || _webViewDestroyed)
                    return;
                if (!ReferenceEquals(sender, core))
                    return;

                Logger.Warn($"WebView2 子进程异常退出: kind={e.ProcessFailedKind}, exitCode={e.ExitCode}");

                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                {
                    _ = DelayedRecreateWebViewAsync(generation, "浏览器进程退出，重建界面");
                    return;
                }

                _processFailCount++;
                if (_processFailCount >= 2)
                {
                    _ = DelayedRecreateWebViewAsync(generation, $"子进程连续崩溃（{_processFailCount} 次），重建界面");
                    return;
                }

                // 渲染/GPU 进程崩溃：轻量恢复——重新加载当前页面（用闭包 core，避免触碰已崩溃的属性 getter）
                try
                {
                    Logger.Warn("尝试 Reload 恢复渲染");
                    core.Reload();
                }
                catch (Exception ex)
                {
                    Logger.Error("Reload 恢复失败", ex);
                    _ = DelayedRecreateWebViewAsync(generation, "Reload 恢复失败，重建界面");
                }
            }
            catch (Exception ex)
            {
                // 兜底：任何异常都不应从这里逃逸到 Dispatcher 导致闪退
                Logger.Error("ProcessFailed 处理异常", ex);
            }
        }

        /// <summary>
        /// 延迟重建：浏览器进程崩溃瞬间重建新 WebView 可能引发原生资源竞争导致二次崩溃，
        /// 等待 1s 让崩溃余波平息后再重建。
        /// </summary>
        private async Task DelayedRecreateWebViewAsync(int generation, string reason)
        {
            try
            {
                await Task.Delay(1000);
                if (generation != _webViewGeneration || _webViewDestroyed)
                    return;
                RecreateWebView(reason);
            }
            catch (Exception ex)
            {
                Logger.Error("延迟重建失败", ex);
            }
        }

        /// <summary>销毁并重建 WebView（含错误/加载覆盖层清理）；连续重建超上限则停止，避免无限循环</summary>
        private void RecreateWebView(string reason)
        {
            try
            {
                _recreateCount++;
                if (_recreateCount > 3)
                {
                    Logger.Error($"WebView 连续重建超过上限，停止自动重建: {reason}");
                    RemoveErrorOverlay();
                    ShowWebViewError("界面连续加载失败，请重启应用。");
                    return;
                }

                Logger.Warn($"重建 WebView: {reason}");
                DestroyWebView();
                if (IsLoaded && Visibility == Visibility.Visible)
                    CreateWebView();
            }
            catch (Exception ex)
            {
                Logger.Error("重建 WebView 失败", ex);
            }
        }

        private void RemoveErrorOverlay()
        {
            try
            {
                if (_errorOverlay != null && WebViewHost.Children.Contains(_errorOverlay))
                    WebViewHost.Children.Remove(_errorOverlay);
                _errorOverlay = null;
            }
            catch
            {
            }
        }

        /// <summary>在 WebView 区域显示错误提示 + 重新加载按钮（兜底，避免白屏无反馈）</summary>
        private void ShowWebViewError(string message)
        {
            try
            {
                // WebView2 是独立 HWND, WPF 元素盖不住它: 先把 WebView 整个拆掉, 提示和「重新加载」
                // 按钮才看得见。拆掉而不是隐藏 —— 被隐藏过的 WebView2 再显示出来画不出内容(见 CreateWebView);
                // 而重试按钮本来就会重建 WebView, 所以拆掉不影响重试。
                DestroyWebView();

                var overlay = new Grid
                {
                    Background = new SolidColorBrush(UiTheme.Background(_isLight)),
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                    VerticalAlignment = VerticalAlignment.Stretch
                };
                var stack = new StackPanel
                {
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                };
                var text = new TextBlock
                {
                    Text = message,
                    Foreground = new SolidColorBrush(UiTheme.OverlayText(_isLight)),
                    FontSize = 14,
                    TextWrapping = TextWrapping.Wrap,
                    TextAlignment = TextAlignment.Center,
                    Margin = new Thickness(40, 0, 40, 20)
                };
                stack.Children.Add(text);

                var retryBtn = new Button
                {
                    Content = "重新加载",
                    Width = 140,
                    Height = 38,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    FontSize = 13
                };
                retryBtn.Click += (_, _) =>
                {
                    try
                    {
                        WebViewHost.Children.Remove(overlay);
                        _errorOverlay = null;
                        // 用户手动重载不占用自动重建计数，重置后走标准重建流程
                        _recreateCount = 0;
                        DestroyWebView();
                        if (IsLoaded && Visibility == Visibility.Visible)
                            CreateWebView();
                    }
                    catch (Exception ex)
                    {
                        Logger.Error("手动重新加载失败", ex);
                    }
                };
                stack.Children.Add(retryBtn);

                overlay.Children.Add(stack);
                WebViewHost.Children.Add(overlay);
                _errorOverlay = overlay;
            }
            catch (Exception ex)
            {
                Logger.Error("显示错误提示失败", ex);
            }
        }

        private void InitializeTray()
        {
            _taskbarIcon = new Hardcodet.Wpf.TaskbarNotification.TaskbarIcon
            {
                Icon = System.Drawing.Icon.ExtractAssociatedIcon(
                    System.Reflection.Assembly.GetEntryAssembly()!.Location
                ),
                ToolTipText = "LongCore 龙核"
            };

            _taskbarIcon.TrayMouseDoubleClick += (_, _) => ShowMainWindow();

            var menu = new ContextMenu();

            var show = new MenuItem { Header = "显示界面" };
            show.Click += (_, _) => ShowMainWindow();

            var exit = new MenuItem { Header = "退出" };
            exit.Click += (_, _) => ExitApplication();

            menu.Items.Add(show);
            menu.Items.Add(exit);

            _taskbarIcon.ContextMenu = menu;
        }

        /// <summary>
        /// 唯一退出路径: 托盘「退出」与外部退出请求(安装器 --quit)共用。
        /// 必须走这里而不是被强杀 —— 强杀不会执行 EcGuard 恢复与驱动卸载,
        /// 会把内核驱动留在半挂起状态, 让下一次启动卡死在 Bridge 初始化。
        /// </summary>
        private void ExitApplication()
        {
            if (_isShuttingDown)
                return;
            try
            {
                _allowClose = true; // 否则 OnClosing 会拦截并隐藏到托盘
                _isShuttingDown = true;
                DestroyWebView();
                _taskbarIcon.Dispose();
                Application.Current.Shutdown();
            }
            catch (Exception ex)
            {
                Logger.Error("退出失败", ex);
            }
        }

        /// <summary>外部(安装器 --quit)请求退出。</summary>
        internal void ExitFromOutside() => ExitApplication();

        #endregion

        #region WebView 管理

        private void DestroyWebView()
        {
            if (_webViewDestroyed)
                return;

            try
            {
                var core = SafeCore(_webView);
                if (core != null)
                {
                    core.WebMessageReceived -= OnWebMessageReceived;
                    if (_processFailedHandler != null)
                        core.ProcessFailed -= _processFailedHandler;
                    _processFailedHandler = null;
                    core.Stop();
                }
                _webView?.Dispose();
            }
            catch
            {
                // 防止关闭阶段异常
            }

            WebViewHost.Children.Clear();
            _webView = null;
            _errorOverlay = null;
            _webViewDestroyed = true;
        }

        /// <summary>判断 WebView 是否处于「已就绪」状态，即对象存在且 CoreWebView2 已初始化可用。</summary>
        private bool IsWebViewReady()
        {
            return !_webViewDestroyed && SafeCore(_webView) != null;
        }

        /// <summary>
        /// 确保 WebView 就绪：已可用则直接返回 true；窗口可见但还没有实例时创建一个，返回 false
        /// （创建与加载都是异步的，调用方在本轮不应再假设 CoreWebView2 可用）。
        /// </summary>
        private bool EnsureWebViewReady()
        {
            if (IsWebViewReady())
                return true;
            // 有实例但 core 未就绪 = 初始化仍在途（Loaded 与托盘显示两条路径都会走到这里），
            // 此时销毁重建只会把刚发起的加载打断, 让它自己跑完即可。
            if (_webViewDestroyed)
                CreateWebView();
            return false;
        }

        // 【新增】响应前端窗口控制请求的方法
        private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                string message = e.TryGetWebMessageAsString();

                if (message == "window-minimize")
                {
                    WindowState = WindowState.Minimized;
                }
                else if (message == "window-maximize")
                {
                    WindowState = WindowState == WindowState.Maximized
                        ? WindowState.Normal
                        : WindowState.Maximized;
                }
                else if (message == "window-drag")
                {
                    DragMove();
                }
                else if (message == "window-close")
                {
                    Close();
                }
                else if (message == "frontend-visible")
                {
                    // 前端从挂起恢复渲染的确认(见 App.vue visibilitychange)。这是"点击托盘 → 界面回来"
                    // 唯一可测的真实信号, 也是判断离屏预热是否生效的依据。
                    if (_resumeAt > 0)
                    {
                        Logger.Info($"界面显示: 点击托盘 → 前端确认恢复渲染 {App.StartupClock.ElapsedMilliseconds - _resumeAt}ms");
                        _resumeAt = 0;
                    }
                }
                else if (message.StartsWith("theme-changed:", StringComparison.Ordinal))
                {
                    // 前端切换主题后同步窗口/WebView 底色
                    bool isLight = message.EndsWith(":light", StringComparison.Ordinal);
                    if (_isLight != isLight)
                    {
                        _isLight = isLight;
                        ApplyThemeColors();
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"处理前端窗口控制消息时发生错误: {ex.Message}");
            }
        }

        /// <summary>按当前主题刷新窗口/WebView/遮罩配色(启动与 theme-changed 时调用)</summary>
        private void ApplyThemeColors()
        {
            Background = new SolidColorBrush(UiTheme.Background(_isLight));
            if (_webView != null)
            {
                _webView.DefaultBackgroundColor = DrawingColorFrom(UiTheme.Background(_isLight));
            }
            if (_errorOverlay != null)
            {
                _errorOverlay.Background = new SolidColorBrush(UiTheme.Background(_isLight));
                foreach (var textBlock in FindVisualChildren<TextBlock>(_errorOverlay))
                {
                    textBlock.Foreground = new SolidColorBrush(UiTheme.OverlayText(_isLight));
                }
            }
        }

        private static System.Drawing.Color DrawingColorFrom(System.Windows.Media.Color color)
        {
            return System.Drawing.Color.FromArgb(color.A, color.R, color.G, color.B);
        }

        private static IEnumerable<T> FindVisualChildren<T>(DependencyObject? root)
            where T : DependencyObject
        {
            if (root == null)
            {
                yield break;
            }
            int count = VisualTreeHelper.GetChildrenCount(root);
            for (int i = 0; i < count; i++)
            {
                var child = VisualTreeHelper.GetChild(root, i);
                if (child is T typed)
                {
                    yield return typed;
                }
                foreach (var descendant in FindVisualChildren<T>(child))
                {
                    yield return descendant;
                }
            }
        }

        private async Task SuspendWebViewAsync()
        {
            try
            {
                var core = SafeCore(_webView);
                if (core != null)
                {
                    await core.TrySuspendAsync();
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Suspend WebView2 异常: {ex.Message}");
            }
        }

        private void ResumeWebView()
        {
            try
            {
                var core = SafeCore(_webView);
                if (core != null)
                {
                    _resumeAt = App.StartupClock.ElapsedMilliseconds;
                    core.Resume();
                    // 自启最小化场景：Suspend 时导航被挂起、必然超时并留下错误层；
                    // 恢复后主动重新导航，错误层由导航成功自动移除
                    if (_errorOverlay != null)
                    {
                        RemoveErrorOverlay();
                        _ = RetryNavigationAsync(_webView!, _webViewGeneration);
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Resume WebView2 异常: {ex.Message}");
            }
        }

        #endregion

        #region 窗口控制

        /// <summary>
        /// 离屏预热: 把窗口显示到任何显示器都够不到的位置, 让 WebView2 与前端在后台真正跑起来。
        /// 必须真的 Show() —— 窗口没显示时 HwndHost 没有 HWND, WebView2 根本初始化不了(见构造函数注释);
        /// 同时 ShowInTaskbar=false / ShowActivated=false, 用户看不到也不会被抢焦点。
        /// </summary>
        internal void StartOffScreenPrewarm()
        {
            try
            {
                _offScreenPrewarm = true;
                ShowInTaskbar = false;
                ShowActivated = false;
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = OffScreenCoordinate;
                Top = OffScreenCoordinate;
                Show();
                Logger.Info($"启动计时: 离屏预热窗口已显示 {App.StartupClock.ElapsedMilliseconds}ms");
                _ = PrewarmWatchdogAsync();
            }
            catch (Exception ex)
            {
                Logger.Error("离屏预热失败, 退回普通显示", ex);
                _offScreenPrewarm = false;
                ShowMainWindow();
            }
        }

        /// <summary>
        /// 摆回主屏居中。WindowStartupLocation=CenterScreen 只在首次 Show 生效,
        /// 被离屏预热用过之后必须自己算, 否则窗口会停在 -32000。
        /// </summary>
        private void MoveToCenteredPosition()
        {
            var wa = SystemParameters.WorkArea;
            Left = Math.Max(wa.Left, wa.Left + (wa.Width - Width) / 2);
            Top = Math.Max(wa.Top, wa.Top + (wa.Height - Height) / 2);
        }

        /// <summary>预热收尾: 界面已就绪, 藏回托盘并挂起(释放 CPU/GPU, 但保留 DOM 与页面状态)。</summary>
        private async Task FinishPrewarmAsync()
        {
            if (!_offScreenPrewarm || _prewarmed || _isShuttingDown)
                return;
            _prewarmed = true;
            try
            {
                // 再等一拍: 页面 mount 之后还有一次布局与首次取数, 提前挂起会留下一张半成品
                await Task.Delay(600);
                if (!_offScreenPrewarm || _isShuttingDown)
                    return; // 期间用户已经点开 → 不要藏
                Hide();
                await SuspendWebViewAsync();
                Logger.Info($"启动计时: 离屏预热完成并已挂起 {App.StartupClock.ElapsedMilliseconds}ms");
            }
            catch (Exception ex)
            {
                Logger.Warn($"离屏预热收尾失败: {ex.Message}");
            }
        }

        /// <summary>预热兜底: 页面始终没加载成功时也要收回托盘, 否则它会一直占着屏幕外的渲染资源。</summary>
        private async Task PrewarmWatchdogAsync()
        {
            await Task.Delay(TimeSpan.FromSeconds(20));
            if (!_offScreenPrewarm || _prewarmed || _isShuttingDown)
                return;
            Logger.Warn("离屏预热超时未完成, 直接收回托盘");
            await FinishPrewarmAsync();
        }

        private void ShowMainWindow()
        {
            // 必须先显示窗口，再处理 WebView 的恢复/重建。
            // 自启隐藏启动时窗口是在屏幕外预热好的, 显示前先把位置挪回主屏居中。
            if (_offScreenPrewarm)
            {
                _offScreenPrewarm = false; // 预热收尾任务看到它变 false 就会放弃隐藏
                MoveToCenteredPosition();
                ShowInTaskbar = true;
            }

            Show();
            WindowState = WindowState.Normal;
            ShowInTaskbar = true;
            Activate();

            // 窗口已可见：CoreWebView2 可用则恢复（Suspend 后仍可用），不可用（隐藏期初始化未完成/失败）则销毁重建。
            if (IsWebViewReady())
                ResumeWebView();
            else
                EnsureWebViewReady();
        }

        private async void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
        {
            // 仅托盘菜单「退出」时允许真正关闭；其余情况（标题栏关闭按钮/前端 window-close）隐藏到托盘
            if (_allowClose)
                return;

            e.Cancel = true;
            Hide();
            await SuspendWebViewAsync();
        }

        #endregion
    }
}
