<script setup lang="ts">
import { computed, onMounted } from 'vue'
import SettingCardComponent from '@/components/common/SettingCardComponent.vue'
import { useConfigStore } from '@/stores/config'

const configStore = useConfigStore()
onMounted(() => configStore.fetchConfig())

const fan = computed(() => configStore.config?.Fan)

/**
 * 两个温度跟踪时间常数与不灵敏带的可选档位。
 * 数值本身就是设计参数, 因此这里不做换算 —— 显示"5 秒"比显示"响应速度 3 档"更能解释现象。
 */
const attackOptions: Array<{ value: number; label: string }> = [
  { value: 3, label: '3 秒' },
  { value: 5, label: '5 秒' },
  { value: 15, label: '15 秒' },
  { value: 40, label: '40 秒' },
]

const releaseOptions: Array<{ value: number; label: string }> = [
  { value: 20, label: '20 秒' },
  { value: 60, label: '1 分钟' },
  { value: 120, label: '2 分钟' },
  { value: 300, label: '5 分钟' },
]

const hysteresisOptions: Array<{ value: number; label: string }> = [
  { value: 0, label: '关闭' },
  { value: 3, label: '3 ℃' },
  { value: 5, label: '5 ℃' },
  { value: 8, label: '8 ℃' },
]

const currentAttack = computed(() => fan.value?.TempAttackS ?? 5)
const currentRelease = computed(() => fan.value?.TempReleaseS ?? 60)
const currentHysteresis = computed(() => fan.value?.TempHysteresisC ?? 5)

const attackHint = computed(() => {
  const v = currentAttack.value
  if (v <= 3) return '几乎立刻跟随温度，但也会把温度的瞬时跳动一起放大'
  if (v <= 5) return '推荐。压掉单次读数跳变，持续升温仍能及时跟上'
  if (v <= 15) return '更平稳，升温时的加速会稍慢半拍'
  return '最平稳，但明显升温时风扇反应偏慢'
})

const releaseHint = computed(() => {
  const v = currentRelease.value
  if (v <= 20) return '温度一降就跟着降，转速变化会比较频繁'
  if (v <= 60) return '推荐。温度回落后仍保持约一分钟的高转速，再缓慢下退'
  if (v <= 120) return '降得更慢，安静但高转速持续时间更长'
  return '基本只在温度大幅回落后才降速'
})

const hysteresisHint = computed(() => {
  const v = currentHysteresis.value
  if (v === 0) return '只要温度有一点变化就调整转速，最容易听到转速反复变化'
  if (v <= 3) return '较灵敏，小幅度温度波动仍会引起调整'
  // 带宽是不对称的: 升速门槛 ≈ 0.6×, 降速门槛 ≈ 1.6×(见 JiaoLongConfig.FanSection 注释)
  if (v <= 5)
    return `推荐。升温约 ${Math.round(v * 0.6)} ℃ 才加速，降温要回落约 ${Math.round(v * 1.6)} ℃ 才减速`
  return '最不易察觉转速变化，但风扇对温度的反应也最迟钝'
})

function pick(field: 'TempAttackS' | 'TempReleaseS' | 'TempHysteresisC', value: number) {
  if (!configStore.config || configStore.config.Fan[field] === value) return
  configStore.config.Fan[field] = value
  configStore.debouncedSave()
}
</script>

<template>
  <setting-card-component
    title="风扇跟随温度的速度"
    :description="attackHint + '。温度上升时，风扇多快开始加速。'"
  >
    <template #extra>
      <div class="seg-group">
        <button
          v-for="opt in attackOptions"
          :key="opt.value"
          class="seg-opt px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
          :class="currentAttack === opt.value ? 'seg-selected' : 'text-muted hover:text-ink'"
          @click="pick('TempAttackS', opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </template>
  </setting-card-component>

  <setting-card-component
    title="转速保持时长"
    :description="
      releaseHint + '。温度回落时，风扇在这个时长内更愿意保持当前转速，不会立刻降下来。'
    "
  >
    <template #extra>
      <div class="seg-group">
        <button
          v-for="opt in releaseOptions"
          :key="opt.value"
          class="seg-opt px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
          :class="currentRelease === opt.value ? 'seg-selected' : 'text-muted hover:text-ink'"
          @click="pick('TempReleaseS', opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </template>
  </setting-card-component>

  <setting-card-component
    title="温度不灵敏范围"
    :description="hysteresisHint + '。两个方向的门槛不同：升温更容易触发调整。'"
  >
    <template #extra>
      <div class="seg-group">
        <button
          v-for="opt in hysteresisOptions"
          :key="opt.value"
          class="seg-opt px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
          :class="currentHysteresis === opt.value ? 'seg-selected' : 'text-muted hover:text-ink'"
          @click="pick('TempHysteresisC', opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </template>
  </setting-card-component>
</template>

<style scoped lang="scss">
/* 与日志/主题设置的分段胶囊保持一致: 底色/字色 + 按压缩放, 无辉光。 */
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
