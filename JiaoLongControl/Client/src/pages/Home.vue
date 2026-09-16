<script setup lang="ts">
import { computed, markRaw, onMounted, onUnmounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { PerformanceMode, SystemInfo, SystemPerMode, CPU } from '@/utils/bridge'
import { useSystemInfoStore } from '@/stores/systemInfo'
import { chartTheme } from '@/theme/theme'
import { tempLevel, tempLevelHys, type TempLevel } from '@/utils/temperature'
import { storeToRefs } from 'pinia'
import { Scale, SlidersHorizontal, Volume1, Zap } from 'lucide-vue-next'

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent])

const systemInfoStore = useSystemInfoStore()
const { cpuTemp, gpuTemp, fanSpeed, gpuStats } = storeToRefs(systemInfoStore)

const cpuTempLevel = ref<TempLevel>(tempLevel(cpuTemp.value))
const gpuTempLevel = ref<TempLevel>(tempLevel(gpuTemp.value))
watch(cpuTemp, (t) => {
  cpuTempLevel.value = tempLevelHys(t, cpuTempLevel.value)
})
watch(gpuTemp, (t) => {
  gpuTempLevel.value = tempLevelHys(t, gpuTempLevel.value)
})

const performanceModes = ref([
  { id: SystemPerMode.PerformanceMode, name: '高性能', icon: markRaw(Zap), active: false },
  { id: SystemPerMode.BalanceMode, name: '平衡', icon: markRaw(Scale), active: false },
  { id: SystemPerMode.QuietMode, name: '静音', icon: markRaw(Volume1), active: false },
  { id: SystemPerMode.CustomMode, name: '自定义', icon: markRaw(SlidersHorizontal), active: false },
])

async function fetchPerformanceMode() {
  try {
    const res = await PerformanceMode.Get()
    if (res.Success) {
      performanceModes.value.forEach((e) => {
        e.active = e.id === res.Data
      })
    }
  } catch (e) {
    console.error(e)
  }
}

function setMode(id: SystemPerMode) {
  performanceModes.value.forEach((m) => {
    m.active = m.id === id
  })
  if (id === SystemPerMode.CustomMode) {
    void CPU.SetCustomMode(true)
  } else {
    void PerformanceMode.Set(id)
  }
}

function handleModeChanged(e: MessageEvent) {
  try {
    const data: unknown = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    if (
      data &&
      typeof data === 'object' &&
      (data as { type?: string }).type === 'mode-changed' &&
      typeof (data as { mode?: unknown }).mode === 'number'
    ) {
      const mode = (data as { mode: number }).mode as SystemPerMode
      performanceModes.value.forEach((m) => {
        m.active = m.id === mode
      })
    }
  } catch {
    /* 非 JSON 消息忽略 */
  }
}

const cpuUsage = computed(() => systemInfoStore.cpuStats?.Usage ?? 0)
const gpuUsage = computed(() => parseInt(gpuStats.value?.GpuUtilization || '0', 10))
const maxFanRpm = computed(() =>
  Math.max(fanSpeed.value.CPUFanSpeed, fanSpeed.value.GPUFanSpeed),
)

const NOISE_CALIBRATION: Array<[rpm: number, dba: number]> = [
  [1500, 19],
  [3000, 25],
  [4800, 40],
  [5800, 45],
  [6800, 48],
]
const noiseLevel = computed(() => {
  const rpm = maxFanRpm.value
  const pts = NOISE_CALIBRATION
  if (rpm <= pts[0]![0]) return pts[0]![1]
  for (let i = 1; i < pts.length; i++) {
    const [hiRpm, hiDba] = pts[i]!
    if (rpm <= hiRpm) {
      const [loRpm, loDba] = pts[i - 1]!
      return Math.round(loDba + ((rpm - loRpm) / (hiRpm - loRpm)) * (hiDba - loDba))
    }
  }
  return pts[pts.length - 1]![1]
})

// 包功耗估算: 无直接传感器时按 CPU/GPU 占用粗估, 标注 est.
const packagePower = computed(() => {
  return Math.round((cpuUsage.value / 100) * 45 + (gpuUsage.value / 100) * 80)
})

const sysCpuName = ref('Loading...')
const sysGpuName = ref('Loading...')
const sysMemory = ref('Loading...')
const sysOs = ref('Loading...')

const tempHistory = ref<{ cpu: number | null; gpu: number | null }[]>(
  Array(10).fill({ cpu: null, gpu: null }),
)

async function fetchStaticInfo() {
  try {
    const res = await SystemInfo.GetSystemOverview()
    if (res.Success && res.Data) {
      sysCpuName.value = res.Data.CpuName
      sysGpuName.value = res.Data.GpuName
      sysMemory.value = res.Data.MemoryInfo
      sysOs.value = res.Data.OsVersion
    }
  } catch (e) {
    console.error('Failed to fetch system info', e)
  }
}

