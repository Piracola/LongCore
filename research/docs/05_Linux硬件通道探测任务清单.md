# 蛟龙16 Pro (MRID6) Linux 硬件通道探测任务清单

> **目的**：验证 LongCore 在 Windows 下依赖的三条硬件通道（WMI 方法调用、EC 索引端口、SMU/GPU 原生库）在 Linux (Ubuntu) 下是否可达，为"跨平台重写"可行性提供事实依据。
> **执行者**：本机 Ubuntu 系统上的 AI agent（或人类按步骤执行）。
> **参考基准**：Windows 侧已探明的协议见 `docs/02_协议手册.md`；EC 索引协议见 `JiaoLongControl/Server/Core/Drivers/Blding64.cs`。
>
> **总原则**：
> 1. **先只读，后写入**。阶段 0–6 全部为只读探测；唯一可选的写实验在阶段 7，必须显式确认后才执行。
> 2. 每个阶段的输出**必须保存为文件**（统一存 `~/longcore-probe/`），最后汇总。
> 3. 遇到 STOP 条件立即停止该阶段，记录现象，继续下一阶段。
> 4. 全程接电源适配器执行（部分寄存器值在电池模式下不同，需对照）。

```bash
mkdir -p ~/longcore-probe && cd ~/longcore-probe
```

---

## 阶段 0：环境与安全基线

```bash
uname -a | tee ~/longcore-probe/00_kernel.txt
lsb_release -a 2>/dev/null | tee -a ~/longcore-probe/00_kernel.txt
sudo dmidecode -t bios | tee ~/longcore-probe/00_bios.txt
sudo dmidecode -t system | tee ~/longcore-probe/00_system.txt
mokutil --sb-state 2>&1 | tee ~/longcore-probe/00_secureboot.txt
cat /sys/kernel/security/lockdown 2>/dev/null | tee ~/longcore-probe/00_lockdown.txt
```

**预期与判读**：
- BIOS 版本应与 Windows 侧一致（参考值 `MRID6_23_V33`）。不一致不代表失败，但要记录。
- **关键分叉点**：
  - `[none]`（lockdown）→ 一切正常，可继续。
  - `[integrity]` 或 `[confidentiality]`（通常因 Secure Boot 开启）→ `/dev/port`、未签名内核模块全部被内核封锁。**STOP**：需要进 BIOS 临时关闭 Secure Boot 后重启，再重跑本阶段。这是 Linux 下硬件直控最常见的拦路虎，务必如实记录。

---

## 阶段 1：标准传感器面（hwmon / lm-sensors）

```bash
sudo apt update && sudo apt install -y lm-sensors dmidecode acpidump pciutils usbutils stress-ng
sudo sensors-detect --auto | tee ~/longcore-probe/01_sensors_detect.txt
sensors | tee ~/longcore-probe/01_sensors.txt
for h in /sys/class/hwmon/hwmon*; do
  echo "== $h name=$(cat $h/name)"; ls $h | grep -E 'pwm|fan|temp' ;
done | tee ~/longcore-probe/01_hwmon.txt
nvidia-smi --query-gpu=name,temperature.gpu,fan.speed,power.draw,power.limit --format=csv 2>&1 | tee ~/longcore-probe/01_nvidia.txt
```

**预期与判读**：
- `k10temp`（7945HX CPU 温度）应出现 → Linux 读 CPU 温度无障碍。
- `nvidia-smi` 应返回 RTX4060 温度/功耗 → GPU 监控无障碍。
- **hwmon 里是否存在 `pwm*` 节点决定原生风扇控制**：游戏本 EC 风扇通常**没有** pwm 节点，属预期；若有则是意外之喜，重点记录。
- 记录 7945HX 的 Radeon 核显（`amdgpu`）是否出现，关系核显/独显模式判定。

---

## 阶段 2：WMI/ACPI 通道（Windows 性能模式切换的载体）

Windows 下性能模式、键盘灯、独显直连走 `MICommonInterface`（ACPI `PNP0C14` 设备，GUID `{b60bfb48-3e5b-49e4-a0e9-8cffe1b3434b}`）。Linux 内核有 WMI 总线，先确认固件是否暴露了同一设备：

