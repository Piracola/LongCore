<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useModeStore } from '@/stores/mode'
import { useSystemInfoStore } from '@/stores/systemInfo'
import { useFanStore } from '@/stores/fan'
import { applyTheme } from '@/theme/theme'

const systemInfoStore = useSystemInfoStore()
const configStore = useConfigStore()
const modeStore = useModeStore()
const fanStore = useFanStore()

/** 冷启动读当前固件档位/自定义覆盖，点亮胶囊。桥未就绪时短重试。 */
async function hydratePerformanceMode() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (await modeStore.refreshObserved()) return
    } catch {
      /* 桥接尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
  }
}

let stopPolling: () => void
let stopFanPolling: () => void

function hideAppLoader() {
  const loader = document.getElementById('app-loader')
  if (loader) {
    loader.classList.add('fade-out')
    setTimeout(() => {
      loader.remove()
    }, 450)
  }
}

function onWebViewMessage(e: MessageEvent) {
  try {
    const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    if (!data || typeof data !== 'object') return
    const type = (data as { type?: string }).type
    if (type === 'config-changed') {
      configStore.refresh()
      return
    }
    // Fn / 固件档位变化：任意页面都要同步胶囊，不能只挂在首页
    if (type === 'mode-changed' && typeof (data as { mode?: unknown }).mode === 'number') {
      modeStore.applyHotkeyMirror((data as { mode: number }).mode)
    }
  } catch {
    // 来自 WebView2 外部消息, 非 JSON 时忽略
  }
}

// 主题跟随配置(含 config-changed 触发的 refresh); 配置拉取失败时保持
// index.html 内联脚本按 localStorage 缓存设置的主题
watch(
  () => configStore.config?.App.Theme,
  (mode) => {
    if (mode) applyTheme(mode)
  },
)

onMounted(() => {
  stopPolling = systemInfoStore.startPolling()
  // 风扇转速 + 曲线服务状态常驻：与温度历史同理，切页不再让读数假死
  stopFanPolling = fanStore.startMonitoring()
  window.chrome?.webview?.addEventListener('message', onWebViewMessage)
  // 主动拉取一次配置以尽早应用主题(fetchPromise 去重, 不会与页面内请求重复)
  void configStore.fetchConfig()
  void hydratePerformanceMode()
  setTimeout(() => {
    hideAppLoader()
  }, 300)
})

onUnmounted(() => {
  if (stopPolling) {
    stopPolling()
  }
  if (stopFanPolling) {
    stopFanPolling()
  }
  window.chrome?.webview?.removeEventListener('message', onWebViewMessage)
})
</script>

<template>
  <Suspense>
    <template #default>
      <router-view class="app-view"></router-view>
    </template>
    <template #fallback>
      <div class="loading-state">
        <div class="loading-orb" aria-hidden="true"></div>
        <span class="loading-label">Loading Hardware Info...</span>
      </div>
    </template>
  </Suspense>
</template>

<style>
body {
  margin: 0;
  overflow: hidden;
  font-family: 'Inter', 'Segoe UI', sans-serif;
}

.app-view {
  user-select: none;
  width: 100vw;
  height: 100vh;
}

/* Suspense fallback: 与 index.html 启动 loader 同色语汇, 但更轻量。
 * 不用无限辉光/双环 —— 那是首次启动的 rare 时刻; 这里只是路由/硬件信息等待。 */
.loading-state {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 12px;
  height: 100vh;
  color: var(--color-text-muted);
  background-color: var(--color-bg-primary);
}

.loading-orb {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: var(--accent);
  border-right-color: var(--accent-line);
  animation: loading-spin 0.8s linear infinite;
}

.loading-label {
  font-size: 12px;
  letter-spacing: 0.5px;
}

@keyframes loading-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-orb {
    animation-duration: 1.6s;
  }
}
</style>