let historyTimer: ReturnType<typeof setInterval> | null = null

function startTimers() {
  stopTimers()
  historyTimer = setInterval(() => {
    tempHistory.value.push({ cpu: cpuTemp.value, gpu: gpuTemp.value })
    if (tempHistory.value.length > 10) tempHistory.value.shift()
  }, 2000)
}

function stopTimers() {
  if (historyTimer) {
    clearInterval(historyTimer)
    historyTimer = null
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopTimers()
  } else {
    startTimers()
  }
}

onMounted(() => {
  fetchStaticInfo()
  fetchPerformanceMode()
  startTimers()
  document.addEventListener('visibilitychange', handleVisibilityChange)
  try {
    window.chrome?.webview?.addEventListener('message', handleModeChanged)
  } catch {
    /* 浏览器预览环境无 WebView 桥 */
  }
})

onUnmounted(() => {
  stopTimers()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  try {
    window.chrome?.webview?.removeEventListener('message', handleModeChanged)
  } catch {
    /* 浏览器预览环境无 WebView 桥 */
  }
})

const LEVEL_LABEL: Record<TempLevel, string> = {
  cool: 'COOL',
  warm: 'WARM',
  hot: 'HOT',
  critical: 'CRIT',
}

const lineChartOption = computed(() => ({
  animation: false,
  animationDurationUpdate: 0,
  grid: { top: 28, bottom: 18, left: 36, right: 8 },
  legend: {
    data: ['CPU', 'GPU'],
    icon: 'roundRect',
    itemWidth: 12,
    itemHeight: 3,
    textStyle: { color: chartTheme.value.legend, fontSize: 10 },
    top: 0,
  },
  xAxis: {
    type: 'category',
    data: Array(10).fill(''),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { show: false },
  },
  yAxis: {
    type: 'value',
    min: 0,
    max: 100,
    interval: 25,
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
    axisLabel: { color: chartTheme.value.axis, fontSize: 10, formatter: '{value}°C' },
  },
  series: [
    {
      name: 'CPU',
      data: tempHistory.value.map((i) => i.cpu),
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
      lineStyle: { color: '#60a5fa', width: 2 },
      itemStyle: { color: '#60a5fa' },
    },
    {
      name: 'GPU',
      data: tempHistory.value.map((i) => i.gpu),
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
      lineStyle: { color: '#34d399', width: 2 },
      itemStyle: { color: '#34d399' },
    },
  ],
}))
</script>