```bash
ls /sys/bus/wmi/devices/ 2>/dev/null | tee ~/longcore-probe/02_wmi_devices.txt
grep -ri "b60bfb48" /sys/bus/wmi/devices/ 2>/dev/null | tee ~/longcore-probe/02_wmi_guid_hit.txt
sudo acpidump > ~/longcore-probe/02_acpidump.bin
sudo acpidump -b > /dev/null 2>&1; strings ~/longcore-probe/02_acpidump.bin | grep -i -E "MIFS|_WDG|PNP0C14" | tee ~/longcore-probe/02_acpi_mifs.txt
dmesg | grep -i wmi | tee ~/longcore-probe/02_dmesg_wmi.txt
```

**预期与判读**：
- **GUID 出现在 `/sys/bus/wmi/devices/`** → 固件 WMI 设备在 Linux 可见，方法调用理论上可通过编写内核 WMI 驱动（或 `acpi_call`）实现。⚠️ 难度大但可行。
- **GUID 不存在但 ACPI dump 里有 MIFS/_WDG** → 设备存在但内核未绑定，仍可开发。
- **两者都无** → WMI 通道在 Linux 下不存在，性能模式切换需要寻找替代路径（很可能就是阶段 3 的 EC 直写，或直接写 SMU）。❌ 不是死刑，但要记录。

---

## 阶段 3：EC 索引端口协议（核心实验 ⭐）

Windows 侧 LongCore 通过 I/O 端口 `0x4E`(索引)/`0x4F`(数据) 直控 EC：先写握手序列定位 16 位寄存器，再读/写数据。已知寄存器（见 `Blding64.cs`）：

| 寄存器 | 含义 | 预期值 |
|---|---|---|
| 0x2000 | EC 芯片 ID | **0x55**（代码中以此判定握手使能） |
| 0x1060 | 索引协议使能位 | bit7 (0x80) |
| 0xC411 | EC 固件版本 | 记录原值 |
| 0xC834 / 0xC835 | CPU / GPU 风扇当前转速 | 原始值 ×100 = RPM |
| 0xC836 / 0xC837 | CPU / GPU 风扇档位 | 0–N |
| 0xC83C / 0xC83D | CPU / GPU 风扇手动设定值 | 自动模式下通常为 0 |
| 0xB20 | 手动模式掩码 | bit1(0x02)=CPU bit3(0x08)=GPU |

将以下脚本保存为 `~/longcore-probe/ec_probe.py`（**只读版本：只实现寄存器读，绝不写 EC RAM 数据字节**。注意：索引定位本身需要向 0x4E/0x4F 写索引字节，这是协议固有步骤，不属于 EC RAM 写入）：

```python
#!/usr/bin/env python3
"""蛟龙16 Pro EC 索引端口只读探测。用法: sudo python3 ec_probe.py"""
import os, sys, time, json

ADDR, DATA = 0x4E, 0x4F
REGS = {
    0x2000: "EC_ChipID(期望0x55)",
    0x1060: "索引协议使能位",
    0xC411: "EC固件版本",
    0xC834: "CPU风扇转速(x100RPM)",
    0xC835: "GPU风扇转速(x100RPM)",
    0xC836: "CPU风扇档位",
    0xC837: "GPU风扇档位",
    0xC83C: "CPU风扇手动设定",
    0xC83D: "GPU风扇手动设定",
    0xB20:  "手动模式掩码(0x02=CPU,0x08=GPU)",
}

fd = os.open("/dev/port", os.O_RDWR)

def outb(port, val):
    os.pwrite(fd, bytes([val]), port)

def inb(port):
    return os.pread(fd, 1, port)[0]

def ec_read(index):
    hi, lo = (index >> 8) & 0xFF, index & 0xFF
    outb(ADDR, 0x2E); outb(DATA, 0x11); outb(ADDR, 0x2F); outb(DATA, hi)
    outb(ADDR, 0x2E); outb(DATA, 0x10); outb(ADDR, 0x2F); outb(DATA, lo)
    outb(ADDR, 0x2E); outb(DATA, 0x12); outb(ADDR, 0x2F)
    return inb(DATA)

results = {}
for rnd in range(3):  # 读 3 轮，观察动态寄存器是否变化
    snap = {}
    for idx, name in REGS.items():
        snap[f"0x{idx:04X}"] = {"name": name, "value": ec_read(idx)}
        time.sleep(0.01)
    results[f"round{rnd}"] = snap
    time.sleep(1)

print(json.dumps(results, ensure_ascii=False, indent=2))
```

