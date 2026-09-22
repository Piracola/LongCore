<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import PageShell from '@/components/common/PageShell.vue'
import useStore from '@/stores'
import { useModeStore } from '@/stores/mode'
import { FIRMWARE_MODE_LABELS, type FirmwareMode } from '@/domain/modes'
import { useSystemInfoStore } from '@/stores/systemInfo'
import { useFanStore } from '@/stores/fan'
import { chartTheme } from '@/theme/theme'
import { tempLevel, tempLevelHys, type TempLevel } from '@/utils/temperature'
import { storeToRefs } from 'pinia'
import { Scale, SlidersHorizontal, Volume1, Zap } from '@lucide/vue'
import { TEMP_HISTORY_INTERVAL_MS } from '@/constants'

use([
  CanvasRenderer,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
])

const systemInfoStore = useSystemInfoStore()
// 四态读数 state（Reading<T>）
const { cpuTemp: cpuTempReading, fanSpeed: fanSpeedReading } = storeToRefs(systemInfoStore)
// getter 裸值（number | null；null = error/unavailable）
const cpuUsageGetter = computed(() => systemInfoStore.cpuUsageValue)
const gpuUsageGetter = computed(() => systemInfoStore.gpuUtilization)
const gpuTempGetter = computed(() => systemInfoStore.gpuTemp)

// 四态读数裸值（v4 §7）：null = 该通道 error/unavailable，显示「—」；禁止回退 0
const cpuTempN = computed(() => cpuTempReading.value.value)
const gpuTempN = gpuTempGetter
const cpuUsageN = computed(() => cpuUsageGetter.value)
const gpuUsageN = computed(() => gpuUsageGetter.value)
const fanSpeedN = computed(() => fanSpeedReading.value.value)
const cpuStale = computed(() => cpuTempReading.value.state === 'stale')
const gpuStale = computed(() => systemInfoStore.gpuDynamic.state === 'stale')
const fanStale = computed(() => fanSpeedReading.value.state === 'stale')

const cpuTempLevel = ref<TempLevel>(tempLevel(cpuTempN.value ?? 0))
const gpuTempLevel = ref<TempLevel>(tempLevel(gpuTempN.value ?? 0))
watch(cpuTempN, (t) => {
  cpuTempLevel.value = tempLevelHys(t ?? 0, cpuTempLevel.value)
})
watch(gpuTempN, (t) => {
  gpuTempLevel.value = tempLevelHys(t ?? 0, gpuTempLevel.value)
})

// 模式胶囊 = 预设选择器三分离（v4 §6 + 冲突 A 裁定）：
// 选中 ≠ 已生效 —— pending 状态显式可感知，失败回滚为观察值，不留虚假激活态。
// 命名映射（Decision 2026-09-17）：办公=静音 · 游戏=平衡 · 狂飙=高性能。
const modeStore = useModeStore()
const fanStore = useFanStore()
const pageStore = useStore()

const modeOptions: Array<{ kind: 'preset'; mode: FirmwareMode; icon: unknown }> = [
  { kind: 'preset', mode: 'performance', icon: Zap },
  { kind: 'preset', mode: 'balance', icon: Scale },
  { kind: 'preset', mode: 'quiet', icon: Volume1 },
]

function isModeActive(kind: 'preset' | 'custom', mode?: FirmwareMode): boolean | 'pending' {
  const active = modeStore.activeKind
  // 冷启动 selected 尚未对齐时，直接按硬件观察值点亮，避免四个胶囊全空
  if (!modeStore.selected) {
    if (kind === 'custom') return modeStore.customOverride
    return !modeStore.customOverride && modeStore.observedFirmware === mode
  }
  if (kind === 'custom') {
    if (modeStore.selected.kind !== 'custom') return false
    return active === 'custom' ? true : 'pending'
  }
  if (modeStore.selected.kind !== 'preset') return false
  if (modeStore.selected.mode !== mode) return false
  return active === 'preset' ? true : 'pending'
}

async function selectPreset(mode: FirmwareMode) {
  await modeStore.select({ kind: 'preset', mode })
}

async function selectCustom() {
  await modeStore.select({ kind: 'custom' })
}

const fanAvailable = computed(
  () => fanSpeedReading.value.state === 'ok' || fanSpeedReading.value.state === 'stale',
)
const maxFanRpm = computed(() => {
  if (!fanAvailable.value || !fanSpeedN.value) return null
  return Math.max(fanSpeedN.value.CPUFanSpeed, fanSpeedN.value.GPUFanSpeed)
})

