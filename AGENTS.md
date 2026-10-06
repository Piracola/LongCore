# AGENTS.md — LongCore 开发约定

本仓库是**单一 git 根**，同时包含应用本体与研究层。所有命令默认在本文件所在目录执行。

## 目录地图

| 路径 | 内容 | 可写性 |
|---|---|---|
| `JiaoLongControl/Client/` | Vue 3 + Vite + Arco + ECharts 前端 | 主开发区 |
| `JiaoLongControl/Server/` | .NET 10 WPF 宿主（Bridge / WMI / EC / SMU） | 主开发区 |
| `JiaoLongControl/Drivers/` | 厂商驱动（**二进制，勿改**） | 只读 |
| `installer/` | Inno Setup 打包脚本 | 按需 |
| `research/` | 协议逆向、实测数据、上游审计、决策记录 | **研究层，默认只读** |
| `docs/` | 机型声明 / 免责声明 / 已知问题 / UI 重构方案 | 按需 |
| `Doc/` | 截图等静态资源 | 只读 |
| `vendor/` | 厂商素材与本地工具（**已 gitignore，禁止入库**） | 本地专用 |

## 前端命令（工作目录必须是 Client）

> ⚠️ **常见错误**：在仓库根直接跑 `npm run format:check` 会失败——仓库根没有 `package.json`。

```powershell
cd JiaoLongControl/Client     # 必须先进入这一层
npm run format:check          # prettier 检查
npm run format                # prettier 修复
npm run lint                  # eslint
npm run type-check            # vue-tsc
npm run build                 # type-check + vite build
npm run test                  # vitest
```

## 构建与打包

```powershell
.\build.ps1 -Full             # 前端 + 后端 + 协议测试
.\build.ps1 -Installer        # 打安装器（需 Inno Setup 6）
.\build.cmd                   # 双击用的交互式菜单
```

`build.ps1` 按顺序查找 NuGet 缓存：先 `vendor/.nuget-packages`（当前布局），再上级目录的 `.nuget-packages`（旧布局兼容）。都找不到时用 dotnet 默认缓存，也可自行设置 `NUGET_PACKAGES`。

## 行尾与格式化（重要）

根目录 `.gitattributes` 强制 `eol=lf`，已覆盖 Windows 全局的 `core.autocrlf=true`。
**不要**再引入 CRLF——否则 prettier 会产生"看着已格式化、检查却失败"的假报错。

## 提交约定

- 中文提交信息，形如 `feat(client): ...` / `fix(server): ...` / `chore: ...`
- 改动较大时先跑 `npm run format:check` + `npm run type-check` 再提交
- 提交前确认 `git status` 干净（本仓库曾因并发写入丢过文件，见 `research/TODO.md` M1 事故记录）
- **引用 `docs/KNOWN_ISSUES.md` 一律写「第 N 条」，不要写 `:NN` 行号**。行号型锚点
  每次编辑文档都会漂移（2026-10-06 那轮重编号就把 5 处代码注释与看板文案指到了无关条目），
  而条号稳定。改完该文件要重编号时，顺手全仓搜一遍 `KNOWN_ISSUES` 复核。

## 后端构建门禁：0 警告

2026-09-23 起后端 `dotnet build` 必须是 **0 警告 0 错误**（此前堆积 26 个）。
这个数字只有在含义唯一时才有用：

- **必须用 `--no-incremental` 验证**。增量构建只重编改动的文件，其它文件的警告根本不报，
  同一份代码会给出 26 / 7 / 0 三种计数。拿增量结果当门禁等于自欺。
- CS1668（`LIB` 环境变量路径无效）已在 `csproj` 用 `NoWarn` 抑制：它是机器级残留，
  项目侧无法修复。若本机清掉 User 作用域里指向已卸载 VS Build Tools 的
  `LIB` / `INCLUDE` / `LIBPATH` / `Path` 残留，可以再把它从 `NoWarn` 里删掉。
- `CommandResult.Data` 是 `object?`（大量调用点只传两个参数）。**不要**为了消警告改回
  `object`——那会把「可能为 null」的真实情况重新藏起来。取值方需自行处理：
  `is bool b && b` / `is not FanSpeedInfo info` / `(T)Data!`（仅限先判过 `Success` 的场合）。

## CommandResult 契约（2026-10-06 起）

`Success` 只表达"这次查询/命令本身成不成功"，业务取值一律进 `Data`（getter 恒 `Success = true`）；
新增 getter 不得把业务值塞进 `Success` —— 前端以 `Success !== true` 判读取失败，写反了就是假红（v4 §14.11）。

## 风扇控制边界（改动前必读）

