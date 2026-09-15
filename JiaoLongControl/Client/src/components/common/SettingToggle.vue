<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import SettingCardComponent from '@/components/common/SettingCardComponent.vue'
import { useConfigStore } from '@/stores/config'

const props = defineProps<{
  title: string
  description: string
  /** config JSON 内的布尔字段路径, 如 "App.BootAdvancedCPUSystem" */
  configPath: string
}>()

const configStore = useConfigStore()
const loading = ref(false)

/** 保存结果的一次性卡片提示(成功=强调蓝 / 失败=红), null = 无提示 */
const flash = ref<'success' | 'error' | null>(null)
let flashTimer: number | null = null

function flashCard(state: 'success' | 'error') {
  if (flashTimer !== null) window.clearTimeout(flashTimer)
  flash.value = state
  // 一次性提示的完整时序: 200ms 渐入 → 持有 400ms → 200ms 渐出, 合计约 800ms。
  // 只触发一次, 不循环。
  flashTimer = window.setTimeout(() => {
    flash.value = null
    flashTimer = null
  }, 600)
}

// 用内联样式而非 CSS 类来给 border-color: 卡片根上的边框色来自 style.css 的
// .glass-card(@layer components), 类选择器存在被同特异度规则覆盖、导致提示
// 根本不显示的风险; 内联样式必然生效。
const flashStyle = computed(() =>
  flash.value === null
    ? {}
    : { borderColor: flash.value === 'success' ? 'var(--color-accent-blue)' : '#e11d48' },
)

onMounted(() => configStore.fetchConfig())

function readValue(): boolean | undefined {
  let node: unknown = configStore.config
  for (const seg of props.configPath.split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[seg]
  }
  return typeof node === 'boolean' ? node : undefined
}

const value = computed(() => readValue() ?? false)

function writePath(v: unknown) {
  const segs = props.configPath.split('.')
  let node = configStore.config as unknown as Record<string, unknown>
  for (let i = 0; i < segs.length - 1; i++) {
    node = (node[segs[i] ?? ''] ?? {}) as Record<string, unknown>
  }
  node[segs[segs.length - 1] ?? ''] = v
}

async function onChange(next: string | number | boolean) {
  if (typeof next !== 'boolean' || !configStore.config) return
  const prev = readValue()
  loading.value = true
  try {
    writePath(next)
    const res = await configStore.saveConfig()
    if (!res?.Success) {
      writePath(prev)
      Message.error(res?.Message || '保存失败')
      flashCard('error')
    } else {
      flashCard('success')
    }
  } catch (e) {
    writePath(prev)
    Message.error('保存失败')
    flashCard('error')
    console.error(e)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <setting-card-component
    :title="title"
    :description="description"
    class="save-flash"
    :style="flashStyle"
  >
    <template #extra>
      <a-switch :model-value="value" :loading="loading" @change="onChange($event)">
        <template #checked-icon>
          <icon-check />
        </template>
        <template #unchecked-icon>
          <icon-close />
        </template>
      </a-switch>
    </template>
  </setting-card-component>
</template>

<style scoped lang="scss">
/* 保存结果提示: 只过渡 border-color 的颜色成分。
 * 不动 box-shadow 扩散半径 —— 那是逐帧重绘、且属已定案禁止的发光效果。
 * 注: 全局 prefers-reduced-motion 块保留颜色类过渡(只关位移/脉冲/hue),
 * 因此减弱动效下这里仍是 200ms 变色, 不会闪烁。 */
.save-flash {
  transition: border-color var(--dur-base) var(--ease-out);
}
</style>