// 包功耗估算: 无直接传感器时按 CPU/GPU 占用粗估, 标注 est.
const packagePower = computed(() => {
  if (cpuUsageN.value === null && gpuUsageN.value === null) return null
  return Math.round(((cpuUsageN.value ?? 0) / 100) * 45 + ((gpuUsageN.value ?? 0) / 100) * 80)
})

const { tempHistory } = storeToRefs(systemInfoStore)
const historyWindowSec = ref(120)
const historyOptions = [
  { label: '2 分钟', seconds: 120 },
  { label: '10 分钟', seconds: 600 },
  { label: '1 小时', seconds: 3600 },
]
const visibleTempHistory = computed(() => {
  const count = Math.ceil((historyWindowSec.value * 1000) / TEMP_HISTORY_INTERVAL_MS)
  return tempHistory.value.slice(-count)
})
const historySummary = computed(() => {
  const samples = visibleTempHistory.value
  const cpuValues = samples.flatMap((sample) => (sample.cpu === null ? [] : [sample.cpu]))
  const gpuValues = samples.flatMap((sample) => (sample.gpu === null ? [] : [sample.gpu]))
  const cpuPeak = cpuValues.length ? Math.max(...cpuValues) : null
  const gpuPeak = gpuValues.length ? Math.max(...gpuValues) : null
  const abnormal = samples.filter((sample) =>
    [sample.cpu, sample.gpu].some((value) => {
      if (value === null) return false
      const level = tempLevel(value)
      return level === 'hot' || level === 'critical'
    }),
  ).length
  return { cpuPeak, gpuPeak, abnormal }
})

onMounted(() => {
  void modeStore.refreshObserved()
  void fanStore.resolveController()
})

function formatClock(at: number) {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatTemp(v: number | null) {
  return v === null ? '—' : `${v}°C`
}

const LEVEL_LABEL: Record<TempLevel, string> = {
  cool: 'COOL',
  warm: 'WARM',
  hot: 'HOT',
  critical: 'CRIT',
}

const lineChartOption = computed(() => {
  const samples = visibleTempHistory.value
  const axis = chartTheme.value.axis
  const gridLine = chartTheme.value.line
  return {
    animation: false,
    animationDurationUpdate: 0,
    grid: { top: 28, bottom: 28, left: 44, right: 12, containLabel: false },
    legend: {
      data: ['CPU', 'GPU'],
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 3,
      textStyle: { color: chartTheme.value.legend, fontSize: 10 },
      top: 0,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'line',
        snap: true,
        lineStyle: {
          color: chartTheme.value.cross,
          width: 1.5,
        },
      },
      backgroundColor: chartTheme.value.tooltipBg,
      borderColor: chartTheme.value.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: chartTheme.value.label, fontSize: 12 },
      extraCssText: 'box-shadow: none;',
      formatter: (raw: unknown) => {
        const items = Array.isArray(raw) ? raw : []
        const first = items[0] as { dataIndex?: number } | undefined
        const idx = typeof first?.dataIndex === 'number' ? first.dataIndex : -1
        const sample = idx >= 0 ? samples[idx] : undefined
        if (!sample) return ''
        return [
          `<div style="font-variant-numeric:tabular-nums;font-size:11px;opacity:.7;margin-bottom:4px">${formatClock(sample.at)}</div>`,
          `<div style="font-variant-numeric:tabular-nums">CPU: ${formatTemp(sample.cpu)}</div>`,
          `<div style="font-variant-numeric:tabular-nums">GPU: ${formatTemp(sample.gpu)}</div>`,
        ].join('')
      },
    },
    xAxis: {
      type: 'category',
      data: samples.map((s) => formatClock(s.at)),
      boundaryGap: false,
      axisLine: { show: true, lineStyle: { color: gridLine, width: 1 } },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: axis,
        fontSize: 10,
        hideOverlap: true,
        formatter: (_value: string, index: number) => {
          if (samples.length <= 1) return _value
          const step = Math.max(1, Math.ceil((samples.length - 1) / 4))
          return index % step === 0 || index === samples.length - 1 ? _value : ''
        },
      },
      splitLine: {
        show: true,
        lineStyle: { color: gridLine, type: 'solid', width: 1 },
      },
      axisPointer: {
        show: true,
        type: 'line',
        snap: true,
        lineStyle: { color: chartTheme.value.cross, width: 1.5 },
        label: { show: false },
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      interval: 20,
      axisLine: { show: true, lineStyle: { color: gridLine, width: 1 } },
      axisTick: { show: false },
      splitLine: {
        show: true,
        lineStyle: { color: gridLine, type: 'solid', width: 1 },
      },
      splitArea: {
        show: true,
        areaStyle: { color: chartTheme.value.band },
      },
      axisLabel: { color: axis, fontSize: 10, formatter: '{value}°' },
    },
    series: [
      {
        name: 'CPU',
        data: samples.map((i) => i.cpu),
        type: 'line',
        smooth: true,
        showSymbol: samples.length < 24,
        symbol: 'circle',
        symbolSize: 6,
        emphasis: { focus: 'series', itemStyle: { borderWidth: 2 } },
        lineStyle: { color: '#60a5fa', width: 2 },
        itemStyle: { color: '#60a5fa' },
      },
      {
        name: 'GPU',
        data: samples.map((i) => i.gpu),
        type: 'line',
        smooth: true,
        showSymbol: samples.length < 24,
        symbol: 'circle',
        symbolSize: 6,
        emphasis: { focus: 'series', itemStyle: { borderWidth: 2 } },
        lineStyle: { color: '#34d399', width: 2 },
        itemStyle: { color: '#34d399' },
      },
    ],
  }
})
</script>

