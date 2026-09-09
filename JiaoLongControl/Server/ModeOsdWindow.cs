using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace JiaoLongControl.Server;

/// <summary>
/// 性能模式 OSD 提示胶囊: 屏幕顶部居中, 点击穿透/不抢焦点/不进任务栏,
/// 短暂展示后自动淡出。用于 Fn 热键切换性能模式时的可视化反馈。
/// 纯代码构建(无 XAML), 全程在 UI 线程操作。
/// </summary>
public class ModeOsdWindow : Window
{
    private static ModeOsdWindow? _current;
    private readonly TextBlock _text;
    private DispatcherTimer? _hideTimer;

    private const int FadeInMs = 120;
    private const int HoldMs = 1300;
    private const int FadeOutMs = 280;

    private ModeOsdWindow()
    {
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false; // 不抢焦点, 游戏内按键也不切窗口
        Focusable = false;
        IsHitTestVisible = false; // 点击穿透
        Opacity = 0;

        _text = new TextBlock
        {
            FontSize = 15,
            FontWeight = FontWeights.Medium,
            Foreground = Brushes.White,
        };

        Content = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(232, 13, 14, 21)),
            CornerRadius = new CornerRadius(999),
            BorderBrush = new SolidColorBrush(Color.FromArgb(200, 59, 130, 246)),
            BorderThickness = new Thickness(1),
            Padding = new Thickness(24, 10, 24, 10),
            Child = _text,
        };

        SizeToContent = SizeToContent.WidthAndHeight;
        SizeChanged += (_, _) => PositionTopCenter();
        Loaded += (_, _) => PositionTopCenter();
    }

    /// <summary>显示 OSD(任意线程安全, 内部转派 UI 线程)。</summary>
    public static void ShowMode(string text)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher == null)
            return;
        dispatcher.BeginInvoke(() => ShowOnUi(text));
    }

    private static void ShowOnUi(string text)
    {
        if (_current == null)
        {
            _current = new ModeOsdWindow();
            _current.Show();
        }
        else if (!_current.IsVisible)
        {
            _current.Show();
        }

        _current._text.Text = text;
        _current.PositionTopCenter();
        _current.RestartFadeSequence();
    }

    private void PositionTopCenter()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Left + (area.Width - ActualWidth) / 2;
        Top = area.Top + 88;
    }

    private void RestartFadeSequence()
    {
        _hideTimer?.Stop();
        _hideTimer?.Dispose();
        var fadeIn = new DoubleAnimation(1, TimeSpan.FromMilliseconds(FadeInMs));
        BeginAnimation(OpacityProperty, fadeIn);

        _hideTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(HoldMs) };
        _hideTimer.Tick += (_, _) =>
        {
            _hideTimer?.Stop();
            _hideTimer = null;
            var fadeOut = new DoubleAnimation(0, TimeSpan.FromMilliseconds(FadeOutMs));
            fadeOut.Completed += (_, _) => Hide();
            BeginAnimation(OpacityProperty, fadeOut);
        };
        _hideTimer.Start();
    }
}
