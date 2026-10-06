<script setup lang="ts">
import { computed, onMounted } from 'vue'
import SettingCardComponent from '@/components/common/SettingCardComponent.vue'
import { useConfigStore } from '@/stores/config'
import type { LogLevelName } from '@/types/config'

const configStore = useConfigStore()
onMounted(() => configStore.fetchConfig())

const log = computed(() => configStore.config?.Log)

const levels: Array<{ value: LogLevelName; label: string; hint: string }> = [
  {
    value: 'DEBUG',
    label: '详细',
    hint: '记录所有细节，日志文件最大。排查故障时使用',
  },
  {
    value: 'INFO',
    label: '常规',
    hint: '推荐。记录温度调节、保护动作和所有错误',
  },
  { value: 'WARN', label: '精简', hint: '只记录警告和错误，日志文件最小' },
  { value: 'ERROR', label: '仅错误', hint: '只记录错误' },
  { value: 'OFF', label: '不记录', hint: '不写日志文件' },
]

const currentLevel = computed<LogLevelName>(() => log.value?.Level ?? 'INFO')
const commandDebug = computed(() => log.value?.CommandDebug ?? false)
const currentHint = computed(() => levels.find((l) => l.value === currentLevel.value)?.hint ?? '')

function pickLevel(value: LogLevelName) {
  if (!configStore.config || currentLevel.value === value) return
  configStore.config.Log.Level = value
  configStore.debouncedSave()
}

function toggleCommandDebug() {
  if (!configStore.config) return
  configStore.config.Log.CommandDebug = !commandDebug.value
  configStore.debouncedSave()
}
</script>

<template>
  <setting-card-component title="日志记录级别" :description="currentHint + '。修改后立即生效。'">
    <template #extra>
      <div class="seg-group">
        <button
          v-for="opt in levels"
          :key="opt.value"
          class="seg-opt px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
          :class="currentLevel === opt.value ? 'seg-selected' : 'text-muted hover:text-ink'"
          @click="pickLevel(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </template>
  </setting-card-component>

  <setting-card-component
    title="记录读取明细"
    description="把每一次硬件数据读取都写进日志。这类内容占了日志的绝大部分，正常情况下建议关闭；只有遇到读数异常、需要交给开发者排查时才打开。"
  >
    <template #extra>
      <a-switch :model-value="commandDebug" @change="toggleCommandDebug"></a-switch>
    </template>
  </setting-card-component>
</template>

<style scoped lang="scss">
/* 与主题设置的分段胶囊保持一致: 底色/字色 + 按压缩放, 无辉光。 */
.seg-group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-md);
  background: var(--color-overlay);
  border: 1px solid var(--hair-strong);
}

.seg-opt {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}

.seg-opt:active {
  transform: scale(0.97);
}
</style>
