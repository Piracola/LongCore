<script setup lang="ts">
import type { Component } from 'vue'
import { Cpu, MonitorCog } from 'lucide-vue-next'
import { SystemPerMode } from '@/utils/bridge'
import { tempBgVarByLevel, tempVarByLevel, type TempLevel } from '@/utils/temperature'

defineProps<{
  cpuTemp: number
  gpuTemp: number
  /** 语义档位由上层(Home.vue)统一判定并带滞回, 保证与监控环同屏同色 */
  cpuTempLevel: TempLevel
  gpuTempLevel: TempLevel
  modes: Array<{
    id: SystemPerMode
    name: string
    icon: Component
    active: boolean
  }>
}>()

const emit = defineEmits<{
  (e: 'change-mode', id: SystemPerMode): void
}>()
</script>

<template>
  <!-- 一行状态条: 品牌 + 温度速读(语义色阶) + 性能模式胶囊切换。
       替代原 280px 视频欢迎横幅, 信息密度优先 -->
  <div class="status-bar">
    <div class="flex items-center gap-3 min-w-0 shrink-0">
      <span class="text-[15px] font-semibold tracking-wide">LongCore</span>
      <span class="hidden xl:inline text-xs text-gray-400 truncate">龙核 · 掌控每一分潜能</span>
    </div>

    <!-- 温度速读: 底色/文字色随语义色阶变化, 图标继承 currentColor -->
    <div class="flex items-center gap-2 shrink-0">
      <div
        class="temp-chip"
        :style="{
          color: tempVarByLevel(cpuTempLevel),
          background: tempBgVarByLevel(cpuTempLevel),
        }"
      >
        <Cpu class="w-4 h-4 shrink-0" :stroke-width="2" />
        <span class="text-sm font-semibold tabular-nums">{{ cpuTemp }}°C</span>
        <span class="text-[11px] opacity-70">CPU</span>
      </div>
      <div
        class="temp-chip"
        :style="{
          color: tempVarByLevel(gpuTempLevel),
          background: tempBgVarByLevel(gpuTempLevel),
        }"
      >
        <MonitorCog class="w-4 h-4 shrink-0" :stroke-width="2" />
        <span class="text-sm font-semibold tabular-nums">{{ gpuTemp }}°C</span>
        <span class="text-[11px] opacity-70">GPU</span>
      </div>
    </div>

    <div class="flex-1"></div>

    <!-- 性能模式胶囊切换(顶部信息架构): 选中段 = 强调色 + 提亮底 -->
    <div class="mode-capsule shrink-0">
      <button
        v-for="mode in modes"
        :key="mode.id"
        :class="['mode-seg', mode.active ? 'mode-seg-active' : '']"
        @click="emit('change-mode', mode.id)"
      >
        <component :is="mode.icon" class="w-4 h-4 shrink-0" :stroke-width="1.75" />
        <span>{{ mode.name }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 一行状态条: 低高度卡片, 不用 glass-card(其 hover 位移/发光对状态条无意义) */
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 16px;
  background: var(--color-card-bg);
  backdrop-filter: blur(12px);
  border: 1px solid var(--color-line-soft);
  border-radius: var(--radius-lg);
}

/* 温度速读胶囊: 圆角令牌 pill。
 * 数字本身瞬时跳变(每秒刷新, 不给过渡), 这里过渡的是"档位语义底色":
 * 跨阈值时 200ms 平滑变色, 配合上层 tempLevelHys 的滞回, 不会在临界点闪色。 */
.temp-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  transition:
    color var(--dur-base) ease,
    background-color var(--dur-base) ease;
}

/* 性能模式胶囊 */
.mode-capsule {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-pill);
  background: var(--color-panel-raised);
  border: 1px solid var(--color-line-soft);
}

.mode-seg {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) ease,
    background-color var(--dur-fast) ease;
}

.mode-seg:hover {
  color: var(--color-text-main);
  background: var(--color-overlay);
}

.mode-seg-active {
  color: var(--color-accent-blue);
  background: var(--color-overlay-strong);
  font-weight: 500;
}
</style>
