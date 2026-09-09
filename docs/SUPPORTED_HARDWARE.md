# 机型支持声明（Supported Hardware）

> 适用版本：LongCore 0.1.0 · 更新日期：2026-09

## 实测机型（Golden Sample）

本项目所有协议逆向、真机探测与回归测试均在以下唯一机型上完成：

| 项目 | 值 |
|---|---|
| 机型 | 机械革命 蛟龙 16 Pro（2023 款，板型 **MRID6**） |
| BIOS | MRID6_23_V33（2023-09-23） |
| CPU | AMD Ryzen 9 7945HX（Dragon Range） |
| GPU | NVIDIA RTX 4060 Laptop |
| EC | 芯片 ID 家族 0x55，索引协议端口 0x4E/0x4F |
| WMI | `root\WMI` 命名空间，`MICommonInterface.InstanceName='ACPI\PNP0C14\MIFS_0'` |

## 理论兼容范围

同代蛟龙 16 Pro [2023] 的其他配置（如 7945HX + RTX 4070/4080/4090、R7 7745HX）**预期可用但未经实测**——它们共享同一 MRID6 板型与 EC 固件线。使用前请先运行
`probe/wmi_probe.ps1`（见仓库上层 `probe/` 目录）确认：

1. `MICommonInterface` 存在且 `MiInterface` 方法可调用；
2. 响应头为 `00 80` 且命令码回显（协议校验在软件内强制执行，不匹配即拒绝写入）；
3. EC 芯片 ID 读数为 0x55。

## 不支持 / 高风险

- **其他品牌/其他机械革命系列**：EC 寄存器表与 WMI 命令码完全机型绑定。软件内置了
  EC 写入地址白名单（仅风扇转速与模式掩码 4 个地址），但请求帧仍会下发到
  `MICommonInterface`——非目标机型的行为未定义。
- **BIOS 更新后**：EC 固件可能变更寄存器布局。升级 BIOS 后建议重新跑一遍探测脚本。
- **Linux / ARM**：依赖 Windows WMI、PawnIO 与厂商驱动（JiaoLongDriver64.sys），仅支持
  Windows 10/11 x64。

## 硬件访问机制（透明度声明）

| 通道 | 用途 | 形式 |
|---|---|---|
| WMI `MICommonInterface` | 性能模式/温度墙/功耗/键盘灯等 | 厂商 ACPI 方法，32 字节请求帧 |
| EC 索引协议（0x4E/0x4F） | 风扇转速手动控制、模式掩码 | 厂商签名驱动 `JiaoLongDriver64.sys` |
| PawnIO | AMD SMU（Curve Optimizer 等）、NVIDIA 遥测 | 官方签名二进制（随包分发） |
| NVAPI | GPU 超频/温度 | NVIDIA 官方接口 |

LongCore 不包含任何自签名内核驱动；EC 通道使用的厂商驱动与官方控制中心所装为同一文件。
