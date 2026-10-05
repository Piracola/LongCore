# LongCore UI 重构 · 最终方案 v4.0（RFC）

> **状态：执行中（2026-09-17）。** 机主已确认自用、三档命名、5.4 GHz、2560×1600@150%、风扇页与胶囊冷启动（其中**风扇页已于 2026-10-06 删除**，见 §14.9）。本文档自身仍受 §1 状态分类法约束。
> 日期 2026-09-17 · 承接 `UI重构_v3_计划.md`（**已降级为「观察集」**，见 §0）
> 合并来源：**A 线**（本仓调查）提供**证据**；**B 线**（外部评审）提供**判据**。
> **合并原则：任何只有"想法"、没有"证据或判据"的条目，一律进 §14 未决问题，不进实现。**

---

## 0. 相对 v3.1 的变更

| v3.1 写法 | v4.0 处置 | 依据 |
|---|---|---|
| 「四项假设全部结案，执行中 Phase 2」 | **降级为 Draft**，全部回退到 Hypothesis | 同一文档存在四种互相冲突的状态（第 5/43/192/272 行） |
| 「当前 IA 是 WMI 协议分类法」 | **删除，判定为事实错误** | Fan = EC 直写 `Blding64`；SMU = PawnIO；GPU = NVAPI。是**硬件子系统**分类法 |
| 「用户的原话」表格 | **删除** | 无访谈/工单/遥测/可用性测试来源，属**臆造证据** |
| 「深浅同病 → 问题纯粹在结构层 → IA 是唯一出路」 | **降级**为「换主题不充分」 | 逻辑跳跃，见 §5 |
| 「写入审计台 = 把已有工程显化」 | **推翻** | `HwWriteGate` 的「审计」实为 `Logger.Debug`，且 `Set` 路径**刻意不校验回显**（有正当理由，见 §4.4） |
| 「失败可回滚」 | **删除**，改为 §8 的**可逆性分级** | CPU 顺序写 7 项、键盘并行写、GPU 需重启、SMU 原值未必可读 |
| 「每页统一三段式」 | **删除**，改为 §10 **操作分类法** | 与 §0.2「推翻每页三段式」自相矛盾 |
| 「内容不足时刻度条提供结构」 | **删除** | 与「版面按内容分配」自相矛盾 |
| 「并置测试/盲测/≤2 点击/grep」四项 DoD | **降级**为辅助检查，主 DoD 见 §13 | 测的是"像不像第一方软件"，不测安全与效率 |
| 200 条环形缓冲叫「审计账本」 | 改名「**最近活动**」 | 审计语义要求完整、持久、可追溯 |

**保留**：§3 逐页问题清单（改名「待验证候选」）、P0 因果关系边界、失败≠0、动效限制、技术栈与非目标、真机验证要求。

---

## 1. 状态分类法（本文档及后续所有文档必须遵守）

| 状态 | 含义 | 提升条件 |
|---|---|---|
| **Observation** 观察 | 有可复现证据的事实 | 必须带 `文件:行` 或截图编号 |
| **Hypothesis** 假设 | 有理由但未验证的推断 | 必须写**反证条件**：什么结果会推翻它 |
| **Decision** 决策 | 有人负责的取舍 | 必须有负责人 + 日期 + 依据 |
| **Implemented** 已实现 | 代码在树里 | 不等同正确，必须附提交号 |
| **Verified** 已验证 | 有独立证据 | 独立证据 ≠ 自测通过 |

> **v3.1 的根本错误**：把 Hypothesis 写成了 Decision。本文档所有未标 Verified 的条目都**不得**被当作执行依据。

---

## 2. 第一性原则（B 线提出，A 线全盘接受）

1. **用户必须能区分**「我想设置的值」/「命令已发送」/「硬件实际值」。三者混用即失去可信度。
2. **危险操作不得**虚假成功、模糊失败、或承诺未经定义的回滚。
3. **IA 必须建立在**真实用户任务与**稳定的**领域模型上。
4. **后台轮询、IPC、硬件写入必须有明确上界**（后端也必须，不只是前端）。
5. **验收衡量**任务成功、安全性与恢复能力，不衡量"像不像大厂软件"。

A 线补充第 6 条（源自本次 P0 事故）：

6. **"不可复现"本身是证据**：它排除确定性缺陷，指向规模/状态依赖的缺陷（累积、并发、泄漏）。诊断必须先问"为什么它有时候不复现"。

---

## 3. 已核实的观察集

### 3.1 实机截图取证（5 页，2026-09-16，浅色主题）

> 全部为 **Observation**。带 ⚠️ 的是**待验证候选**（我的判断，不是事实）。

| 页 | 证据 | 性质 |
|---|---|---|
| 跨页 | 首页无页面标题，其余 5 页有 | Observation |
| 跨页 | 侧栏底部疑似两枚齿轮 | ⚠️ 待确认 |
| 跨页 | 标题栏 logo 为 "LC" 文本，DESIGN.md 冻结的龙鳞标识未落地 | Observation |
| 跨页 | MODE 胶囊 / 四格读数卡 / 规格条可见青紫描边 | Observation |
| 跨页 | **深浅色下问题完全一致** | Observation（用户确认） |
| 首页 | `FAN MAX 3134 RPM` 与状态条右侧 `FAN 3134 RPM` 完全重复 | Observation |
| 首页 | `PACKAGE POWER 2 W` 占据 1/4 主读数区 | Observation |
| 首页 | `TEMPERATURE HISTORY` 占页面最大面积，仅 2 个数据点 | Observation |
| 首页 | `26 dBA` 独占整行 | Observation |
| 首页 | 页面下方约 1/3 空白 | Observation |
| 首页 | `FANS & LOAD` 用无刻度的进度条表示 0% / 2% | ⚠️ 待验证候选 |
| 首页 | GPU 温度读数=蓝，同页图例 GPU=绿 | Observation（颜色通道含义混乱） |
| CPU | PL1/PL2/温度墙/最大睿频同组 | ⚠️ 待验证候选（语义层级混用） |
| CPU | 频率/电压/使用率/温度共用同一种进度条 | ⚠️ 待验证候选 |
| CPU | 「核心分布」00–11 十二格无标注 | ⚠️ 待验证候选 |
| GPU | 仅 2 个滑条却占满整卡，下方约 1/3 空白 | Observation |
| GPU | 6 格 sparkline 中 4 格退化为角落小折角 | Observation（缺空态） |
| SMU | **13 个同款「应用」按钮**，每滑条一枚 | Observation |
| SMU | 左列限制值全显示 **0** | Observation（**曾是安全事故**，见 §4.3） |
| SMU | 分类为功耗/电流/温度/时钟 = **协议分类** | Observation |
| SMU | 遥测卡有真实值（PPT 28.7 W / 70.5 ℃），左侧全 0 | Observation（两套数据来源不同） |
| SMU | 页面无任何"这些值会写进固件"的危险感 | ⚠️ 待验证候选 |
| 风扇 | `1500 RPM` 用全站最大字号 | Observation（**全站唯一层级正确的元素**） |
| 风扇 | 遥测曲线压在左下角约 1/4 区域 | Observation |
| 风扇 | 「安全提示」整段散文 + 一枚危险按钮，权重相同 | ⚠️ 待验证候选 |
| 键盘 | 预览区是通用圆角矩形网格，非真实键盘布局 | Observation（2026-10-06 灯效页已删，仅存档） |
| 键盘 | 预设命名与色相不对应（冰晶=青/极光=绿/烈焰=玫红） | ⚠️ 待验证候选（同上，已无对象） |

### 3.2 代码核查（逐行，带位置）

| 位置 | 事实 | 对方案的影响 |
|---|---|---|
| `stores/systemInfo.ts:90-110` | 单项失败被转成 `0` 或 `'0'`（一排 `: 0` / `: '0'`） | **直接违反第一性原则 1**；`scale.ts` 的 null 安全被上游击穿 |
| `stores/systemInfo.ts:112` | `if (fSpeed.Success) this.fanSpeed = fSpeed.Data` —— **全场唯一没被污染的读取** | 正确写法项目里已有，只用在了一处 |
| `stores/systemInfo.ts:124-128` | `startPolling()` = 裸 `setInterval`，无可见性暂停、无在途锁、无失败停止 | 违反原则 4；**我只修了页面轮询，没修这里** |
| `pages/Home.vue:49-58` | `setMode()` **先改 UI，再 `void` 发出，不 await、不看结果、无回滚** | 违反原则 1、2。**若模式升格为全局主轴，即是虚假成功** |
| `stores/index.ts:21-30` | 页面持久化 = `Number(localStorage['jl-ui-page'])` 校验 `1..length`，靠**数组下标**恢复 | **IA 一改，老用户恢复到错误页面**。必然发生，A 线原先漏掉 |
| `Server/MainWindow.xaml:9-10` | `Width=1300 Height=820 MinWidth=1300 MinHeight=820` 写死 | **1920×1080@150% 逻辑 1280×720 装不下**；200% 下更甚 |
| `Client/package.json` | `build = npm run type-check && npm run build-only`（无 lint、无 test）；`*.spec.ts`/`*.test.ts` **零个** | 现有"验证"远不足以支撑 DoD |
| 工作树 | **42 项**：26 修改 + 1 删除 + 15 未跟踪 | v3.1 写的"23 项"已过期 |
| `utils/temperature.ts` | `t<=70 cool / <=80 warm / <=90 hot`，且有 `tempLevelHys()` **滞回**，注释说明滞回是为了防止"配合 200ms 过渡出现肉眼可见的持续闪色" | **A 线新写的 `scale.ts` 与它冲突且丢失滞回，须处置** |

