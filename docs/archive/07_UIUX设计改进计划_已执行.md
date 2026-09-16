# LongCore UI/UX 设计改进计划（动效与交互层）

> 版本 v1.1 · 2026-09-11
> 依据：`06_技术栈与UX审查结论.md`（栈不动、目标 Fluent 原生视觉、去"AI 味"）
> 编制：动效精修工作室（审计 / 标准裁决 / 实现蓝图 / 复审 四阶段）
> 状态：**P0 / P1 / P2 已全部执行完毕，构建通过**（见第九节执行记录）；第 6.3 节的人工/真机验证项待办

---

## 一、结论先行

**当前 UI 动效层处于"看起来有动效、实际上基本失效且方向错误"的状态，必须整体重构，而不是微调。**

三条最该先修的事：

1. **页面切换动效是一段无效代码**，而且**落地顺序搞反会卡死导航**。`RightSide.vue` 唯一的过渡靠给元素加 `.swap` 类触发 animate.css 的位移关键帧，但没挂时长基类，`animation-duration` 回落到 `0s` —— 动画同帧完成，等于硬跳。若先删 `magic.min.css` 而暂留这段 `<transition>`，`animationend` 将永不触发、`done()` 永不调用，Vue 判定过渡未结束，**其后所有导航切换会被吞掉**。这是本计划唯一的"顺序即生死"点。
2. **全项目零动效令牌、零 `prefers-reduced-motion`、零 hover 门禁**。14 个文件里的 `transition` 全是各写各的，主力语言是 Material 方言的 `transition: all 0.3s cubic-bezier(0.4,0,0.2,1)` —— 无界属性动画 + 非 Fluent 曲线。
3. **全局把 `button:focus-visible` 的 outline 干掉了**（`Global.scss:168-176`）。设置页全是开关与按钮，键盘用户 Tab 导航会陷入完全盲区。这是无障碍硬伤，不是审美问题。

**同时必须明确"不该动"的地方**：每秒/每 5 秒刷新的温度与转速读数、ECharts 监控环、拖拽中的曲线节点——给这些加过渡是本次最容易犯的错。评审官的裁决是**一律瞬时**。

**取档合规性**：本计划所有曲线与时长均取自评审标准表，未自造任何值；原 `cubic-bezier(0.4,0,0.2,1)` 将被彻底移除。

---

## 二、现状诊断（分级清单）

### 2.1 HIGH —— 必修

| # | 位置 | 现状证据 | 问题 |
|---|---|---|---|
| H1 | `components/layout/RightSide.vue:15-24,29` | `enter(){el.classList.add('swap'); el.addEventListener('animationend',done)}`、`leave(){done()}`；`.swap` 来自 `magic.min.css`，其规则不含 `animation-duration`，回落 **0s** | 过渡实际无效果；且与 H2 存在**顺序依赖**，顺序搞反即导航卡死 |
| H2 | `main.ts:4` | `import './assets/magic.min.css'` —— 33.9KB 动画包，全库唯一消费点就是 H1 那一个关键帧 | 为一个失效关键帧背整包体积 |
| H3 | `assets/Global.scss:201-241` | `.glowing-card{transition:all .3s cubic-bezier(.4,0,.2,1); &:hover{box-shadow:0 0 20px; transform:translateY(-2px)}}`、`.active-glow`、`.cyber-button`；`.glowing-card` 还硬编码 `border-radius:24px` 绕开令牌 | `transition: all` + 非合成属性 + hover 上浮 + 辉光。**三类模板引用数 = 0（死代码）** |
| H4 | `assets/Global.scss:168-176` | 对 `button / a / [role='button']` 的 `:focus` 与 `:focus-visible` 一律 `outline: none` | 键盘用户完全失去焦点可见性 |
| H5 | `pages/Main.vue:50,79`（另 `:33,:44,:56,:84,:87`） | 选中导航项背后 `animate-pulse` + `blur-[8px]` 蓝光圆点**无限脉冲**；图标 `drop-shadow-[0_0_6px_...]`；`transition-all duration-300` | 最高频交互面（导航，日常数十次/天）叠加装饰性无限动效与辉光 |
| H6 | 全项目 | `prefers-reduced-motion` 命中数 **0**（仅第三方包内有） | 无限脉冲/旋转、位移入场对所有用户一律播放 |

### 2.2 MEDIUM —— 应修

| # | 位置 | 现状证据 | 问题 |
|---|---|---|---|
| M1 | `pages/KeyBoard.vue:170,177,189,192,215,352` | 6 处 `transition-all duration-300`；`:177` 溢出层与 `:192` 的 52 个按键内 div **同时**挂 `filter:hue-rotate`（共 53 个滤镜层） | 大面积逐帧重算，掉帧源 |
| M2 | `pages/FanCurveEditor.vue:369,389,435,462` | `.status-dot{transition:all .3s}` + `@keyframes pulse` 动画 `box-shadow`；`.menu-item{transition:all .2s}`；`:deep(.arco-radio-button){transition:all .3s !important}` | 3 处 `transition: all`；`box-shadow` 不可合成 |
| M3 | `components/common/SettingCardComponent.vue:10` | `transition-all duration-300 hover:border-cyber-purple/30 hover:shadow-[0_0_20px_rgba(138,43,226,.15)]`（设置页 8 张卡共用） | 容器非可点元素，hover 暗示可点 = 误导；紫辉光 |
| M4 | `pages/Main.vue:33,56,84` | 导航按钮/图标 `transition-all duration-300`（Tailwind 默认曲线 = Material 方言） | 高频面色变用 300ms + `all` |
| M5 | `KeyBoard.vue:160,220`、`SettingCardComponent.vue:10`、`Main.vue` hover | `hover:scale-105`、`group-hover:scale-110`，无 `@media (hover:hover) and (pointer:fine)` 门禁 | 触屏点击会粘住 hover 态 |
| M6 | `theme/theme.ts:52-67` | `documentElement.dataset.theme = resolved` 瞬时替换全量 CSS 变量；`style.css:41-57` body 多层 `radial-gradient` | 主题切换全站硬切、瞬间跳变 |
| M7 | `pages/CPU.vue:182,326`、`pages/Fan.vue:107,113`、`pages/GPU.vue:464` | 配置卡片 `transition-all`；应用按钮 `shadow-[0_0_15px_rgba(138,43,226,0.3)]` 紫辉光 | 同理 H3 |