执行与记录：

```bash
sudo python3 ~/longcore-probe/ec_probe.py | tee ~/longcore-probe/03_ec_read_idle.txt
# 然后施加 CPU 负载让风扇起转，再读一次：
stress-ng --cpu 16 --timeout 60s &
sleep 30 && sudo python3 ~/longcore-probe/ec_probe.py | tee ~/longcore-probe/03_ec_read_load.txt
wait
# 对照实验：ACPI EC (0x62/0x66) 是否存在（与索引端口是不同通道）
sudo modprobe ec_sys write_support=1 2>&1
ls -la /sys/kernel/debug/ec/ec0/io 2>/dev/null | tee ~/longcore-probe/03_ec_sys.txt
sudo hexdump -C /sys/kernel/debug/ec/ec0/io 2>/dev/null | head -20 | tee -a ~/longcore-probe/03_ec_sys.txt
```

**预期与判读（本实验是整个可行性的分水岭）**：
- **0x2000 读出 0x55** → 索引协议在 Linux 下活着！再核对：负载后 0xC834/0xC835 明显上升且换算后 RPM 合理（100–6800）。✅ 成立则**风扇监控+风扇直控在 Linux 下完全可行**，且可复用 Windows 侧全部寄存器知识。
- 全部返回 0x00 或 0xFF → 协议不通。可能原因：lockdown 未解除、端口被 ACPI 驱动占用、或该通道需先置 0x1060 使能位（属写操作，转入阶段 7 决策）。记录后 STOP。
- 值随机跳变/不合常理 → 可能读到了真实但语义不同的映射，保存数据供后续对照分析。
- **STOP 条件**：探测过程中若风扇突然全速或停转、键盘失灵、系统死机 → 立即断电长按电源重启，如实记录，不再继续任何 EC 实验。

---

## 阶段 4：Ryzen SMU（上游"降压超频"功能的 Linux 等价物）

上游的 Ryzen SMU 功能在 Linux 下有成熟开源等价物 RyzenAdj（直接读写 SMU mailbox）：

```bash
sudo apt install -y build-essential cmake libpci-dev git
git clone https://github.com/FlyGoat/RyzenAdj ~/longcore-probe/RyzenAdj
cd ~/longcore-probe/RyzenAdj && mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release .. && make -j
sudo ./ryzenadj --info | tee ~/longcore-probe/04_ryzenadj_info.txt
sudo ./ryzenadj --dump-table 2>&1 | head -50 | tee ~/longcore-probe/04_ryzenadj_table.txt
cd ~/longcore-probe
```

**预期与判读**：
- `--info` 能列出 STAPM/PPT 限制、温度墙等 → ✅ Linux 下 CPU 功耗/降压路径**已被开源社区走通**，LongCore 可直接调用 ryzenadj 或移植其 SMU 通信代码。这是最不可能失败的一项。
- 失败（SMU 不响应）→ 记录 SMU 版本，查 RyzenAdj 对 Phoenix/Dragon Range (7945HX) 的支持状态。

---

## 阶段 5：GPU 通道（NVAPI 的 Linux 等价物）

Windows 侧 GPU 超频走 KaronOC.dll（NVAPI 封装）。Linux 下对应能力：

```bash
nvidia-smi -q -d CLOCK,POWER,TEMPERATURE 2>&1 | tee ~/longcore-probe/05_nvidia_detail.txt
nvidia-smi --query-gpu=clocks.max.graphics,clocks.max.mem --format=csv 2>&1 | tee -a ~/longcore-probe/05_nvidia_detail.txt
nvidia-settings -q GPUPerfModes 2>/dev/null | head -20 | tee ~/longcore-probe/05_nvsettings.txt
```