### 3.3 codegraph 索引（本次新建）

`LongCore` 已建立索引：**93 文件 / 2,097 节点 / 5,028 边 / 5.4 MB**。
它当场产出了 §4.2 的关键线索。**查询必须传 `LongCore` 路径**（codegraph 向上找索引，不向下）。
`.codegraph/.gitignore` 已自忽略，不会污染仓库；但 git 会报 `?? .codegraph/`，需提交该 `.gitignore` 或在 `LongCore/.gitignore` 加一行。

---

## 4. P0 卡死事故（独立成章）

### 4.1 现象

切到 Ryzen SMU 后点击无响应，界面数据仍刷新；同期整个桌面（含资源管理器）一度无响应。**重启后不复现。**

设计上，`MethodServices` 与 `HwWriteGate` 都不允许"写入 0"（白名单 + 值域 + 令牌桶）。所以 §4.3 的 0 值必须经由绕开 `MethodServices` 的**独立通路**外出。

### 4.2 机制（代码级，两半）

**前端半** —— 累积型竞态：

    onMounted(async () => {            ← 回调是 async
      await CPU.GetPhysicalCoreCount()    ┐ 两次桥接往返
      await CPU.GetCpuInfo()              ┘
      pollingTimer = setInterval(...)   ← 定时器在这里才创建
    })
    onUnmounted(() => { if (pollingTimer) clearInterval(pollingTimer) })
                                    ↑ 此刻仍是 null，什么也没清

两次 `await` 期间切走页面 → 定时器在**卸载之后**才创建 → 永久泄漏。SPA 切页不刷新文档 →
泄漏**在整个应用生命周期内累积**：每访问一次多一个 3 秒轮询器。重启归零 → 不复现。

放大器：`call()` **无超时**、`cached()` **无在途去重** → 宿主一变慢，排队**上界无穷**且永不自愈。

**服务端半** —— codegraph 索引当场发现：

    RyzenSmuController.cs:465  GetSmuTelemetry()
      └─ GetOrCreateLhm()  →  LibreHardwareMonitor.Hardware.Computer   (:449)
           ├─ computer.Open()        ← 开内核驱动
           └─ hardware.Update()      ← 每传感器组的驱动 I/O (:484)

| 事实 | 位置 |
|---|---|
| `GetSmuTelemetry` **不走 PawnIO**，走 LibreHardwareMonitor | `:465` |
| `GetOrCreateLhm()` 只对**创建**做了双检锁 | `:451-462` |
| `hardware.Update()` 在**锁外**调用，`_lhmComputer` 是 **`static` 单例** | `:392`, `:484` |
| `_lhmComputer` **永不释放、永不失效**，无损坏重建路径 | `:392` |

**两半接起来**：无界轮询堆积 → 并发 `GetSmuTelemetry()` → **并发 `hardware.Update()` 打在同一个 LHM 单例上**（非线程安全）。

**不对称**：WMI 那条路早已做"单例复用损坏重建"（M2 `536421d`），**LHM 这条路没有**；而 README 明说加载驱动需先处理内存完整性拦截，即 `Open()` 失败是**预期内**情形，失败后该静态单例会被永久复用。

### 4.3 已修复（Implemented + 部分 Verified）

| 文件 | 改动 |
|---|---|
| `bridge.ts` | `call()` 加 8s 超时；`cached()` 加在途去重 + 失败冷却 15s + 仅成功写缓存；修 `ts` 取值时机 |
| `RyzenSmu.vue` | `telemetryInFlight` 在途守卫；`disposed` 标志根治泄漏；连续失败 5 次停轮询；不可见时停轮询 |
| `RyzenSmu.vue` | 修正 `loadingMap` 键名不一致（模板读 `item.key`、写入落 `'Set'+item.key`，**13 个按钮禁用态从未生效**） |
| `RyzenSmu.vue` | `ZERO_UNWRITABLE` 前端闸门：12 个限制型 setter 值为 0 时拒绝写入，界面显示「未读取」并置灰 |

**验证证据**：`vue-tsc` 退出码 0 · `eslint` 退出码 0 · 用户终端 `npm run build` 通过 · 真机反复进出 SMU 页 20 次无复现。

### 4.4 因果边界（必须保留）

- 机制**已确证**（代码摆在那里）。
- **但"它就是那次事故的成因"未被确证。** 只复现一次的现象无法定性；20 次无复现是**必要而非充分**证据。
- **严格控制变量**：测试期间需保持前台窗口、可见性、DPI、主题不变。

### 4.5 一处必须澄清的技术真相反转

B 线指出"WMI 写调用不抛异常即视为已下发；明确不校验写响应回显 → 不能宣称已『回读校验』"——**结论正确，但性质被讲成了疏忽，实际是有证据的刻意决定**。`MethodServices.cs:92-100` 原文：

```
// Set 路径: 与官方客户端判定对齐 —— 调用未抛异常即视为下发成功。
// 依据 decompiled/main.cs ExcMethod: 官方只在 ManagementException 时返回 false……
// 本项目此前对 Set 也套用 Get 的严格回显校验, 而部分命令(实测为命令 23 CPUPower)
// 的响应并不回显命令码 —— 写入实际已生效, 却被引擎判为失败,
// 表现为 CPU 页四个档位点应用一律提示"设置失败"(根因)。
```

**这改变了审计台的设计约束**：

> 「回读校验」**不能**做成"比对写响应的回显"——命令 23 这类合法地不回显命令码，硬比对会把**成功写成失败**（项目已踩过）。
> 它必须是**写后独立重读**；对没有可靠 getter 的参数（部分 SMU），只能诚实标注「**仅命令确认，不可回读**」。

`HwWriteGate.cs:168-172` 的"闸 4: 审计"实为 `if (Logger.IsDebugEnabled) Logger.Debug(...)` 一句日志。**称其为"已有审计"是高估。**

---

## 5. 被推翻 / 降级的假设

| 假设 | v3.1 结论 | v4.0 结论 | 依据 |
|---|---|---|---|
| **A** 导航改意图分类法 | ✅ 已确认 | **降级为 Hypothesis** | 推导依据（"WMI 协议分类法"）是事实错误；"用户原话"是臆造证据 |
| **B** 模式升格为全局主控轴 | ✅ 已采纳 | **推翻** | 领域模型不存在（§6）；且当前实现是 fire-and-forget 乐观更新 |
| **C** 审计台 + 刻度条为一等公民 | ✅ 已选定 | **降级** | 技术前提大部分不成立（§4.4、§8）；刻度条推导不成立（§12） |
| **D** 暗色承载身份 | ❌ 已否 | 维持已否 | 深浅同病 |
| 「深浅同病 → 问题纯粹在结构层 → IA 是唯一出路」 | 结论 | **降级为**：换主题不是充分解 | 逻辑跳跃，不能排除视觉层/内容模型/数据状态/交互模型 |

**唯一维持 Decision 级的**：不换技术栈、不动协议层与硬件安全架构、保留温度语义色阶、保留动效克制原则。

---

## 6. 领域模型：必须先分离的七个概念（**当前最大阻塞**）

"模式"在当前代码里至少是**四种不同概念**：

| 概念 | 真实语义 | 证据 |
|---|---|---|
| 固件性能档位 | 平衡 / 高性能 / 静音 —— **只有三档** | EC 命令 8；Fn 热键只回传三档 |
| 自定义功耗覆盖 | 开 / 关 —— 是命令 23 的**子状态**，不是固件第四档 | `bridge.ts:24-26` 注释：CustomMode=3 是**本地逻辑态**；`PerformanceModeController.cs:20` |
| CPU 配置预设 | Default / Performance / Saving / Custom —— 是**持久化配置块**，≠ 当前硬件状态 | `CPU.vue:35` |
| Windows 电源计划 | 可选联动的**副作用**，可能失败且不阻止固件切换 | `App.SyncWindowsPowerPlan` |

必须分离的正式状态对象：

- `ObservedFirmwareMode` —— 从固件/热键**观察**到的档位
- `CustomPowerOverride` —— 命令 23 子状态
- `SelectedConfigProfile` / `AppliedConfigProfile` —— **必须分开**（选了 ≠ 应用了）
- `WindowsPowerPlanState` —— 独立、可失败
- `FanPolicy` —— 自动 / 曲线（2026-10-06 前还有「手动接管」，随功能删除，见 §14.9），有独立状态机
- `GPUPerformancePolicy` —— 锁频、输出模式（可能需要重启）

**在 UI 讨论"模式"代表什么之前，这七个必须先在代码里分开。** 三者不可混用：预设、硬件观察值、待应用配置。

---

## 7. 状态真实性契约

### 7.1 读数必须四态（不是布尔）

`ok` / `stale` / `unavailable` / `error`。

- `ok` —— 本次成功读取
- `stale` —— 保留最后一次有效值，并**明确标注过期**
- `unavailable` —— 通道不存在（如无独显）
- `error` —— 读取失败

**硬规则：读取失败不得显示为真实 0。** 过期值必须标注，不得静默沿用。

### 7.2 现状与差距

| 现状 | 位置 | 差距 |
|---|---|---|
| `: 0` / `: '0'` 兜底 | `systemInfo.ts:90-110` | 直接违反上条 |
| `if (fSpeed.Success)` | `systemInfo.ts:112` | **唯一正确写法**，应推广 |
| 8s 超时 | `bridge.ts:351` | **只拒绝前端 Promise，不取消已进入 WebView2/COM/宿主的调用。** 它限制的是"前端等待时间"，不是"宿主队列的真实上界" |

