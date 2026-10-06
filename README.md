<h1 align="center">LongCore</h1>

<p align="center">
  <strong>蛟龙 16 PRO 笔记本硬件控制中心</strong><br>
  <em>基于 7945HX + RTX 4060 版本开发，理论兼容其他 16 PRO [2023] 版本</em>
</p>

> [!IMPORTANT]
> **本仓库是 JiaolongControl 的独立 fork（LongCore）**：UI 重设计、EC 直写安全护栏、
> Fn 热键接管、电源计划联动，版本自 0.1.0 独立起版（与上游 10.x 脱钩）。
> 机型声明见 [docs/SUPPORTED_HARDWARE.md](docs/SUPPORTED_HARDWARE.md) ·
> [免责声明](docs/DISCLAIMER.md) · [已知问题](docs/KNOWN_ISSUES.md) ·
> English: [README_EN.md](README_EN.md)

<p align="center">
  <img src="Doc/Main.png" alt="主界面" width="800" />
</p>

<p align="center">
  <a href="https://qm.qq.com/q/4ase4LoAJi">
    <img src="https://img.shields.io/badge/QQ%20群-蛟龙工具箱问题反馈-EB1923?logo=tencentqq&logoColor=white" alt="QQ Group">
  </a>
  <img src="https://img.shields.io/badge/.NET-10.0-512BD4?logo=dotnet" alt=".NET">
  <img src="https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vuedotjs" alt="Vue">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

---

## 功能

### CPU

- **功率控制** — 短时功率 (SPL) / 长时功率 (SPP) 调节
- **温度墙** — 60°C ~ 105°C 可设
- **睿频开关** — 通过 `powercfg` 修改电源计划
- **最大频率限制** — 支持 AC / DC 分别设定
- **实时监控** — 温度、使用率、频率、电压

### GPU

- **显卡模式切换** — 混合输出 / 独显直连
- **核心频率锁定** — 锁定指定频率，支持范围检测
- **显存频率锁定** — 同上
- **功耗限制** — mW 级精度调节
- **解锁 DB** — 通过 NVPCF 驱动解锁 GPU 功率上限
- **实时监控** — 使用率、显存占用、核心/显存频率、温度、风扇转速

### Ryzen SMU（高级 CPU 调校）

- **功耗限制** — STAPM / Fast PPT / Slow PPT / PPT
- **电流限制** — VRM / TDC / EDC
- **温度限制** — MP1 / RSMU
- **PBO** — Scalar / OC Clock / Per-Core OC Clock
- **Curve Optimizer** — 全核 / 分核，正压 / 降压
- 自动检测 CPU 家族（Dragon Range / FP7 / FP8 / Strix / FP6）

### 风扇

- 手动固定转速（原「手动控制」档位）已于 2026-10-06 移除 —— 风扇由应用内曲线 / EC 固件温控 / 固件三档管理
- **高级自动风扇** — 温度驱动的智能调速：
  - 双跟踪器：升温走快跟踪器（安全优先，升速目标按它查曲线），回落后按慢跟踪器决定降速目标
    （噪音优先）—— 单一跟踪值无法同时满足"升温跟得上"和"回落后多保持"
  - 温度不灵敏带（默认 5℃）：温度小幅起伏时不改写硬件，且与曲线陡峭程度无关
  - 不对称转速斜坡：升温不设限、降温每秒最多退一格（一旦进入降速段就退到曲线值，不再重等门槛）
  - 曲线/档位改完当拍生效，不必等温度变化；转速长期高出曲线 800 RPM 达 60 秒也会放开降速
  - 可选双风扇合并（同转速同音高，消除两风扇转速差产生的拍频调制）
  - 三项均可在设置页调整：`Fan.TempAttackS` / `TempReleaseS` / `TempHysteresisC`
- **风扇曲线编辑器** — 可视化编辑温度-转速曲线
- **开机自启恢复** — 启动时自动恢复风扇策略

> **与 EC 固件的关系（重要）**：固件三档（办公 / 游戏 / 狂飙）下，EC 自带温控表在低负载区把转速
> 压得极低、临近温度墙（默认 95℃）才跳变，表现为"平时很静、到墙才猛拉"，其形状无法在软件层改变。
> **应用内曲线接管在三档下同样生效**，因此开关位于风扇曲线页，不要求先切到「自定义」档位。
> 接管后 `0xB20` 手动掩码会置位，EC 自身温控被绕开，兜底改为 `ThermalWatchdog`（98℃/10s 强制拉满）
> 与 `EcGuard`（进程崩溃后下次启动恢复 EC 自动模式）。关掉曲线开关，或在风扇曲线页点「交还 EC 固件温控」即交还 EC。

### 日志

- **可调项**（设置页修改，保存即生效）：日志详细程度、是否记录读取明细、写入间隔。
  警告和错误始终立即保存，不受写入间隔影响。
- **默认更安静**：默认只记录温度调节、保护动作和错误，不再记录每一次硬件读数，
  日志体积约为原来的百分之一。需要在论坛或群里反馈问题时，可临时切到「详细」。

### 键盘灯效

键盘 RGB 灯效（颜色 / 亮度 / 灯效模式）**不由 LongCore 控制**，请用厂商自带的灯效软件或键盘固件快捷键。
2026-10-06 起本软件已删除键盘颜色/亮度功能，也不再提供开机自动渐变。

### 环境光

- Logo 灯开关控制

---

## 使用说明

1. 从 [Releases](../../releases) 下载最新安装包
2. 运行安装程序（Inno Setup）
3. 启动后会在系统托盘显示图标，右键可显示主界面或退出
4. 在设置页可配置开机自启和启动最小化

> **注意：** 修改硬件参数有一定风险，请确保理解各项设置的含义后再操作。使用前建议备份当前配置。

---

## 开发

```bash
# 前端开发（需要 Node.js 24.15+，见 Client/.nvmrc）
cd JiaoLongControl/Client
npm install
npm run dev

# 后端构建（需要 .NET 10 SDK）
dotnet build JiaoLongControl/JiaoLongControl.csproj

# 发布
dotnet publish JiaoLongControl/JiaoLongControl.csproj -c Release
```

前端开发时 Vite dev server 运行在 `localhost:5173`，后端 WebView2 在开发模式下指向该地址。

> **前端命令的工作目录是 `JiaoLongControl/Client`**（仓库根没有 `package.json`）。
> 完整开发约定见 [AGENTS.md](AGENTS.md)。

---

## 仓库结构

本仓库是**单一 git 根**，应用本体与研究层同仓：

| 路径                              | 内容                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `JiaoLongControl/Client/`         | Vue 3 前端（Vite + Arco + ECharts + Pinia）            |
| `JiaoLongControl/Server/`         | .NET WPF 宿主（WebView2 Bridge / WMI / EC / SMU）      |
| `installer/`                      | Inno Setup 打包脚本                                    |
| [`research/`](research/README.md) | **协议研究层**：逆向成果、实测数据、上游审计、决策记录 |

研究层原为独立仓库，2026-09 并入本仓，**历史完整保留**。文档入口：[`research/docs/00_索引.md`](research/docs/00_索引.md)。

---

## 许可证

[MIT](LICENSE.md) © 2025 GaoXanSheng

---

<p align="center">
  <sub>使用风险自负 · 非官方工具 · 与机械革命/清华同方无关联</sub>
</p>
