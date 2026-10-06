# UI 重构评估：迁移到 miuix 的架构审查与可行性方案

> 2026-10 · 应机主要求对 LongCore 前端架构做一次整体审查，并评估「将 UI 重构为
> <https://github.com/compose-miuix-ui/miuix>」的可行性。本文只陈述事实与路线，
> 最终取舍由机主裁定。

## 1. 现状架构审查（2026-10 基线）

### 1.1 分层与数据流（健康）

- WPF 宿主 (.NET 10) → WebView2 ⇄ window.chrome.webview.hostObjects.bridge（唯一硬件通道）
- utils/bridge.ts：类型映射 + 8s 超时 + 1s/30s 缓存 + 在途去重 + 失败冷却
- stores/*：pinia，四态 Reading<T>（ok/stale/unavailable/error）
- PollingChannel：统一调度（在途 1 请求、隐藏暂停、失败退避、停转）
- pages/*：组件只做渲染；domain/* 纯函数可单测（93 个测试）

这套契约是项目的核心资产：**四态读数、失败不落 0、pending 不冒充已生效、
写后独立重读**等第一性原则全部沉淀在 stores/domain 层，与渲染层解耦。
换 UI 库**不动**这些层中的大部分（bridge / stores / domain / composables）。

### 1.2 渲染层现状（问题所在）

| 层 | 现状 | 问题 |
|---|---|---|
| 组件库 | Arco Design Vue 2.58（按需引入）+ 手写组件混用 | 两套视觉语言；Arco 变量靠 Global.scss 手工对齐 |
| 图表 | ECharts（概览/核心监控环）+ 手绘 SVG（遥测/曲线编辑器）+ sparkline 工具（GPU/SMU） | 三种实现；本次已收敛为 TrendChart 单一渲染器 |
| 样式 | Tailwind 4 + CSS 变量令牌（Global.scss 硬件仪表 v2）+ 每页 scoped SCSS | 令牌层是统一的，但页面间字阶/卡片头写法漂移（本次已对齐） |
| 布局 | 自研 Main.vue + 图标轨 + TitleBar（无边框自绘） | 与 WPF 窗口耦合（拖拽/最大化走 postMessage） |

### 1.3 历史包袱（迁移时必须处理，与新库无关）

- Arco 组件类名覆盖链脆弱：本次滑块错位即因 `.arco-slider-button` 死选择器
  （Arco 实际是 `.arco-slider-btn`）未被察觉——覆盖层靠猜类名，无类型保护。
- 遗留 token 别名（Global.scss「迁移别名」区块）尚未清零。
- GPU.vue 仍有一批注释掉的高级超频面板死代码。

## 2. miuix 事实核查（2026-10，全部带出处）

### 2.1 miuix（Compose Multiplatform 版）

- 定位：**Kotlin** / Compose Multiplatform UI 库，小米 HyperOS 设计风格。
  <https://github.com/compose-miuix-ui/miuix>
- 平台：Android / iOS / macOS(native) / **Desktop(JVM)** / Web(JsCanvas+WasmJs)。
  <https://github.com/compose-miuix-ui/miuix/blob/main/miuix-ui/build.gradle.kts>
- 许可证 Apache-2.0；最新版 0.9.4（2026-08-13 tag）；README 自述
  **"This library is experimental. APIs may change without notice."**
  <https://github.com/compose-miuix-ui/miuix>
- 活跃度：约 1.3k–1.4k stars，最近提交 2026-09-29，维护者 YuKongA。
- 组件 50+：Scaffold/TopAppBar/NavigationBar/Card/Switch/Slider/Dialog/BottomSheet/
  NumberPicker/Preference 行组件等；弹窗体系自研（Overlay* 必须包在 Scaffold 内）。
  <https://github.com/compose-miuix-ui/miuix/tree/main/docs/components>
- 主题：MiuixTheme + light/darkColorScheme，支持 Monet 动态取色；**不内置 MiSans**
  （官方示例从小米 CDN 加载）。
  <https://github.com/compose-miuix-ui/miuix/blob/main/docs/guide/theme.md>

### 2.2 miuix-vue（同作者 Vue 移植）

- **存在**：<https://github.com/YuKongA/miuix-vue>，npm 包 `miuix-vue`，
  peer 依赖 vue ^3.4 + motion-v ^2，主题走 CSS 变量、暗色由 `.m-theme-dark` 切换。
- 成熟度（关键）：npm 首发 2026-05-31，仅 2 个版本，latest **0.1.1**；仓库 29 stars；
  最后提交 2026-06-20；周下载约 160、月下载约 517 —— **早期阶段，API 不稳定**。
  <https://www.npmjs.com/package/miuix-vue>
- 组件覆盖：Button/Card/Switch/Slider/Input/Checkbox/NumberPicker/SearchBar/
  Preference 六种行组件/TopAppBar/NavigationBar/TabRow/BottomSheet/Dialog/
  ScrollArea/ProgressIndicator/Snackbar（README 表）。**无图表组件**。
- 未发现 React 实现。miuix 自身可编译到 Web，但那是 Compose 渲染到 canvas，
  不是 DOM/CSS 组件库。

### 2.3 Compose Desktop 路线（如果不用 Vue 移植）

- Compose Multiplatform 桌面稳定线 1.11.x/1.12.x；Windows 无边框窗口
  （`undecorated=true` + `WindowDraggableArea`）、托盘（`Tray`）为官方能力。
  <https://kotlinlang.org/docs/multiplatform/compose-desktop-top-level-windows-management.html>
- 打包：jpackage + jlink，`TargetFormat.Msi`(WiX) / `TargetFormat.Exe`(**Inno Setup**)；
  不支持交叉编译。现有 installer/ 的 Inno Setup 脚本可复用（`createDistributable`
  产应用镜像 → 交给现有 .iss）。
  <https://kotlinlang.org/docs/multiplatform/compose-native-distribution.html>
- 与现有 WPF 宿主的关系：官方**没有** WPF/HWND 嵌入方案。两条路线：
  1. **独立窗口**：Compose 应用即独立 EXE/窗口，与 WPF 宿主进程并存；
  2. **HWND 嵌入**：ComposePanel（Swing 组件）经 WPF HwndHost 嵌入 ——
     属社区实践，焦点/airspace/输入法需自行验证，弹窗默认受 ComposePanel 边界限制。
     <https://kotlinlang.org/docs/multiplatform/compose-desktop-swing-interoperability.html>
     <https://learn.microsoft.com/en-us/dotnet/desktop/wpf/advanced/hosting-win32-content-in-wpf>

## 3. 三条路线的取舍

### 路线 A：Vue 内换皮 —— 引入 miuix-vue 替换 Arco（渐进）

- **做法**：保留现有 App 壳、bridge/stores/domain 全部不动；组件层从 Arco
  逐页换成 miuix-vue；图表维持 ECharts/TrendChart（miuix-vue 无图表组件）。
- **代价**：miuix-vue 0.1.1、四个月未更新、周下载 160 —— 锁死在一个早期依赖上，
  组件缺口（Modal/Message/Slider marks 等本项目实际用到的）要自己补；
  上游 API 变更无人兜底。
- **收益**：HyperOS 视觉；迁移成本最低；风险集中在「依赖弃维护」。
- **判断**：**现阶段不建议直接切换**。可作为观察项：等 miuix-vue 出 0.2+ /
  半年内有持续提交再评估。在此之前，本项目自研令牌层（Global.scss）+ TrendChart
  已经承担了视觉统一职责。

### 路线 B：Compose Desktop + miuix 整体重写（推倒重来）

- **做法**：新建 Kotlin/Compose Desktop 前端，miuix 做组件层；硬件通道从
  WebView2 bridge 换成进程内直调 —— 这是路线 B 的最大架构收益：
  CommandResult 的 COM 编组层（8s 超时、缓存、在途去重都是为跨进程兜底）
  可以整层删除。但前提是宿主从 WPF 换成 KMP 或做 .NET↔JVM 桥（无成熟方案）。
- **代价**（按工程量排序）：
  1. 硬件通道重建：现宿主是 .NET WPF，Kotlin 与 .NET 之间要么换宿主语言
     （EC/SMU/驱动调用全部重验证），要么做 .NET↔JVM 桥；
  2. 无边框窗口/托盘/OSD/Fn 热键/WMI 交互全部按 Compose Desktop API 重写；
  3. HWND 嵌入路线（保留 WPF 宿主）无官方支持，airspace/焦点/输入法是已知雷区；
  4. miuix API 标注 experimental，可能随时变更；
  5. 8 个页面 + 全部交互逻辑重写，四态读数/复合写入/看板语义要在新栈重新落地。
- **收益**：真正的 HyperOS 观感；删除 WebView2 编组层；单进程架构。
- **判断**：相当于把前端**再写一遍并连带重审宿主进程模型**，是一个**独立立项**，
  不是「重构」。

### 路线 C（本次已落地）：不换库，收敛设计系统（推荐维持）

本次已完成的收敛即路线 C 的第一批落地：

1. **TrendChart 单一渲染器**：全站趋势图（概览温度历史、风扇曲线页遥测）统一为
   一个组件，网格/字阶/图例/tooltip/断线语义（null 不补 0）一处定义；
2. **遥测上收 store**：telemetry.ts 环形缓冲（300 点 ≈ 10 分钟）挂 App.vue，
   切页不停 —— 与 tempHistory 同一模式，历史跨页面累积；
3. **InfoHint 说明气泡**：替代裸 title 的「?」，悬停/点击/键盘三通道可用；
4. **滑块几何修复**：圆点与轨道垂直对齐（根因是死选择器 + 轨道高度改动），
   并顺带把覆盖层改为对照 Arco 源码逐一核实；
5. **排版统一**：看板/面板头字阶从「11px 大写微缩」对齐到「13px/650」卡片标准；
   GPU/SMU 遥测磁贴底色统一为 bg-inset + border-hair。

后续可做：Global.scss 迁移别名清零；Arco 组件收口到一个 components/ui/ 包装层
（禁止页面直接 import arco），把「换库」的爆炸半径压缩到一层。

### 结论

- 「重构为 miuix」在 **Vue 语境下** = 换用 miuix-vue，但该库当前（0.1.1，
  2026-06 后无提交）不足以承载生产应用；建议观察，维持路线 C。
- 若「miuix」指 **Compose Desktop 原生版**，等价于整体重写 + 硬件通道重建，
  是独立立项量级的工作；技术可行性成立（Compose Desktop 在 Windows 成熟、
  Inno Setup 打包可复用），但收益/成本比在本项目现阶段不成立。
- 两条路线共同的前提（视觉令牌、TrendChart、四态读数组件化）恰好就是路线 C
  的内容 —— **先做 C 不亏**：无论将来去 miuix-vue 还是 Compose，这些资产全部平移。

## 4. 若机主仍决定推进，下一步的最小验证清单

1. 用 miuix-vue 搭一个 demo 页（Card/Switch/Slider/Preference 行），跑通
   config.yaml 深浅主题切换（`.m-theme-dark` 与现有 `data-theme` 同步）；
2. 评估缺口：Modal/Message/图表容器 —— 逐一给出「自研 or 保留 Arco 混用」结论；
3. 若走 Compose：先做 1 周 spike —— WPF 宿主进程 + ComposePanel HWND 嵌入，
   验证焦点/键盘/bridge 直调替代方案，再谈立项。