### 7.3 监测调度必须统一（前端 + 宿主两侧）

前端：每通道最多 1 个在途 · 隐藏时暂停 · 失败退避 · 四态区分 · 静态/动态不同刷新策略 · 保留最后有效值。
**宿主：若无法取消，就必须限制新请求进入。** 仅靠前端超时不构成上界。

### 7.4 验收方式

**长时间 soak test**：观测调用数、计时器数、内存、WebView 响应是否随运行时持续增长。

---

## 8. 写入操作模型（替代「回滚」）

### 8.1 统一操作事件模型（先定义模型，再决定 UI 形态）

| 字段 | 说明 |
|---|---|
| `source` | 用户 / 启动恢复 / 自动风扇 / 温控看门狗 / Fn 热键 —— **来源不同，权限与提示不同** |
| `transport` | WMI / EC / SMU / NVAPI / `powercfg` / 配置 |
| `requestedValue` | 用户**想设置的值** |
| `preRead` | 写入前原值，**以及它是否可靠可读** |
| `commandAccepted` | 命令是否被接受（**不等于**写入生效） |
| `postRead` | 写入后重读值，**以及是否存在可靠 getter** |
| `reversible` | 是否可安全逆转 |
| `compensation` | 安全补偿动作是什么 |
| `steps[]` | 复合操作中每一步的结果 |
| `partialApplied` | 当前是否处于部分应用状态 |

### 8.2 可逆性分级 —— 禁止万能撤销

| 等级 | 例子 | UI 允许的措辞 |
|---|---|---|
| **A 可安全逆转** | Logo 灯（有 getter + setter；2026-10-06 前举例是「键盘颜色」，该功能已删） | 「撤销」 |
| **B 只能重新应用** | SMU 限制（原值未必可读） | 「改回 …」 |
| **C 只能恢复默认/自动** | 风扇曲线接管（2026-10-06 前是「手动接管」） | 「交还 EC 固件温控」 |
| **D 需要重启** | GPU 输出模式 | 「重启后生效」+ 重启引导 |
| **E 不可逆** | （如有） | 前置二次确认，**不得提供撤销** |

**硬规则：只有 A 级才允许显示「回滚」。**

### 8.3 复合操作的真相

| 页面 | 现状 | 后果 |
|---|---|---|
| CPU | **顺序写 7 项**（自定义状态/温度墙/长时功耗/短时功耗/频率/睿频/SMU） | 中间失败 → **前面已生效** |
| （键盘） | 颜色与亮度曾**并行**发送（`pages/KeyBoard.vue`，2026-10-06 整页删除） | 历史上会出现"一个成功一个失败 → 部分应用"；该页已不存在 |
| GPU | 输出模式可能需重启 | 立即反馈是假的 |

必须**逐项报告**成功 / 失败 / 跳过，并显式暴露「部分应用」状态。

### 8.4 「回读校验」的真实约束（A 线发现，见 §4.5）

- 写响应回显**不可用**作校验依据（命令 23 合法不回显，硬比对会把成功写成失败）
- 校验 = **写后独立重读**
- 无可靠 getter 的参数 → 只能标注「**仅命令确认，不可回读**」
- **不得**把「命令已接受」渲染成「已生效」

### 8.5 「最近活动」≠「审计账本」

- 名称降级为「**最近活动**」
- 必须分三层：**用户意图级历史** / **复合操作步骤** / **底层诊断日志**
- 环形缓冲（建议 200 条）**只承载第一层**；第二层随操作存活；第三层走现有 Logger
- **不得**让自动风扇 / 看门狗的底层写入冲掉用户操作

### 8.6 两道闸门的位置

| 层 | 现状 | 目标 |
|---|---|---|
| 前端 | `ZERO_UNWRITABLE` 硬编码在 `RyzenSmu.vue` | 抽为**单一** `writeGate`，全部 setter 收口 |
| Server | `HwWriteGate`：命令白名单 + 值域 + 每命令令牌桶 + 全局令牌桶 | **保持并扩展**：SMU setter 全部纳入值域校验 |

**前端不得是唯一防线。**

---

## 9. IA：两个候选，先验证、不实现

> **A 线立场：拒绝用一个未经验证的方案替换另一个未经验证的方案。**
> v3.1 的纯意图式 IA 已被推翻（§5），B 线的混合式仍自标为"待验证候选"——所以两者都只是候选。

### 候选 1 · 硬件领域型（现状改良）
一级导航：概览 / 性能 / 散热 / 灯效 / 高级 / 系统（原文写于 2026-10-05；灯效页已于 2026-10-06 删除，实际一级导航为 6 项：概览 / CPU / GPU / 风扇曲线 / SMU / 系统 —— 见 §14.10）
- CPU、GPU 作为「性能」页内的**稳定分区**
- SMU 归入「高级」，不作为一等入口

### 候选 2 · 混合型（B 线提出）
在候选 1 之上，**首页**提供高频意图入口与推荐方案（静音 / 平衡 / 性能 / 续航）。
意图入口是**快捷方式**，不是独立一级页面。

### 候选 0 · 纯意图型（v3.1 原方案）—— **淘汰**
淘汰理由：无法回答「散热与噪声同时拥有风扇控件，谁有提交权、如何同步」；
且其推导依据（"WMI 协议分类法"）是事实错误（Fan=EC / SMU=PawnIO / GPU=NVAPI，详见 §0）。

### 验证方法（不是投票）

- 低保真原型 + 两项任务集
- **真实目标用户**，记录：路径、犹豫点、错误入口、对结果的理解偏差
- **不要只问"喜欢哪个"**
- 判据：任务完成率、错误次数、是否理解「已生效 vs 已发送」

### 迁移约束（A 线发现，**必须前置**）

`stores/index.ts:21` 用**数组下标**持久化当前页 —— **IA 一改，老用户恢复到错误页面**。
改 IA 之前必须先把 page id 换成**稳定字符串 ID**，并做旧值迁移。

---

## 10. 操作分类法（替代「统一三段式」）

v3.1 一边推翻"每页三段式"，一边又规定"每页统一三段"——自相矛盾。
正确做法是**先分类操作，再决定组件**：

| 类别 | 例子 | 交互模型 |
|---|---|---|
| 即时且可逆 | 灯光颜色 | 即时预览 + 显式保存 |
| 即时但有风险 | 风扇曲线接管（2026-10-06 前含「手动接管」） | 「交还 EC 固件温控」常驻可达 |
| 暂存后提交 | CPU 多参数 | 待应用集合 + 批量提交 + 逐项结果 |
| 多步骤复合 | CPU 保存配置 | 逐步结果 + 部分应用状态 |
| 需要重启 | GPU 输出模式 | 重启引导，**不得伪装即时成功** |
| 自动策略接管 | 风扇曲线 / 看门狗 | 必须显示「当前由谁控制」 |
| 只读监测 | 遥测卡 | **无提交区** |

---

## 11. 第一个垂直切片：散热 / 风扇

**为什么是它**（A 线截图证据 + B 线判据）：

- 它是**全站唯一层级做对的页面**（`1500 RPM` 的大字号）→ **有基准可比**
- 同时具备：清晰状态 · 危险操作 · 自动/手动策略 · 读取失败 · 崩溃恢复（`EcGuard`）
- 覆盖面最广：新壳、新状态模型、新提交反馈、最近活动记录，**一次全验**

**切片必须验证的七项**：

1. `FanPolicy` 状态机（自动 / 曲线 —— **当前由谁控制**；2026-10-06 前还有「手动」，见 §14.9）
2. 四态读数（ok / stale / unavailable / error）；风扇 RPM 读取失败**不得显示 0**
3. 危险操作确认 + 「交还 EC 固件温控」常驻可达（原「恢复自动控制」）
4. 提交反馈：逐项结果 + 部分应用状态
5. 最近活动记录（含来源标注）
6. DPI 矩阵下的可达性（含 §3.2 的窗口最小尺寸问题）
7. soak test：计时器数 / 在途数 / 内存不持续增长

**通过之后**再推广到 CPU / GPU / SMU —— **不是一次重建五个页面**。

---

## 12. 视觉与动效（降级为观察，**未到冻结阶段**）

**维持（Decision 级）**：不换技术栈 · 温度语义色阶 + 滞回（`temperature.ts` 为**唯一权威源**）· 读数零过渡 · 时长上限 250ms · 禁装饰循环 · `:focus-visible` · reduced-motion 全局覆盖。

**降级为待验证（v3.1 曾写成"要求"）**：

| v3.1 要求 | 问题 |
|---|---|
| 「温度/功耗/转速/噪声统一零点、分档、阈值」 | 各量纲语义不同：温度有明确危险阈值；使用率 100% 不一定危险；CPU 功耗合理区间取决于模式与机型；电压不是"越高越危险"；**噪声是 RPM 插值估算，不是声压测量** |
| 「`box-shadow: inset` 解决 DPI 发丝线」 | **未证明彩边成因**（半透明边框？相邻表面？transform？合成层？WebView 缩放？）。且 `inset box-shadow` 与 `border` 同为 CSS px |
| 「内容不足时，刻度条本身提供结构」 | 与"版面按内容分配、不按网格分配"**自相矛盾** |

**正确原则**：**统一组件语法，不统一各量纲的业务含义。**
每量纲的取值范围与阈值必须**可追溯**；无安全阈值的指标不强行分红黄绿；温度**直接复用** `temperature.ts`，**不得复制阈值**。

