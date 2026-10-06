<script setup lang="ts">
/**
 * 实时运行状态遥测（风扇曲线页底部卡）。
 *
 * 纯渲染：采样与历史都在 stores/telemetry.ts（App.vue 全局挂载、切页不停），
 * 本组件不再持有定时器 —— 旧实现 onUnmounted 即丢历史，切页回来图表只剩一段。
 * 图表用统一 TrendChart（活值图例 + 无轴线仪表风）：左轴 RPM / 右轴 °C
 * 双轴混排，null 断线不补 0。
 */
import { computed } from 'vue'
import TrendChart from '@/components/common/TrendChart.vue'
import { useTelemetryStore } from '@/stores/telemetry'
import { FAN_MAX_RPM, POLL_INTERVAL_FAN_SPEED } from '@/constants'
import type { TrendSeries } from '@/utils/chart'

const telemetry = useTelemetryStore()

// 与温度语义色同源：CPU 蓝 / GPU 绿，温度走 hot 系（沿用旧遥测四色板）
const COLORS = {
  cpuFan: '#60a5fa',
  gpuFan: '#34d399',
  cpuTemp: '#fb923c',
  gpuTemp: '#f87171',
} as const

const series = computed<TrendSeries[]>(() => [
  {
    key: 'cpuFan',
    label: 'CPU 转速',
    color: COLORS.cpuFan,
    unit: 'RPM',
    axis: 'left',
    axisMax: FAN_MAX_RPM,
    data: telemetry.samples.map((s) => s.cpuFan),
  },
  {
    key: 'gpuFan',
    label: 'GPU 转速',
    color: COLORS.gpuFan,
    unit: 'RPM',
    axis: 'left',
    axisMax: FAN_MAX_RPM,
    data: telemetry.samples.map((s) => s.gpuFan),
  },
  {
    key: 'cpuTemp',
    label: 'CPU 温度',
    color: COLORS.cpuTemp,
    unit: '°C',
    axis: 'right',
    axisMax: 100,
    data: telemetry.samples.map((s) => s.cpuTemp),
  },
  {
    key: 'gpuTemp',
    label: 'GPU 温度',
    color: COLORS.gpuTemp,
    unit: '°C',
    axis: 'right',
    axisMax: 100,
    data: telemetry.samples.map((s) => s.gpuTemp),
  },
])

const times = computed(() => telemetry.times)
</script>

<template>
  <div class="fan-speed-root panel-card p-5 space-y-3">
    <div class="flex justify-between items-center select-none">
      <h2 class="section-label head-title">实时运行状态遥测</h2>
      <span class="text-[10px] text-weak tnum">
        {{ POLL_INTERVAL_FAN_SPEED / 1000 }}s 采样 · {{ telemetry.stateLabel }}
      </span>
    </div>
    <TrendChart
      :series="series"
      :times="times"
      :height="240"
      empty-text="等待可靠遥测样本，读取失败不会显示为 0。"
    />
  </div>
</template>

<style scoped>
/* section-label 全局样式带 16px 下边距，卡内标题行需要与右侧状态同行对齐 */
.head-title {
  margin: 0;
}

.fan-speed-root {
  min-width: 0;
  max-width: 100%;
}
</style>