<template>
  <div class="home flex flex-col h-full overflow-hidden">
    <!-- 状态条: 模式 + 温度 chip + 功耗/风扇/噪音 -->
    <header class="status-strip">
      <span class="status-label">Mode</span>
      <div class="mode-seg" role="tablist" aria-label="性能模式">
        <button
          v-for="mode in performanceModes"
          :key="mode.id"
          :class="['mode-btn', mode.active ? 'active' : '']"
          role="tab"
          :aria-selected="mode.active"
          @click="setMode(mode.id)"
        >
          <component :is="mode.icon" class="w-3.5 h-3.5 shrink-0" :stroke-width="2" />
          {{ mode.name }}
        </button>
      </div>
      <div class="temp-pair">
        <div class="temp-chip" :class="cpuTempLevel">
          <span class="val tnum">{{ cpuTemp }}°C</span>
          <span class="tag">CPU</span>
        </div>
        <div class="temp-chip" :class="gpuTempLevel">
          <span class="val tnum">{{ gpuTemp }}°C</span>
          <span class="tag">GPU</span>
        </div>
      </div>
      <div class="status-meta tnum">
        <span>PWR <b>{{ packagePower }}W</b></span>
        <span>FAN <b>{{ maxFanRpm }}</b> RPM</span>
        <span>NOISE <b>{{ noiseLevel }}</b> dBA</span>
      </div>
    </header>

    <!-- 内容: 读数机架 -->
    <div class="content">
      <div class="readout-grid">
        <div class="readout">
          <div class="readout-label">CPU Temp</div>
          <div class="readout-value tnum" :class="cpuTempLevel">
            {{ cpuTemp }}<span class="unit">°C</span>
          </div>
          <div class="readout-sub">
            <div class="meter" :class="cpuTempLevel">
              <i :style="{ width: `${Math.min(cpuTemp, 100)}%` }" />
            </div>
            <span>{{ LEVEL_LABEL[cpuTempLevel] }}</span>
          </div>
        </div>
        <div class="readout">
          <div class="readout-label">GPU Temp</div>
          <div class="readout-value tnum" :class="gpuTempLevel">
            {{ gpuTemp }}<span class="unit">°C</span>
          </div>
          <div class="readout-sub">
            <div class="meter" :class="gpuTempLevel">
              <i :style="{ width: `${Math.min(gpuTemp, 100)}%` }" />
            </div>
            <span>{{ LEVEL_LABEL[gpuTempLevel] }}</span>
          </div>
        </div>
        <div class="readout">
          <div class="readout-label">Fan Max</div>
          <div class="readout-value tnum">
            {{ maxFanRpm }}<span class="unit">RPM</span>
          </div>
          <div class="readout-sub">
            <div class="meter">
              <i :style="{ width: `${Math.min((maxFanRpm / 6800) * 100, 100)}%` }" />
            </div>
            <span>CPU+GPU</span>
          </div>
        </div>
        <div class="readout">
          <div class="readout-label">Package Power</div>
          <div class="readout-value tnum">
            {{ packagePower }}<span class="unit">W</span>
          </div>
          <div class="readout-sub">
            <div class="meter">
              <i :style="{ width: `${Math.min((packagePower / 140) * 100, 100)}%` }" />
            </div>
            <span>est.</span>
          </div>
        </div>
      </div>

      <div class="lower">
        <section class="panel fan-panel">
          <div class="panel-head">
            <h2>Fans & Load</h2>
            <span class="badge">LIVE</span>
          </div>
          <div class="fan-rows">
            <div class="fan-row">
              <span class="name">CPU Fan</span>
              <div class="bar-track">
                <i :style="{ width: `${Math.min((fanSpeed.CPUFanSpeed / 6800) * 100, 100)}%` }" />
              </div>
              <span class="rpm tnum">{{ fanSpeed.CPUFanSpeed }}<span>RPM</span></span>
            </div>
            <div class="fan-row">
              <span class="name">GPU Fan</span>
              <div class="bar-track">
                <i :style="{ width: `${Math.min((fanSpeed.GPUFanSpeed / 6800) * 100, 100)}%` }" />
              </div>
              <span class="rpm tnum">{{ fanSpeed.GPUFanSpeed }}<span>RPM</span></span>
            </div>
            <div class="fan-row">
              <span class="name">CPU Use</span>
              <div class="bar-track">
                <i :style="{ width: `${cpuUsage}%` }" />
              </div>
              <span class="rpm tnum">{{ cpuUsage }}<span>%</span></span>
            </div>
            <div class="fan-row">
              <span class="name">GPU Use</span>
              <div class="bar-track">
                <i :style="{ width: `${gpuUsage}%` }" />
              </div>
              <span class="rpm tnum">{{ gpuUsage }}<span>%</span></span>
            </div>
          </div>
          <div class="noise-line">
            <span class="num tnum">{{ noiseLevel }}</span>
            <span class="unit">dBA</span>
            <span class="lbl">噪音估算</span>
          </div>
        </section>

        <section class="panel chart-panel">
          <div class="panel-head">
            <h2>Temperature History</h2>
            <span class="badge">20s</span>
          </div>
          <div class="chart-body">
            <VChart :option="lineChartOption" autoresize />
          </div>
        </section>

        <section class="panel sys-panel">
          <div class="sys-rows">
            <div class="sys-cell">
              <span class="k">CPU</span>
              <span class="v">{{ sysCpuName }}</span>
            </div>
            <div class="sys-cell">
              <span class="k">GPU</span>
              <span class="v">{{ sysGpuName }}</span>
            </div>
            <div class="sys-cell">
              <span class="k">Memory</span>
              <span class="v">{{ sysMemory }}</span>
            </div>
            <div class="sys-cell">
              <span class="k">OS</span>
              <span class="v">{{ sysOs }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.home {
  background: var(--bg-app);
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

.temp-pair {
  display: flex;
  gap: 8px;
}

.temp-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  font-variant-numeric: tabular-nums;
  transition:
    color var(--dur-base) var(--ease-out),
    background-color var(--dur-base) var(--ease-out);

  .val {
    font-size: 13px;
    font-weight: 600;
  }

  .tag {
    font-size: 10px;
    opacity: 0.75;
    letter-spacing: 0.04em;
  }

  &.cool {
    background: var(--temp-cool-bg);
    color: var(--temp-cool);
  }

  &.warm {
    background: var(--temp-warm-bg);
    color: var(--temp-warm);
  }

  &.hot {
    background: var(--temp-hot-bg);
    color: var(--temp-hot);
  }

  &.critical {
    background: var(--temp-critical-bg);
    color: var(--temp-critical);
  }
}

.status-meta {
  margin-left: auto;
  display: flex;
  gap: 18px;
  font-size: 11px;
  color: var(--weak);

  b {
    color: var(--muted);
    font-weight: 500;
  }
}

.content {
  flex: 1;
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
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
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  grid-template-rows: 1fr auto;
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
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
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

.sys-panel {
  grid-column: 1 / -1;
  grid-row: 2;
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

.sys-rows {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}

.sys-cell {
  padding: 12px 14px;
  border-right: 1px solid var(--hair);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;

  &:last-child {
    border-right: 0;
  }

  .k {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--weak);
    font-weight: 600;
  }

  .v {
    font-size: 12px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
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