**`scale.ts` 的处置**：A 线本次新写的 `Client/src/utils/scale.ts` 与 `temperature.ts` **分档冲突**（70℃ 恰好落在两侧）且**丢失滞回**（`tempLevelHys` 的存在正是为了防止温度抖动引发的持续闪色），并自称"唯一权威源"却含两个"待真机确认"量程。
→ **降级重写**：只保留"统一组件语法"部分；温度完全委托 `temperature.ts`；其余量纲在领域模型确立后逐个补来源。**不得作为权威源。**

**DPI / 窗口验收（必须扩展）**：100/125/150/175/200% × 完整窗口可达性 × Windows 文本缩放 × 标题栏按钮 × 长文本与错误消息 × 页面滚动 × 键盘焦点 × 底部操作区不被遮挡。
**前置问题**：`MainWindow.xaml` 写死 1300×820 最小尺寸 —— **1080p@150% 与 2560×1600@200% 均装不下**。

---

## 13. 阶段顺序与 Definition of Done

| Phase | 内容 | 门禁 |
|---|---|---|
| **0 · 恢复可信基线** | 核对 42 项工作树；**P0 稳定性修复单独成一次提交**（不跟计划一起作废）；修复或删除失效文档引用；截图建立证据清单（文件名/提交号/主题/DPI/窗口尺寸/硬件状态）；v3.1 正式改标 Draft | 基线可复现 |
| **1 · 状态真实性与安全边界** | 读数四态化；统一前端+宿主的监测调度（在途/退避/可见性/上界）；SMU setter 的 **Server 侧**范围校验；复合写入逐步结果模型；明确哪些操作可得后读 | 无"失败渲染成 0"；soak test 通过 |
| **2 · 领域模型** | 分离 §6 的七个状态；定义各自权威来源；定义 Fn 热键 ↔ UI 同步规则；**决定"模式"是选择器还是观察值** | 状态模型评审通过 |
| **3 · 验证 IA（不实现）** | 候选 1 / 候选 2 低保真对比 + 真实用户任务测试 | 任务数据支持 |
| **4 · 单个垂直切片** | §11 散热/风扇，全机制跑通 | §11 七项全过 |
| **5 · 审计/活动形态** | 先实现统一操作事件模型，**再**判断它是抽屉、系统页历史、还是失败时诊断 | **不预占一级导航** |
| **6 · 视觉与动效收口** | 到此时才冻结：刻度组件 / 图表范围 / 色彩编码 / DPI 方案 / 模式切换动效 / 密度与空态 | — |

### 主 DoD（替代 v3.1 的四项）

| 维度 | 判据 |
|---|---|
| 用户任务 | 目标用户在无指导下完成：降低噪声 / 恢复自动风扇 / 切换性能模式 / 设置功耗限制 / 恢复默认 |
| 对照基线 | 完成时间、错误次数、错误入口、是否理解结果 —— 与当前版本对比 |
| **状态真实性** | 任何读取失败都不显示为真实 0；过期值明确标注 |
| **模式同步** | Fn 热键 / 应用内切换 / 启动恢复三条路径最终一致；失败不留虚假激活态 |
| **复合写入** | 逐项报告成功 / 失败 / 跳过 / 部分应用 |
| **安全边界** | 所有 SMU setter 在 **Server 侧**有范围校验与测试；前端非唯一防线 |
| 资源稳定性 | soak test：在途数、计时器数、内存、WebView 响应无持续增长 |
| DPI / 窗口 | 目标分辨率与缩放矩阵下所有操作可达 |
| 可访问性 | 键盘导航、焦点顺序、焦点可见、对比度、reduced motion |
| 自动化 | 完整 `build` + 完整 `lint` + 前端关键状态测试 + 后端边界测试 + 真机集成测试（**当前：build 不含 lint/test，前端测试为零**） |
| **迁移** | page id 改为稳定字符串 ID + 旧值迁移（§9） |

---

## 14. 未决问题与用户答复（2026-09-17）

### 14.1 已答复（Decision 级）

| # | 问题 | 答复 | 状态 |
|---|---|---|---|
| 1 | "模式"代表预设选择器还是硬件观察值？ | **预设选择器** | ✅ 已决策 |
| 2 | Fn 热键的第四档是什么？ | 用户陈述：三档 = 办公 / 游戏 / 狂飙，第四档 = 自定义 | ⚠️ **与代码冲突，见 §14.2** |
| 3 | `installer/Output/*.exe` 的删除是否有意？ | **是有意的**，旧构建产物无需关注 | ✅ 已确认，不再阻塞 |

> **答复 1 是 Decision 级**，它直接决定了 §6 的领域模型形态：`SelectedConfigProfile`
> （我选了什么）与 `ObservedFirmwareMode`（硬件实际在哪档）**必须分离**。

### 14.2 答复与代码的两处冲突（**Phase 2 必须解决，不得直接采信任一方**）

**冲突 A — 当前实现不是预设选择器，而是"固件档位 + 自定义叠加"的观察值**

`PerformanceModeController.Get()`（`:13-29`）：

    var mode = GetValue<SystemPerMode>(MethodName.SystemPerMode);   // 固件真实档位
    if (mode is Balance or Performance or Quiet) {
        var custom = GetValue<CPUPower>(MethodName.CPUPower);
        if (custom == OpenState) mode = CustomMode;                  // 叠加成第 4 档
    }

→ 胶囊现在展示的是**观察值**。切换为「预设选择器」语义意味着 **`Get()` 与胶囊的语义都要改**，
   且必须落实 §6 的三分离：`SelectedConfigProfile` / `AppliedConfigProfile` / `ObservedFirmwareMode`。
→ 附带风险：`Home.vue:49-58` 的 `setMode()` 是 **fire-and-forget 乐观更新**。
   观察值语义下尚可勉强，**预设选择器语义下必然产生虚假选中态**（违反第一性原则 2）。

**冲突 B — Fn 热键物理上切不到「自定义」**

