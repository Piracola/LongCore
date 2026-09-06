# jiaolongctl — 蛟龙 16 Pro (MRID6) 开源硬件控制工具

第三方开源控制台，逆向自「蛟龙游戏控制中心 v0.3.15.0」，在 **机械革命蛟龙 16 Pro 2023（MECHREVO MRID6，Ryzen 9 7945HX + RTX 40 系）** 上实测验证。

> 本项目不包含任何厂商二进制文件，仅通过系统标准接口（ACPI WMI / NVAPI）与硬件通信。

## 已验证的硬件接口

三条通道，全部在本机（BIOS MRID6_23_V33）实测通过：

| 通道 | 用途 | 状态 |
|---|---|---|
| WMI `root\WMI:MICommonInterface` | 性能模式/显卡模式/风扇/键盘RGB/功耗/锁 | ✅ 实测通过 |
| 原生 `KaronOC.dll`（NVAPI 封装） | GPU 核心/显存时钟偏移（P0 超频） | 🔍 已逆向签名 |
| WMI 事件 `HID_EVENT20` | Fn 热键事件 | 🔍 已逆向，待接入 |

## 快速开始（当前能力）

```powershell
# 列出全部硬件状态（只读）
python -m jiaolongctl status

# 读取单项
python -m jiaolongctl get fan      # CPU/GPU 风扇转速
python -m jiaolongctl get temp     # CPU 温度墙
python -m jiaolongctl get mode     # 性能模式
```

详细协议见 [docs/02_协议手册.md](docs/02_协议手册.md)。

## 文档导航

- [docs/01_术语表.md](docs/01_术语表.md) — Windows 开发术语详解（面向初学者）
- [docs/02_协议手册.md](docs/02_协议手册.md) — WMI 二进制协议完整规格
- [docs/03_路线图.md](docs/03_路线图.md) — 项目进展规划

## 免责声明

- 写操作（Set）直接作用于固件，错误值可能导致硬件异常。**本项目默认只读**，写操作需显式加 `--write` 确认。
- 接口定义在 ACPI SSDT 表中，**随 BIOS 版本变化**。其他 BIOS 版本请先运行探测脚本验证。
- 本项目与机械革命（MECHREVO）无任何关联。
