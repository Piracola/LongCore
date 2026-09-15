using System.Management;
using JiaoLongControl.Server.Core.Models;
using log4net;

namespace JiaoLongControl.Server.Core.Services
{
    public static class MethodServices
    {
        private static readonly object WmiLock = new();
        private static ManagementObject? _sharedObject;
        private static readonly log4net.ILog WmiLog = log4net.LogManager.GetLogger(typeof(MethodServices));

        public static T GetValue<T>(MethodName methodName)
        {
            var result = ExecuteMethod(ProtocolCodec.MakeRequest(MethodType.Get, methodName));

            if (!result.Item1)
                return GetDefaultValue<T>();

            var data = result.Item2;
            if (typeof(T) == typeof(Tuple<int, int>))
                return (T)(object)ProtocolCodec.DecodeUInt16Pair(data);

            if (typeof(T) == typeof(Tuple<int, int, int>))
                return (T)(object)ProtocolCodec.DecodeTriple(data);

            return (T)(object)ProtocolCodec.DecodeByte(data);
        }

        public static bool SetValue(MethodName methodName, object value)
        {
            // 越界值(>255/负数)在此抛 OverflowException, 转为干净失败并记录, 不让异常穿透到 COM 边界
            byte b;
            try
            {
                b = Convert.ToByte(value);
            }
            catch (Exception ex)
            {
                LogManager.GetLogger(typeof(MethodServices))
                    .Warn($"写入 {methodName} 失败: 值 '{value}' 无法转为单字节 —— {ex.Message}");
                return false;
            }

            return SetValueCore(methodName, new[] { b });
        }

        public static bool SetValue(MethodName methodName, byte[] values)
        {
            return SetValueCore(methodName, values);
        }

        /// <summary>
        /// 全部 WMI/EC 写入的唯一实际出口: 先过硬件安全闸门, 再下发。
        /// 闸门覆盖见 HwWriteGate 说明(命令白名单 / 值域 / 限流 / 审计)。
        /// </summary>
        private static bool SetValueCore(MethodName methodName, byte[] values)
        {
            if (values == null || values.Length == 0)
                return false;

            if (!HwWriteGate.TryValidate(methodName, values, out _))
                return false;

            var data = ProtocolCodec.MakeSetRequest(methodName, values);
            // Set 不校验响应回显(与官方判定一致), 详见 ExecuteMethod 注释
            return ExecuteMethod(data, requireEcho: false).Item1;
        }

        private static Tuple<bool, byte[]> ExecuteMethod(byte[] inData, bool requireEcho = true)
        {
            if (inData.Length != ProtocolCodec.BufferLength)
                return new Tuple<bool, byte[]>(false, null!);

            // MICommonInterface 非线程安全: 单例复用 + 锁串行化,
            // 消除上游每次调用重建 ManagementObject 的重复连接开销
            lock (WmiLock)
            {
                // 响应校验失败/通道抖动重试一次; 两次均失败视为通道异常
                for (var attempt = 0; attempt < 2; attempt++)
                {
                    // ok = WMI 调用本身未抛异常(通道可用), 与响应内容无关
                    var ok = InvokeRaw(inData, out var output);

                    if (requireEcho)
                    {
                        if (ok && output != null && ProtocolCodec.ValidateResponse(inData, output))
                            return new Tuple<bool, byte[]>(true, output);
                        continue;
                    }

                    // Set 路径: 与官方客户端判定对齐 —— 调用未抛异常即视为下发成功。
                    //
                    // 依据 decompiled/main.cs ExcMethod: 官方只在 ManagementException 时返回 false,
                    // 只要拿到 OutData(哪怕为 null)就返回 true, 从不校验响应头/命令码回显。
                    // 本项目此前对 Set 也套用 Get 的严格回显校验, 而部分命令(实测为命令 23 CPUPower)
                    // 的响应并不回显命令码 —— 写入实际已生效, 却被引擎判为失败,
                    // 表现为 CPU 页四个档位点应用一律提示"设置失败"(根因)。
                    //
                    // 回显不符不再判失败, 只落日志留证据; 真正的失败判定交给"调用是否抛异常"。
                    if (!ok)
                        continue;

                    if (output == null || !ProtocolCodec.ValidateResponse(inData, output))
                    {
                        WmiLog.Warn(
                            $"写入 {inData[3]} 响应未回显命令码(视为已下发): out=" +
                            (output == null ? "<null>" : Convert.ToHexString(output)));
                    }

                    return new Tuple<bool, byte[]>(true, output ?? Array.Empty<byte>());
                }
                return new Tuple<bool, byte[]>(false, null!);
            }
        }

        private static bool InvokeRaw(byte[] inData, out byte[]? output)
        {
            try
            {
                var mo = GetSharedObject();
                var parameters = mo.GetMethodParameters("MiInterface");
                parameters["InData"] = inData;
                output = mo.InvokeMethod("MiInterface", parameters, null)?["OutData"] as byte[];
                return true;
            }
            catch
            {
                // 连接/实例可能已损坏: 丢弃缓存, 下次调用重建
                try { _sharedObject?.Dispose(); } catch { /* 忽略释放异常 */ }
                _sharedObject = null;
                output = null;
                return false;
            }
        }

        private static ManagementObject GetSharedObject()
        {
            if (_sharedObject != null)
                return _sharedObject;
            _sharedObject = new ManagementObject(
                "root\\WMI",
                "MICommonInterface.InstanceName='ACPI\\PNP0C14\\MIFS_0'",
                null);
            return _sharedObject;
        }

        private static T GetDefaultValue<T>()
        {
            if (typeof(T) == typeof(Tuple<int, int>)) return (T)(object)new Tuple<int, int>(-1, -1);
            if (typeof(T) == typeof(Tuple<int, int, int>)) return (T)(object)new Tuple<int, int, int>(-1, -1, -1);
            if (typeof(T) == typeof(byte)) return (T)(object)byte.MaxValue;
            return default(T)!;
        }
    }
}