### 2.3 LOW —— 清理

| # | 位置 | 问题 |
|---|---|---|
| L1 | `layout/TitleBar.vue:65-83` | caption 按钮 50×50、`transition: background-color .2s`、缺 `:active` 按压反馈、缺焦点环 |
| L2 | `style.css:33,63-66,69,74` | `--radius-cyber:32px`、`.glass-card{rounded-[32px] backdrop-blur-3xl}`、`.neon-text-*`/`.neon-border-*` 死 CSS |
| L3 | `Home.vue:334`、`FanSpeed.vue:170`、`RyzenSmu.vue:527,532`、`index.html:100,112,121,164` | 无限循环装饰动画：`animate-spin` 3s 风扇、`animate-pulse` 圆点、载入动画 4 条无限 + drop-shadow |
| L4 | `Home.vue:110-123,153` | ECG"心电图"由 `Math.random()` + 硬编码波形以 **100ms（10Hz）** 驱动，50 点 polyline 常驻重算；`:361-367` 还套了 `feGaussianBlur` 霓虹滤镜 |

### 2.4 机会点（该动但没动）

| 位置 | 现状 | 该动什么 | 为什么值 |
|---|---|---|---|
| `Home/StatusBanner.vue:74` | 温度胶囊用 `:style` 直接给色，无过渡 | 色变 200ms `ease` + **阈值滞回** | 跨 70/80/90° 阈值时瞬间跳色；高曝光读数 |
| `CPU.vue:381-435` | 频率/电压/使用率/温度条用 `:style width %`，无过渡 | 改 `transform: scaleX()` + 250ms | 每 5s 轮询硬跳；且 `width` 非合成属性 |
| `SettingToggle.vue:39-57` | 保存成功只靠 Arco Message | 卡片边框一次性高亮 | 设置页无本地状态确认反馈 |

### 2.5 审计盲区（读代码判断不了）

- WebView2 合成器实测帧率；
- WPF 侧 `MainWindow.xaml` / DWM backdrop / WebView2 透明底（Mica 未接入，会影响背景动效取舍）；
- Arco 内置动效（switch / modal / message / radio）未被本令牌体系覆盖；
- `backdrop-filter` / `filter: blur` 在低端 GPU 的实际代价。

---

## 三、改进方案

### 3.0 动效令牌增量（先立地基）

项目当前**完全没有**动效令牌。新增到 `assets/Global.scss` 的 `:root`（现有 `:root` 在 `:6–:84`，本块追加到 `--glow-center` 之后、`[data-theme='light']` 之前）：

```scss
/* ===== 动效令牌 (Fluent 对齐, 仅此几档, 不得自造) ===== */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);

--dur-press: 120ms;   /* 按压 / 焦点反馈 */
--dur-fast: 150ms;    /* 短时态变 / 主题 / 模式切换 / 菜单项 */
--dur-base: 200ms;    /* 常态色变 (温度语义) */
--dur-slow: 250ms;    /* 长尾上限, 不得再大 */
```

**圆角收敛（Fluent：sm 4 / md 8 / lg 8 / xl 8，卡片 8px，pill 保留）** —— 直接改 `Global.scss:59-63`：

```scss
--radius-sm: 4px;     /* 原 8px  */
--radius-md: 8px;     /* 原 12px */
--radius-lg: 8px;     /* 原 16px */
--radius-xl: 8px;     /* 原 20px */
--radius-pill: 999px; /* 不变 */
```

> **⚠ 对原蓝图的一处修正（重要）**
> 蓝图原方案是"在 `style.css` 的 `@theme` 块里覆盖 Tailwind 的 `--radius-*`"。**该方案的前提不成立，已被本计划修正。**
> 事实核查：`Global.scss` 的 `:root` 是**无层（unlayered）**声明，而 Tailwind v4 的主题变量在 `@layer theme` 内。按 CSS 层叠规则，**无层声明优先于任何 layer**。因此项目内所有 `rounded-*` 工具类今天读到的就是 `Global.scss` 的自有令牌 —— `rounded-xl` 实际是 **20px**（不是 Tailwind 默认的 12px），`rounded-lg` 是 16px，`rounded-md` 是 12px。
> **结论：圆角收敛只需改 `Global.scss:59-63` 这一处**，即可全站生效，**无需新增 `@theme` 覆盖块**（原方案里 `--radius-lg: 8px` 是空操作、`--radius-md: 6→8px` 的"方向反了"判断亦属误判）。
> 动工前请用 DevTools 对任一 `rounded-xl` 元素确认一次计算值，以坐实此结论。

