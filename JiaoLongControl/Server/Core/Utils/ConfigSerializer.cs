using System.IO;
using System.Reflection;
using JiaoLongControl.Server.Core.Models;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.ObjectGraphVisitors;

namespace JiaoLongControl.Server.Core.Utils;

public static class ConfigSerializer
{
    private const string FileName = "config.yaml";
    private const string BackupExt = ".bak";
    private const string TempExt = ".tmp";

    private static readonly IDeserializer Deserializer = new DeserializerBuilder()
        .IgnoreUnmatchedProperties()
        .Build();

    private static readonly ISerializer Serializer = new SerializerBuilder()
        .WithEmissionPhaseObjectGraphVisitor(args => new CommentsObjectGraphVisitor(args.InnerVisitor))
        .ConfigureDefaultValuesHandling(DefaultValuesHandling.Preserve)
        .Build();

    public static string ConfigDir { get; set; } = Path.Combine(AppContext.BaseDirectory, "config");
    public static string ConfigPath => Path.Combine(ConfigDir, FileName);
    private static string TempPath => ConfigPath + TempExt;
    private static string BackupPath => ConfigPath + BackupExt;
    
    public static string Serialize<T>(T config)
    {
        return Serializer.Serialize(config);
    }
    public static string? ReadFileContent()
    {
        if (!File.Exists(ConfigPath))
            return null;
        return File.ReadAllText(ConfigPath);
    }

    public static JiaoLongConfig Load()
    {
        JiaoLongConfig config;

        if (!File.Exists(ConfigPath))
        {
            config = new JiaoLongConfig();
        }
        else
        {
            try
            {
                var yaml = File.ReadAllText(ConfigPath);
                config = Deserializer.Deserialize<JiaoLongConfig>(yaml);
            }
            catch (Exception)
            {
                config = null!;
                if (File.Exists(BackupPath))
                {
                    try
                    {
                        var yaml = File.ReadAllText(BackupPath);
                        config = Deserializer.Deserialize<JiaoLongConfig>(yaml);
                    }
                    catch
                    {
                        // 原始文件和备份文件均读取失败
                    }
                }

                config ??= new JiaoLongConfig();
            }
        }

        // [ConfigRange] 此前只用于生成 YAML 注释, 从未校验 —— 手改配置即可让越界值直达硬件。
        // 闸门(HwWriteGate)是最后一道防线, 这里再加一道: 载入即收敛到声明范围内。
        EnforceRanges(config);
        return config;
    }

    private static readonly log4net.ILog RangeLog =
        log4net.LogManager.GetLogger(typeof(ConfigSerializer));

    /// <summary>
    /// 递归收敛配置中的越界数值到 [ConfigRange] 声明范围。
    /// 只对带该属性的数值属性生效; 嵌套配置节最多下探 <see cref="MaxDepth"/> 层。
    /// </summary>
    private const int MaxDepth = 4;

    private static void EnforceRanges(object? node, string path = "", int depth = 0)
    {
        if (node == null || depth > MaxDepth)
            return;

        foreach (var prop in node.GetType().GetProperties())
        {
            if (!prop.CanRead || prop.GetIndexParameters().Length > 0)
                continue;

            var name = path.Length == 0 ? prop.Name : $"{path}.{prop.Name}";
            object? value;
            try { value = prop.GetValue(node); }
            catch { continue; }

            if (value == null)
                continue;

            var range = prop.GetCustomAttribute<ConfigRangeAttribute>();
            if (range != null)
            {
                // 与写入闸门不同: 这里是"收敛"而非"拒绝"。
                // 启动阶段拒绝配置会导致功能整体不可用, 收敛到边界值更稳妥, 并留痕。
                if (TryClampNumber(value, range.Min, range.Max, out var clamped) &&
                    !Equals(clamped, value))
                {
                    RangeLog.Warn($"配置越界已收敛: {name} {value} → {clamped} (范围 {range.Min}~{range.Max})");
                    if (prop.CanWrite)
                    {
                        try { prop.SetValue(node, clamped); } catch { /* 只读属性忽略 */ }
                    }
                }
                continue;
            }

            // 下探嵌套配置节(跳过字符串/值类型/集合)
            var t = prop.PropertyType;
            if (t.IsPrimitive || t.IsEnum || t == typeof(string) || t.IsValueType)
                continue;
            if (typeof(System.Collections.IEnumerable).IsAssignableFrom(t))
                continue;

            EnforceRanges(value, name, depth + 1);
        }
    }