`HotkeyController.cs:145` 明文：

    // 命令 8 只有三档; 3=自定义 是本项目的本地逻辑态, 固件不会回传
    if (mode != BalanceMode && mode != PerformanceMode && mode != QuietMode) {
        Logger.Warn($"热键事件携带未知档位 {mode}, 已忽略");

→ **固件只回传 0/1/2，热键路径显式拒绝 3。** 你陈述的「Fn 切到第四档自定义」**当前不可能发生**。
→ 需你二选一：
   **(a) 描述现状** → 与代码不符，代码是对的；UI 只能通过胶囊切自定义。
   **(b) 提出目标** → 需要改造：Fn 第四档由软件层模拟（在 `MirrorPerformanceMode` 里叠加命令 23 状态），
                         属于**新功能**，不是现状。

**未决的命名映射**：你给的档位名（**办公 / 游戏 / 狂飙**）与代码里的（**静音 / 平衡 / 高性能**）
需要一张正式映射表。**猜测不可接受** —— 请在 Phase 2 前确认。

### 14.3 2026-09-17 续答（Decision 级，自用机主）

| # | 问题 | 答复 | 状态 |
|---|---|---|---|
| 2′ | Fn 第四档 | **不做**。只留三档：办公 / 游戏 / 狂飙 | ✅ 已决策；与代码冲突 B 的 (a) 一致 |
| 4 | 目标用户 | **仅机主自用** | ✅ Phase 3 不另招受试；IA 维持硬件领域型 + 稳定 page id |
| 5 | CPU 睿频上限 | **最大 5.4 GHz** | ✅ 滑条/出厂默认已对齐 5400 MHz |
| 6 | SMU 可靠 getter | **目前不清楚** | ✅ 全部 SMU 限制按「仅命令确认，不可回读」 |
| 7 | 目标 DPI / 分辨率 | **2560×1600 · 150% · 240Hz**（逻辑约 1707×1067） | ✅ 当前最小窗 1300×820 装得下，不下调 |

命名映射（正式）：**办公 = QuietMode(2)** · **游戏 = BalanceMode(0)** · **狂飙 = PerformanceMode(1)**。

### 14.4 2026-09-24 · SMU 页版式改版（**Decision**，机主自用）

| 项 | 内容 |
|---|---|
| 决策 | SMU 页从「协议清单序」改为「任务序」：**曲线偏移置顶并独立成提交单元**；温度墙第二并独立提交；功耗/电流、时钟与逐核、名词解释**默认收起** |
| 负责人 / 日期 | 机主 · 2026-09-24（自用工具，Phase 3 验证按 §14.3 #4 豁免） |
| 依据 | 机主自述使用事实：**只调全核曲线偏移，其他设置很少动**；代码证据 `RyzenSmu.vue:101`（旧实现把全核 CO 并进「时钟与超频」组，唯一提交按钮叫「应用时钟组」，而控件本体是只读卡样式 = 假只读）；截图证据 `.visual-qa/default/smu-dark.before.png` vs `.visual-qa/smu-dark.png`（1440×900，改后三个高频单元 + 三个收起区**单屏可容纳**） |
| 反证条件 | 出现「以为已应用、实则未下发」；或展开态到达逐核编辑的步数增加 → 推翻「默认收起」 |
| Implemented | `19d9a04`：`RyzenSmu.vue`（曲线/温度墙独立组 + 重置）、`CollapsibleSection.vue`（新机制，**摘要承载状态**：未读取 N / 待应用 N / 无改动）、`ApplyBar.vue`（可选 reset-label，其余页面零影响） |
| 明确不做 | SMU 限制值回读（属 Phase 1 欠账，见 §14.3 #6）；为**没有默认值**的 10 项限制参数（功耗 6 + 电流 4）编造「系统默认」；重置只做「改表单 + 存配置，不下发硬件」（与 `CPU.vue:184` 既有语义一致） |
| 温度墙 99 ℃ | 是**应用推荐值**，不是从固件读回的默认值 —— 页面内已如此标注，并注明风扇 98 ℃/10s 保守护栏会先于它动作 |

> **收起机制的硬约束（后续复用必须遵守）**：折叠标题必须自带状态摘要。本页正文里的「未读取 / 待应用 / 被闸门跳过」一旦被收起来而不上浮，就等于把「其实没下发」藏起来，违反第一性原则 1。

### 14.5 2026-09-24 · 模式领域模型收口（**Decision**）

| 项 | 内容 |
|---|---|
| 事实核对 | v4 §6 的「七个概念」中，**四个已落地**：ObservedFirmwareMode / CustomPowerOverride / SelectedMode（我选了什么）/ FanPolicy —— 均在 `stores/mode.ts`、`stores/fan.ts`。§14.2 冲突 A 点名的「Home.vue 乐观更新」风险在 store 落地后已消除 |
| 决废除 | `SelectedConfigProfile` / `AppliedConfigProfile`：CPU「均衡/性能/节能/自定义」四方案表已合并为唯一 `Cpu.Custom`（`types/config.ts:32`、`JiaoLongConfig.cs:84`），该轴不存在，类型已删 |
| 决定不做 | `WindowsPowerPlanState` / `GPUPerformancePolicy`：**不为未落地的概念声明空类型**。电源计划只保留「是否联动」开关（设置页）；GPU 锁频与输出模式由 GPU 页、显卡直连设置页各自管理。真要做时连同权威来源一起补进 §6 清单 |
| 切档成功判据 | 「命令被接受」**不等于**已生效。判据改为：写后独立重读，且回读到的观察值与本次请求一致（`observedFirmware === 请求档位 && !customOverride`，自定义则看 `customOverride`）。**不得用 `activeKind` 判定** —— `select()` 期间 `syncing` 恒为真，`activeKind` 恒为 `'pending'`（旧代码的 `activeKind === 'pending'` 分支因此恒为真）|
| 失败必须被看见 | 首页胶囊此前失败只回滚、无提示。现在：消费 `select()` 返回值 → `Message.error(lastError)` + 该档位 3 秒错误态；`observedState` 非 ok 时标注「读数过期 / 档位未知」 |
| Implemented | `domain/modes.ts` 收口、`stores/mode.ts` 判据、`pages/Home.vue` 失败可见、`stores/__tests__/mode.spec.ts`（9 条） |

### 14.6 2026-09-24 · 收尾核对（阶段与主 DoD 逐条）

**阶段**

| Phase | 状态 | 依据 |
|---|---|---|
| 0 恢复可信基线 | 已达成 | P0 修复独立提交 `f2eba86`；v3.1 标 Draft；截图 harness 旁挂 provenance manifest |
| 1 状态真实性与安全边界 | **已达成** | 读数四态化（reading.ts / 各页 ReadingState）；统一调度 PollingChannel；SmuWriteGate + ProtocolCodecTest 10 条闸门用例（CI 跑）；复合写入逐步结果 CompositeSteps；「哪些操作可后读」已裁定（SMU 限制不可回读，§14.3 #6） |
| 2 领域模型 | **已达成**（§14.5 收口） | stores/mode.ts 三分离 + stores/fan.ts FanPolicy；未落地概念不声明空类型 |
| 3 验证 IA（不实现） | 按决策豁免 | §14.3 #4：仅机主自用，IA 维持硬件领域型 + 稳定 page id |
| 4 单个垂直切片（风扇） | 代码已达成；第 7 项待真机 | `ca4a4c8`：FanPolicy「当前由谁控制」/四态转速/危险确认/恢复自动常驻/最近活动；**soak test 未做** |
| 5 审计与活动形态 | 已达成 | ActivityDrawer 抽屉 + 标题栏入口，未预占一级导航 |
| 6 视觉与动效收口 | 部分 | 令牌、时长上限 250ms、reduced-motion 已落地；utils/scale.ts 已按 §12 降级重写但**零消费点**；DPI 矩阵与刻度冻结待真机/待决策 |

**主 DoD**

| 维度 | 状态 |
|---|---|
| 状态真实性 | 已达成：读取失败不渲染 0；「未读取」/「读数过期」/「档位未知」三处显式标注 |
| 模式同步 | 已达成：Fn 热键 / 应用内切换 / 启动读取汇入同一 store；失败不留虚假激活态（§14.5 判据） |
| 复合写入 | 已达成：逐项成功/失败/跳过/部分应用 |
| 安全边界 | 已达成：SMU 全部 setter（18/18）在 Server 侧值域校验，10 条 CI 用例 |
| 资源稳定性 | **待真机**：soak test（计时器 / 在途数 / 内存） |
| DPI / 窗口 | **待真机**：目标 2560×1600@150% 已确认，未逐项验收 |
| 可访问性 | 部分：:focus-visible、aria、键盘可达已覆盖；未做逐页焦点顺序验收 |
| 自动化 | 已达成：前端 format:check + lint + **vitest（本次补进 CI）** + build；后端 build + 协议/闸门用例 |
| 迁移 | 已达成：page id 稳定字符串 + 旧值迁移 |

**明确不做（Decision）**：SMU 限制值回读（需传输表协议 + 真机逐 family 验证，见 KNOWN_ISSUES 24）。

**逐核值的跨重启处理（Decision 2026-09-24）**：写进 `config.yaml`（`Smu.PerCoreCurve` /
`Smu.PerCoreOcClk`）并在重启后填回表单，但**不在启动时自动下发** —— 16 核 × 2 参数 = 32 条
SMU 命令的无人值守开机写入，手误会被每次开机重放。要生效仍需用户在 SMU 页点「应用逐核设置」。；为未落地概念声明空类型（§14.5）。

**待真机清单**（本环境只能出图，不能验行为）：soak · DPI 矩阵 · 键盘焦点顺序 · 模式失败路径演练（KNOWN_ISSUES 23）· 0.1.4 风扇改动的听感验收 · 电池 DC 场景 · Windows 10。

---

## 附录 A · 反模式清单（出现即算失败）

紫罗兰主色 · 玻璃拟态 · 径向光晕 · `neon-*`/`cyber-*` 命名 · 假波形 / 假 ECG · 无限脉冲 · 大圆角卡片墙 · hover 上浮 + 辉光 · `transition: all` · 渐变 CTA · 把读取失败渲染成 0 · 每滑条一枚「应用」按钮 · 纯装饰的进度条 · 用散文承担控件该承担的说明 · 径向对称的"鳞"

**流程级反模式（v3.1 犯过的）**：把 Hypothesis 写成 Decision · 用未经验证的方案替换另一个未经验证的方案 · 编造证据 · 万能撤销按钮 · 未定位根因先锁定技术解法

## 附录 B · 资产与风险

| 项 | 状态 |
|---|---|
| 温度语义色阶 + 滞回（`temperature.ts`） | **保留，唯一权威源** |
| 写入安全流（`HwWriteGate` 令牌桶 / `EcGuard` 心跳） | 保留；但其"审计"只是 debug 日志，**不得据此宣称已有审计** |
| `ControlModule` / `ApplyBar` / `useApplyState` / `PageShell` | 保留为**机制**；其**编排**待 Phase 3 决定 |
| `bridge.ts` 超时/去重、`RyzenSmu.vue` 泄漏与闸门 | **已修，勿回退** |
| `scale.ts` | **降级重写**，不得作为权威源 |
| 42 项工作树 | **按逻辑单元拆分提交**，不做"大冻结提交" |
| `Client/src` 曾被并发进程清空两次 | 整文件原子写入 → 构建通过 → 同一命令链内提交 |
| `.codegraph/` 索引（93 文件 / 2,097 节点） | 已建；需提交其 `.gitignore` 或加进 `LongCore/.gitignore` |

## 附录 C · 本方案明确否定 v3.1 的那些条（防第四轮重犯）

1. 把"用户原话"当证据 —— **禁止编造证据**
2. 把"推翻某个设计"的理由建立在一个**未核实**的分类学断言上
3. 从 A 推 B 时跳过中间环节（"深浅同病" → "IA 是唯一出路"）
4. 一边推翻某种模式，一边在别处重新引入同一种模式
5. 用一个未经验证的方案替换另一个未经验证的方案
6. 把"独特性"当作产品价值证明
7. 未定位根因就先锁定技术解法
8. 在领域模型不存在时先建**全局脊柱**

---

### 14.7 2026-10-05 · 已应用功能看板与「可逆性门禁」（**Decision**；本节按要求追加在文末）

**Decision（负责人：实施者（AI），2026-10-05）**
概览页下半页新增「已应用功能」看板：每行两栏 —— **意图** = `Config.GetConfig()` 读到的 `config.yaml` 字段路径，
**实测** = 桥接 getter 的回读值；两者不一致时显式标出「配置开着·硬件没写进去」。逐行「移除」+ 页内「全部还原」，
让「软件改过哪些硬件、还生不生效、能不能退出」第一次可以看见。
唯一真源 `JiaoLongControl/Client/src/domain/appliedFeatures.ts`（当时 **50 项**，**2026-10-06 为 45 项**，见 §14.9/§14.10：意图路径 / 回读方法 / 可逆级别 a–e / 有序移除步骤 / 结论+理由；
2026-10-06 先由 50 项删去 `fan.manual-speed`（§14.9）、再删去 4 个键盘项（§14.10）），
组件只遍历注册表，不做任何功能清单硬编码。

**依据**
1. 本轮任务书硬规则 + §2 第一性原则 1（用户必须能区分「我想设置的值」/「命令已发送」/「硬件实际值」）。
2. §7.1 状态真实性契约：读不到写「不可回读 / 读取失败」，**不得回退 0/false**。看板对 33 项无可回读接口的项如此处理。
3. §8.2 可逆性分级 + `Client/src/domain/operations.ts:21-29` 的五级定义 —— 本轮把它从「日志标签」变成**真门禁**：
   回读方法 = `null` 或级别 = `e` 的项禁止挂可点的「移除」，只能显示「无法还原 + 原因」。
4. §8.4 回读校验约束：命令被接受 ≠ 已生效。移除步骤走既有的 `composables/useCompositeWrite.ts`，
   末尾追加显式「复核：独立重读 `<getter>()`」步骤；回读失败即判 failed，界面只能说「未确认移除成功」。
5. Observation（本轮实测）：各页「重置」语义不一致 —— `pages/CPU.vue:184-194` 与 `pages/RyzenSmu.vue:363-372` 只改表单+存盘、
   **不下发硬件**；`composables/useFanCurveEditor.ts:399-466`（曲线页「交还 EC 固件温控」；2026-10-06 前为已删除的 `pages/Fan.vue:119-126`）
   与 `pages/GPU.vue:308-337` 真下发。同一个词两种含义是本轮的直接动因。
6. Observation（本轮 grep，全仓 26 处 `reversible:'x'`，`src/` 内 22 处）此前**没有任何按钮**消费该分级。

**反证条件（Reject if）**
- 真机上任一行的回读值与硬件实况不符（getter 口径不对）→ 该行必须换 getter 或降级为「不可回读」，不得保留错误结论。
- EC 若提供手动转速掩码查询命令 → 该问句随「风扇手动设定风速档位」于 2026-10-06 删除而**失去对象**：
  注册表里 `推断（inferred）` 已归零，`fan.manual-speed` 行不存在（见 §14.9）。将来若重新引入手动档位，本反证条件随之复活。
- 若看板在真机上「读取失败」频次高到无法使用（每次刷新并发 17 次 getter），则必须先补 getter / 加刷新门禁，再谈「一键还原」。
  → **2026-10-05 已补门禁**（`loading` 期间禁用「重新读取」+ `refresh()` 在途去重，见 §14.8 FIX-6）；真机频次行为仍未验证。
- 「全部还原」若在真机上出现"漏了正生效的项"或"动了别的工具设的值" → 覆盖判据必须回到注册表逐项复核（§14.8 FIX-1 已按此改）。

**边界（本轮刻意不做）**
- 只出结论不删功能：`HomeCardType` 仍 8 项（`stores/index.ts:51-66`）、`PAGE_IDS` 未变（`stores/pageIds.ts:6-15`）；
  `cut` 只作为看板标签与 `docs/功能必要性与架构梳理.md` 的结论存在。
  → **2026-10-06 部分取代**：机主拍板删除「风扇手动设定风速档位」，`HomeCardType` 8 → 7 项（`stores/index.ts:50-64`）、
  `PAGE_IDS` 8 → 7 项（`stores/pageIds.ts:6-14`）；`Server` 侧只删了 `FanSection.ManualFanSpeed` 一个字段。见 §14.9。
- `Server/**` 的 C# 源码零改动（唯一例外：`RyzenSmuControllerTest/RyzenSmuControllerTest.csproj` 补 `Compile Include` 修既有编译红灯，未改任何 `.cs`）。
- 未实现 SMU 回读（KNOWN_ISSUES 第 24 条），20 个 SMU 项在看板上恒为「不可回读」。

**Implemented**
- `c24d03f` feat(client)：注册表 + 看板 + 28 个用例（含反向验证：让 getter 失败 → 该行显示「读取失败」，移除只报「未确认移除成功」，
  全文不出现「已移除」）。
- `9d01a64` fix(test)：探针工程补齐编译依赖（SmuWriteGate / LogRuntime / Models / YamlDotNet），0 错误。
- 逐条功能必要性结论与证据见 `docs/功能必要性与架构梳理.md`（计数逐时点实测：`c24d03f` **50 项**：keep 39 / review 5 / cut 6；
  `72b1325` 49 项：38/5/6（删 `fan.manual-speed`，§14.9）；`e00e218` **45 项：keep 36 / review 3 / cut 6**（再删 4 个键盘项，§14.10））。
- `714b249` fix(client)（复查整改，见 §14.8）：`observedActive` 一等字段 + 覆盖范围说明 + 移除判据自洽 + 文案去重 + 刷新门禁。

**Verified（独立证据）**：`npm run test` 9 文件 / 60 通过 / 0 跳过（`c24d03f` 时点）；截图 `JiaoLongControl/Client/.visual-qa/home-dark.png`、
`home-dark-bottom.png`（mock 桥，含一行「配置开着·硬件没写进去」与 `--fail-readback` 的失败态）。
**未 Verified**：真机硬件行为（本轮无真机复现，见该文档 §8）。

---

### 14.8 2026-10-05 · 看板覆盖判据整顿（**Decision**；§14.7 独立审查后的 FIX-1~6）

**Decision（负责人：实施者（AI，复查整改），2026-10-05；依据：§14.7 的独立审查结论 + §7.1 状态真实性契约 + §8.2/§8.4）**

§14.7 的看板被判定「有条件通过」：**「全部还原」既漏正生效的项，又误收本软件从未写过的项**（假绿），
另有 3 行的「移除」结构上永不成功（恒定假红）。本节记录整顿后的判据，取代 §14.7 中与之冲突的表述。

**Decision 内容**

1. **「硬件当前是否真的生效」是一等字段**，不再靠 `status` 白名单反推。
   `FeatureVerdict.observedActive: boolean | null`：`readback === null` 或回读非 `ok/stale` → `null`（**不知道**），
   否则 `evalRule(observedRule, picked)`。
2. **「全部还原」三条同时满足才收**：`canRemove` **且** `writePath !== null`（本软件确实下发得出去）
   **且**（`observedActive === true` **或**（`observedActive === null` **且**配置意图明确为开））。
   最后一条保留了「一次读取失败不该卡住用户」的既有口径。
3. **覆盖范围必须在界面上说清**：新增纯函数 `removalScope()` 把「覆盖 / 非本软件下发 / 当前未生效 /
   没读出生效值 / 本行不给移除」算成数据；按钮 `title` + `aria-label` + 表头下一行说明**逐项列出**，不许只报一个数字。
4. **「移除」判据必须与恢复动作自洽**：`cpu.turbo` 的「已生效」改为「限制被施加」
   （`equals:false`，行名「关闭睿频（Turbo 限制）」）；`keyboard.color` / `keyboard.brightness` 没有可证明「已还原」的
   回读判据 → `removalConfirm: 'command-only'`，文案「仅命令确认，未确认已恢复」，**不渲染成失败态**。
   新增普查用例：13 个有「移除」按钮的项，移除后要么 `judgeRemoval === true`，要么明确 `command-only` —— 不允许存在"永不成功"的项。
5. **文案不重复**：33 个不可回读行的原因只留在「实测」栏（`不可回读 · <原因>`），状态栏不再重复同一段长文。
6. **先算后提交**：配置移除步骤改为改克隆副本、保存成功才让共享对象变成新值；失败回滚显示值并强制重拉配置。
7. **刷新要有上界**（不引入新机制）：`loading` 期间禁用「重新读取」+ `refresh()` 在途 Promise 去重。
   §14.7 的反证条件「若读取失败频次高到无法使用 → 必须先加刷新门禁」到此已落实，但真机频次仍未验证。

**依据（Observation，可复现）**

- 旧 `bulkRemovalPlan()` 的白名单 `['match','mismatch','hardware-only','no-write-path']` 不含 `observed-only`：
  5 项实测正开着却漏出计划（`cpu.custom-override`、`keyboard.color`、`keyboard.brightness`、`keyboard.logo-light`、`system.autostart`）。
- 同一白名单无条件收 `no-write-path`：`gpu.core-offset` / `gpu.memory-offset` / `gpu.voltage-boost` 的 `writePath` 为 `null`
  （注册表自述"硬件侧的值非本软件所写"）也会进计划，点一下会执行 `NvidiaGpu.ResetClockOffsets()` /
  `SetVoltageBoostPercent(0)`，清掉别的工具（如 MSI Afterburner）设的偏移。
- 3 行恒假红：`cpu.turbo`（移除 `Power.EnableTurbo()` vs 判据 `truthy`）、`keyboard.color` / `keyboard.brightness`
  （移除写回默认值 vs 判据 `present`）。
- 现有用例只断言意图栏里有 `Fan.Enabled` 这个字符串 —— 意图栏写死也能全绿。

**Implemented / Verified（本机实测输出）**

- 用例数 **60 → 72**（9 文件 / 72 通过 / 0 跳过；新增 12 条，无 `.skip`/`.only`，未放宽任何既有断言）。
- FIX-1 复现命令：修前 `[]` → 修后 `[ 'cpu.custom-override' ]`。
- 移除普查：`714b249` 时点 14 项中 12 项可回读确认、2 项（键盘颜色/亮度）明确 `command-only`、0 项永不成功；
  2026-10-06 删掉 `fan.manual-speed` 后为 **13 项中 11 项**（见 §14.9）。
- 截图（mock 桥）：`全部还原（8 项）`，chip「不一致 1 / 读取失败 0 / 不可回读 33 / 无下发路径 5」，
  覆盖说明行逐项列出 8 项覆盖 + 4 项「非本软件下发」+ 2 项「当前未生效」+ 36 项「本行不提供移除」。
- 后端门禁：`dotnet build --no-incremental` 0 警告 0 错误；`ProtocolCodecTest` 29 通过 0 失败。
- 逐条结论与证据、以及**未做/未验证**项见 `docs/功能必要性与架构梳理.md`（§5.1 D5–D7、§7.1、§8）。

**未 Verified**

- 真机（WebView2 桥）行为：`observedActive` 的取值依赖各 getter 的真实返回结构，只在 mock 桥下验证。
- 刷新门禁（FIX-6）没有单测：并发点难以在组件用例里观测。
- 键盘颜色/亮度仍无法证明"用户原先的灯效已被还原"（`command-only` 的来源）。

---

### 14.9 2026-10-06 · 删除「风扇手动设定风速档位」（**Decision**；机主拍板）

**Decision（负责人：机主，2026-10-06）**

机主原话：「直接删风扇手动设定风速档位，之后都走自动控制或者机器档位」。风扇此后只有两种控制权：
**应用内曲线接管**（`Fan.Enabled` + `AutoFanControl` 运行中）或 **EC 固件自动温控 / 机器三档**。
「手动钉住一个固定转速」这个第三种状态从界面、配置、闸门与桥接包装里一并删除。

**依据**
1. 机主直接指示（2026-10-06）。
2. §6 FanPolicy 原本的三态（`auto` / `curve` / `manual`）里，`manual` 的控制权**只能推断**：
   EC 没有「手动掩码」getter，区分不出「固件自动」与「残留手动值」（`docs/功能必要性与架构梳理.md` H1）。
   删掉 `manual` 后 FanPolicy 收敛为两态，判定全部落在可直读的 `AutoFanControl.IsRunning()` 上，H1 随之终结。
3. 安全出口不降级：原「风扇控制」页的「恢复自动控制」挪到风扇曲线页，成为「**交还 EC 固件温控**」，
   行为反而更完整 —— 停曲线服务 → `Fan.RemoveFanSpeed` → `Fan.Enabled=false` **真落盘**，
   三步逐项报告、失败不报成功（§8.3 + §8.4 口径，复用 `composables/useCompositeWrite.ts`）。
   `stores/fan.ts` 的 `restoreAuto()` 保留为 store 侧同一出路。

**删除面（Implemented）**
- 前端：`Client/src/pages/Fan.vue` 整页删除（侧栏 8 → 7 项）；`writeGate.fanManualSpeed`；
  `utils/bridge.ts` 导出对象的 `Fan.SetFanSpeed` 包装（**`BridgeApi` 类型声明保留** —— 后端方法真实存在，
  且 `ThermalWatchdog` 在用，声明与包装本就不必一一对应，见 §O4）；`types/config.ts` 的 `FanSectionType.ManualFanSpeed`；
  `stores/fan.ts` 的 `applyManualSpeed()` 与基于 `config.Fan.ManualFanSpeed > 0` 的 manual 推断；`controllerLabel` 去掉「手动接管」。
- 注册表：删 `fan.manual-speed` 项 —— **50 → 49 项**、可移除 **14 → 13**、`推断（inferred）` **1 → 0**、
  bridge 方法名 29 → 27；`fan.curve` 的移除步骤当时是 2 步（停服务 + 清 `Fan.Enabled`），
  **`dca35c8` 补成 3 步**（停服务 → `Fan.RemoveFanSpeed` 撤 0xB20 手动掩码 → 落盘意图，见 §14.10 与 `docs/功能必要性与架构梳理.md` §5.1 D9）。
- 后端：`JiaoLongConfig.FanSection.ManualFanSpeed` 连同 `ConfigComment` / `ConfigRange` 删除（其余 C# 未动）。
  **`FanController.SetFanSpeed(byte)` 必须保留** —— `ThermalWatchdog` 过温兜底（98℃/10s 拉满 5800）靠它。
- 落点迁移（必须）：`localStorage['jl-ui-page']` 的旧字符串 `'fan'` 与旧下标 `6` 都迁到 `fan-curve`
  （`stores/pageIds.ts` 的 `LEGACY_PAGE_ID_ALIAS` / `LEGACY_INDEX_TO_ID`）；旧下标数字键 1..8 **不重新编号**。
- 截图工具：`scripts/visual-shot.mjs` 去掉 fan 页截图项与 mock 配置里的 `ManualFanSpeed`。

**反证条件（Reject if）**
- 「交还 EC 固件温控」在真机上「三步都报成功、风扇却仍由曲线控制」→ 该出口的实现或回读口径必须重做。
- 老用户升级后落点不是 `fan-curve`（被弹回概览页）→ 迁移映射有漏，必须补齐。
- 若将来重新引入手动档位 → 必须重建 配置字段 / 闸门 / 桥接包装 / 页面，并按**当时证据**重新立 H1（§14.7 的反证条件随之复活）。

**Implemented 提交**：`72b1325` refactor(client)（2026-10-06）。

**Verified（本机实测输出，`72b1325` 时点）**
- 前端门禁：`npm run format:check` / `lint` / `type-check` / `build` 全通过；`npm run test` **10 文件 / 75 通过 / 0 跳过**（删 3 条功能绑定用例、增 6 条，72 → 75）。
- 后端门禁：`dotnet build -c Release --no-incremental` **0 警告 0 错误**；`ProtocolCodecTest` **29 通过 0 失败**。
- 反向验证：`JiaoLongControl/**` 内 `ManualFanSpeed` / `applyManualSpeed` / `fanManualSpeed` **零命中**；
  `migratePageId('fan')` 与 `migratePageId('6')` 手工运行均返回 `fan-curve`。
- 截图：`node scripts/visual-shot.mjs --out=.visual-qa` 通过，日志 `nav items: 7`，不再产出 `fan-dark.png`
  （只产出 `fan-curve-dark.png`；旧残留截图已删）。

**未 Verified**：真机（WebView2 桥）行为 —— 只做了 mock 桥单测与 `scripts/visual-shot.mjs` 截图验证；
`Fan.RemoveFanSpeed` 是否真的撤掉 EC 侧 0xB20 手动掩码，仍以 `research/docs/08_硬件安全架构.md` 的既有证据为准，本轮未新增真机证据。


---

### 14.10 2026-10-06 · 删除「键盘颜色/亮度」整个功能，Logo 灯保留并换组（**Decision**；机主拍板）

**Decision（负责人：机主，2026-10-06）**

机主原话：「键盘颜色/亮度的这个功能也需要直接删除掉，我用不到」。整个「灯效」页（颜色 / 亮度 / 快捷预设 /
区域预览 / 键盘灯效模式 / 键盘渐变）连同后端 `KeyboardController` + `KeyboardGradientController` 一并删除；
**Logo 灯全链路保留**，注册表分组由 `keyboard`（标签「键盘与灯效」）改名为 `lighting`（标签「Logo 灯 / 环境光」）。

按 §1 分类法，这是一条 **Decision** 而不是 Observation：依据是机主的明确产品取舍，不是实施者的技术判断。

**依据**

1. 机主直接指示（2026-10-06）。键盘 RGB 与厂商灯效软件 / 系统 RGB 生态功能重叠，凭据在实现者手里 —— 用不到就删。
2. 键盘渐变服务在运行中约每 100ms 持续写颜色通道（原 `KeyboardGradientController`），与灯效页「应用颜色/亮度」
   争抢同一通道；删掉整条链路同时也消掉了这个争用。
3. §8.2 的 A 级举例原本就是「键盘颜色」—— 该功能删除后，A 级仍需一个有 getter + setter 的例子，故正文举例改为 Logo 灯。
4. 保留而不是顺手删掉 Logo 灯：它走的是 EC 的 `MethodName.Ambientlight`（命令 15），与键盘 RGB（16/17/18）
   是不同寄存器，机主只说了删键盘灯效。

**删除面（Implemented）**

- 前端：`Client/src/pages/KeyBoard.vue` 整页删除；`stores/index.ts` 的 `HomeCardType` 7 → 6 项；
  `stores/pageIds.ts` 的 `PAGE_IDS` 7 → 6 项、`PageId` 去掉 `'keyboard'`；`pages/Settings.vue` 的「自启动键盘渐变」开关；
  `utils/bridge.ts` 的 `Keyboard` / `KeyboardGradient` 两个导出对象与 `BridgeApi` 里对应的两段声明
  （后端方法即将不存在，留着声明就是撒谎）；
  `domain/writeGate.ts` 的 `writeGate.keyboardColor()` 与 `WriteDomain` 的 `'keyboard'`；
  `types/config.ts` 的 `AppSectionType.BootKeyboardGradient`。
- 注册表：删 4 项（`keyboard.color` / `keyboard.brightness` / `keyboard.mode` / `keyboard.gradient`）——
  **49 → 45 项**、可移除 **13 → 9**、bridge 方法名 **27 → 20**、`keep/review/cut` **38/5/6 → 36/3/6**；
  `keyboard.logo-light` 保留（id 不变），`group` 由 `keyboard` 改为 `lighting`。
  `readback: null` 的 **33 项不变**（4 个键盘项都有回读），无「移除」按钮的 **36 项也不变**。
  硬规则仍成立：`readback === null` 或级别 e 的项挂移除步骤 = **0**。
- 后端：`Server/Core/Controllers/KeyboardController.cs`、`Server/Core/Controllers/KeyboardGradientController.cs` 删除；
  `Server/Interop/Bridge.cs` 删两个属性**与 `Dispose()` 里的 `KeyboardGradient.Dispose()`**（只删属性不删 Dispose 就是资源泄漏）；
  `Server/Core/Models/JiaoLongConfig.cs` 的 `AppSection.BootKeyboardGradient`（含 `ConfigComment`）；
  `Server/Core/Utils/SelfStart.cs` 的 `if (bridge.Config.App.BootKeyboardGradient) bridge.KeyboardGradient.Start();`。
  这一行同时覆盖**睡眠唤醒**：`MainWindow.OnPowerModeChanged`（`PowerModes.Resume`）会再跑一次 `new SelfStart()`。
  `Server/Core/Models/ColorInfo.cs` 删除（唯一消费者 `KeyboardController` 已删，全仓零引用 —— 2026-10-06 补删，FIX-5）；
  `SysEnums.cs` 的 `MethodName.RGBKeyboard*`（16/17/18）与 `HwWriteGate.cs` 的键盘白名单/值域项**按协议层事实保留**，不动
  （理由见 `docs/功能必要性与架构梳理.md` §8 第 9 条）。
- 落点迁移：旧数字 `7` 与旧字符串 `'keyboard'` 都**显式**映射到 `'home'`（该页没有继任页；Logo 灯在设置页里，
  不是可导航的灯效页）。数字键 1..8 **不重新编号**：`'8'` 仍是 `'settings'`，否则存着 `'8'` 的人会落到别的页面。
  别名表仍是 `Map`（防 `localStorage` 里 `'toString'` 命中 prototype）。
- 截图工具：`scripts/visual-shot.mjs` 去掉 keyboard 页截图项、`Keyboard.*` / `KeyboardGradient.*` 的 mock handlers、
  mock 配置里的 `BootKeyboardGradient`；侧栏项数断言 7 → 6。

**反证条件（Reject if）**

- 老用户升级后落点不是 `home`（被弹到别的页面或白屏）→ 迁移映射有漏，必须补齐。
- Logo 灯在真机上不再可用（Get/Set 返回失败）→ 说明它与键盘 RGB 共享了被删掉的链路，必须恢复那部分。
- 若将来重新引入键盘 RGB → 必须同时重建 后端控制器 + 桥接包装 + 闸门闸位 + 页面 + 注册表行，
  并重新评估渐变服务与厂商灯效软件争抢同一通道的问题；不得直接引用本条删除记录当"已论证过"。

**Implemented 提交**：`e00e218` refactor（前端 + 后端 + 注册表 + 用例）；本文档与
`docs/功能必要性与架构梳理.md` / `docs/KNOWN_ISSUES.md` / `README.md` 的计数同步）。
（WS1 的 `dca35c8` fix(client) 是同一轮的前置安全补丁：`fan.curve` 的移除补上 `Fan.RemoveFanSpeed`。）

**Verified（本机实测输出，本轮时点）**
- 前端门禁：`npm run format:check` / `lint` / `type-check` / `build` 全通过；`npm run test` **10 文件 / 79 通过 / 0 跳过**。
- 后端门禁：`dotnet build -c Release --no-incremental` **0 警告 0 错误**；`ProtocolCodecTest` **29 通过 0 失败**。
- 反向验证：`JiaoLongControl/**` 内 `KeyboardController` / `KeyboardGradient` / `BootKeyboardGradient` /
  `SetLightBrightness` / `SetColor` **零命中**；`migratePageId('keyboard')` 与 `migratePageId('7')` 手工运行均返回 `home`，
  `migratePageId('fan')` / `('6')` 仍返回 `fan-curve`（回归）。
- 截图：`node scripts/visual-shot.mjs --out=.visual-qa` 通过，日志 `nav items: 6`，不再产出 `keyboard-*.png`。

**未 Verified**：真机（WebView2 桥）行为 —— 只做了 mock 桥单测与截图验证；「键盘 RGB 由厂商软件/固件管理」
是产品表述，不是本仓代码可验证的事实。

---

### 14.11 2026-10-06 · `CommandResult.Success` 契约收口：业务取值一律进 `Data`（**Decision**；聚焦复审整改）

**Decision（负责人：实施者（AI，聚焦复审整改），2026-10-06）**

`CommandResult.Success` **只表达"这次查询/命令本身成不成功"**；业务取值（"在不在跑""开没开"这类状态）
**一律进 `Data`**，getter 恒 `Success = true`。把"没在跑 / 未开启"这种**正常的业务结果**写成 `Success = false`
是违约：前端的读取闸门就是 `Success !== true`（`Client/src/composables/useAppliedFeatures.ts:122`），
违约会让一次**成功的读取**被判成"读取失败"。

**依据**

1. 本轮聚焦复审的复现：曲线没在跑（正常态）时 `AutoFanControl.IsRunning()` 返回
   `Success=false / Data=false`，看板 `fan.curve` 行显示「读取失败（自动风扇控制没有在运行中）」；
   点「移除」时三步（`AutoFanControl.Stop` → `Fan.RemoveFanSpeed` → `ConfigCtrl.SetConfig`）**真下发**，
   复核却判失败 → 结论「未确认移除成功」。**两个方向都是假红**：正常态报读取失败，真还原报未确认。
2. 同族第二处 `FanController.GetMaxFanSpeedSwitch()` 也是"取值既进 `Success` 又进 `Data`"的写法。
   它当前在前端没有消费者（`utils/bridge.ts:150` 只声明未导出），属于会被下一个人照抄的 landmine，一并修。
3. 契约本身不是新发明：`CpuController.GetCustomMode`、`FanController.GetFanSpeed` 等既有 getter
   早就是 `new CommandResult(true, "获取成功", <值>)` 的形状；本轮只把两处偏离按**既有**约定收口。
4. 配套：确认用的回读（`useFanCurveEditor.stopCurveService` / `useAppliedFeatures.buildRemovalSteps`）
   在 `Success !== true` 时必须**不采信 `Data`**，按"未确认已停止"中止（保守方向：没有证据就不撤
   `0xB20` 手动掩码 —— 撤了会被曲线的下一拍写回来）。

**反证条件（Reject if）**

- 看板 `fan.curve` 行在曲线未运行时仍显示「读取失败」→ 契约没生效（后端返回值或前端闸门有一处没改）。
- 点「移除」后三步都下发、结论仍是「未确认移除成功」→ 复核用的 `IsRunning()` 仍返回 `Success=false`。
- 将来若 `Success` 需要表达查询侧的第三种状态（如"部分成功"）→ 必须**新增字段**，不得复用
  `Success = false` 表达业务取值：那会立刻让所有 `Success !== true` 闸门把该状态判成读取失败。

**Implemented 提交**：`13ca2f6` fix(server)（两处返回值 + 契约注释）；`fix(client)+docs:`（本轮第二条提交：
确认回读的 `Success` 闸门、FIX-D 去掉 TOCTOU 短路、契约回归用例、mock 注释、本文档与已知问题同步）。

**Verified（本机实测输出，本轮时点）**

- 前端门禁：`npm run format:check` / `lint` / `type-check` / `build` 全通过；`npm run test`
  **10 文件 / 89 通过 / 0 跳过**（本轮 85 → 89）。
- 后端门禁：`dotnet build -c Release --no-incremental` **0 警告 0 错误**；`ProtocolCodecTest` **29 通过 0 失败**。
- 临时探针（放 `$env:TEMP`，引用 Release `LongCore.dll`，**不调 `Start()`**）：`new AutoFanControl().IsRunning()`
  → `Success=True / Data=False / "自动风扇控制没有在运行中"`；`new FanController().GetMaxFanSpeedSwitch()`
  → `Success=True / Data=False / "获取成功"`（本机 EC 未初始化，取值本身不构成硬件事实）。
- 反向验证：`git grep -n "new CommandResult(_isRunning" HEAD -- JiaoLongControl` 与
  `git grep -n 'new CommandResult(res, "获取成功"' HEAD -- JiaoLongControl` **均零命中**。
- 用例判别力（临时变异后跑用例，随后**已还原文件并删除备份**）：去掉确认回读的 `Success` 闸门 →
  契约回归用例红；把两处回读 `catch` 改成乐观返回（`accepted:true` / `stopped:true`）→ 两条 reject 用例红；
  恢复旧的 TOCTOU 短路 → 两条 FIX-D 用例红。

**FIX-D（TOCTOU 短路）已做**：`useFanCurveEditor.stopCurveService` 不再先自读"在不在跑"来决定发不发
`Stop`，而是**总是发**（`Stop()` 幂等：没在跑也 `Success=true`），停没停只由命令返回值 + 独立回读判定。
理由：自读与 Stop 之间存在竞态窗口，并发的 `Start`（开机自启 / 另一个页面）会把曲线拉起来，
被跳过的 `Stop` 让 `Fan.RemoveFanSpeed` 撤掉的掩码与曲线下一拍写入竞争。

**未 Verified**：真机（WebView2 桥 + EC）行为。本轮全部证据来自单测、mock 桥与一个只读探针；
「看板行恢复正常态显示」「移除后结论为『已移除并回读确认』」在真机上尚未复现一次。