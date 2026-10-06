<script setup lang="ts">
/**
 * 统一趋势图（TrendChart）—— 全站折线趋势图的唯一渲染器。
 *
 * 设计基线（2026-10 机主方向）：主页旧 ECharts 样式被明确否决（不美观），
 * 本组件按「硬件仪表」语言重新设计，两处使用方（概览页温度历史 /
 * 风扇曲线页遥测）共用同一规范：
 * - 无轴线、无背景带：只留 4 条极淡虚线网格，刻度为裸数字；
 * - 平滑曲线 2px + 可选渐变面积（多序列 ≥3 重叠时建议关闭）；
 * - 活值图例：图例项 = 色点 + 名称 + 当前最新值（仪表盘读数风格），
 *   点击切换该序列显隐 —— 取代 ECharts 内置图例（无活值、无读数）；
 * - null 断线：数据缺失处断开显示，绝不补 0 画假谷；
 * - 左轴量程可由调用方钉死（转速钉 FAN_MAX_RPM），第二单位走右轴各自归一化；
 * - 单位后缀只在图例与 tooltip 显示，轴刻度保持纯数字。
 * 主题切换重绘由 chartTheme（theme/theme.ts）驱动。
 */
import { computed, ref } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { AxisPointerComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { chartTheme } from '@/theme/theme'
import type { TrendSeries } from '@/utils/chart'

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, AxisPointerComponent])

const props = withDefaults(
  defineProps<{
    series: TrendSeries[]
    /** x 轴时间标签（HH:MM:SS），与每条 series.data 一一对应 */
    times: string[]
    /** 图表高度（px），默认 200 */
    height?: number
    /** 曲线下渐变面积；多序列（≥3）重叠时建议关闭 */
    area?: boolean
    /** 数据全空时的占位文案 */
    emptyText?: string
  }>(),
  { height: 200, area: false, emptyText: '暂无数据' },
)

/** 面板内部字号：本组件一律 10–11px，禁止各页面自定字阶 */
const AXIS_FONT = 10

/** 图例点按显隐（图表局部交互态，不进 pinia） */
const hidden = ref(new Set<string>())
function toggle(key: string) {
  const next = new Set(hidden.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  hidden.value = next
}

const visibleSeries = computed(() => props.series.filter((s) => !hidden.value.has(s.key)))

/** 活值图例：每项展示该序列最后一个有效值（null → 「—」） */
const legendItems = computed(() =>
  props.series.map((s) => {
    let latest: number | null = null
    for (let i = s.data.length - 1; i >= 0; i--) {
      const v = s.data[i]
      if (v !== null && Number.isFinite(v)) {
        latest = v
        break
      }
    }
    return {
      key: s.key,
      label: s.label,
      color: s.color,
      unit: s.unit,
      latest: latest === null ? '—' : String(Math.round(latest * 10) / 10),
      isHidden: hidden.value.has(s.key),
    }
  }),
)

const anyData = computed(() =>
  props.series.some((s) => s.data.some((v) => v !== null && Number.isFinite(v))),
)

/** 向上取整到 1/1.5/2/2.5/3/4/5/6/8×10^n 的「好数字」量程 */
function niceMax(values: Array<number | null>, pinned?: number): number {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v))
  const raw = pinned ?? (finite.length > 0 ? Math.max(...finite) : 1)
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (raw <= m * magnitude) return m * magnitude
  }
  return 10 * magnitude
}

const leftMax = computed(() => {
  const left = props.series.filter((s) => (s.axis ?? 'left') === 'left')
  const pinned = left.find((s) => s.axisMax !== undefined)?.axisMax
  const all = left.flatMap((s) => s.data)
  return niceMax(all, pinned)
})

const rightMax = computed(() => {
  const right = props.series.filter((s) => s.axis === 'right')
  if (right.length === 0) return null
  const pinned = right.find((s) => s.axisMax !== undefined)?.axisMax
  const all = right.flatMap((s) => s.data)
  return niceMax(all, pinned)
})

/** #rrggbb → rgba(r,g,b,a)；ECharts 渐变的 colorStops 只认颜色字符串 */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

