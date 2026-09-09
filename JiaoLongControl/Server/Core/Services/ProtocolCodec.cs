namespace JiaoLongControl.Server.Core.Services
{
    /// <summary>
    /// MICommonInterface 协议编解码(纯逻辑, 无 WMI 依赖, 可独立单元测试)。
    ///
    /// 请求帧(32 字节): [1]=方法类型(Get=250 / Set=251) [3]=命令码 [4..]=Set 载荷
    /// 响应帧(实测 30 字节): [0..1]=0x00 0x80 固定响应头 [3]=命令码回显 [4..]=载荷
    ///   - 载荷 b4..b7: 单值取 b4; u16 对取 (b5&lt;&lt;8)+b4 / (b7&lt;&lt;8)+b6 (小端)
    ///
    /// 黄金样本(真机实测)见 probe/10_wmi_get_probe.txt, 单元测试以此为回归基线。
    /// </summary>
    internal static class ProtocolCodec
    {
        internal const int BufferLength = 32;

        // 响应最小可校验长度: 实测响应 30 字节(非 32), 只要求覆盖校验所需前缀
        internal const int MinResponseLength = 8;

        private const byte ResponseHeader0 = 0x00;
        private const byte ResponseHeader1 = 0x80;

        internal static byte[] MakeRequest(MethodType methodType, MethodName methodName)
        {
            var buffer = new byte[BufferLength];
            buffer[1] = (byte)methodType;
            buffer[3] = (byte)methodName;
            return buffer;
        }

        internal static byte[] MakeSetRequest(MethodName methodName, byte payload)
        {
            var buffer = MakeRequest(MethodType.Set, methodName);
            buffer[4] = payload;
            return buffer;
        }

        internal static byte[] MakeSetRequest(MethodName methodName, byte[] payload)
        {
            if (payload == null || payload.Length + 4 > BufferLength)
                throw new ArgumentException("Invalid value length.");

            var buffer = MakeRequest(MethodType.Set, methodName);
            Array.Copy(payload, 0, buffer, 4, payload.Length);
            return buffer;
        }

        /// <summary>
        /// 响应回显校验(移植自 jiaolongctl):
        /// 响应头必须为 00 80, 且 [3] 处命令码与请求一致。
        /// </summary>
        internal static bool ValidateResponse(byte[] inData, byte[] output)
        {
            if (output.Length < MinResponseLength)
                return false;
            if (output[0] != ResponseHeader0 || output[1] != ResponseHeader1)
                return false;
            return output[3] == inData[3];
        }

        /// <summary>解码两个小端 u16: (b5&lt;&lt;8)+b4 与 (b7&lt;&lt;8)+b6。</summary>
        internal static Tuple<int, int> DecodeUInt16Pair(byte[] data)
        {
            return new Tuple<int, int>((data[5] << 8) + data[4], (data[7] << 8) + data[6]);
        }

        /// <summary>解码三个连续字节 b4/b5/b6。</summary>
        internal static Tuple<int, int, int> DecodeTriple(byte[] data)
        {
            return new Tuple<int, int, int>(data[4], data[5], data[6]);
        }

        /// <summary>解码单字节 b4。</summary>
        internal static byte DecodeByte(byte[] data)
        {
            return data[4];
        }
    }
}