<template>
  <PageShell title="概览" subtitle="查看关键硬件状态，并快速切换性能档位与常用控制。">
    <div class="home flex flex-col">
      <!-- 状态条只承载档位选择与硬件观察状态，不重复下方读数 -->
      <header class="status-strip">
        <span class="status-label">性能档位</span>
        <div class="mode-seg" role="tablist" aria-label="性能模式">
          <button
            v-for="opt in modeOptions"
            :key="opt.mode"
            :class="[
              'mode-btn',
              isModeActive('preset', opt.mode) === true ? 'active' : '',
              isModeActive('preset', opt.mode) === 'pending' ? 'pending' : '',
            ]"
            role="tab"
            :aria-selected="isModeActive('preset', opt.mode) === true"
            :disabled="modeStore.syncing"
            @click="selectPreset(opt.mode)"
          >
            <component :is="opt.icon" class="w-3.5 h-3.5 shrink-0" :stroke-width="2" />
            {{ FIRMWARE_MODE_LABELS[opt.mode] }}
          </button>
          <button
            :class="[
              'mode-btn',
              isModeActive('custom') === true ? 'active' : '',
              isModeActive('custom') === 'pending' ? 'pending' : '',
            ]"
            role="tab"
            title="打开自定义功耗覆盖，具体 SPL/SPPT 在 CPU 页下发"
            :aria-selected="isModeActive('custom') === true"
            :disabled="modeStore.syncing"
            @click="selectCustom"
          >
            <component :is="SlidersHorizontal" class="w-3.5 h-3.5 shrink-0" :stroke-width="2" />
            自定义
          </button>
        </div>
        <div class="mode-observed" role="status" aria-live="polite">
          <span>硬件观察</span>
          <strong>{{ modeStore.firmwareLabel || '未读取' }}</strong>
          <em v-if="modeStore.customOverride">自定义覆盖</em>
          <em v-else-if="modeStore.syncing">确认中</em>
        </div>
      </header>

      <!-- 内容: 读数机架 -->
      <div class="content">
        <div class="readout-grid">
          <div class="readout">
            <div class="readout-label">CPU 温度</div>
            <div class="readout-value tnum" :class="cpuTempN !== null ? cpuTempLevel : ''">
              <template v-if="cpuTempN !== null"
                >{{ cpuTempN }}<span class="unit">°C</span></template
              >
              <span v-else class="unit">—</span>
            </div>
            <div class="readout-sub">
              <div class="meter" :class="cpuTempN !== null ? cpuTempLevel : ''">
                <i :style="{ width: cpuTempN !== null ? `${Math.min(cpuTempN, 100)}%` : '0' }" />
              </div>
              <span
                >{{ cpuTempN !== null ? LEVEL_LABEL[cpuTempLevel] : '无数据'
                }}{{ cpuStale ? ' · 过期' : '' }}</span
              >
            </div>
          </div>
          <div class="readout">
            <div class="readout-label">GPU 温度</div>
            <div class="readout-value tnum" :class="gpuTempN !== null ? gpuTempLevel : ''">
              <template v-if="gpuTempN !== null"
                >{{ gpuTempN }}<span class="unit">°C</span></template
              >
              <span v-else class="unit">—</span>
            </div>
            <div class="readout-sub">
              <div class="meter" :class="gpuTempN !== null ? gpuTempLevel : ''">
                <i :style="{ width: gpuTempN !== null ? `${Math.min(gpuTempN, 100)}%` : '0' }" />
              </div>
              <span
                >{{ gpuTempN !== null ? LEVEL_LABEL[gpuTempLevel] : '无数据'
                }}{{ gpuStale ? ' · 过期' : '' }}</span
              >
            </div>
          </div>
          <div class="readout">
            <div class="readout-label">风扇转速</div>
            <div class="readout-value tnum">
              <template v-if="maxFanRpm !== null"
                >{{ maxFanRpm }}<span class="unit">RPM</span></template
              >
              <span v-else class="unit">—</span>
            </div>
            <div class="readout-sub">
              <div class="meter">
                <i
                  :style="{
                    width: maxFanRpm !== null ? `${Math.min((maxFanRpm / 6800) * 100, 100)}%` : '0',
                  }"
                />
              </div>
              <span>{{ fanStale ? '过期' : fanStore.controllerLabel }}</span>
            </div>
          </div>
          <div class="readout">
            <div class="readout-label">封装功耗</div>
            <div class="readout-value tnum">
              <template v-if="packagePower !== null"
                >{{ packagePower }}<span class="unit">W</span></template
              >
              <span v-else class="unit">—</span>
            </div>
            <div class="readout-sub">
              <div class="meter">
                <i
                  :style="{
                    width:
                      packagePower !== null ? `${Math.min((packagePower / 140) * 100, 100)}%` : '0',
                  }"
                />
              </div>
              <span>估算 · 非传感器</span>
            </div>
          </div>
        </div>

        <div class="lower">
          <section class="panel fan-panel">
            <div class="panel-head">
              <h2>运行与控制</h2>
              <span class="badge">{{ fanStore.controllerLabel }}</span>
            </div>
            <div class="fan-rows">
              <div class="fan-row">
                <span class="name">CPU 负载</span>
                <div class="bar-track">
                  <i :style="{ width: cpuUsageN !== null ? `${cpuUsageN}%` : '0' }" />
                </div>
                <span class="rpm tnum"
                  >{{ cpuUsageN !== null ? cpuUsageN : '—' }}<span>%</span></span
                >
              </div>
              <div class="fan-row">
                <span class="name">GPU 负载</span>
                <div class="bar-track">
                  <i :style="{ width: gpuUsageN !== null ? `${gpuUsageN}%` : '0' }" />
                </div>
                <span class="rpm tnum"
                  >{{ gpuUsageN !== null ? gpuUsageN : '—' }}<span>%</span></span
                >
              </div>
              <div class="quick-actions">
                <button type="button" @click="pageStore.setPage('cpu')">调整 CPU 参数</button>
                <button type="button" @click="pageStore.setPage('fan')">管理风扇策略</button>
              </div>
            </div>
          </section>

          <section class="panel chart-panel">
            <div class="panel-head">
              <div>
                <h2>温度历史</h2>
                <p>
                  CPU 峰值 {{ historySummary.cpuPeak ?? '—' }}° · GPU 峰值
                  {{ historySummary.gpuPeak ?? '—' }}° · 异常样本 {{ historySummary.abnormal }}
                </p>
              </div>
              <div class="history-range" aria-label="温度历史范围">
                <button
                  v-for="option in historyOptions"
                  :key="option.seconds"
                  type="button"
                  :class="{ active: historyWindowSec === option.seconds }"
                  @click="historyWindowSec = option.seconds"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <div class="chart-body">
              <VChart :option="lineChartOption" autoresize />
            </div>
          </section>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<style scoped lang="scss">