const option = computed(() => {
  const t = chartTheme.value
  const seriesList = visibleSeries.value
  return {
    animation: false,
    animationDurationUpdate: 0,
    grid: {
      top: 10,
      bottom: 24,
      left: 40,
      right: rightMax.value !== null ? 44 : 14,
      containLabel: false,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'line',
        snap: true,
        lineStyle: { color: t.cross, width: 1.5 },
      },
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: t.label, fontSize: 12 },
      extraCssText: 'box-shadow: none;',
      formatter: (raw: unknown) => {
        const items = Array.isArray(raw) ? raw : []
        const first = items[0] as { dataIndex?: number } | undefined
        const idx = typeof first?.dataIndex === 'number' ? first.dataIndex : -1
        if (idx < 0 || idx >= props.times.length) return ''
        const rows = seriesList
          .map((s) => {
            const v = s.data[idx]
            const value = v === null || !Number.isFinite(v) ? '—' : String(Math.round(v * 10) / 10)
            const dot =
              '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;' +
              'background:' +
              s.color +
              ';margin-right:6px"></span>'
            return (
              '<div style="font-variant-numeric:tabular-nums;display:flex;justify-content:space-between;gap:16px">' +
              '<span>' +
              dot +
              s.label +
              '</span><span>' +
              value +
              ' ' +
              s.unit +
              '</span></div>'
            )
          })
          .join('')
        return (
          '<div style="font-variant-numeric:tabular-nums;font-size:11px;opacity:.7;margin-bottom:4px">' +
          props.times[idx] +
          '</div>' +
          rows
        )
      },
    },
    xAxis: {
      type: 'category',
      data: props.times,
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: t.axis,
        fontSize: AXIS_FONT,
        hideOverlap: true,
        formatter: (value: string, index: number) => {
          const total = props.times.length
          if (total <= 1) return value
          const step = Math.max(1, Math.ceil((total - 1) / 4))
          return index % step === 0 || index === total - 1 ? value : ''
        },
      },
      splitLine: { show: false },
      axisPointer: {
        show: true,
        type: 'line',
        snap: true,
        lineStyle: { color: t.cross, width: 1.5 },
        label: { show: false },
      },
    },
    yAxis: [
      {
        type: 'value',
        min: 0,
        max: leftMax.value,
        interval: leftMax.value / 4,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: t.line, type: [4, 4], width: 1 } },
        splitArea: { show: false },
        axisLabel: {
          color: t.axis,
          fontSize: AXIS_FONT,
          formatter: (v: number) => (v === 0 ? '0' : String(Math.round(v))),
        },
      },
      ...(rightMax.value !== null
        ? [
            {
              type: 'value',
              min: 0,
              max: rightMax.value,
              interval: rightMax.value / 4,
              axisLine: { show: false },
              axisTick: { show: false },
              splitLine: { show: false },
              axisLabel: {
                color: t.axis,
                fontSize: AXIS_FONT,
                formatter: (v: number) => (v === 0 ? '0' : String(Math.round(v))),
              },
            },
          ]
        : []),
    ],
    series: seriesList.map((s) => ({
      name: s.label,
      type: 'line',
      yAxisIndex: (s.axis ?? 'left') === 'right' && rightMax.value !== null ? 1 : 0,
      data: s.data,
      smooth: true,
      smoothMonotone: 'x',
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 5,
      connectNulls: false,
      emphasis: { focus: 'series', itemStyle: { borderWidth: 2 } },
      lineStyle: { color: s.color, width: 2, cap: 'round' },
      itemStyle: { color: s.color },
      ...(props.area
        ? {
            areaStyle: {
              // colorStops 不认 opacity 字段 —— 透明度必须烘进 rgba，
              // 否则渐变退化为不透明实心色块（视觉 QA 抓到过）。
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: hexToRgba(s.color, 0.18) },
                  { offset: 1, color: hexToRgba(s.color, 0) },
                ],
              },
            },
          }
        : {}),
    })),
  }
})
</script>

<template>
  <div class="trend-chart">
    <!-- 活值图例：色点 + 名称 + 最新读数；点按切换显隐 -->
    <div class="legend-row" role="group" aria-label="序列显隐">
      <button
        v-for="item in legendItems"
        :key="item.key"
        type="button"
        class="legend-item"
        :class="{ off: item.isHidden }"
        :aria-pressed="!item.isHidden"
        @click="toggle(item.key)"
      >
        <span class="dot" :style="{ background: item.color }" aria-hidden="true"></span>
        <span class="lbl">{{ item.label }}</span>
        <span class="val tnum"
          >{{ item.latest }}<span class="unit">{{ item.unit }}</span></span
        >
      </button>
    </div>
    <VChart
      v-if="anyData && visibleSeries.length > 0"
      :option="option"
      autoresize
      :style="{ height: height + 'px' }"
    />
    <div v-else class="trend-empty" :style="{ height: height + 'px' }">
      {{ visibleSeries.length === 0 && anyData ? '所有序列已隐藏，点击图例恢复。' : emptyText }}
    </div>
  </div>
</template>

<style scoped>
.trend-chart {
  min-width: 0;
}

.legend-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 6px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}

.legend-item:hover {
  background: var(--color-overlay);
}

.legend-item.off {
  opacity: 0.45;
}

.legend-item .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.legend-item .lbl {
  font-size: 11px;
  color: var(--muted);
}

.legend-item .val {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink);
}

.legend-item .val .unit {
  margin-left: 2px;
  font-size: 9px;
  font-weight: 400;
  color: var(--weak);
}

.trend-empty {
  display: grid;
  place-items: center;
  color: var(--weak);
  font-size: 11px;
  text-align: center;
  border: 1px dashed var(--hair);
  border-radius: var(--radius-md);
}
</style>
