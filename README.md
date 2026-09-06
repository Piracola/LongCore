# LongCore 龙核

> 蛟龙 16 Pro 的开源硬件控制中心。
> 协议逆向自官方「蛟龙游戏控制中心 v0.3.15.0」，应用 fork 自社区项目 [JiaolongControl](https://github.com/GaoXanSheng/JiaolongControl)（MIT），按自己的方向全量重制。

**目标机型**：机械革命蛟龙 16 Pro 2023（MECHREVO MRID6，Ryzen 9 7945HX + RTX 40 系），BIOS `MRID6_23_V33` 实测通过。

> 本项目不包含任何厂商二进制文件，仅通过系统标准接口（ACPI WMI / NVAPI / PawnIO）与硬件通信。

## 项目构成

本仓库是 LongCore 的**大本营**：协议研究成果、测试工具与上游审计。重制版应用在 fork 仓库开发（链接待补）。

| 目录 | 内容 |
|---|---|
| `docs/01_术语表.md` | Windows 开发术语详解（面向初学者） |
| `docs/02_协议手册.md` | WMI 32 字节二进制协议完整规格 + 踩坑记录 |
| `docs/03_路线图.md` | 早期规划（背景资料） |
| `docs/04_上游审计.md` | JiaolongControl 三通道架构审计与 UI 诊断 |
| `src/jiaolongctl/` | Python 协议封装 + CLI（协议层的参考实现） |
| `probe/` | 本机实测脚本与第一手数据 |
| `TODO.md` | 开发待办清单（M0–M4 里程碑） |

## 快速开始（协议层）

```powershell
# 环境准备
python -m venv .venv
.venv\Scripts\pip install pywin32

# 列出全部硬件状态（只读）
$env:PYTHONPATH="src"; .venv\Scripts\python -m jiaolongctl status

# 读取单项
python -m jiaolongctl get fan      # CPU/GPU 风扇转速
python -m jiaolongctl get temp     # CPU 温度
python -m jiaolongctl get mode     # 性能模式
```

## 硬件通道（三条，均已核实）

| 通道 | 用途 | 状态 |
|---|---|---|
| WMI `root\WMI:MICommonInterface` | 性能模式/显卡模式/键盘RGB/功耗 SPL·SPPT/锁 | ✅ 本机实测 |
| EC 直读（厂商驱动） | 风扇手动转速与曲线（寄存器表见审计报告） | 🔍 已审计，待验证 |
| PawnIO（签名模块） | Ryzen SMU：Curve Optimizer / PBO / TDC·EDC | 🔍 上游已实现 |

## Fork 路线

- **不向上游提 PR**；定期 rebase 只取上游功能修复
- **UI 全量重设计**（诊断：去视频背景、统一线性图标、温度语义色阶、信息架构重组）
- **功能增强**：热键系统（HID_EVENT20 事件表已逆向）、WMI 响应校验、性能模式补全

## 免责声明

- 写操作（Set）直接作用于固件，错误值可能导致硬件异常。**协议工具默认只读**，写操作需显式 `--write` 确认。
- 接口定义在 ACPI SSDT 表中，**随 BIOS 版本变化**。其他 BIOS 版本请先运行探测脚本验证。
- EC 直写与 SMU 调校风险高于 WMI，使用前务必阅读审计报告的检查清单。
- 本项目与机械革命（MECHREVO）无任何关联。
