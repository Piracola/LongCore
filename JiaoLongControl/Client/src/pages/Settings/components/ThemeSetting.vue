<script setup lang="ts">
import { computed, onMounted } from 'vue'
import SettingCardComponent from '@/components/common/SettingCardComponent.vue'
import { useConfigStore } from '@/stores/config'
import { applyTheme } from '@/theme/theme'
import type { ThemeMode } from '@/types/config'

const configStore = useConfigStore()
onMounted(() => configStore.fetchConfig())

const options: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '白色主题' },
  { value: 'dark', label: '深色主题' },
  { value: 'system', label: '跟随系统' },
]

// 配置未加载完成前按默认"跟随系统"展示
const current = computed(() => configStore.config?.App.Theme ?? 'system')

function select(mode: ThemeMode) {
  if (!configStore.config || current.value === mode) return
  configStore.config.App.Theme = mode
  // 即时生效; applyTheme 内部会同步 WPF 窗口底色与 localStorage 防闪烁缓存
  applyTheme(mode)
  configStore.debouncedSave()
}
</script>

<template>
  <setting-card-component
    title="界面主题"
    description="选择软件界面配色：白色主题、深色主题，或跟随 Windows 系统深浅色模式自动切换（默认），切换后立即生效。"
  >
    <template #extra>
      <div class="flex items-center gap-1 p-1 rounded-xl bg-ink/[0.04] border border-ink/[0.06]">
        <button
          v-for="opt in options"
          :key="opt.value"
          class="theme-opt px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
          :class="current === opt.value ? 'seg-selected' : 'text-muted hover:text-ink'"
          @click="select(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </template>
  </setting-card-component>
</template>

<style scoped lang="scss">
/* 主题选项胶囊: 底色/字色 + 按压缩放。选中态去辉光(原 shadow-[0_0_10px_紫])。 */
.theme-opt {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}

.theme-opt:active {
  transform: scale(0.97);
}
</style>
