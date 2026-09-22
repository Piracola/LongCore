// 协议层回归测试(无外部依赖的简易断言运行器):
// 黄金样本 = probe/10_wmi_get_probe.txt 真机实测响应(30 字节)。
// 运行: dotnet run --project ProtocolCodecTest   退出码 0=全过 / 1=有失败
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Services;

var failures = new List<string>();
var passed = 0;

void Check(string name, bool cond, string detail = "")
{
    if (cond)
    {
        passed++;
        Console.WriteLine($"  PASS  {name}");
    }
    else
    {
        failures.Add(name);
        Console.WriteLine($"  FAIL  {name}   {detail}");
    }
}

// ── 请求组帧 ─────────────────────────────────────────────
Console.WriteLine("== 请求组帧 ==");
var getMode = ProtocolCodec.MakeRequest(MethodType.Get, MethodName.SystemPerMode);
Check("Get 请求长度 = 32", getMode.Length == ProtocolCodec.BufferLength);
Check("[1] = 250(Get)", getMode[1] == (byte)MethodType.Get);
Check("[3] = 8(SystemPerMode)", getMode[3] == (byte)MethodName.SystemPerMode);
var restZero = true;
for (var i = 0; i < ProtocolCodec.BufferLength; i++)
{
    if (i != 1 && i != 3 && getMode[i] != 0)
        restZero = false;
}
Check("其余字节全 0", restZero);

var setMode = ProtocolCodec.MakeSetRequest(MethodName.SystemPerMode, 1);
Check("Set 请求 [1] = 251(Set)", setMode[1] == (byte)MethodType.Set);
Check("Set 请求 [3] = 8", setMode[3] == (byte)MethodName.SystemPerMode);
Check("Set 请求 [4] = 1(载荷)", setMode[4] == 1);

var arrayPayload = new byte[] { 0x11, 0x22, 0x33 };
var setArray = ProtocolCodec.MakeSetRequest(MethodName.CPUPower, arrayPayload);
Check("数组载荷拷贝到 [4..6]", setArray[4] == 0x11 && setArray[5] == 0x22 && setArray[6] == 0x33);
var overflowThrows = false;
try
{
    ProtocolCodec.MakeSetRequest(MethodName.CPUPower, new byte[ProtocolCodec.BufferLength - 3]);
}
catch (ArgumentException)
{
    overflowThrows = true;
}
Check("超长载荷抛 ArgumentException", overflowThrows);

// ── 响应校验(黄金样本) ────────────────────────────────────
Console.WriteLine("== 响应校验 ==");
// 真机样本: SystemPerMode Get → 00 80 00 08 01 00 ... (30 字节, 档位=1 高性能)
var goldenMode = Hex("00 80 00 08 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00");
Check("黄金样本通过校验", ProtocolCodec.ValidateResponse(getMode, goldenMode));
Check("黄金样本单字节解码 = 1(高性能)", ProtocolCodec.DecodeByte(goldenMode) == 1);

var badHeader = (byte[])goldenMode.Clone();
badHeader[1] = 0x81;
Check("响应头错误 → 拒绝", !ProtocolCodec.ValidateResponse(getMode, badHeader));

var echoMismatch = (byte[])goldenMode.Clone();
echoMismatch[3] = 0x0D;
Check("命令码回显不一致 → 拒绝", !ProtocolCodec.ValidateResponse(getMode, echoMismatch));

Check("短于最小长度 → 拒绝",
    !ProtocolCodec.ValidateResponse(getMode, new byte[] { 0x00, 0x80, 0x00, 0x08, 0x01, 0x00, 0x00 }));

// 边界: 恰好 8 字节(最小可校验长度)应通过
var boundary = new byte[] { 0x00, 0x80, 0x00, 0x08, 0x01, 0x00, 0x00, 0x00 };
Check("恰好 8 字节 → 通过", ProtocolCodec.ValidateResponse(getMode, boundary));

// ── 载荷解码(黄金样本) ────────────────────────────────────
Console.WriteLine("== 载荷解码 ==");
// 真机样本: CPUGPUFanSpeed Get → 00 80 00 0D B7 0D 7F 0D ... (CPU=0x0DB7=3511, GPU=0x0D7F=3455)
var goldenFan = Hex("00 80 00 0D B7 0D 7F 0D 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00");
var fanPair = ProtocolCodec.DecodeUInt16Pair(goldenFan);
Check($"风扇转速 u16 对 = (CPU 3511, GPU 3455)  实际 {fanPair.Item1}/{fanPair.Item2}",
    fanPair.Item1 == 3511 && fanPair.Item2 == 3455);

// 真机样本: CPUThermometer Get → b4 = 0x4B = 75°C
var goldenTemp = Hex("00 80 00 16 4B 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00");
Check("CPU 温度 = 75", ProtocolCodec.DecodeByte(goldenTemp) == 75);

var triple = ProtocolCodec.DecodeTriple(Hex("00 80 00 17 01 02 03 00"));
Check("三字节解码 = (1,2,3)", triple.Item1 == 1 && triple.Item2 == 2 && triple.Item3 == 3);

// 小端序边界: 0xFF 0xFF → 65535
var maxPair = ProtocolCodec.DecodeUInt16Pair(Hex("00 80 00 00 FF FF FF FF"));
Check("u16 上界 = (65535, 65535)", maxPair.Item1 == 65535 && maxPair.Item2 == 65535);

Console.WriteLine("== SMU 写入闸门 ==");
Check("54W STAPM 放行", SmuWriteGate.TryValidate("StapmLimit", 54, out _));
Check("0W STAPM 拒绝", !SmuWriteGate.TryValidate("StapmLimit", 0, out var zeroReason) && (zeroReason?.Contains("0") ?? false));
Check("201W STAPM 拒绝", !SmuWriteGate.TryValidate("StapmLimit", 201, out _));
Check("温度墙 90 放行", SmuWriteGate.TryValidate("TempLimitMp1", 90, out _));
Check("温度墙 100 放行", SmuWriteGate.TryValidate("TempLimitMp1", 100, out _));
Check("温度墙 101 拒绝", !SmuWriteGate.TryValidate("TempLimitMp1", 101, out _));
Check("温度墙 0 拒绝", !SmuWriteGate.TryValidate("TempLimitMp1", 0, out _));
Check("CO +1 拒绝", !SmuWriteGate.TryValidate("CurveOptimizerAll", 1, out _));
Check("CO -20 放行", SmuWriteGate.TryValidate("CurveOptimizerAll", -20, out _));
Check("未知键拒绝", !SmuWriteGate.TryValidate("NotAKey", 1, out _));

Console.WriteLine();
Console.WriteLine($"通过 {passed} 项, 失败 {failures.Count} 项");
return failures.Count == 0 ? 0 : 1;

static byte[] Hex(string hex) =>
    hex.Split(' ', StringSplitOptions.RemoveEmptyEntries)
        .Select(x => Convert.ToByte(x, 16))
        .ToArray();
