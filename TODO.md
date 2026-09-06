# LongCore 龙核 · 开发待办

> 策略：独立 fork，不向上游提 PR；定期 rebase 只取上游修复。
> ✅ = 已完成 · 上游 = GaoXanSheng/JiaolongControl（windows/X86-64 分支）

## M0 · 立项与基线

- [ ] GitHub 上 fork `GaoXanSheng/JiaolongControl` 到个人账号
- [ ] 本地 `upstream/JiaolongControl` 关联双 remote：`origin` = 我的 fork，`upstream` = 原作者（取修复用）
- [ ] 本机装 .NET 8 SDK（当前只有 runtime）+ Node 20/22，跑通上游构建（前端 `npm run build`，后端 `dotnet publish`）
- [ ] 本机试运行上游：与官方控制中心**二选一**；加载 JiaoLongDriver64.sys 需先处理内存完整性拦截
- [ ] 用 `probe/` 实测数据对照验证上游读数正确性（风扇/温度/模式/适配器）
- [x] 项目定名：**LongCore 龙核**

## M1 · UI 重设计（核心目标）

- [ ] 建立设计令牌：Arco Design 主题变量统一（间距/圆角/字阶/暗色）
- [ ] 移除背景视频与动漫横幅 → 压缩为一行状态条
- [ ] 图标统一为线性图标库（Lucide/Tabler），清理混杂的 PNG（含中文名文件）
- [ ] 温度语义色阶：≤70° 蓝 → 70–80° 青 → 80–90° 橙 → >90° 红（中文语境"升温=红"）
- [ ] 信息架构重组：性能模式改顶部胶囊切换；监控环加阈值变色
- [ ] 重新设计应用内布局：欢迎页信息密度提升
- [ ] Logo 与应用图标（意象：龙鳞环抱核心）
- [ ] 全量更名 LongCore：可执行文件名、窗口标题、托盘、安装器

## M2 · 功能增强

- [ ] WMI 响应回显校验（把 jiaolongctl 的校验逻辑移植进 MethodServices）
- [ ] 热键系统：HID_EVENT20 事件监听（事件名表在协议手册 §热键）+ 可选 RegisterHotKey 全局热键 + OSD 提示
- [ ] 性能模式补全：上游仅 3 档（平衡/性能/安静），协议里还有 AirPlaneMode/CustomMode
- [ ] EC 直写安全护栏：范围校验、写入节流、进程异常退出自动恢复风扇自动模式
- [ ] SPL/SPPT 档位联动 Windows 电源计划（powercfg）
- [ ] ManagementObject 复用（消除每次调用的重复实例化）

## M3 · 工程化

- [ ] 协议层单元测试：用 probe 黄金样本做回归基线
- [ ] GitHub Actions CI：前端 vite build + 后端 dotnet publish + 打包安装器
- [ ] 版本方案：独立起版 `0.1.0`（不继承上游版本号，避免混淆）
- [ ] rebase 节奏：每两个上游 release 同步一次，冲突只接受在 fork 侧解决

## M4 · 发布

- [ ] README 英文版（README_EN）
- [ ] Release v0.1.0：安装器（Inno Setup）+ 杀软误报评估
- [ ] 支持机型声明 + 免责声明 + 已知问题清单
