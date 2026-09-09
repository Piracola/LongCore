using System.IO;
using System.Runtime.InteropServices;
using JiaoLongControl.Server.Core.Models;
using JiaoLongControl.Server.Core.Native;
using JiaoLongControl.Server.Core.Utils;

namespace JiaoLongControl.Server.Core.Drivers;

public class Blding64 : IDisposable
{
    private const string DllName = "JiaoLongDriver64.dll";
    private const string SysName = "JiaoLongDriver64.sys";
    private const string ServiceName = "JiaoLongDriver64";
    private readonly object _ioLock = new();
    private IntPtr _dllHandle = IntPtr.Zero;
    public bool IsInitialized { get; set; }

    [DllImport(DllName, EntryPoint = "InitializeBldring", CallingConvention = CallingConvention.StdCall)]
    private static extern bool InitializeBldring();

    [DllImport(DllName, EntryPoint = "ShutdownBldring", CallingConvention = CallingConvention.StdCall)]
    private static extern void ShutdownBldring();

    [DllImport(DllName, EntryPoint = "GetBLDPortVal", CallingConvention = CallingConvention.StdCall)]
    private static extern bool GetBLDPortVal(ushort wPortAddr, ref byte pdwPortVal, byte bSize);

    [DllImport(DllName, EntryPoint = "SetBLDPortVal", CallingConvention = CallingConvention.StdCall)]
    private static extern bool SetBLDPortVal(ushort wPortAddr, byte dwPortVal, byte bSize);

    private bool ReadPort(ushort portAddr, out byte value)
    {
        value = 0;
        return GetBLDPortVal(portAddr, ref value, 1);
    }

    private bool WritePort(ushort portAddr, byte value)
    {
        return SetBLDPortVal(portAddr, value, 1);
    }

    // ── EC 直写安全护栏 ─────────────────────────────────────────────
    // 允许写入的 EC 地址白名单(读操作不限制)。任何白名单外的写入直接拒绝:
    // EC 覆盖键盘灯/电源策略等关键寄存器, 写错地址可能导致硬件异常。
    private static readonly HashSet<ushort> WritableAddresses = new()
    {
        ECMemoryTable.Fan1_RPM_SET, // 0xC83C CPU 风扇转速
        ECMemoryTable.Fan2_RPM_SET, // 0xC83D GPU 风扇转速
        0xB20,                      // 风扇手动/自动模式掩码
        0x1060,                     // EC_init 索引协议使能位
    };

    // 同地址同值的重复写入在窗口内直接跳过(节流), 避免控制环高频重写 EC
    private const int ThrottleWindowMs = 300;
    private readonly Dictionary<ushort, (byte Value, DateTime At)> _lastWrites = new();

    private bool ThrottledWrite(ushort address, byte data)
    {
        if (!WritableAddresses.Contains(address))
        {
            log4net.LogManager.GetLogger(typeof(Blding64))
                .Error($"EC 护栏: 拒绝白名单外写入 0x{address:X4}={data:X2}");
            return false;
        }

        lock (_lastWrites)
        {
            if (_lastWrites.TryGetValue(address, out var last) &&
                last.Value == data &&
                (DateTime.UtcNow - last.At).TotalMilliseconds < ThrottleWindowMs)
            {
                return true; // 已是目标值, 视为成功
            }
        }

        // 只有底层写成功才记入节流缓存, 避免失败写入被后续调用误判为已完成
        if (!EC_RAM_WRITE(address, data))
            return false;

        lock (_lastWrites)
        {
            _lastWrites[address] = (data, DateTime.UtcNow);
        }
        return true;
    }