- **转速区间只有一个真源**：`Client/src/constants/index.ts` 的 `FAN_MIN_RPM` / `FAN_MAX_RPM`（1500/5800）。
  禁止在页面或 composable 里硬编码 Rpm 数值——历史上曲线上限曾硬编码 6800，而驱动侧
  `Blding64.FanSpeedRawMax` 是 58，滑块能拖出一个永远下发不了的假值。
- **写风扇转速会置位 `0xB20` 手动掩码**，EC 自身温控曲线随之被绕开，软件成为唯一控制者。
  任何新增写转速的路径都必须同时考虑兜底：`ThermalWatchdog`（98℃/10s 拉满）与
  `EcGuard`（崩溃后恢复 EC 自动）。详见 `research/docs/08_硬件安全架构.md`。
- **曲线接管不按性能档位设限**（2026-09-23 起）：固件三档下同样生效，是否接管由
  `Fan.Enabled` + 曲线服务运行状态决定，不要重新引入"先在概览页切到自定义"这类前置门禁。
- **改完默认曲线要同步两处**：`JiaoLongConfig.FanSection`（后端出厂值）与
  `useFanCurveEditor.ts`（前端占位值），否则打开页面会先跳一下。
  `ConfigSerializer.Update()` 是无损迁移，**不会**用新默认值覆盖用户已存的曲线。
- **不要重新引入 CPU→GPU 交叉同步**（2026-09-23 移除）：原实现按 `0.85 × CPU 目标` 抬高
  GPU 转速，实测 GPU 仅 56℃ 时其风扇被顶到 3400 RPM（按自身曲线只需 1500~1800）。
  那是零散热收益的噪音源。两风扇要联动就用 `FanCurveMerge`（同转速、同音高，消除拍频）。
- **抑制转速抖动必须靠"温度域"手段，不要在转速域设死区**（0.1.4 结论）。
  0.1.3 曾在最终 RPM 上加 300 RPM 死区，实测无效：挡得住 100 RPM 的量子抖动，
  挡不住"被低通放大后的 ±3℃ × 曲线斜率"= ±400 RPM。现在由三件事共同负责，
  调参前先读 `AutoFanControl.ProcessAndApplyFanSpeed`：
  1. 双跟踪器（`TempAttackS` 快升 / `TempReleaseS` 慢降）。**升速目标取快跟踪值的曲线点，
     降速目标取慢跟踪值**——单一跟踪值无法同时满足"升温跟得上"和"回落后多保持"；
     若把升速目标也改成慢跟踪值，升温初期会长期欠冷（离线重放实测低 400~900 RPM）。
  2. 不灵敏带锚定在"上次写硬件时的温度"（`TempHysteresisC`）。锚点必须随每次写入刷新，
     否则温度单向漂移时会被整段吃掉。
  3. 降速走"请求值"（`ReleaseRequestByte`）并每秒最多退一格，且**只在请求值低于硬件
     实际值时才写**。绝不用原始目标直接写硬件：不灵敏带挂起期间缓存的目标会与硬件实际
     值反向，一恢复调整就会把转速写反（离线重放抓到过这个 bug）。
     `FallGateC` 只负责**进入**降速段（`FanState.Descending`），**不得**要求每退一格都重新
     过门槛：写出会刷新锚点，那样会退化成"每 8℃ 才降 100 RPM"——2026-10-06 真机日志里
     `86.0℃/5100 → 77.8℃/5000 → 69.8℃/4900 → 61.8℃/4800` 就是它，用户看到的是"曲线不生效"。
     降速段另有第二条入口 `InSustainedExcess`（转速持续高出当前曲线 800 RPM 达 60 秒）。
     它是**唯一一处转速域判据**，但**不是死区**：不做抖动抑制，量的是"比曲线吵多少"且要求
     持续超限；它只可能让转速更早降下来，不可能让它升上去。改它前先读 `docs/KNOWN_ISSUES.md`
     第二轮那条（尖峰后平台期永久高出曲线 1200 RPM 就是它修的）。
  4. **配置热改必须当拍生效**：控制循环每拍比对 `FanConfigFingerprint`（曲线/噪音档/合并开关/
     两个时间常数），变了就按 `curve(快跟踪值)` 重算一次。温度平稳时两个温度域门槛都不满足，
     没有这条的话用户在曲线页拖动存盘会"毫无反应"。

## 日志约定（2026-09-24 起）

- **安全事件必须 WARN 及以上**：看门狗触发、`EcGuard` 恢复、写入闸门拦截、驱动加载失败。
- **禁止把逐次数据读取写成 DEBUG**：旧行为一天 5.7 万行里 98.4% 是 `CommandResult` 构造的
  DEBUG 行（约 27 次/秒同步写盘）。现默认 `Log.Level=INFO` + `Log.CommandDebug=false`，
  排查读取类问题时可临时打开（设置页即时生效，无需重启）。新增读取路径不得绕过这条。