配套清理：
- `style.css:63-66` `.glass-card` 的 `rounded-[32px]` → `rounded-lg`（承接 `--radius-lg: 8px`）
- `style.css:33` `--radius-cyber: 32px` → `8px`（基本无引用，仅口径统一）
- `Global.scss:224` 的 `.cyber-button{border-radius:12px}` **随死代码一并删除**（见 P0-3）

> 圆角不参与盒模型，纯视觉，**不存在"压到内部留白或图标"的布局副作用**。
> 令牌消费点核查：`var(--radius-*)` 仅 `Home/StatusBanner.vue:74,84,93,104` 四处直接引用（`radius-lg` ×1、`radius-pill` ×3），其余全部走 Tailwind `rounded-*` 工具类（约 68 处匹配，覆盖 8 个文件）。

---

### 3.1 P0 —— 必修批次

> **落地顺序铁律：P0-1（删 `RightSide.vue` 过渡）必须先于 P0-2（删 magic.min.css）。顺序搞反 = 导航永久卡死。**

#### P0-1 · 删除失效的页面切换过渡
`components/layout/RightSide.vue:15-24,29,38`

- **改法**：删除 `enter` / `leave` 两个函数与 `<transition>` 包装，仅保留 `<Suspense>`。fallback 的加载圈保留，但加 `suspense-spinner` 类供 reduced-motion 豁免。
- **生效参数**：无过渡、无位移、无 keyframes；切换整体静止（评审官裁决：导航属最高频面，**不该动**）。
- **备案件（默认关闭）**：若日后确需柔化，只允许**无 `mode` 的纯 `opacity` 交叉淡入**，且必须是 CSS `transition` 而非 JS 钩子（可中断）：
  ```css
  .v-enter-active, .v-leave-active { transition: opacity var(--dur-fast) var(--ease-out); }
  .v-enter-from, .v-leave-to { opacity: 0; }
  ```
  **整页不得位移**（审计师曾建议的 `translateY(6px)` 方案已由主理人驳回）。
- **验证**：连点侧边导航 10 次，页面瞬时替换、无空等、无卡死；DevTools 确认无 `.swap` 被添加、无 `animationend` 监听。

#### P0-2 · 移除 magic.min.css
`main.ts:4` → 删除 `import './assets/magic.min.css'`。

- **验证**：`grep -rn "magic" src/` 无引用；`npm run dev` 控制台无 404。
- **待决策**：是否物理删除该 33.9KB 文件（见第七节 D2）。

#### P0-3 · 清除三个死类（全删，不保留）
`assets/Global.scss:201-241`

- **改法**：`.glowing-card`、`.active-glow`、`.cyber-button` **三条规则全部删除**。
- **依据**：全库 `*.vue` 模板引用数 = 0。**没有消费者的样式不留** —— 给 `.cyber-button` 保留一份"改造后备用"的写法，等于留下一套无人使用的按钮样式，还会硬编码第二份 `border-radius: 8px` 与令牌重复，正是要走掉的"并行体系"。
- **验证**：全站搜索三个类名无引用；无 `transition: all`、无 `translateY`、无 `box-shadow: 0 0 20px` 残留。

#### P0-4 · 恢复键盘焦点可见性
`assets/Global.scss:168-176`

```scss
/* 鼠标点击不显示焦点框, 键盘导航必须可见 (Fluent 焦点环) */
:where(button, a, [role='button']):focus {
  outline: none;
}
:where(button, a, [role='button']):focus-visible {
  outline: 2px solid var(--color-accent-blue);
  outline-offset: 2px;
}
```

- **用 `:where()` 降特异度**（评审官补充裁定）：原写法特异性为 `(0,1,1)`，会顶掉 Arco 自带按钮的焦点样式；`:where()` 使其降为 `(0,1,0)`（`:focus-visible` 伪类贡献），让 Arco 组件仍可自行覆盖。
- **验证**：纯键盘 Tab 遍历设置页，每个开关/按钮有可见蓝色焦点环；鼠标点击不出现环；Arco 按钮的焦点样式未被覆盖。

#### P0-5 · 导航面去辉光、去无限脉冲
`pages/Main.vue:33,44,50,56,79,84,87`

- 删除两处 `animate-pulse` + `blur-[8px]` 蓝色氛围 `<span>`（`:50`、`:79` 整行删）
- 删除图标上的 `drop-shadow-[0_0_6px_rgba(59,130,246,0.9)]`（`:44`、`:87`），选中态保留 `opacity-100 / opacity-75` 区分
- `:33` 按钮 → `transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);`
- `:56`、`:84` 图标 → `transition: opacity var(--dur-fast) var(--ease-out);`
- **验证**：高频点击导航无脉冲、无辉光；选中态色变 150ms 平滑。

---

### 3.2 P1 —— 应修批次

#### P1-1 · 键盘页：53 个滤镜层收敛到 1 层
`pages/KeyBoard.vue:170,177,189,192,215,246,352`