.home {
  background: var(--bg-app);
  gap: 12px;
}

.status-strip {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 48px;
  padding: 0 20px;
  border-bottom: 1px solid var(--hair);
  background: var(--bg-panel);
  flex-shrink: 0;
}

.status-label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--weak);
  font-weight: 600;
}

.mode-seg {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-inset);
  border: 1px solid var(--hair);
  border-radius: var(--radius-md);
}

.mode-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}

.mode-btn:hover {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.04);
}

.mode-btn.active {
  color: var(--accent-ink);
  background: var(--accent);
  font-weight: 600;
}

/* pending = 已选未确认（命令在途或未回读到一致观察值）：不冒充已生效（v4 第一性原则 1） */
.mode-btn.pending {
  color: var(--muted);
  background: var(--bg-inset);
  box-shadow: inset 0 0 0 1px var(--hair-strong);
}

.mode-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

.mode-observed {
  display: flex;
  align-items: center;
  margin-left: auto;
  gap: 8px;
  font-size: 11px;
  color: var(--weak);

  strong {
    color: var(--ink);
    font-weight: 600;
  }

  em {
    font-style: normal;
    color: var(--accent);
    background: var(--accent-dim);
    border-radius: var(--radius-sm);
    padding: 2px 6px;
  }
}

.content {
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.readout-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  background: var(--bg-panel);
  border: 1px solid var(--hair);
  border-radius: var(--radius-md);
  overflow: hidden;
  flex-shrink: 0;
}

