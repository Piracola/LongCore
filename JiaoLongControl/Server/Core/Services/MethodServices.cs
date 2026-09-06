using System.Management;
using JiaoLongControl.Server.Core.Models;

namespace JiaoLongControl.Server.Core.Services
{
    public static class MethodServices
    {
        private const int BufferLength = 32;

        // 响应协议(逆向 + 真机实测, 见 docs/02_协议手册.md):
        // OutData[0..1] = 0x00 0x80 固定响应头; OutData[3] = 命令码回显;
        // 实测响应长 30 字节(非 32), 故只要求最小可校验长度
        private const byte ResponseHeader0 = 0x00;
        private const byte ResponseHeader1 = 0x80;
        private const int MinResponseLength = 8;

        private static readonly object WmiLock = new();
        private static ManagementObject? _sharedObject;

        private static byte[] MakeMethodParams(MethodType methodType, MethodName methodName)
        {
            var buffer = new byte[BufferLength];
            buffer[1] = (byte)methodType;
            buffer[3] = (byte)methodName;
            return buffer;
        }

        public static T GetValue<T>(MethodName methodName)
        {
            var result = ExecuteMethod(MakeMethodParams(MethodType.Get, methodName));

            if (!result.Item1)
                return GetDefaultValue<T>();

            var data = result.Item2;
            if (typeof(T) == typeof(Tuple<int, int>))
                return (T)(object)new Tuple<int, int>((data[5] << 8) + data[4], (data[7] << 8) + data[6]);

            if (typeof(T) == typeof(Tuple<int, int, int>))
                return (T)(object)new Tuple<int, int, int>(data[4], data[5], data[6]);

            return (T)(object)data[4];
        }

        public static bool SetValue(MethodName methodName, object value)
        {
            var data = MakeMethodParams(MethodType.Set, methodName);
            data[4] = Convert.ToByte(value);
            return ExecuteMethod(data).Item1;
        }

        public static bool SetValue(MethodName methodName, byte[] values)
        {
            if (values == null || values.Length + 4 > BufferLength)
                throw new ArgumentException("Invalid value length.");

            var data = MakeMethodParams(MethodType.Set, methodName);
            Array.Copy(values, 0, data, 4, values.Length);
            return ExecuteMethod(data).Item1;
        }

        private static Tuple<bool, byte[]> ExecuteMethod(byte[] inData)
        {
            if (inData.Length != BufferLength)
                return new Tuple<bool, byte[]>(false, null);

            // MICommonInterface 非线程安全: 单例复用 + 锁串行化,
            // 消除上游每次调用重建 ManagementObject 的重复连接开销
            lock (WmiLock)
            {
                // 响应校验失败/通道抖动重试一次; 两次均失败视为通道异常
                for (var attempt = 0; attempt < 2; attempt++)
                {
                    var output = InvokeRaw(inData);
                    if (output != null && ValidateResponse(inData, output))
                        return new Tuple<bool, byte[]>(true, output);
                }
                return new Tuple<bool, byte[]>(false, null);
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

        /// <summary>响应回显校验: 响应头 00 80 + 命令码与请求一致(移植自 jiaolongctl)</summary>
        private static bool ValidateResponse(byte[] inData, byte[] output)
        {
            if (output.Length < MinResponseLength)
                return false;
            if (output[0] != ResponseHeader0 || output[1] != ResponseHeader1)
                return false;
            return output[3] == inData[3];
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