- 保留 `:177` 溢出层的 `gradient-glow`，**删除 `:192` 按键内 div 上的 `gradient-glow`**（53 → 1 层）
- `:170` 面板 → **删除其 `transition: box-shadow`**（评审官裁定）：`box-shadow` 是重绘类非 GPU 属性，本该由 reduced-motion 块禁止；且该阴影内的辉光按定案要删，过渡将无事可做
- `:177` 溢出层 → **删除其 `transition: opacity`**（评审官裁定）：opacity 不由任何状态改变，是**永不触发的死声明**
- `:189` 按键外 div → 直接删除 `transition-all duration-300`
- `:192` 按键内 div → **删除该过渡**（评审官裁定）：亮度由滑块**连续拖动**产生，连续值挂过渡会让 52 个元素各自"追赶"指针 = 滞后 + 逐帧重绘。与 P2-6「拖拽零过渡」同一条原则
- `:215` 预设卡 → `transition: border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);`
- `:352` 当前色卡 → `transition: background-color var(--dur-base) var(--ease-out);`
- `:246` 运行中状态点 → **删除 `animate-pulse`**，保留静态绿点（见 P1-2 统一裁决）
- **保留项**：`@keyframes gradient-hue` 12s `linear` 循环 —— 它映射真实硬件色轮，属合法状态指示，是评审官明确保留项
- **验证**：开启渐变，DevTools 确认仅 1 个 `filter: hue-rotate` 层在跑；拖亮度滑块无重绘卡顿。

#### P1-2 · 曲线页：状态点去脉冲 + `transition: all` 清理
`pages/FanCurveEditor.vue:369,389,435,462`

```scss
.status-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background-color: #86909c; margin-right: 6px;
  transition: background-color var(--dur-fast) var(--ease-out);
  &.active { background-color: #00b42a; }
}
```

- 删除 `@keyframes pulse`（`:389-399`）与 `.active` 的 `animation` + `box-shadow`
- `.menu-item`、`:deep(.arco-radio-button)` → `transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);`
- **统一裁决（评审官）**：曲线页与键盘页的运行状态点性质相同，**一律删脉冲、保留静态绿点**。颜色已经表达了状态，不需要再动。

#### P1-3 · 设置卡片：移除误导性 hover
`components/common/SettingCardComponent.vue:10`

- **注意**：真实类名是 `.glass-card`（连字符），**不是** `glass_card`。蓝图原稿此处拼写有误，照抄会让 8 张设置卡同时丢掉毛玻璃背景、边框与圆角。
- 改法：删除 `transition-all duration-300` 与 `hover:border-cyber-purple/30 hover:shadow-[0_0_20px_...]`，容器对 hover 完全无响应。
- **验证**：悬停设置卡片无任何边框/阴影/位移变化。

#### P1-4 · 主题选项按钮 + 主题切换过渡
`pages/Settings/components/ThemeSetting.vue:39,42` 与 `theme/theme.ts:52-67`

- `:39` `transition-all` → `transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);`
- `:42` 选中态删除 `shadow-[0_0_10px_var(--color-glow-purple)]`
- 主题切换：只在 `applyResolved()` 里对**根容器**做一次过渡，**严禁对子孙元素批量加 transition**（那正是闪烁来源）：
  ```ts
  root.dataset.theme = resolved
  root.style.transition = 'background-color var(--dur-fast) ease, color var(--dur-fast) ease'
  // 一帧后清空, 避免永久污染 <html> 内联样式
  requestAnimationFrame(() => {
    setTimeout(() => { root.style.transition = '' }, 200)
  })
  ```
- **对原蓝图的修正（评审官）**：原方案"只设不撤"会**永久污染 `<html>` 的内联样式**。必须"先设过渡 → 改 `data-theme` → `transitionend`/兜底定时器后清空"。
- 接受 Mica 场景下该过渡可能不可见（Mica 接管背景后退化）。

#### P1-5 · 标题栏 caption 按钮
`components/layout/TitleBar.vue:65-83` —— **需用户拍板，见第七节 D1**

评审官裁定要点（无论选哪种）：
- 原 `.action-btn{height:50px; width:50px}` + `transition: background-color .2s` 需改
- `46×32` 是 caption 按钮的**最小命中尺寸**，不是"缩在 50px 条里居中"的依据
- **去掉 `border-radius`**：Win11 caption 按钮是直角，`var(--radius-sm)` 用在这里形态不对
- 补 `:active` 按压反馈（120ms `ease`）与 `:focus-visible` 焦点环（`outline-offset: -2px`）
- 保留关闭键 `:hover #e81123`

#### P1-6 · 卡片与按钮的 `transition: all` 清理
`pages/CPU.vue:182,326`、`pages/Fan.vue:107,113`、`pages/GPU.vue:464`

- 卡片 → `transition: color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);`
- 应用按钮 → `transition: background-color var(--dur-fast) var(--ease-out);`，**删除 `shadow-[0_0_15px_rgba(138,43,226,0.3)]` 紫辉光**

#### P1-7 · 补 hover 门禁（直接做，不等决策）
`KeyBoard.vue:160,220` 的 `hover:scale-105` / `group-hover:scale-110` 等

```scss
@media (hover: hover) and (pointer: fine) {
  /* 原有的 hover: 规则移入此处 */
}
```

- **评审官意见：不列为假设、直接做**。成本一行媒体查询，纯收益。触屏点击粘住 hover 态是真实缺陷。

---

### 3.3 P2 —— 机会点批次

#### P2-1 · 温度语义底色 + 阈值滞回
`pages/Home/StatusBanner.vue:74,84,93,104` 与 `utils/temperature.ts`

```scss
.temp-chip {
  border-radius: var(--radius-pill);
  transition: color var(--dur-base) ease, background-color var(--dur-base) ease;
}
```

滞回函数 —— **边界必须取"共享边"**（对原蓝图的重要修正）：

