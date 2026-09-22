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
    public object Data { get; set; }

    public CommandResult(bool success, string message, object data = null)
    {
        Success = success;
        Message = message;
        Data = data;
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