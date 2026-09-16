"""蛟龙 16 Pro (MRID6) ACPI WMI 接口封装。

协议来源: 反编译 GamingControlCenter v0.3.15.0 + 本机实测 (BIOS MRID6_23_V33)。
详见 docs/02_协议手册.md。

安全设计:
- 所有写操作需要显式 allow_write=True 或 --write 参数
- 写值范围与厂商控制中心保持一致，超范围直接拒绝
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

import pywintypes

# ---------------------------------------------------------------------------
# 协议常量（见 docs/02_协议手册.md）
# ---------------------------------------------------------------------------

WMI_NAMESPACE = r"root\WMI"
WMI_CLASS = "MICommonInterface"
WMI_INSTANCE_PATH = (
    f"MICommonInterface.InstanceName='ACPI\\PNP0C14\\MIFS_0'"
)
METHOD_NAME = "MiInterface"

PACKET_SIZE = 32          # InData 必须恰好 32 字节
METHOD_TYPE_GET = 0xFA    # 250
METHOD_TYPE_SET = 0xFB    # 251

IDX_METHOD_TYPE = 1       # InData[1] = Get/Set
IDX_COMMAND = 3           # InData[3] = 命令码
IDX_ARG = 4               # InData[4..] = 参数

RESP_HEADER = (0x00, 0x80)  # OutData[0..1] 固定头
IDX_RESP_DATA = 4           # OutData[4..] = 数据


class MethodType(enum.IntEnum):
    GET = METHOD_TYPE_GET
    SET = METHOD_TYPE_SET


class Command(enum.IntEnum):
    """命令码 = 反编译枚举 WMIMethodName。"""

    SystemPerMode = 8          # 0=均衡 1=性能 2=静音
    GPUMode = 9                # 0=混合 1=独显直连（切换需重启）
    RGBKeyboardStatus = 10     # 0=关 1=开
    FnLock = 11
    TPLock = 12                # 触摸板锁定
    CPUGPUFanSpeed = 13        # 读: 2x u16 小端 RPM
    GPUFanSpeed_NotUse = 14
    Ambientlight = 15
    RGBKeyboardMode = 16       # 0=灭 1=自动循环 2=固定色 3=自定义
    RGBKeyboardColor = 17      # 写: [R,G,B]
    RGBKeyboardBrightness = 18  # 0-10, 128=自动
    SystemAcType = 19          # 读: 1=TypeC 2=圆口
    MaxFanSpeedSwitch = 20     # 强冷开关
    MaxFanSpeed = 21
    CPUThermometer = 22        # 读: CPU 温度 (°C)
    CPUPower = 23              # 写: [2,SPL]/[3,SPPT]/[4,温度墙]


class PerfMode(enum.IntEnum):
    BALANCE = 0
    PERFORMANCE = 1
    QUIET = 2


class GPUMode(enum.IntEnum):
    HYBRID = 0
    DISCRETE = 1  # 独显直连，切换必须重启


class RGBMode(enum.IntEnum):
    OFF = 0
    AUTO_CYCLIC = 1
    FIXED = 2
    CUSTOM = 3


# 写值范围（与厂商控制中心一致，超范围拒绝）
SPL_RANGE = (75, 85)
SPPT_RANGE = (105, 120)
TEMP_WALL_RANGE = (60, 100)  # 反编译未见强制范围，此处为保守自定


class ProtocolError(Exception):
    """协议层错误（包长错误/响应头不匹配/命令码回显不一致）。"""


class HardwareError(Exception):
    """WMI 调用层错误。"""


@dataclass
class MiResponse:
    """一次 MiInterface 调用的完整响应。"""

    ok: bool
    out_data: bytes
    reserved: int

    def data_byte(self, offset: int = 0) -> int:
        return self.out_data[IDX_RESP_DATA + offset]

    def data_u16(self, offset: int = 0) -> int:
        """小端 16 位读取：OutData[5]<<8 + OutData[4]（与厂商一致）。"""
        lo = self.out_data[IDX_RESP_DATA + offset]
        hi = self.out_data[IDX_RESP_DATA + offset + 1]
        return (hi << 8) + lo


def _build_packet(method: MethodType, command: Command, args: bytes = b"") -> bytes:
    if len(args) > PACKET_SIZE - IDX_ARG:
        raise ProtocolError(f"参数过长: {len(args)} 字节 (最多 {PACKET_SIZE - IDX_ARG})")
    pkt = bytearray(PACKET_SIZE)
    pkt[IDX_METHOD_TYPE] = method.value
    pkt[IDX_COMMAND] = command.value
    pkt[IDX_ARG : IDX_ARG + len(args)] = args
    return bytes(pkt)


def _validate_response(in_packet: bytes, out_data: bytes) -> None:
    # 实测响应为 30 字节（头 4 + 数据 26），非 32。只需保证覆盖到数据区前 8 字节。
    if len(out_data) < 16:
        raise ProtocolError(f"响应过短: {len(out_data)} 字节")
    if out_data[0] != RESP_HEADER[0] or out_data[1] != RESP_HEADER[1]:
        raise ProtocolError(f"响应头异常: {out_data[:2].hex()}")
    if out_data[IDX_COMMAND] != in_packet[IDX_COMMAND]:
        raise ProtocolError(
            f"命令码回显不一致: 发 {in_packet[IDX_COMMAND]:#04x} 收 {out_data[IDX_COMMAND]:#04x}"
        )


class JiaolongWMI:
    """WMI 硬件接口客户端。

    用法::

        wl = JiaolongWMI()
        resp = wl.get(Command.CPUGPUFanSpeed)
        print(resp.data_u16(0), resp.data_u16(2))   # CPU RPM, GPU RPM
    """

    def __init__(self, allow_write: bool = False) -> None:
        import pythoncom
        import win32com.client

        self.allow_write = allow_write
        pythoncom.CoInitialize()
        self._wmi = win32com.client.GetObject("winmgmts:" + WMI_NAMESPACE)
        instances = list(self._wmi.InstancesOf(WMI_CLASS))
        if not instances:
            raise HardwareError(
                f"未找到 {WMI_CLASS} 实例。本工具仅支持蛟龙 16 Pro (MRID6) 系列。"
            )
        self._obj = instances[0]

    # -- 底层 ---------------------------------------------------------------

    def _invoke(self, packet: bytes) -> MiResponse:
        in_params = self._obj.Methods_(METHOD_NAME).InParameters.SpawnInstance_()
        in_params.InData = packet
        out_params = self._obj.ExecMethod_(METHOD_NAME, in_params)
        props = out_params.Properties_
        out_data = bytes(props.Item("OutData").Value)
        _validate_response(packet, out_data)
        try:
            reserved = props.Item("Reserved").Value
        except pywintypes.com_error:  # 部分响应不含 Reserved
            reserved = 0
        return MiResponse(ok=True, out_data=out_data, reserved=reserved)

    # -- 读操作 -------------------------------------------------------------

    def get(self, command: Command) -> MiResponse:
        return self._invoke(_build_packet(MethodType.GET, command))

    # -- 写操作（显式授权） ---------------------------------------------------

    def set(self, command: Command, args: bytes) -> MiResponse:
        if not self.allow_write:
            raise PermissionError(
                "写操作已禁用。构造时传 allow_write=True (CLI 加 --write)。"
            )
        return self._invoke(_build_packet(MethodType.SET, command, args))

    # -- 高层封装 ------------------------------------------------------------

    def read_cpu_fan_rpm(self) -> int:
        return self.get(Command.CPUGPUFanSpeed).data_u16(0)

    def read_gpu_fan_rpm(self) -> int:
        return self.get(Command.CPUGPUFanSpeed).data_u16(2)

    def read_cpu_temperature(self) -> int:
        return self.get(Command.CPUThermometer).data_byte()

    def read_perf_mode(self) -> PerfMode:
        return PerfMode(self.get(Command.SystemPerMode).data_byte())

    def read_gpu_mode(self) -> GPUMode:
        return GPUMode(self.get(Command.GPUMode).data_byte())

    def read_power_adapter_type(self) -> int:
        return self.get(Command.SystemAcType).data_byte()

    # -- 功耗写操作（带范围校验） ----------------------------------------------

    def set_spl(self, watts: int) -> MiResponse:
        lo, hi = SPL_RANGE
        if not lo <= watts <= hi:
            raise ValueError(f"SPL 超范围: {watts} (允许 {lo}-{hi} W)")
        return self.set(Command.CPUPower, bytes((2, watts)))

    def set_sppt(self, watts: int) -> MiResponse:
        lo, hi = SPPT_RANGE
        if not lo <= watts <= hi:
            raise ValueError(f"SPPT 超范围: {watts} (允许 {lo}-{hi} W)")
        return self.set(Command.CPUPower, bytes((3, watts)))

    def set_temp_wall(self, celsius: int) -> MiResponse:
        lo, hi = TEMP_WALL_RANGE
        if not lo <= celsius <= hi:
            raise ValueError(f"温度墙超范围: {celsius} (允许 {lo}-{hi} °C)")
        return self.set(Command.CPUPower, bytes((4, celsius)))