```ts
const GAP = 2
export function tempLevelHys(t: number, prev: TempLevel): TempLevel {
  const lv = tempLevel(t)
  if (prev === lv) return lv
  const order: TempLevel[] = ['cool', 'warm', 'hot', 'critical']
  const i = order.indexOf(lv), p = order.indexOf(prev)
  if (Math.abs(i - p) !== 1) return lv            // 跨 2 档 = 大幅跳变, 直切合理
  const boundary = [70, 80, 90][Math.min(i, p)]!  // 共享边, 不是 [p]
  const dir = i > p ? 1 : -1
  return (t - boundary) * dir >= GAP ? lv : prev
}
```

- **为什么必须改**：用 `p` 只在升温方向正确；降温方向会退化为 `t <= 上一边界 - 2`（几乎恒真）= **滞回空操作**，与"回 cool 需 <68"的设计意图不符。`GAP` 一旦调大，降温退出点会漂移到无意义位置。
- **同屏一致性（评审官补充）**：状态条胶囊按"滞回 level"上色，而同一屏 `CoreMonitoring` 的温度环走 `tempChartColor(真实温度)`，会出现**同温不同色**。需统一色源 —— 要么把 level 也传给温度环，要么两者都走 raw 值。
- **验证**：让温度在 69–71° 间小幅抖动，色块不频繁跳变；跨大阈值 200ms 平滑变色。

#### P2-2 · CPU 实时条改合成属性
`pages/CPU.vue:381-435`（频率 / 电压 / 使用率 / 温度四条）

- **评审官最终裁定：有条件通过**（其首轮的"否掉"已自我推翻 —— `transform-origin` 漏看、圆角系父层裁剪而非填充层自带、轮询实为 5s 非 1s）
- 三条硬护栏：
  1. `origin-left` 必须保留
  2. 填充 div **不得自带 `border-radius`** —— 圆角由父层 `rounded-full` + `overflow-hidden` 裁剪实现，`scaleX` 只被裁剪，永远碰不到圆角；填充层自带圆角才会真变形
  3. 250ms 采纳，在档内
- 分工不冲突：**数值文本继续瞬时**，只有**条**做过渡
- **验证**：每 5s 轮询，条缓动到位不硬跳；低端 GPU 无掉帧。

#### P2-3 · 设置保存成功反馈
`components/common/SettingToggle.vue:39-57`

- **评审官裁定：有条件通过**（低频、一次性、因果明确的合法反馈）
- **两个必须修正的点**：
  1. `.save-flash{border-color:...}` 特异度 `(0,1,0)` 与卡片根上 Tailwind 的 `border-ink/[0.04]` 相同，**无法保证覆盖，高亮可能根本不显示** → 需 `!important` 或改内联样式
  2. 原蓝图参数描述与代码不符：`setTimeout(..., 600)` 实际是"200ms 上 + 400ms 保持 + 200ms 下"，不是"200ms 高亮一次"。**二选一写清，别把歧义留给实现**
- 约束：只做一次不自循环；只动 `border-color` 的颜色成分，不叠加紫辉光；失败态需与成功态有区别
- **验证**：拨动开关并保存，卡片边框蓝亮一次后恢复。

#### P2-4 · 关闭 ECharts 更新动画
`pages/Home/CoreMonitoring.vue:20-66`、`pages/Home.vue:202-249`

- 在 `getRingOption` 返回对象根与 `lineChartOption` 根各加 `animation: false, animationDurationUpdate: 0`
- **理由**：ECharts 画布是 Canvas 自绘，不受 CSS transition 影响，只能由自身配置控制。当前每次 `computed` 重建 option 都会触发默认入场动画，2–5s 刷新一次 = 动画永远在"追"。
- **验证**：数值刷新时图形瞬时到位、无补间追赶。

#### P2-5 · 删除装饰性小点
`components/common/FanSpeed.vue:170`、`pages/Home.vue:334`

- `FanSpeed.vue:170` 删 `animate-pulse` span；`Home.vue:334` 去掉 `animate-spin` 与 `style="animation-duration:3s"`

#### P2-6 · 拖拽跟手保持零过渡（不要改）
`pages/FanCurveEditor.vue:163-195`

- **保持现状，严禁为拖拽节点/折线加任何 `transition`**。仅可加 `cursor: grabbing` 静态态。
- **理由**：拖拽需 1:1 映射指针位置，任何过渡都会引入"目标值追赶"延迟，指针停而图形仍在补间，产生迟滞与误判。

---

### 3.4 全局 `prefers-reduced-motion` 块

新增到 `assets/Global.scss`：

```scss
/* 减弱动效: 保留 opacity / 颜色过渡, 关闭位移 / 脉冲 / hue 循环 / 拖拽跟随
 * —— 更少更轻, 而非归零 (标准 #8)
 * 注意: 本块用 `*` + !important 收窄 transition-property, 是钝器。
 * 往核心交互加 transform/width 依赖前, 请先确认此处不会静默改行为。 */
@media (prefers-reduced-motion: reduce) {
  /* 1. 关闭所有无限 / 装饰性动画 */
  [class*='animate-']:not(.suspense-spinner),
  .gradient-glow,
  .status-dot {
    animation: none !important;
  }

  /* 2. 仅保留 opacity / 颜色系过渡 */
  *,
  *::before,
  *::after {
    transition-property: color, background-color, border-color, outline-color, opacity, fill !important;
    scroll-behavior: auto !important;
  }
}
```

