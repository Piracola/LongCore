// 三态主题(ligh/dark/system)解析与应用。
// 解析结果写入 <html data-theme="light|dark"> 驱动 CSS 变量切换, 并缓存到
// localStorage 供 index.html 内联脚本在 Vue 启动前抢先设置, 避免浅色用户
// 启动时闪深色屏。配置文件(config.App.Theme)是唯一事实来源, localStorage
// 只是启动期的缓存。
import { computed, ref } from 'vue'
import type { ThemeMode } from '@/types/config'

const THEME_STORAGE_KEY = 'jl-theme'

export const resolvedTheme = ref<'light' | 'dark'>('dark')

// echarts(zrender) 自身解析颜色, 不支持 CSS 变量/color-mix, 图表配色在此按主题给值;
// 图表配置的 computed 引用本对象即可在主题切换时自动重绘
export const chartTheme = computed(() =>
  resolvedTheme.value === 'light'
    ? {
        legend: '#5a6478',
        axis: '#8a93a5',
        line: 'rgba(13, 14, 21, 0.16)',
        band: ['rgba(13, 14, 21, 0.035)', 'transparent'] as [string, string],
        label: '#1a1b26',
        cross: 'rgba(8, 145, 178, 0.9)',
        tooltipBg: 'rgba(255, 255, 255, 0.94)',
        tooltipBorder: 'rgba(13, 14, 21, 0.12)',
      }
    : {
        legend: '#A0AEC0',
        axis: '#8B93A7',
        line: 'rgba(255, 255, 255, 0.14)',
        band: ['rgba(255, 255, 255, 0.04)', 'transparent'] as [string, string],
        label: '#FFFFFF',
        cross: 'rgba(34, 211, 238, 0.95)',
        tooltipBg: 'rgba(16, 18, 26, 0.94)',
        tooltipBorder: 'rgba(255, 255, 255, 0.12)',
      },
)

let mediaQuery: MediaQueryList | null = null
let currentMode: ThemeMode = 'dark'

// 主题切换过渡: 只在 <html> 根层做一次 background-color/color 过渡。
// 严禁对子孙元素批量加 transition —— 那才是"全站级联闪烁"的来源。
// 另一个坑: transition 若只设不撤, 会永久污染 <html> 的内联样式,
// 因此过渡结束(或兜底超时)后必须清空。
let themeTransitionTimer: number | null = null

function runThemeTransition() {
  const root = document.documentElement
  root.style.transition = 'background-color var(--dur-fast) ease, color var(--dur-fast) ease'
  // 强制一次样式重算, 确保 transition 属性已进入 before-change style
  void root.offsetHeight
  if (themeTransitionTimer !== null) window.clearTimeout(themeTransitionTimer)
  const clear = () => {
    root.style.transition = ''
    if (themeTransitionTimer !== null) {
      window.clearTimeout(themeTransitionTimer)
      themeTransitionTimer = null
    }
  }
  root.addEventListener('transitionend', clear, { once: true })
  // 兜底: 若背景不参与过渡(如 Mica 接管窗口背景)导致 transitionend 不触发
  themeTransitionTimer = window.setTimeout(clear, 300)
}

function readStoredTheme(): 'light' | 'dark' | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersDark() ? 'dark' : 'light'
}

function applyResolved(resolved: 'light' | 'dark', animated = false) {
  if (animated) runThemeTransition()
  resolvedTheme.value = resolved
  document.documentElement.dataset.theme = resolved
  // Arco Design 组件(switch/select/modal 等)跟随主题: 暗色挂 arco-theme 属性,
  // 浅色移除(Arco 默认即浅色); 配合 Global.scss 中的 Arco 变量对齐块
  if (resolved === 'dark') {
    document.body.setAttribute('arco-theme', 'dark')
  } else {
    document.body.removeAttribute('arco-theme')
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, resolved)
  } catch {
    /* localStorage 不可用时跳过缓存 */
  }
}

function onSystemChange() {
  if (currentMode === 'system') {
    applyResolved(resolve('system'), true)
  }
}

// 模块加载时先用缓存恢复一次(与 index.html 内联脚本设置的 data-theme 保持一致),
// 无缓存时跟随系统深浅色; 保证 canvas 绘图等 JS 逻辑在首帧前就能拿到正确的主题。
// 注意: 首帧恢复不加过渡(否则启动瞬间会看到一次整屏渐变)。
applyResolved(readStoredTheme() ?? resolve('system'))

export function applyTheme(mode: ThemeMode) {
  currentMode = mode
  if (!mediaQuery) {
    mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
    mediaQuery?.addEventListener('change', onSystemChange)
  }
  const resolved = resolve(mode)
  applyResolved(resolved, true)
  // 通知 WPF 侧同步窗口背景 / WebView2 底色(浏览器开发环境无 webview 时静默跳过)
  window.chrome?.webview?.postMessage(`theme-changed:${resolved}`)
}
