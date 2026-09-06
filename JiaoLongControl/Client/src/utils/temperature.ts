// 温度语义色阶(中文语境: 升温=红):
// ≤70° 蓝(cool) → 70–80° 青(warm) → 80–90° 橙(hot) → >90° 红(critical)
//
// CSS 侧返回 var() 引用, 由 Global.scss 按主题给值, 自动适配深浅色;
// ECharts(zrender) 自行解析颜色, 不支持 CSS 变量, 图表上下文用
// tempChartColor() 取当前主题下的具体色值。
import { resolvedTheme } from '@/theme/theme'

export type TempLevel = 'cool' | 'warm' | 'hot' | 'critical'

export function tempLevel(t: number): TempLevel {
  if (t <= 70) return 'cool'
  if (t <= 80) return 'warm'
  if (t <= 90) return 'hot'
  return 'critical'
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