.readout {
  padding: 16px 18px 14px;
  border-right: 1px solid var(--hair);
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;

  &:last-child {
    border-right: 0;
  }
}

.readout-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--weak);
  font-weight: 600;
}

.readout-value {
  font-size: 36px;
  font-weight: 600;
  line-height: 1;
  color: var(--ink);
  letter-spacing: -0.02em;

  .unit {
    font-size: 13px;
    font-weight: 500;
    color: var(--weak);
    margin-left: 4px;
    letter-spacing: 0;
  }

  &.cool {
    color: var(--temp-cool);
  }

  &.warm {
    color: var(--temp-warm);
  }

  &.hot {
    color: var(--temp-hot);
  }

  &.critical {
    color: var(--temp-critical);
  }
}

.readout-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
}

.meter {
  flex: 1;
  height: 3px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 2px;
  overflow: hidden;

  > i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
  }

  &.cool > i {
    background: var(--temp-cool);
  }

  &.warm > i {
    background: var(--temp-warm);
  }

  &.hot > i {
    background: var(--temp-hot);
  }

  &.critical > i {
    background: var(--temp-critical);
  }
}

.lower {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  grid-template-rows: minmax(340px, auto);
  gap: 12px;
  min-height: 280px;
}

.panel {
  background: var(--bg-panel);
  border: 1px solid var(--hair);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--hair);

  h2 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  p {
    margin: 4px 0 0;
    font-size: 10px;
    color: var(--weak);
    letter-spacing: 0;
    text-transform: none;
  }

  .badge {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 2px 6px;
    border-radius: 3px;
  }
}

.fan-panel {
  grid-column: 1;
  grid-row: 1;
}

.chart-panel {
  grid-column: 2;
  grid-row: 1;
}

.fan-row {
  display: grid;
  grid-template-columns: 72px 1fr 78px;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--hair);

  .name {
    font-size: 12px;
    color: var(--muted);
  }

  .rpm {
    font-size: 14px;
    font-weight: 600;
    text-align: right;

    span {
      font-size: 10px;
      color: var(--weak);
      font-weight: 400;
      margin-left: 2px;
    }
  }
}

.quick-actions {
  display: flex;
  gap: 8px;
  padding: 14px;

  button {
    flex: 1;
    height: 32px;
    border: 1px solid var(--hair-strong);
    border-radius: var(--radius-md);
    color: var(--muted);
    font-size: 11px;
    transition:
      color var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);

    &:hover,
    &:focus-visible {
      color: var(--accent);
      border-color: var(--accent-line);
      background: var(--accent-dim);
    }
  }
}

.history-range {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--hair);
  border-radius: var(--radius-md);
  background: var(--bg-inset);

  button {
    height: 24px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    color: var(--weak);
    font-size: 10px;

    &.active {
      color: var(--accent-ink);
      background: var(--accent);
    }
  }
}

.bar-track {
  height: 6px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 2px;
  overflow: hidden;

  > i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, rgba(34, 211, 238, 0.35), var(--accent));
  }
}

.noise-line {
  margin-top: auto;
  padding: 12px 14px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  border-top: 1px solid var(--hair);
  background: var(--bg-inset);

  .num {
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
  }

  .unit {
    font-size: 11px;
    color: var(--weak);
  }

  .lbl {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
  }
}

.chart-body {
  flex: 1;
  padding: 8px 12px 10px;
  min-height: 160px;
}

.echarts {
  width: 100%;
  height: 100%;
}

[data-theme='light'] .bar-track {
  background: rgba(13, 14, 21, 0.06);
}

[data-theme='light'] .meter {
  background: rgba(13, 14, 21, 0.06);
}

[data-theme='light'] .mode-btn:hover {
  background: rgba(13, 14, 21, 0.04);
}
</style>
