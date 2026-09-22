<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Fan, CPU, NvidiaGpu } from '@/utils/bridge.ts'
import { POLL_INTERVAL_FAN_SPEED } from '@/constants'

const MAX_POINTS = 10
const INTERVAL = POLL_INTERVAL_FAN_SPEED
const PADDING_X = 40
const PADDING_Y = 20

// 定义色板（与系统全局风格统一）
const COLOR_CPU_FAN = '#60a5fa' // CPU 转速
const COLOR_GPU_FAN = '#34d399' // GPU 转速
const COLOR_CPU_TEMP = '#fb923c' // CPU 温度
const COLOR_GPU_TEMP = '#f87171' // GPU 温度

const MAX_FAN_RPM = 7800
const MAX_TEMP_C = 110

// 宽高：高度由 CSS 钉死，宽度只跟容器走。
// 禁止给 SVG 预设像素宽（旧值 600）：grid 子项 min-width:auto 会按内尺撑开右栏，
// ResizeObserver 再把宽度写回去，左右栏就会缓慢互挤。
const container = ref<HTMLElement | null>(null)
const width = ref(0)
const height = ref(180)

// 只有可靠读取到的样本才进入图表；空数组明确表示尚无数据，不能伪装成 0。
const cpuFan = ref<number[]>([])
const gpuFan = ref<number[]>([])
const cpuTemp = ref<number[]>([])
const gpuTemp = ref<number[]>([])

const readingState = ref<'loading' | 'ok' | 'stale' | 'error'>('loading')
const readingStateLabel = computed(() => {
  if (readingState.value === 'ok') return '数据正常'
  if (readingState.value === 'stale') return '数据过期'
  if (readingState.value === 'error') return '读取失败'
  return '正在读取'
})
const hasSamples = computed(
  () =>
    cpuFan.value.length > 0 ||
    gpuFan.value.length > 0 ||
    cpuTemp.value.length > 0 ||
    gpuTemp.value.length > 0,
)
const hoverIndex = ref<number | null>(null)
let timer: number | null = null
let running = true
let resizeObserver: ResizeObserver | null = null

function push(arr: number[], v: number) {
  if (arr.length >= MAX_POINTS) arr.shift()
  arr.push(v)
}

const chartW = computed(() => Math.max(0, width.value - PADDING_X * 2))
const chartH = computed(() => Math.max(0, height.value - PADDING_Y * 2))

const xStep = computed(() => {
  const count = Math.max(
    cpuFan.value.length,
    gpuFan.value.length,
    cpuTemp.value.length,
    gpuTemp.value.length,
  )
  if (count <= 1) return 0
  return chartW.value / (count - 1)
})

const xs = computed(() => {
  const currentLen = Math.max(
    cpuFan.value.length,
    gpuFan.value.length,
    cpuTemp.value.length,
    gpuTemp.value.length,
  )
  return Array.from({ length: currentLen }, (_, i) => {
    return PADDING_X + i * xStep.value
  })
})

// 核心修改：根据 target ('cpu' | 'gpu') 分配不同的垂直轨道区间
function getY(v: number, max: number, target: 'cpu' | 'gpu') {
  const val = isNaN(v) ? 0 : v

  // 单个轨道占总高度的 45%
  const bandHeight = chartH.value * 0.45
  const relativeY = (1 - val / max) * bandHeight

  if (target === 'cpu') {
    // CPU 处于上半区间 (0% 到 45%)
    return PADDING_Y + relativeY
  } else {
    // GPU 处于下半区间 (55% 到 100%)，留出 10% 的中部空隙
    return PADDING_Y + chartH.value * 0.55 + relativeY
  }
}

const makePath = (data: number[], max: number, target: 'cpu' | 'gpu') => {
  if (data.length === 0) return ''
  return data.map((val, i) => `${xs.value[i]},${getY(val, max, target)}`).join(' ')
}

const cpuFanPath = computed(() => makePath(cpuFan.value, MAX_FAN_RPM, 'cpu'))
const gpuFanPath = computed(() => makePath(gpuFan.value, MAX_FAN_RPM, 'gpu'))
const cpuTempPath = computed(() => makePath(cpuTemp.value, MAX_TEMP_C, 'cpu'))
const gpuTempPath = computed(() => makePath(gpuTemp.value, MAX_TEMP_C, 'gpu'))