**判读**：Linux 下 GPU 功耗上限可用 `nvidia-smi -pl`；核心/显存偏移需要 X11 + Coolbits 或 NVML。Wayland 会话下超频路径受限，记录当前会话类型（`echo $XDG_SESSION_TYPE`）。

---

## 阶段 6：热键事件（HID_EVENT20 的 Linux 等价物）

Windows 侧性能模式键等通过 WMI 事件推送。Linux 下验证这些键产生什么：

```bash
sudo libinput debug-events 2>/dev/null | tee ~/longcore-probe/06_libinput.txt &
LIBPID=$!
# 依次按下: 性能模式键 / Fn 组合键 / 亮度键, 每个间隔 3 秒, 共 30 秒
sleep 30 && sudo kill $LIBPID
sudo evtest 2>&1 | head -40 | tee ~/longcore-probe/06_evtest_devices.txt   # 列出输入设备, 找 "AT Translated" / "Video Bus" / 厂商特定设备
sudo dmesg -w 2>&1 | tee ~/longcore-probe/06_dmesg_keys.txt &
sleep 1; echo "请再次按上述按键, 30秒后自动停止"; sleep 30; sudo pkill -f "dmesg -w"
```

**判读**：键出现在 evtest/libinput → 可按标准输入事件处理；只在 dmesg 出现 `Unknown key ... ` → 可映射；毫无踪迹 → 同 WMI 事件通道一样需要 ACPI 层开发。

---

## 阶段 7（可选·写实验）：风扇手动控制冒烟测试

> ⚠️ **仅在阶段 3 全部读数合理（0x2000=0x55、RPM 随负载变化）后，经用户明确批准才执行。**
> 风险：若程序崩溃且未恢复，EC 会停留在手动风扇模式（Windows 侧 LongCore 用 EcGuard 处理同一问题）。**必须**预置恢复手段。

实验内容（由执行 agent 将 Windows 侧 `Blding64.cs` 的 `EC_RAM_WRITE` 移植为 Python 后执行）：
1. 读并记录 0xB20、0xC83C 原值 → 备份文件。
2. 写 0xC83C = 30（约 3000RPM），写 0xB20 置 0x02 → 听风扇是否变化。
3. **立即恢复**：0xC83C=0，0xB20=0（恢复全自动）。
4. 全程脚本内置 try/finally 保证恢复执行；记录听感与读回值到 `07_fan_write_test.txt`。

**判读**：风扇转速随设定变化 → ✅ Linux 下风扇直控完全打通，跨平台重写的最大技术风险消除。

---

## 阶段 8：汇总判定表（执行 agent 填写）

| LongCore 功能 | Windows 通道 | Linux 探测结果 | Linux 可行性 |
|---|---|---|---|
| CPU/GPU 温度监控 | WMI 命令 22/13 | | ☐ 直接可行 ☐ 需开发 ☐ 不可行 |
| 风扇转速监控 | WMI 13 / EC 0xC834-5 | | ☐ ☐ ☐ |
| 风扇手动控制 | EC 0x4E/0x4F | | ☐ ☐ ☐ |
| 性能模式切换 | WMI 命令 8 | | ☐ ☐ ☐ |
| 独显直连切换 | WMI 命令 9 | | ☐ ☐ ☐ |
| CPU 功耗/降压 | SMU (上游功能) | | ☐ ☐ ☐ |
| GPU 超频 | KaronOC/NVAPI | | ☐ ☐ ☐ |
| RGB 键盘灯 | WMI 命令 10/16/17/18 | | ☐ ☐ ☐ |
| 热键事件 | HID_EVENT20 | | ☐ ☐ ☐ |

**最终产出**：将 `~/longcore-probe/` 整个目录打包，连同填好的判定表，交还给项目维护者。这份事实数据将直接决定"跨平台重写"的架构选型结论。
