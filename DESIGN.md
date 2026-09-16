# LongCore Design System

> 版本 v2.0 · 2026-09-12（硬件仪表身份）  
> **状态：Draft（2026-09-17，见 docs/UI重构_最终方案_v4.md §1 状态分类法）。**
> 身份方向（近黑哑光 / 温度语义 / 拒绝玻璃与紫罗兰）**仍有效**；但其中
> 「单强调色足以承担数据语义」「刻度统一」「DPI 发丝线方案」三项已被 v4 §12 **降级为待验证**。
>
> 视觉决策冻结见 ../docs/09_UI全量重设计计划.md 附录 A（**父仓，本仓不含**）  
> 动效令牌见 `../docs/07_动效原则.md`（**父仓，本仓不含**；仍生效）

## 身份

**蛟龙 16 Pro 硬件控制仪器**——精密、暗底、读数优先。  
旁观者第一眼应识别为「硬件仪表 / 控制台」，不是 AI 生成仪表盘，也不是 Win11 设置克隆。

参考侧：Armoury Crate / iCUE 的信息密度与工程感；**不用 RGB 灯海**。

## 锚点

| 维度 | 选定 | 拒绝 |
|---|---|---|
| 材质 | 近黑哑光底 + 细发丝分割 + 实心读数面板 | 玻璃拟态、大 blur、多层光晕 |
| 字体 | 数值 mono + tabular-nums；UI Segoe UI Variable | 装饰衬线、过大 display |
| 色彩 | 中性石墨阶 + **单一冷青强调** + 温度语义色 | 紫罗兰主色、彩虹渐变 |
| 几何 | 密度 compact、圆角 4–8、发丝线分区 | 大圆角卡片墙、hover 上浮 |
| 动效 | 状态可见、读数瞬时、无装饰循环 | 无限脉冲、假波形、整页位移 |

## 壳

```
┌─────────────────────────────────────────────┐
│ TitleBar 36px                               │
├──┬──────────────────────────────────────────┤
│R │ StatusStrip 48px  [Mode] [Temp chips]    │
│a │                 [PWR] [FAN] [NOISE]      │
│i ├──────────────────────────────────────────┤
│l │ Content                                  │
│60│  首页: 读数机架 4 格大数字 + 风扇/曲线/系统│
└──┴──────────────────────────────────────────┘
```

- 导航：**60px 图标轨**，tooltip，选中态 = 冷青 + 左缘 2px 指示条  
- 禁止 240px SaaS 侧栏文字列表壳

## 令牌

令牌唯一权威源：`Client/src/assets/Global.scss`。本文件只作人读摘要。

### 表面

| Token | Dark | Light |
|---|---|---|
| `--bg-app` | `#0a0b0f` | `#f2f4f9` |
| `--bg-panel` | `#12141a` | `#ffffff` |
| `--bg-raised` | `#181a22` | `#ffffff` |
| `--bg-inset` | `#0e1015` | `#eef1f6` |

实心或极轻透明；**禁大 blur**。

### 墨色

| Token | Dark | Light |
|---|---|---|
| `--ink` | `#e8eaef` | `#1a1b26` |
| `--muted` | `#8b93a7` | `#5a6478` |
| `--weak` | `#5c6478` | `#7b86a0` |

数值一律 `font-family: var(--font-mono); font-variant-numeric: tabular-nums`。

### 强调（唯一）

| Token | Value |
|---|---|
| `--accent` | `#22d3ee` |
| `--accent-dim` | `rgba(34,211,238,.12)` |
| `--accent-line` | `rgba(34,211,238,.35)` |

焦点环、选中、主操作、进度条共用。**不得引入第二功能强调色。**

### 温度语义（保留）

| 档 | 色 | 范围 |
|---|---|---|
| cool | `#60a5fa` | ≤70°C |
| warm | `#22d3ee` | 70–80°C |
| hot | `#fb923c` | 80–90°C |
| critical | `#f87171` | >90°C |

逻辑在 `utils/temperature.ts`（含滞回）。与 CSS `--temp-*` 同源。

### 分割与圆角

- 发丝线：`1px` `--hair` / `--hair-strong`  
- 圆角：`sm 4 / md 6 / lg 8`；pill 仅胶囊切换

### 动效（继承 `../docs/07_动效原则.md`）

```
--dur-press 120ms
--dur-fast  150ms
--dur-base  200ms
--dur-slow  250ms  // 上限
```

- 读数（温/转/频/拖拽曲线）**瞬时**  
- 装饰动画 **零**（加载态除外）  
- 禁 `transition: all`

## 组件约定

### 控制模块三段式（Phase D）

1. **读数头**：标题 + 当前值（mono）+ 状态 badge  
2. **控件**：slider / switch / 分段  
3. **应用确认**：待应用 → 应用中 → 成功/失败（可回读）

### 按钮

- 主操作：实心冷青底 + 近黑字  
- 次操作：描边 / 低对比底  
- 危险：语义红描边或文字，二次确认  
- 禁紫渐变 CTA

### 图表

- 主题无霓虹  
- 面积低透明度  
- 网格弱化（`rgba(255,255,255,.05)`）  
- 实时曲线 `animation: false`

## 已拆除（不得回潮）

- `--color-accent-purple` 主色地位  
- `--glow-*` 与 body 多层 `radial-gradient`  
- `.glass-card` backdrop-blur  
- `.neon-*` / `cyber-*` 命名与视觉  
- 假 ECG、无限 spin/pulse 装饰  
- 紫渐变 apply 按钮

## 文件映射

| 关注点 | 路径 |
|---|---|
| CSS 令牌 | `Client/src/assets/Global.scss` |
| Tailwind 映射 / 基底 | `Client/src/style.css` |
| 壳 | `Client/src/pages/Main.vue` |
| 首页 | `Client/src/pages/Home.vue` |
| 温度逻辑 | `Client/src/utils/temperature.ts` |
| 动效遗产 | `../docs/07_动效原则.md`（**父仓**） |
| 决策与冻结表 | `docs/UI重构_最终方案_v4.md`（本仓，**现行**）<br>`../docs/09_UI全量重设计计划.md`（**父仓，已被取代**） |
