using System.Runtime.InteropServices;
using System.Text.Encodings.Web;
using System.Text.Json;
using log4net;

namespace JiaoLongControl.Server.Core.Utils;

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public class CommandResult
{
    private readonly ILog Logger= LogManager.GetLogger(typeof(CommandResult));
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false
    };

    public bool Success { get; set; }
    public string Message { get; set; }
    public object? Data { get; set; }

    // data 标 object?: 大量调用点只传两个参数(纯状态查询), 默认值就是 null。
    public CommandResult(bool success, string message, object? data = null)
    {
        Success = success;
        Message = message;
        Data = data;

        // 这一行是日志体积的 98% 来源: 每次 WMI/EC 读取、每次前端 IPC 调用都会构造
        // 一个 CommandResult。实测一天 5.7 万行里 5.6 万行出自这里, 而真正的控制侧
        // 信息(AutoFanControl 转速/看门狗/护栏)只占 1.4%。
        // 默认关; 排查"某次读取为什么返回空"时在设置页临时打开。
        // 外层 IsDebugEnabled 是必需的: 级别不是 DEBUG 时连字符串插值都省掉,
        // 而不是先拼好字符串再被 log4net 丢弃。
        if (LogRuntime.VerboseCommandLog && Logger.IsDebugEnabled)
            Logger.Debug($"{success} {message} {data}");
    }

    /// <summary>
    /// 必须按 Data 的运行时类型写 JSON。
    /// Data 声明为 object 时，System.Text.Json 会把装箱枚举写成 {}，
    /// 前端 PerformanceMode.Get 读到空对象 → 冷启动胶囊全不亮，点击却能亮（点选先改了本地态）。
    /// </summary>
    public string toJson()
    {
        string dataJson;
        if (Data is null)
            dataJson = "null";
        else if (Data.GetType().IsEnum)
            dataJson = Convert.ToInt32(Data).ToString();
        else
            dataJson = JsonSerializer.Serialize(Data, Data.GetType(), JsonOptions);

        return "{\"Success\":" + (Success ? "true" : "false")
             + ",\"Message\":" + JsonSerializer.Serialize(Message ?? "", JsonOptions)
             + ",\"Data\":" + dataJson + "}";
    }
}