using System.Management;
using JiaoLongControl.Server.Core.Models;

namespace JiaoLongControl.Server.Core.Services
{
    public static class MethodServices
    {
        private static readonly object WmiLock = new();
        private static ManagementObject? _sharedObject;

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
            var data = ProtocolCodec.MakeSetRequest(methodName, Convert.ToByte(value));
            return ExecuteMethod(data).Item1;
        }

        public static bool SetValue(MethodName methodName, byte[] values)
        {
            var data = ProtocolCodec.MakeSetRequest(methodName, values);
            return ExecuteMethod(data).Item1;
        }

        private static Tuple<bool, byte[]> ExecuteMethod(byte[] inData)
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
                    var output = InvokeRaw(inData);
                    if (output != null && ProtocolCodec.ValidateResponse(inData, output))
                        return new Tuple<bool, byte[]>(true, output);
                }
                return new Tuple<bool, byte[]>(false, null!);
            }
        }

        private static byte[]? InvokeRaw(byte[] inData)
        {
            try
            {
                var mo = GetSharedObject();
                var parameters = mo.GetMethodParameters("MiInterface");
                parameters["InData"] = inData;
                return mo.InvokeMethod("MiInterface", parameters, null)?["OutData"] as byte[];
            }
            catch
            {
                // 连接/实例可能已损坏: 丢弃缓存, 下次调用重建
                try { _sharedObject?.Dispose(); } catch { /* 忽略释放异常 */ }
                _sharedObject = null;
                return null;
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