function onMouseMove(e: MouseEvent) {
  if (!container.value || cpuFan.value.length === 0) return

  const rect = container.value.getBoundingClientRect()
  const mouseX = e.clientX - rect.left
  const chartX = mouseX - PADDING_X
  let index = Math.round(chartX / xStep.value)

  if (index < 0) index = 0
  if (index >= cpuFan.value.length) index = cpuFan.value.length - 1

  hoverIndex.value = index
}

async function poll() {
  if (!running) return

  let anySuccess = false

  try {
    const fan = await Fan.GetFanSpeed()
    if (fan?.Success && fan.Data) {
      push(cpuFan.value, fan.Data.CPUFanSpeed)
      push(gpuFan.value, fan.Data.GPUFanSpeed)
      anySuccess = true
    }
  } catch (e) {
    console.error('读取风扇失败:', e)
  }

  try {
    const hw = await CPU.GetCPUThermometer()
    if (hw?.Success && hw.Data !== undefined) {
      push(cpuTemp.value, hw.Data)
      anySuccess = true
    }
  } catch (e) {
    console.error('读取CPU温度失败:', e)
  }

  try {
    const gpu = await NvidiaGpu.GetGpuTemperature()
    if (gpu?.Success && gpu.Data !== undefined) {
      push(gpuTemp.value, Number(gpu.Data))
      anySuccess = true
    }
  } catch (e) {
    console.error('读取GPU温度失败:', e)
  }

  readingState.value = anySuccess ? 'ok' : hasSamples.value ? 'stale' : 'error'
  timer = window.setTimeout(poll, INTERVAL)
}

onMounted(() => {
  poll()
  if (container.value) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.floor(entry.contentRect.width)
        if (next > 0 && next !== width.value) width.value = next
      }
    })
    resizeObserver.observe(container.value)
  }
})

onUnmounted(() => {
  running = false
  if (timer) clearTimeout(timer)
  if (resizeObserver) resizeObserver.disconnect()
})
</script>

