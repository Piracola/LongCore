# LongCore 龙核 · 开发待办

> 策略：独立 fork，不向上游提 PR；定期 rebase 只取上游修复。
> ✅ = 已完成 · 上游 = GaoXanSheng/JiaolongControl（windows/X86-64 分支）

## M0 · 立项与基线

- [x] GitHub 上 fork `GaoXanSheng/JiaolongControl` 到个人账号（→ 用户自建空仓库 Piracola/LongCore，由本地推送完整历史，分支规范为 `main`）
- [x] 本地仓库关联双 remote：`origin` = Piracola/LongCore，`upstream` = GaoXanSheng/JiaolongControl
- [x] 本机装 .NET 8 SDK（用户级 `C:\Users\NullCola\.dotnet`，8.0.424）+ Node/npm（托管 22.22.2 + npm 10.9.7）
- [x] 前端构建通过：`npm install` + `npm run build` → `bin/publish/WebRoot/`
- [ ] 后端构建：**在本工作目录内无法完成**（宿主进程环境缺陷，见下）→ 用仓库根目录的 `build-and-push.cmd` 在用户自己的终端执行
- [ ] 首次推送 main 到 Piracola/LongCore（build-and-push.cmd 第 2 步，会弹 GitHub 登录）
- [ ] 本机试运行上游：与官方控制中心**二选一**；加载 JiaoLongDriver64.sys 需先处理内存完整性拦截
- [ ] 用 `probe/` 实测数据对照验证上游读数正确性（风扇/温度/模式/适配器）
- [x] 项目定名：**LongCore 龙核**

> **环境坑（2026-09-06）**：WorkBuddy 宿主进程树缺失 SystemRoot/PROGRAMDATA 等核心变量，且 `SHGetKnownFolderPath` 全树失效（0x80070002）→ NuGet `path1 null`，会话内无法修复（winenv.sh + NUGET_COMMON_APPLICATION_DATA + 无沙箱均无效）。`dotnet build` 必须在用户自己的终端跑。npm/vite 不受影响。
> 环境修复脚本：`C:\Users\NullCola\.workbuddy\winenv.sh`（治标）。
> GitHub 设备码登录三次失败：`/login/oauth/*` 端点被网络重置 → 推送改走用户终端的 Git Credential Manager 浏览器弹窗。

## M1 · UI 重设计（核心目标）— 全部完成 ✅（6896932…d3dad7f）

- [x] 建立设计令牌：圆角/温度语义色令牌 + Arco 暗色主题对齐（body[arco-theme]）+ 字阶令牌 --text-xs..3xl（d3dad7f）
- [x] 移除背景视频与动漫横幅 → 压缩为一行状态条（StatusBanner.vue，删 BackgroundVideo.mp4 2.2MB）
- [x] 图标统一为 Lucide 线性图标库，19 个 PNG（含中文名文件）全清（b43ccf0）
- [x] 温度语义色阶：≤70° 蓝 → 70–80° 青 → 80–90° 橙 → >90° 红（状态条/监控环/中心数值联动）
- [x] 信息架构重组：性能模式改顶部胶囊切换（并入状态条）；监控环加阈值变色占满整行
- [x] Logo 与应用图标：八片龙鳞环抱核心 SVG + 纯标准库多尺寸 app.ico（b43ccf0）
- [x] 全量更名 LongCore：exe/窗口标题/托盘/任务计划/互斥体/前端标题（31268e6；命名空间与 csproj 文件名有意保留）

> **事故记录（2026-09-06 晚）**：会话进行中 `Client/src/` 整目录被并发进程清空两次（疑似另一残留会话持有陈旧文件缓冲，伴随 EBUSY 锁与已编辑文件回滚）。已用 `git restore` 全量恢复；后续改动一律"整文件原子写入 → 构建通过后同一命令链内立刻提交"。09-09 起幽灵进程未再犯案。

## M2 · 功能增强 — 全部完成 ✅（536421d…52c6d63）

- [x] WMI 响应回显校验（jiaolongctl 逻辑移植，失败重试一次）+ ManagementObject 单例复用损坏重建（536421d）
- [x] 热键系统：HID_EVENT20 监听接管事件15性能模式键（高性能→平衡→静音循环）+ OSD 胶囊提示 + mode-changed 前端同步；其余 Fn 键保持固件默认；配置开关 App.HotkeyEnabled（52c6d63）
- [x] 性能模式补全：新增 CustomMode=3 本地逻辑态（命令 23 自定义子状态叠加）；AirPlaneMode 有意不补全（命令 9 需重启，不能热切换）（a19950d）
- [x] EC 直写安全护栏：写入地址白名单（0xC83C/0xC83D/0xB20/0x1060）+ 同址同值 300ms 去重节流 + EcGuard 心跳护栏（崩溃后下次启动自动恢复风扇自动模式）（9925464）
- [x] SPL/SPPT 档位联动 Windows 电源计划（PowerPlanHelper + App.SyncWindowsPowerPlan，默认开）（a19950d）
- [x] ManagementObject 复用（536421d，同上）

## M3 · 工程化 — 代码侧完成 ✅（acfcf8a…8525937）

- [x] 协议层单元测试：ProtocolCodec 纯逻辑抽取（组帧/校验/解码）+ ProtocolCodecTest 控制台测试，黄金样本取自 probe/10_wmi_get_probe.txt 真机响应（acfcf8a；build-and-push.cmd 已插入测试步骤）
- [x] GitHub Actions CI：ci.yml 双 job（前端 ubuntu npm ci+build；后端 windows dotnet build + 协议测试）（8525937；推送后即生效）
- [x] 版本方案：独立起版 0.1.0（csproj AppVersion + package.json），InnoUpdater 更新源改指 Piracola/LongCore 避免 10.x 诱导弹窗（8525937）
- [ ] rebase 节奏：每两个上游 release 同步一次（长期事项，首次推送后自然开始）

## M4 · 发布 — 材料侧完成 ✅（a81b4e8），剩余用户终端动作

- [x] README 英文版（README_EN.md）+ 中文 README fork 横幅
- [x] 安装器：installer/LongCore.iss（管理员/AppMutex 联动/WebView2+.NET8 离线可选静默装）+ build-installer.cmd 一键链
- [x] 支持机型声明（docs/SUPPORTED_HARDWARE.md）+ 免责声明（docs/DISCLAIMER.md）+ 已知问题清单（docs/KNOWN_ISSUES.md，15 项）
- [ ] **用户终端**：跑 `build-and-push.cmd`（构建后端+协议测试+首次推送 main；M0 两项与 CI 激活都靠它）
- [ ] **用户终端**：跑 `installer\build-installer.cmd` 产出安装器并实测安装/卸载
- [ ] GitHub Release v0.1.0 + 杀软误报评估（推送后在仓库网页操作）
