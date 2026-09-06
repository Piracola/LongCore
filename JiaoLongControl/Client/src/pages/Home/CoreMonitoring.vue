<script setup lang="ts">
import { computed } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { chartTheme } from '@/theme/theme'
import { tempChartColor } from '@/utils/temperature'

use([CanvasRenderer, PieChart, GridComponent, TooltipComponent])

const props = defineProps<{
  cpuUsage: number
  gpuUsage: number
  cpuTemp: number
  gpuTemp: number
}>()

const getRingOption = (
  value: number,
  colorStart: string,
  colorEnd: string,
  suffix: string = '%',
  labelColor?: string,
) => ({
  series: [
    {
      type: 'pie',
      radius: ['75%', '90%'],
      avoidLabelOverlap: false,
      silent: true,
      label: {
        show: true,
        position: 'center',
        formatter: () => `${value}${suffix}`,
        fontSize: 24,
        fontWeight: 'bold',
        color: labelColor ?? chartTheme.value.label,
      },
      data: [
        {
          value: value,
          itemStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 1,
              y2: 1,
              colorStops: [
                { offset: 0, color: colorStart },
                { offset: 1, color: colorEnd },
              ],
            },
            borderRadius: 10,
          },
        },
        {
          value: 100 - value,
          itemStyle: { color: chartTheme.value.line },
        },
      ],
    },
  ],
})

const cpuUsageOption = computed(() => getRingOption(props.cpuUsage || 0, '#3B82F6', '#8A2BE2'))
const gpuUsageOption = computed(() => getRingOption(props.gpuUsage || 0, '#10B981', '#3B82F6'))
// 温度环: 色随语义色阶(≤70 蓝 / 70-80 青 / 80-90 橙 / >90 红), 中心数值同色
const cpuTempColor = computed(() => tempChartColor(props.cpuTemp || 0))
const gpuTempColor = computed(() => tempChartColor(props.gpuTemp || 0))
const cpuTempOption = computed(() =>
  getRingOption(
    props.cpuTemp || 0,
    cpuTempColor.value,
    cpuTempColor.value,
    '°C',
    cpuTempColor.value,
  ),
)
const gpuTempOption = computed(() =>
  getRingOption(
    props.gpuTemp || 0,
    gpuTempColor.value,
    gpuTempColor.value,
    '°C',
    gpuTempColor.value,
  ),
)
</script>

<template>
  <!-- 性能模式胶囊已上移至状态条, 监控环占满整行 -->
  <div class="col-span-12 glass-card p-6 flex flex-col">
    <h2 class="text-[15px] font-medium text-ink/90 mb-2">核心监控</h2>
    <div class="flex-1 flex justify-around items-center px-4">
      <!-- CPU 使用率 -->
      <div class="flex flex-col items-center">
        <div class="w-32 h-32 relative">
          <VChart :option="cpuUsageOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2">CPU 使用率</span>
      </div>

      <!-- GPU 使用率 -->
      <div class="flex flex-col items-center">
        <div class="w-32 h-32 relative">
          <VChart :option="gpuUsageOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2">GPU 使用率</span>
      </div>

      <!-- CPU 温度 -->
      <div class="flex flex-col items-center">
        <div class="w-32 h-32 relative">
          <VChart :option="cpuTempOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2">CPU 温度</span>
      </div>

      <!-- GPU 温度 -->
      <div class="flex flex-col items-center">
        <div class="w-32 h-32 relative">
          <VChart :option="gpuTempOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2">GPU 温度</span>
      </div>
    </div>
  </div>
</template>
