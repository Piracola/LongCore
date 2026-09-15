// 温度语义色阶(中文语境: 升温=红):
// ≤70° 蓝(cool) → 70–80° 青(warm) → 80–90° 橙(hot) → >90° 红(critical)
//
// CSS 侧返回 var() 引用, 由 Global.scss 按主题给值, 自动适配深浅色;
// ECharts(zrender) 自行解析颜色, 不支持 CSS 变量, 图表上下文用
// tempChartColor() 取当前主题下的具体色值。
import { resolvedTheme } from '@/theme/theme'

export type TempLevel = 'cool' | 'warm' | 'hot' | 'critical'

export const TEMP_ORDER: TempLevel[] = ['cool', 'warm', 'hot', 'critical']

/** 分档边界, 与 tempLevel() 的 <=70 / <=80 / <=90 一一对应 */
const TEMP_BOUNDS = [70, 80, 90] as const

/** 滞回间隙(°C): 进/出阈值分离的宽度 */
export const TEMP_HYSTERESIS_GAP = 2

export function tempLevel(t: number): TempLevel {
  if (t <= 70) return 'cool'
  if (t <= 80) return 'warm'
  if (t <= 90) return 'hot'
  return 'critical'
}

/**
 * 带滞回的档位判定 —— 防止温度在阈值附近抖动时底色持续闪烁。
 *
 * 纯 tempLevel() 在 70/80/90 处是"单边门槛", 温度在 69↔71 之间来回时
 * 每帧都会翻档, 配合 200ms 底色过渡就是肉眼可见的持续闪色。
 * 这里把"进"和"出"的阈值分开(间隙 GAP °C): 例如进 warm 需 >72, 回到 cool 需 <68。
 *
 * 跨 2 档以上视为温度大幅跳变, 不存在抖动风险, 直接切换。
 *
 * @param prev 上一次的档位(调用方需持有该状态, 因此本函数不是纯函数)
 */
export function tempLevelHys(t: number, prev: TempLevel, gap = TEMP_HYSTERESIS_GAP): TempLevel {
  const next = tempLevel(t)
  if (prev === next) return next
  const i = TEMP_ORDER.indexOf(next)
  const p = TEMP_ORDER.indexOf(prev)
  if (Math.abs(i - p) !== 1) return next
  // 相邻档之间的边界取两者的"共享边"(min), 不是 prev 自己的边
  const boundary = TEMP_BOUNDS[Math.min(i, p)]!
  const dir = i > p ? 1 : -1
  return (t - boundary) * dir >= gap ? next : prev
}

/** CSS 用: 返回语义色变量引用, 如 var(--temp-hot) */
export function tempVar(t: number): string {
  return `var(--temp-${tempLevel(t)})`
}

/** CSS 用: 返回语义色低透明度底色变量引用, 如 var(--temp-hot-bg) */
export function tempBgVar(t: number): string {
  return `var(--temp-${tempLevel(t)}-bg)`
}

/** ECharts 用: 各主题下的具体色值(与 Global.scss 中 --temp-* 保持一致) */
export const TEMP_CHART_COLORS = {
  dark: {
    cool: '#60a5fa',
    warm: '#22d3ee',
    hot: '#fb923c',
    critical: '#f87171',
  },
  light: {
    cool: '#2563eb',
    warm: '#0891b2',
    hot: '#ea580c',
    critical: '#dc2626',
  },
} as const

export function tempChartColor(t: number): string {
  return TEMP_CHART_COLORS[resolvedTheme.value][tempLevel(t)]
}

/** ECharts 用: 按"已判定档位"取具体色值。
 * 用于与状态条胶囊共享同一档位来源, 避免同屏出现"同温不同色" */
export function tempChartColorByLevel(level: TempLevel): string {
  return TEMP_CHART_COLORS[resolvedTheme.value][level]
}

/** CSS 用: 按"已判定档位"取语义色变量引用 */
export function tempVarByLevel(level: TempLevel): string {
  return `var(--temp-${level})`
}

/** CSS 用: 按"已判定档位"取语义色低透明度底色变量引用 */
export function tempBgVarByLevel(level: TempLevel): string {
  return `var(--temp-${level}-bg)`
}