    private static bool TryClampNumber(object value, double min, double max, out object? result)
    {
        result = value;
        switch (value)
        {
            case int i:
                result = (int)Math.Clamp(i, (int)min, (int)max);
                return true;
            case long l:
                result = (long)Math.Clamp(l, (long)min, (long)max);
                return true;
            case double d:
                result = Math.Clamp(d, min, max);
                return true;
            case float f:
                result = (float)Math.Clamp(f, (float)min, (float)max);
                return true;
            case byte b:
                result = (byte)Math.Clamp((int)b, (int)min, (int)max);
                return true;
            case short s:
                result = (short)Math.Clamp((int)s, (int)min, (int)max);
                return true;
            case ushort us:
                result = (ushort)Math.Clamp((int)us, (int)min, (int)max);
                return true;
            case uint ui:
                result = (uint)Math.Clamp((long)ui, (long)min, (long)max);
                return true;
            default:
                return false;
        }
    }

    public static void Save(JiaoLongConfig config)
    {
        Directory.CreateDirectory(ConfigDir);
        var yaml = Serialize(config);
        if (File.Exists(ConfigPath))
            File.Copy(ConfigPath, BackupPath, overwrite: true);
        File.WriteAllText(TempPath, yaml);
        File.Move(TempPath, ConfigPath, overwrite: true);
        if (File.Exists(TempPath))
            File.Delete(TempPath);
    }

    public static void Initialize(string version)
    {
        // 如果配置文件不存在
        if (!File.Exists(ConfigPath))
        {
            Save(new JiaoLongConfig { Version = version });
        }

        var existing = Load();
        // 如果配置文件版本字段不存在 删除重建
        if (string.IsNullOrWhiteSpace(existing.Version))
        {
            if (File.Exists(ConfigPath))
            {
                File.Delete(ConfigPath);
            }
            Save(new JiaoLongConfig { Version = version });
        }
        // 如果配置文件存在但版本不一致
        if (existing.Version != version )
        {
            Update(existing, version);
        }

        // 逃生舱: 把用户对硬件写入闸门的取舍告知闸门。
        // 这一行不能省 —— 否则安全机制判断有误时, 用户只能重新编译才能绕过。
        Core.Services.HwWriteGate.Configure(existing.Safety?.WriteGateEnabled ?? true);
    }

    public static void Update(JiaoLongConfig LowConfig, string version)
    {
        // 默认无损迁移
        LowConfig.Version = version;
        Save(LowConfig);
    }

    private class CommentsObjectGraphVisitor : ChainedObjectGraphVisitor
    {
        public CommentsObjectGraphVisitor(IObjectGraphVisitor<IEmitter> nextVisitor)
            : base(nextVisitor)
        {
        }

        public override bool EnterMapping(IPropertyDescriptor key, IObjectDescriptor value, IEmitter context,
            ObjectSerializer serializer)
        {
            var commentAttr = key.GetCustomAttribute<ConfigCommentAttribute>();
            if (commentAttr != null)
            {
                context.Emit(new Comment(commentAttr.Comment, isInline: false));
            }

            var rangeAttr = key.GetCustomAttribute<ConfigRangeAttribute>();
            if (rangeAttr != null)
            {
                context.Emit(new Comment($"范围: {rangeAttr.Min} ~ {rangeAttr.Max}", isInline: false));
            }

            return base.EnterMapping(key, value, context, serializer);
        }
    }
}