- **对原蓝图的修正**：原稿只按 `[class*='animate-pulse']` / `animate-spin` 列举，Tailwind 的 `animate-bounce` / `animate-ping` **不会被关**。改为 `[class*='animate-']:not(.suspense-spinner)` 全覆盖。
- **被接管的动效**：键盘 `.gradient-glow` 12s hue 循环 → 停在末色；曲线页 `.status-dot` → 关；`FanSpeed.vue:170`、`RyzenSmu.vue:527,532`、`KeyBoard.vue:246` 的 pulse → 关；`Home.vue:334` 风扇 spin → 关。
- **豁免**：`<Suspense>` 加载圈因 `.suspense-spinner` 豁免，保留必要的加载反馈。
- **已验证**：`outline-color` 收窄**不影响**焦点环渲染（`outline: 2px solid …` 不依赖过渡）。
- **"保留 opacity/颜色 vs 全部归零"** —— 评审官确认前者更符合标准。

---

## 四、落地顺序与硬约束

1. **P0-1 必须先于 P0-2**（删 `RightSide.vue` 过渡 → 再删 magic 包）。反之导航永久卡死。
2. **P0-4（焦点环）应独立成一个小改动尽早合入**，它不与任何其他项耦合，且是唯一的无障碍硬伤。
3. **P0-3 与 3.0 的圆角收敛改同一文件（`Global.scss`）**，建议合并为一次提交，避免同文件反复冲突。
4. `magic.min.css` 的物理删除（若有）**放最后**，作为清理批次，与行为变更解耦。
5. **P2-6 是"不许改"的保护性条款** —— 实施 P2-2 时容易顺手给拖拽节点也加过渡，需在 PR 描述里显式声明。

---

## 五、与 `06` 文档的关系（范围边界）

本计划覆盖的是 **动效与交互反馈层**（曲线、时长、属性选择、中断性、reduced-motion、焦点可见性）。

`06_技术栈与UX审查结论.md` 里的 P0–P4（Mica 外壳、去 AI 味令牌重建、仪表盘重做、状态联动外观、运行日志）属**视觉与架构层**，不在本计划范围。两者的交界面是：

- **辉光 / hover 上浮 / `transition: all`** —— 既是"AI 味"，也是动效缺陷，本计划一并清除（H3 / M3 / M7）。
- **紫罗兰主色本身** —— 属视觉层，**本计划不碰**（只撤掉它的 transition 与辉光阴影）。评审官提醒：不要让"transition 与辉光已撤、主色仍是紫"的半吊子状态跨过一整个迭代。
- **背景渐变光晕**（`style.css:41-57`、`Main.vue:105-109`）—— 属视觉层，但它决定了主题过渡（P1-4）的目标是否可见；Mica 接入前不建议提前优化。
- **ECG 假心电图** —— 属功能删除。**动效裁决：应删**（10Hz 常驻装饰循环 = 持续占主线程 + 白耗电，属"环境性装饰动效 + 高频常驻"应删类）。建议单独立项。

---

## 六、遗留项与需人眼验证的部分

### 6.1 动效裁决已明确「应删」但超出本计划执行范围的
- ECG 假心电图（`Home.vue:110-123,153,350-379`）—— 建议单独立项，标注"动效裁决：删除"

### 6.2 本计划明确不做
- Arco 内置动效 token 覆盖（switch / modal / message / radio）—— 列为后续 issue
- Mica 接入后的背景与主题过渡适配 —— 真机实测前不提前优化
- 紫罗兰主色 / 渐变按钮的视觉替换 —— 属视觉层

### 6.3 代码判断不了、必须人眼或真机确认的

| 项目 | 验证方法 |
|---|---|
| 主题切换 150ms 根层过渡的实际观感 | 把时长临时放大 2–5 倍（`--dur-fast: 500ms`），切换主题观察是否存在逐元素级联闪烁；确认无闪烁后改回 |
| 53 → 1 层 hue-rotate 的收益 | DevTools Performance 录制，对比开启渐变前后的帧时间与滤镜重绘次数 |
| reduced-motion 下 Arco switch / modal 的观感 | 在系统开启"减弱动态效果"后实测这两个组件的入场，确认没有被"压扁"到难以理解 |
| Mica 叠加下的主题过渡可见性 | 需 P1（`06` 文档的外壳原生化）接入 DWM backdrop 后，真机切换主题观察 |
| 温度胶囊 200ms 色变 + 滞回的手感 | 让机器在阈值附近自然波动（跑一段负载），确认色块不闪；2°C 间隙若仍抖则加大到 3°C |
| 拖拽跟手是否真的零延迟 | 真机拖动风扇曲线节点，快速甩动观察有无"追赶"补间 |
| 进度条 250ms 的占空比观感 | 在 5s 轮询下肉眼确认不是"一直在动" |
| 焦点环与 Arco 自带焦点样式的叠加 | 纯键盘 Tab 遍历全站，确认 `:where()` 降特异度后 Arco 组件样式未被顶掉 |

> 通用方法：**把时长放慢 2–5 倍看**、用 DevTools 动画检查器逐帧步进、手势类必须在真机上试。建议次日换新眼睛再看一遍。

---

