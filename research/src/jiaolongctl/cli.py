"""jiaolongctl 命令行入口。

用法::

    python -m jiaolongctl status              # 全部只读状态
    python -m jiaolongctl get fan             # 风扇转速
    python -m jiaolongctl get temp            # CPU 温度
    python -m jiaolongctl get mode            # 性能/显卡模式
    python -m jiaolongctl set spl 80 --write  # 写 SPL（需显式 --write）
"""

from __future__ import annotations

import argparse
import sys

from .wmi_interface import Command, GPUMode, JiaolongWMI, PerfMode

READABLE = {
    "fan": "CPU/GPU 风扇转速",
    "temp": "CPU 温度",
    "mode": "性能模式",
    "gpu": "显卡模式",
    "adapter": "电源适配器类型",
    "keyboard": "键盘灯状态/模式/亮度",
    "locks": "FnLock / 触摸板锁",
    "all": "以上全部",
}


def cmd_status(wl: JiaolongWMI) -> int:
    cpu_rpm = wl.read_cpu_fan_rpm()
    gpu_rpm = wl.read_gpu_fan_rpm()
    temp = wl.read_cpu_temperature()
    perf = wl.read_perf_mode().name
    gpu = wl.read_gpu_mode().name
    adapter = wl.read_power_adapter_type()

    kb_status = wl.get(Command.RGBKeyboardStatus).data_byte()
    kb_mode = wl.get(Command.RGBKeyboardMode).data_byte()
    kb_bright = wl.get(Command.RGBKeyboardBrightness).data_byte()
    fn_lock = wl.get(Command.FnLock).data_byte()
    tp_lock = wl.get(Command.TPLock).data_byte()
    boost = wl.get(Command.MaxFanSpeedSwitch).data_byte()

    print("蛟龙 16 Pro 硬件状态")
    print("-" * 46)
    print(f"  CPU 风扇     : {cpu_rpm} RPM")
    print(f"  GPU 风扇     : {gpu_rpm} RPM")
    print(f"  CPU 温度     : {temp} °C")
    print(f"  性能模式     : {perf}")
    print(f"  显卡模式     : {gpu}")
    print(f"  电源适配器   : {'TypeC' if adapter == 1 else '圆口' if adapter == 2 else adapter}")
    print(f"  键盘背光     : {'开' if kb_status else '关'}  模式={kb_mode} 亮度={kb_bright}")
    print(f"  FnLock       : {'开' if fn_lock else '关'}")
    print(f"  触摸板锁定   : {'是' if tp_lock else '否'}")
    print(f"  强冷         : {'开' if boost else '关'}")
    return 0


def cmd_get(wl: JiaolongWMI, item: str) -> int:
    if item in ("fan", "all"):
        print(f"CPU 风扇: {wl.read_cpu_fan_rpm()} RPM | GPU 风扇: {wl.read_gpu_fan_rpm()} RPM")
    if item in ("temp", "all"):
        print(f"CPU 温度: {wl.read_cpu_temperature()} °C")
    if item in ("mode", "all"):
        print(f"性能模式: {wl.read_perf_mode().name}")
    if item in ("gpu", "all"):
        print(f"显卡模式: {wl.read_gpu_mode().name}")
    if item in ("adapter", "all"):
        print(f"电源适配器: {wl.read_power_adapter_type()}")
    if item in ("keyboard", "all"):
        s = wl.get(Command.RGBKeyboardStatus).data_byte()
        m = wl.get(Command.RGBKeyboardMode).data_byte()
        b = wl.get(Command.RGBKeyboardBrightness).data_byte()
        print(f"键盘灯: {'开' if s else '关'} 模式={m} 亮度={b}")
    if item in ("locks", "all"):
        print(f"FnLock={wl.get(Command.FnLock).data_byte()} TPLock={wl.get(Command.TPLock).data_byte()}")
    if item == "fan":
        pass
    elif item not in READABLE:
        print(f"未知项: {item}。可选: {', '.join(READABLE)}", file=sys.stderr)
        return 2
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jiaolongctl", description="蛟龙 16 Pro 硬件控制")
    parser.add_argument("--write", action="store_true", help="允许写操作（默认只读）")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="显示全部硬件状态")
    p_get = sub.add_parser("get", help="读取单项")
    p_get.add_argument("item", choices=list(READABLE))
    p_set = sub.add_parser("set", help="写入（危险）")
    p_set.add_argument("target", choices=["spl", "sppt", "tempwall", "perf"])
    p_set.add_argument("value", type=int)

    args = parser.parse_args(argv)
    wl = JiaolongWMI(allow_write=args.write)

    if args.cmd == "status":
        return cmd_status(wl)
    if args.cmd == "get":
        return cmd_get(wl, args.item)
    if args.cmd == "set":
        if not args.write:
            print("拒绝执行：写操作需要 --write 参数。", file=sys.stderr)
            return 1
        from .wmi_interface import MethodType

        if args.target == "spl":
            wl.set_spl(args.value)
            print(f"SPL 已设为 {args.value} W")
        elif args.target == "sppt":
            wl.set_sppt(args.value)
            print(f"SPPT 已设为 {args.value} W")
        elif args.target == "tempwall":
            wl.set_temp_wall(args.value)
            print(f"温度墙已设为 {args.value} °C")
        elif args.target == "perf":
            wl.set(Command.SystemPerMode, bytes([args.value]))
            print(f"性能模式已设为 {args.value}")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
