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