## 七、需用户拍板的决策点

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| **D1** | **标题栏 caption 按钮形态** | **A**：把 `.title-bar` 从 50px 收到 32px，按钮高度填满、直角、贴右上角（真 Fluent，但会改变整体观感与 logo 行）<br>**B**：`.title-bar` 保持 50px，按钮改为 `height: 100%` + 去掉圆角（改动最小） | **B**（低风险，不改视觉身份）；把 A 作为后续跟随"外壳原生化"（`06` 文档 P1）一并处理。**无论选哪种，都不要维持现状的"50px 条里居中一个 32px 圆角按钮"** |
| **D2** | `magic.min.css` 是否物理删除 | 仅取消 import（留文件待清理）／一并删掉 33.9KB 文件 | **物理删除**，与 import 移除同一提交，避免留一个"没人引用但会被误用"的文件 |
| **D3** | 圆角收敛到 8px 的观感接受度 | 全站卡片由 12/16/20px 统一收到 8px | **建议接受**。圆角不参与盒模型、无布局副作用；若个别组件需保留大圆角，改为在该组件写 `rounded-[Npx]` 任意值单独豁免，不要为此保留旧的令牌体系 |

> 另：`06` 文档中的 P1（Mica 外壳原生化）未在本计划执行范围内，但它会直接影响 P1-4 主题过渡与背景光晕的取舍。若决定先做 Mica，建议 **Mica 先行、本计划随后**，避免主题过渡做两遍。

---

## 八、本轮复审的遗留问题（供下一轮跟踪）

评审官 Phase 3 复审判定为**打回**，7 条缺陷已全部并入本计划（P0-3 死类全删、P1-1 三处过渡删除、P1-3 类名拼写、P1-5 尺寸与圆角、P2-1 边界取共享边、P2-3 特异度与时序、P1-2 状态点统一）。此外还有 2 条补充裁定已并入（P0-4 用 `:where()`、P1-7 hover 门禁直接做）。

仍未闭环、需在下轮确认的：

1. **圆角收敛的层叠结论**（第 3.0 节）—— 本计划基于 CSS 层叠规则推定为"`Global.scss` 单点改动即全站生效"，**动工前需用 DevTools 实测一次计算值坐实**。
2. **温度色的同屏一致性**（P2-1）—— 滞回 level 与 raw 温度两套色源需统一，方案未定。
3. **`--radius-pill` 的保留** —— 已按评审官意见保留（胶囊/状态点仍用 pill），如与 Fluent 形态冲突需另行评估。

---

## 九、执行记录（2026-09-11）

### 9.1 决策落地

三项决策均按建议执行：**D1** = 保持 `.title-bar` 50px，按钮改 `height: 100%`、去圆角；**D2** = `assets/magic.min.css` 已物理删除；**D3** = 圆角全站收敛到 8px。

### 9.2 批次结果

| 批次 | 内容 | 状态 |
|---|---|---|
| 3.0 令牌 | `Global.scss :root` 新增 3 曲线 + 4 档时长；圆角收敛 sm4/md8/lg8/xl8；`style.css` 的 `.glass-card` → `rounded-lg` | ✅ |
| P0-1 | `RightSide.vue` 删除失效 `<transition>` 与 `enter`/`leave`，保留 `<Suspense>` 并加 `suspense-spinner` | ✅ |
| P0-2 | `main.ts` 移除 import；`magic.min.css`（33.9KB）物理删除，全库无残留引用 | ✅ |
| P0-3 | `.glowing-card` / `.active-glow` / `.cyber-button` 三个死类全删（留注释说明原写法，防被恢复） | ✅ |
| P0-4 | 焦点环用 `:where()` 降特异度恢复，`outline: 2px solid var(--color-accent-blue)` | ✅ |
| P0-5 | `Main.vue` 导航去 `animate-pulse` 光斑、去 `drop-shadow` 辉光，过渡改 `.nav-btn`/`.nav-icon` 令牌类 | ✅ |
| P1-1 | `KeyBoard.vue` 滤镜层 **53 → 1**；6 处 `transition-all` 清理；`:192` 按键内层过渡删除（连续拖拽值） | ✅ |
| P1-2 | `FanCurveEditor.vue` 删 `@keyframes pulse` 与状态点辉光；`.menu-item` / Arco radio 过渡改令牌 | ✅ |
| P1-3 | `SettingCardComponent.vue` 移除误导性 hover（类名确认为 `.glass-card`，蓝图的 `glass_card` 拼写错误未照抄） | ✅ |
| P1-4 | `ThemeSetting.vue` 去辉光；`theme.ts` 根层单次过渡 + `transitionend`/300ms 兜底清空内联样式 | ✅ |
| P1-5 | `TitleBar.vue` caption 按钮 46×宽 / 填满高度 / 直角 / 120ms 按压 / 焦点环 | ✅ |
| P1-6 | `CPU.vue`、`Fan.vue`、`GPU.vue` 卡片与按钮 `transition-all` 清理、紫辉光移除 | ✅ |
| P1-7 | `KeyBoard.vue` hover 门禁 `@media (hover:hover) and (pointer:fine)` | ✅ |
| P2-1 | 温度滞回 `tempLevelHys()`（共享边 + 2°C 间隙）；档位在 `Home.vue` 顶层判定后下传，**同屏色源统一** | ✅ |
| P2-2 | `CPU.vue` 四个实时条改 `transform: scaleX()` + `origin-left` + 250ms；填充层不带圆角 | ✅ |
| P2-3 | `SettingToggle.vue` 保存结果一次性边框提示（成功蓝 / 失败红） | ✅ |
| P2-4 | `CoreMonitoring.vue` 与 `Home.vue` 的 ECharts 均设 `animation: false, animationDurationUpdate: 0` | ✅ |
| P2-5 | 删 `FanSpeed.vue` 装饰脉冲点、`Home.vue` 风扇 `animate-spin` | ✅ |
| P2-6 | 拖拽保持零过渡（保护性未改动，已核实无 transition 残留） | ✅ |
| 3.4 | 全局 `@media (prefers-reduced-motion: reduce)` 块，`[class*='animate-']:not(.suspense-spinner)` 全覆盖 | ✅ |