<template>
  <div class="fan-speed-root bg-panel border border-hair rounded-lg p-5 space-y-4">
    <!-- 图表顶栏标题 -->
    <div class="flex justify-between items-center select-none">
      <h2 class="text-[13px] font-semibold text-gray-300 flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full" style="background: var(--accent)"></span>
        实时运行状态遥测
      </h2>
      <span class="text-[10px] text-gray-500 font-mono"
        >{{ INTERVAL / 1000 }}s 采样间隔 · {{ readingStateLabel }}</span
      >
    </div>
    <!-- 图表区域 -->
    <div
      ref="container"
      class="chart-container"
      @mousemove="onMouseMove"
      @mouseleave="hoverIndex = null"
    >
      <svg v-if="width > 0 && hasSamples" :width="width" :height="height">
        <defs>
          <!-- 无滤镜: 曲线实色绘制, 禁 neon glow -->
        </defs>

        <!-- 1. 背景网格横线 (CPU 区间) -->
        <g
          style="stroke: color-mix(in srgb, var(--color-text-main) 2%, transparent)"
          stroke-width="1"
        >
          <line :x1="PADDING_X" :x2="width - PADDING_X" :y1="PADDING_Y" :y2="PADDING_Y" />
          <line
            :x1="PADDING_X"
            :x2="width - PADDING_X"
            :y1="PADDING_Y + chartH * 0.22"
            :y2="PADDING_Y + chartH * 0.22"
          />
          <line
            :x1="PADDING_X"
            :x2="width - PADDING_X"
            :y1="PADDING_Y + chartH * 0.45"
            :y2="PADDING_Y + chartH * 0.45"
          />
        </g>

        <!-- 2. 中部 CPU / GPU 软隔离线 -->
        <line
          :x1="PADDING_X"
          :x2="width - PADDING_X"
          :y1="PADDING_Y + chartH * 0.5"
          :y2="PADDING_Y + chartH * 0.5"
          style="stroke: color-mix(in srgb, var(--color-text-main) 8%, transparent)"
          stroke-width="1"
          stroke-dasharray="4,4"
        />

        <!-- 3. 背景网格横线 (GPU 区间) -->
        <g
          style="stroke: color-mix(in srgb, var(--color-text-main) 2%, transparent)"
          stroke-width="1"
        >
          <line
            :x1="PADDING_X"
            :x2="width - PADDING_X"
            :y1="PADDING_Y + chartH * 0.55"
            :y2="PADDING_Y + chartH * 0.55"
          />
          <line
            :x1="PADDING_X"
            :x2="width - PADDING_X"
            :y1="PADDING_Y + chartH * 0.77"
            :y2="PADDING_Y + chartH * 0.77"
          />
          <line
            :x1="PADDING_X"
            :x2="width - PADDING_X"
            :y1="PADDING_Y + chartH"
            :y2="PADDING_Y + chartH"
          />
        </g>

        <!-- 4. CPU/GPU 侧边标识文本 -->
        <text
          :x="PADDING_X - 12"
          :y="PADDING_Y + chartH * 0.25"
          font-size="9"
          style="fill: color-mix(in srgb, var(--color-text-main) 25%, transparent)"
          text-anchor="end"
          font-weight="bold"
        >
          CPU
        </text>
        <text
          :x="PADDING_X - 12"
          :y="PADDING_Y + chartH * 0.8"
          font-size="9"
          style="fill: color-mix(in srgb, var(--color-text-main) 25%, transparent)"
          text-anchor="end"
          font-weight="bold"
        >
          GPU
        </text>

        <!-- 5. 独立轨道折线路径 -->
        <polyline :points="cpuFanPath" fill="none" :stroke="COLOR_CPU_FAN" stroke-width="2" />
        <polyline
          :points="gpuFanPath"
          fill="none"
          :stroke="COLOR_GPU_FAN"
          stroke-width="2"
          stroke-dasharray="6,4"
        />
        <polyline :points="cpuTempPath" fill="none" :stroke="COLOR_CPU_TEMP" stroke-width="2" />
        <polyline
          :points="gpuTempPath"
          fill="none"
          :stroke="COLOR_GPU_TEMP"
          stroke-width="2"
          stroke-dasharray="6,4"
        />

        <!-- 6. 数据点拐点微圆点 -->
        <g v-for="(x, i) in xs" :key="'nodes-' + i">
          <circle
            v-if="cpuFan[i] !== undefined"
            :cx="x"
            :cy="getY(cpuFan[i]!, MAX_FAN_RPM, 'cpu')"
            r="2"
            :fill="COLOR_CPU_FAN"
          />
          <circle
            v-if="gpuFan[i] !== undefined"
            :cx="x"
            :cy="getY(gpuFan[i]!, MAX_FAN_RPM, 'gpu')"
            r="2"
            :fill="COLOR_GPU_FAN"
          />
          <circle
            v-if="cpuTemp[i] !== undefined"
            :cx="x"
            :cy="getY(cpuTemp[i]!, MAX_TEMP_C, 'cpu')"
            r="2"
            :fill="COLOR_CPU_TEMP"
          />
          <circle
            v-if="gpuTemp[i] !== undefined"
            :cx="x"
            :cy="getY(gpuTemp[i]!, MAX_TEMP_C, 'gpu')"
            r="2"
            :fill="COLOR_GPU_TEMP"
          />
        </g>

        <!-- 7. 交互式悬浮垂直标线及 Tooltip -->
        <template v-if="hoverIndex !== null && xs[hoverIndex] !== undefined">
          <!-- 悬浮轴标虚线 -->
          <line
            :x1="xs[hoverIndex]"
            :x2="xs[hoverIndex]"
            :y1="PADDING_Y"
            :y2="height - PADDING_Y"
            style="stroke: color-mix(in srgb, var(--color-text-main) 12%, transparent)"
            stroke-width="1"
            stroke-dasharray="3"
          />
          <!-- 悬浮高亮圆圈 -->
          <g>
            <circle
              v-if="cpuFan[hoverIndex] !== undefined"
              :cx="xs[hoverIndex]"
              :cy="getY(cpuFan[hoverIndex]!, MAX_FAN_RPM, 'cpu')"
              r="3.5"
              fill="#fff"
              :stroke="COLOR_CPU_FAN"
              stroke-width="2"
            />
            <circle
              v-if="gpuFan[hoverIndex] !== undefined"
              :cx="xs[hoverIndex]"
              :cy="getY(gpuFan[hoverIndex]!, MAX_FAN_RPM, 'gpu')"
              r="3.5"
              fill="#fff"
              :stroke="COLOR_GPU_FAN"
              stroke-width="2"
            />
            <circle
              v-if="cpuTemp[hoverIndex] !== undefined"
              :cx="xs[hoverIndex]"
              :cy="getY(cpuTemp[hoverIndex]!, MAX_TEMP_C, 'cpu')"
              r="3.5"
              fill="#fff"
              :stroke="COLOR_CPU_TEMP"
              stroke-width="2"
            />
            <circle
              v-if="gpuTemp[hoverIndex] !== undefined"
              :cx="xs[hoverIndex]"
              :cy="getY(gpuTemp[hoverIndex]!, MAX_TEMP_C, 'gpu')"
              r="3.5"
              fill="#fff"
              :stroke="COLOR_GPU_TEMP"
              stroke-width="2"
            />
          </g>

          <!-- 悬浮数据指示卡 -->
          <g
            :transform="`translate(${
              xs[hoverIndex]! + (xs[hoverIndex]! > width / 2 ? -200 : 20)
            }, ${PADDING_Y - 5})`"
            style="pointer-events: none"
          >
            <rect
              width="180"
              height="124"
              rx="8"
              style="
                fill: var(--color-popover-bg);
                stroke: color-mix(in srgb, var(--color-text-main) 8%, transparent);
              "
              stroke-width="1"
            />
            <text
              x="15"
              y="24"
              font-size="11"
              font-weight="bold"
              style="fill: var(--color-text-main)"
            >
              时间切片: {{ hoverIndex + 1 }} / 10
            </text>
            <g transform="translate(15, 46)">
              <circle r="3.5" :fill="COLOR_CPU_FAN" cy="-3.5" />
              <text
                x="14"
                font-size="11"
                style="fill: color-mix(in srgb, var(--color-text-main) 70%, transparent)"
              >
                CPU风扇:
                <tspan
                  font-weight="bold"
                  style="fill: var(--color-text-main)"
                  font-family="monospace"
                >
                  {{ cpuFan[hoverIndex] }}
                </tspan>
                RPM
              </text>
            </g>
            <g transform="translate(15, 66)">
              <circle r="3.5" :fill="COLOR_GPU_FAN" cy="-3.5" />
              <text
                x="14"
                font-size="11"
                style="fill: color-mix(in srgb, var(--color-text-main) 70%, transparent)"
              >
                GPU风扇:
                <tspan
                  font-weight="bold"
                  style="fill: var(--color-text-main)"
                  font-family="monospace"
                >
                  {{ gpuFan[hoverIndex] }}
                </tspan>
                RPM
              </text>
            </g>
            <g transform="translate(15, 86)">
              <circle r="3.5" :fill="COLOR_CPU_TEMP" cy="-3.5" />
              <text
                x="14"
                font-size="11"
                style="fill: color-mix(in srgb, var(--color-text-main) 70%, transparent)"
              >
                CPU温度:
                <tspan
                  font-weight="bold"
                  style="fill: var(--color-text-main)"
                  font-family="monospace"
                >
                  {{ cpuTemp[hoverIndex] }}
                </tspan>
                °C
              </text>
            </g>
            <g transform="translate(15, 106)">
              <circle r="3.5" :fill="COLOR_GPU_TEMP" cy="-3.5" />
              <text
                x="14"
                font-size="11"
                style="fill: color-mix(in srgb, var(--color-text-main) 70%, transparent)"
              >
                GPU温度:
                <tspan
                  font-weight="bold"
                  style="fill: var(--color-text-main)"
                  font-family="monospace"
                >
                  {{ gpuTemp[hoverIndex] }}
                </tspan>
                °C
              </text>
            </g>
          </g>
        </template>
      </svg>
      <div v-else class="chart-empty">等待可靠遥测样本，读取失败不会显示为 0。</div>
    </div>
  </div>
</template>

<style scoped>
.fan-speed-root {
  min-width: 0;
  max-width: 100%;
}

.chart-container {
  width: 100%;
  height: 180px;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.chart-empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--weak);
  font-size: 11px;
  text-align: center;
}

svg {
  display: block;
  position: absolute;
  inset: 0;
  max-width: 100%;
}

text {
  user-select: none;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
}
</style>