    public Blding64()
    {
        try
        {
            string driverFolderPath = Path.Combine(AppContext.BaseDirectory, "Drivers", "Blding");
            string fullDllPath = Path.Combine(driverFolderPath, DllName);
            string fullSysPath = Path.Combine(driverFolderPath, SysName);
            if (!File.Exists(fullSysPath))
                throw new FileNotFoundException($"Driver file not found: {fullSysPath}");

            _dllHandle = Kernel32.LoadLibrary(fullDllPath);
            if (_dllHandle == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                throw new Exception($"Failed to load DLL ({DllName}), ErrorCode: {err}");
            }

            DriverLoader.LoadDriver(ServiceName, fullSysPath);
            IsInitialized = InitializeBldring();
            if (!IsInitialized)
                throw new Exception("DLL initialization failed");
            EC_init();
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    private void EC_init()
    {
        byte EC_CHIP_ID1 = EC_RAM_READ(0x2000);
        if (EC_CHIP_ID1 == 0x55)
        {
            byte val = EC_RAM_READ(0x1060);
            val = (byte)(val | 0x80);
            EC_RAM_WRITE(0x1060, val);
        }
    }

    public void CpuFanSetSpeed(byte speed)
    {
        ThrottledWrite(ECMemoryTable.Fan1_RPM_SET, speed);
        SetManualMask(0x02);
        Core.Services.EcGuard.NoteEngaged();
    }

    public void GpuFanSetSpeed(byte speed)
    {
        ThrottledWrite(ECMemoryTable.Fan2_RPM_SET, speed);
        SetManualMask(0x08);
        Core.Services.EcGuard.NoteEngaged();
    }

    /// <summary>0xB20 读改写整段持锁, 防止双风扇路径并发丢位; 位已置则跳过写。</summary>
    private void SetManualMask(byte bit)
    {
        lock (_ioLock)
        {
            byte mask = EC_RAM_READ(0xB20);
            if ((mask & bit) != 0)
                return;
            EC_RAM_WRITE(0xB20, (byte)(mask | bit));
        }
    }

    public void RemoveFanSpeed()
    {
        // 恢复自动: 先停手动转速再清掩码。不经 SetSpeed, 避免再次置位 0xB20 / NoteEngaged。
        lock (_ioLock)
        {
            EC_RAM_WRITE(ECMemoryTable.Fan1_RPM_SET, 0);
            EC_RAM_WRITE(ECMemoryTable.Fan2_RPM_SET, 0);
            EC_RAM_WRITE(0xB20, 0x00);
        }
        Core.Services.EcGuard.NoteReleased();
    }

    private bool EC_RAM_WRITE(ushort iIndex, byte data)
    {
        lock (_ioLock)
        {
            byte highByte = (byte)(iIndex >> 8);
            byte lowByte = (byte)(iIndex & 0xFF);

            if (!WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2E)) return false;
            if (!WritePort(ECMemoryTable.EC_DATA_PORT, 0x11)) return false;
            if (!WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2F)) return false;
            if (!WritePort(ECMemoryTable.EC_DATA_PORT, highByte)) return false;

            if (!WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2E)) return false;
            if (!WritePort(ECMemoryTable.EC_DATA_PORT, 0x10)) return false;
            if (!WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2F)) return false;
            if (!WritePort(ECMemoryTable.EC_DATA_PORT, lowByte)) return false;

            if (!WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2E)) return false;
            if (!WritePort(ECMemoryTable.EC_DATA_PORT, 0x12)) return false;
            if (!WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2F)) return false;

            return WritePort(ECMemoryTable.EC_DATA_PORT, data);
        }
    }

    private byte EC_RAM_READ(ushort iIndex)
    {
        lock (_ioLock)
        {
            byte highByte = (byte)(iIndex >> 8);
            byte lowByte = (byte)(iIndex & 0xFF);

            WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2E);
            WritePort(ECMemoryTable.EC_DATA_PORT, 0x11);
            WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2F);
            WritePort(ECMemoryTable.EC_DATA_PORT, highByte);

            WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2E);
            WritePort(ECMemoryTable.EC_DATA_PORT, 0x10);
            WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2F);
            WritePort(ECMemoryTable.EC_DATA_PORT, lowByte);

            WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2E);
            WritePort(ECMemoryTable.EC_DATA_PORT, 0x12);
            WritePort(ECMemoryTable.EC_ADDR_PORT, 0x2F);

            ReadPort(ECMemoryTable.EC_DATA_PORT, out byte data);
            return data;
        }
    }

    public void Dispose()
    {
        if (IsInitialized)
        {
            try
            {
                ShutdownBldring();
            }
            catch
            {
            }

            IsInitialized = false;
        }

        if (_dllHandle != IntPtr.Zero)
        {
            Kernel32.FreeLibrary(_dllHandle);
            _dllHandle = IntPtr.Zero;
        }

        try
        {
            DriverLoader.UnloadDriver(ServiceName);
        }
        catch
        {
        }

        GC.SuppressFinalize(this);
    }

    ~Blding64() => Dispose();
}