### 9.3 构建校验

`npm run build`（`vue-tsc --build` + `vite build`）**通过，无类型错误**。产物 `index-DVKfD1gf.css`（222,257 字节）内：

- `--ease-out` / `--dur-*` / `--radius-xl:8px` / `--radius-sm:4px` 均在位
- `prefers-reduced-motion` 块在位
- `translateY(-2px)` = **0 处**（hover 上浮已彻底清除）
- **残留 `transition:all` 14 处，经逐条核对全部来自 Arco Design 自带样式**（`.arco-*`，曲线为 Arco 自有的 `cubic-bezier(0,0,1,1)` / `.3,1.3,.3,1`），非本项目代码 —— 对应第 6.2 节「Arco 内置动效覆盖」后续 issue

### 9.4 对计划的三处偏离（均已说明理由）

1. **`TitleBar.vue` 的 `.action-btn` 由 `div` 改为真 `<button>`**（并补 `aria-label`）。理由：`div` 不可聚焦，仅加 `:focus-visible` 是**惰性代码**——计划 P1-5 想要的"补焦点环"根本无法生效。换成 `<button>` 后焦点环与键盘可用性才真正成立。这是让计划目标可达的必要改动，不是范围扩大。
2. **`KeyBoard.vue` 的"应用"按钮、`FanCurveEditor.vue` 的 Arco radio 选中态也一并去辉光**。理由：计划 P1-6 只列了 CPU/Fan/GPU，但这三处与 P1-6 属**同一缺陷类**（同一段紫辉光 `rgba(138,43,226,*)`），分两次做会留下不一致状态；P1-1 本身已在改 KeyBoard 页。
3. **P2-3 用内联 `:style` 而非 CSS 类给 `border-color`**。理由：评审官指出类选择器与卡片根上 Tailwind 的边框色特异度相同、存在覆盖失败导致提示不显示的风险；他给出的两个选项里"改内联样式"必然会生效，故取此路（未用 `!important`）。

另有一项**有意不采纳评审官子建议**：P2-3 的 reduced-motion 行为。评审官建议"减弱模式下退化为瞬时变色"，但全局 reduce 块的设计是**保留颜色类过渡、只关位移/脉冲/hue**；且该块用 `transition-property: ... !important`（钝器），单组件反向覆盖反而需要再加 `!important`。为保持策略统一，这里在减弱模式下仍是 200ms 变色（不闪烁），已在组件注释中写明。

### 9.5 有意保留（未改动）与理由

| 项 | 位置 | 保留理由 |
|---|---|---|
| `animate-pulse`「检测中…」 | `RyzenSmu.vue:527,532` | 瞬时加载态，与 Suspense 加载圈同类，属合法反馈 |
| Suspense 加载圈 | `RightSide.vue` | 同上；`.suspense-spinner` 在 reduce 下豁免 |
| `@keyframes gradient-hue` 12s | `KeyBoard.vue` | 映射真实硬件色轮，评审官明确保留项 |
| 分色 Slider 拖拽钮辉光 | `style.css`、`KeyBoard.vue`、`RyzenSmu.vue` | 跨 5 页一致的"紫/蓝/红/橘分色"视觉系统，属**视觉层**（第五节范围边界） |
| 背景 `radial-gradient` 光晕 | `Main.vue:84,88`、`style.css:41-57` | 视觉层；且其去留受 Mica 是否接管背景影响 |
| GPU.vue 注释中的 3 处 `transition-all` | `GPU.vue:382,393,589` | 注释掉的备选实现，属死代码但非本次范围。**风险**：日后取消注释会把缺陷带回来 |

### 9.6 执行中附带发现（超出本计划范围，建议单独处理）

1. **`WebRoot` 构建不清空目录**：`vite build` 提示 `outDir ... is not inside project root and will not be emptied`，`bin/publish/WebRoot/assets/` 已累积 **7 个**历史 `index-*.css`。`index.html` 只引用最新哈希，实际是死重。建议给 `vite.config` 加 `emptyOutDir: true` 或在打包脚本里先清目录。
2. **Arco 自带动效语言未覆盖**：14 处 `transition:all` + Arco 自有缓动曲线（含 `.3,1.3,.3,1` 过冲曲线）。对应第 6.2 节后续 issue。
3. **ECG 假心电图仍原样保留**：`Home.vue:110-123,153,350-379`（10Hz 常驻装饰循环）。动效裁决为"应删"，但按第 6.1 节作为独立立项处理，本次未动其逻辑。

### 9.7 待人工 / 真机验证

见第 6.3 节表格，共 8 项。其中**必须真机跑**的是：主题切换根层过渡的观感、53→1 层 hue-rotate 的帧收益、reduced-motion 下 Arco switch/modal 的观感、温度滞回在真实负载下是否仍抖（2°C 不足则加到 3°C）、拖拽跟手零延迟、进度条 250ms 占空比观感、焦点环与 Arco 自带焦点样式是否叠加冲突。