## 模式约定（2026-09-24 起）

- **只有三档**：办公 = QuietMode(2) · 游戏 = BalanceMode(0) · 狂飙 = PerformanceMode(1)。
  枚举顺序是历史坑（见 `utils/bridge.ts` 顶部注释），改动前先读那里。
- **三分离**：我选了什么（`selected`）/ 固件实际在哪档（`observedFirmware` + `customOverride`）
  / 上次应用成功的是什么，三者不得混用；UI 激活态**只由 `activeKind` 决定**。
- **切档成功判据**：写后独立重读，且**回读本身必须成功**；「命令被接受但回读未确认」记为
  `accepted`（不算成功、也不算失败），不得报成功，也不得静默弹回（`stores/mode.ts`，v4 §14.5）。
- **从自定义档切出时，命令 23 必须先关、命令 8 必须后写**（2026-10-06 修）：
  关命令 23 会把固件档位退回**进入自定义前的那一档**，且只有"退回值 ≠ 刚写入值"时才补抛一次
  档位事件（全日志 5 簇"自定义开着时关 23"，5/5 自洽、0 反例；`19:00` 两次退回狂飙、
  `20:38` 退回游戏）。先写 8 再关 23 就会被这次重新发布顶掉。日志顺序（`2026-10-06.log:331-335`；
  注意日志**不记录写入载荷**，"写入 8 是办公"只是由紧随的事件推断，不是日志原文）：
  `20:38:39,993 写入 8` → `40,018 写入 23` → `40,021 写入 23` → `40,024 事件办公` → `40,042 事件游戏`。
  代码见 `PerformanceModeController.CloseCustomOverrideBeforeModeWrite` / `ReassertIfNotApplied`。
  官方只是**顺序意图**参考：`decompiled/main.cs:2182-2184` 属热键事件路径，其中刷档位那步只刷 UI。
- **服务端不得把"回读不一致"报成失败**：那会把 documented 的 `accepted` 降级成 `failed`，并让前端
  跳过权威的写后独立回读（`mode.ts` 的 `if (accepted)`）。服务端只做尽力收敛（回读**明确**不一致时
  补写一次），成功判据永远留在前端。
- **读命令 8 / 23 一律用 `GetValue<byte>`**：`GetValue<T>` 读失败时的默认值随 T 变（`byte` 才是
  255，枚举会落到 `default` = 0 = `BalanceMode`），按枚举读会把"读不到"当成"游戏档"（假绿/假红）。
- **`mode-changed` 事件镜像在 `syncing` 期间不得改写状态**：我们自己的写入也会让固件回抛事件，
  采信中间态会让写后回读判据看到假值（`stores/mode.ts` 的 `applyHotkeyMirror` 守卫）；
  `syncing` 期间的重复点击要按"忙"提示，不得标成失败态（`Home.vue` 的 `runSelection`）。
  晚投递（事件在 `syncing` 结束后才被 JS 处理）挡不住，见 KNOWN_ISSUES 第二轮那条 ⚠️。
- 新增切档入口（页面 / Fn 热键 / 启动恢复）必须走同一个 store，不得各写一条 `PerformanceMode.Set`。

## vendor/（本地素材，永不入库）

`vendor/` 存放**不可发布**的本地资产，整目录已在 `.gitignore` 中忽略：

| 子目录 | 内容 |
|---|---|
| `vendor/installed/` | 厂商已安装程序（含有版权 DLL/EXE） |
| `vendor/extract/` | 从 Setup.exe 解包的产物 |
| `vendor/decompiled/` | ILSpy 反编译输出（协议逆向证据） |
| `vendor/tools/` | 逆向脚本（解包/雕刻/图标生成） |
| `vendor/.nuget-packages/` | NuGet 缓存（约 210MB） |
| `vendor/.venv/` | Python 虚拟环境（含硬编码绝对路径） |
| `vendor/蛟龙游戏控制中心Setup.exe` | 厂商原始安装包（不可重建，**勿删**） |

> ⚠️ **不要**为 `vendor/` 添加任何 `!` 反向例外，也不要用 `git add -f` 强加。
> 这些厂商二进制一旦进了公开仓，就无法通过删除提交来撤销。

research/ 的 `docs/` 与 `REPORT.md` 会引用这些路径（如 `decompiled/main.cs`），
引用的是**仓库内相对位置**，实际文件在 `vendor/` 下。移动素材后需同步这些脚本内的绝对路径。

## 研究层（research/）

- 文档入口：`research/docs/00_索引.md`
- 其中的 `src/jiaolongctl/` 是 Python 协议参考实现，不属于应用构建产物
- 历史文档中的 `LongCore/xxx` 路径写于合并前，应读作 `xxx`（见 `research/docs/archive/` 注记）
