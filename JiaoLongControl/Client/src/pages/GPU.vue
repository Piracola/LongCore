<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, type Ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { NvidiaGpu } from '@/utils/bridge'
import { writeGate } from '@/domain/writeGate'
import { buildSparkline } from '@/utils/chart'
import { useConfigStore } from '@/stores/config'
import { useSystemInfoStore } from '@/stores/systemInfo'
import { storeToRefs } from 'pinia'
import { useCompositeWrite } from '@/composables/useCompositeWrite'
import CompositeSteps from '@/components/common/CompositeSteps.vue'
import ApplyBar from '@/components/common/ApplyBar.vue'
import PageShell from '@/components/common/PageShell.vue'
import { useActivityStore } from '@/stores/activity'

const configStore = useConfigStore()
const systemInfoStore = useSystemInfoStore()
const {
  gpuName,
  gpuDriverVersion,
  gpuDriverDate,
  gpuMemoryTotal,
  gpuBusWidth,
  gpuUtilization,
  gpuMemoryUtilization,
  gpuCoreClock,
  gpuMemoryClock,
  gpuTemp,
  gpuFanSpeed,
} = storeToRefs(systemInfoStore)
const loading = ref(false)
const composite = useCompositeWrite()
const activity = useActivityStore()
// 「还没读到」≠「读不到」。旧实现把首屏的 loading/error 一律判为缺失，
// 于是在第一次轮询回来之前会闪一张「未检测到独立 GPU」的错卡。
const gpuMissing = computed(
  () =>
    systemInfoStore.gpuStatic.state === 'error' ||
    systemInfoStore.gpuStatic.state === 'unavailable',
)
/** 首屏尚未尝试：显示等待，而不是下结论 */
const gpuPending = computed(
  () => systemInfoStore.gpuStatic.state === 'loading' && gpuName.value === null,
)

// --- Sparkline Chart History ---
const historyLength = 20
const utilHistory = ref<number[]>([])
const memUtilHistory = ref<number[]>([])
const coreClockHistory = ref<number[]>([])
const memClockHistory = ref<number[]>([])
const tempHistory = ref<number[]>([])
const fanSpeedHistory = ref<number[]>([])

const updateHistory = (history: Ref<number[]>, value: number | null, divisor = 1) => {
  if (value === null || !Number.isFinite(value)) return
  history.value.push(value / divisor)
  if (history.value.length > historyLength) {
    history.value.shift()
  }
}

let unwatch: (() => void) | null = null

onMounted(() => {
  updateHistory(utilHistory, gpuUtilization.value)
  updateHistory(memUtilHistory, gpuMemoryUtilization.value)
  updateHistory(coreClockHistory, gpuCoreClock.value, 100)
  updateHistory(memClockHistory, gpuMemoryClock.value, 100)
  updateHistory(tempHistory, gpuTemp.value)
  updateHistory(fanSpeedHistory, gpuFanSpeed.value, 100)

  const stopWatchers = [
    watch(gpuUtilization, (v) => updateHistory(utilHistory, v)),
    watch(gpuMemoryUtilization, (v) => updateHistory(memUtilHistory, v)),
    watch(gpuCoreClock, (v) => updateHistory(coreClockHistory, v, 100)),
    watch(gpuMemoryClock, (v) => updateHistory(memClockHistory, v, 100)),
    watch(gpuTemp, (v) => updateHistory(tempHistory, v)),
    watch(gpuFanSpeed, (v) => updateHistory(fanSpeedHistory, v, 100)),
  ]
  unwatch = () => stopWatchers.forEach((fn) => fn())
})

onUnmounted(() => {
  if (unwatch) unwatch()
})

// --- Chart Generation ---
function generateSvgPath(history: number[], yMax: number, smooth = true) {
  return buildSparkline(history, { width: 160, height: 40, max: yMax, smooth, area: true })
}

const utilChart = computed(() => generateSvgPath(utilHistory.value, 100))
const memUtilChart = computed(() => generateSvgPath(memUtilHistory.value, 100))
const coreClockChart = computed(() => generateSvgPath(coreClockHistory.value, 30)) // Corresponds to 3000 MHz
const memClockChart = computed(() => generateSvgPath(memClockHistory.value, 100)) // Corresponds to 10000 MHz
const tempChart = computed(() => generateSvgPath(tempHistory.value, 100))
const fanChart = computed(() => generateSvgPath(fanSpeedHistory.value, 40)) // Corresponds to 4000 RPM

// --- Settings and Presets Logic ---
const GPUData = computed(() => configStore.config?.Gpu)

// 改参数即存盘（只落 config.yaml，不碰硬件）：避免"调完滑条没点应用，重启就没了"。
// 真正的下发只在「应用」里发生（LockGpuClock / LockMemoryClock）。
//
// 关键守卫：本页进入时会按驱动值域**钳制** GpuClock / MemoryClock / PowerLimit，
// 若不加区分，用户只是浏览页面也会触发 debouncedSave，把他从没动过的值写回配置。
// 因此只有「用户自己改过」或「明确要求落盘」时才存盘。
const userTouched = ref(false)
const clampOnly = ref(false)

watch(
  () => JSON.stringify(GPUData.value),
  () => {
    if (!composite.isBusy.value) composite.reset()
    if (clampOnly.value) return
    if (!userTouched.value) return
    configStore.debouncedSave()
  },
)

const coreClockRange = ref({ Min: 0, Max: 500 })
const memClockRange = ref({ Min: 0, Max: 1500 })
// 功耗限制滑条本身已被注释掉，但「重置」仍要把 PowerLimit 拉回驱动上限
// （handleResetNormal），故值域与钳制都要留着。
const powerLimitRange = ref({ Min: 50, Max: 140 })

async function fetchGpuRanges() {
  // 钳制期：本函数会把越界的配置值拉回值域内，这属于「按驱动能力修正」，
  // 不是用户意图，因此期间禁止自动落盘。
  clampOnly.value = true
  try {
    // 只读活着的滑条需要的三个值域。高级超频面板已整段删除，其偏移/温度墙/能力探测
    // 的 NVAPI 调用一并撤销 —— 那套探测会在用户 V/F 曲线上真的写值，冷启动不该做。
    const [core, mem, power] = await Promise.all([
      NvidiaGpu.GetGpuCoreClockRange(),
      NvidiaGpu.GetGpuMemoryClockRange(),
      NvidiaGpu.GetGpuPowerLimitRange(),
    ])

    if (core.Success && core.Data) {
      const min = core.Data.Min ?? 0
      const max = core.Data.Max ?? 500
      coreClockRange.value = { Min: min, Max: max }
      if (GPUData.value && (GPUData.value.GpuClock < min || GPUData.value.GpuClock > max)) {
        GPUData.value.GpuClock = max
      }
    }

    if (mem.Success && mem.Data) {
      const min = mem.Data.Min ?? 0
      const max = mem.Data.Max ?? 1500
      memClockRange.value = { Min: min, Max: max }
      if (GPUData.value && (GPUData.value.MemoryClock < min || GPUData.value.MemoryClock > max)) {
        GPUData.value.MemoryClock = max
      }
    }

    if (power.Success && power.Data) {
      const min = power.Data.Min ?? 50
      const max = power.Data.Max ?? 140
      powerLimitRange.value = { Min: min, Max: max }
      if (GPUData.value && (GPUData.value.PowerLimit < min || GPUData.value.PowerLimit > max)) {
        GPUData.value.PowerLimit = max
      }
    }
  } catch (err) {
    console.error('Failed to fetch GPU ranges', err)
  } finally {
    clampOnly.value = false
  }
}
/**
 * 基准快照的捕获时机：`fetchGpuRanges()` 会按驱动值域钳制 GpuClock/MemoryClock，
 * 基准必须取「钳制之后」的值，否则用户什么都没动也会看到「待应用 N 项」。
 * 配置改为后台加载后，setup 期 GPUData 可能还是 null —— 故在配置到位、
 * 且（首次进入时）钳制完成后统一落一次。
 */
const appliedSnapshot = ref<string | null>(null)
function captureBaseline() {
  if (appliedSnapshot.value !== null) return
  appliedSnapshot.value = JSON.stringify([
    GPUData.value?.GpuClock ?? null,
    GPUData.value?.MemoryClock ?? null,
  ])
}
const gpuPendingCount = computed(() => {
  if (!GPUData.value || appliedSnapshot.value === null) return 0
  const [clock, memory] = JSON.parse(appliedSnapshot.value) as [number | null, number | null]
  return Number(GPUData.value.GpuClock !== clock) + Number(GPUData.value.MemoryClock !== memory)
})
const applyPhase = computed(() => {
  if (composite.state.value.phase !== 'idle') return composite.state.value.phase
  return gpuPendingCount.value > 0 ? ('pending' as const) : ('idle' as const)
})
const applyStatus = computed(() => {
  if (applyPhase.value === 'pending') return `待应用 ${gpuPendingCount.value} 项 · 配置已存盘`
  if (applyPhase.value === 'running') return '正在下发频率设置…'
  if (applyPhase.value === 'partial') return '部分应用 · 请检查逐项结果'
  if (applyPhase.value === 'failed') return composite.state.value.message || '应用失败'
  if (applyPhase.value === 'success') return '命令已接受 · 当前频率以实时监控为准'
  // 从未成功应用过：不能声称"已存盘"（照 CPU 页的 neverApplied 语义）。
  // appliedSnapshot 为 null 有两种成因：尚未落基准（后台探测未完成），或用户在探测期间
  // 动过滑条而我们刻意没落基准（见 IIFE 里的 userTouched 守卫）—— 两种都得说"未应用"。
  return appliedSnapshot.value === null
    ? '尚未应用 · 改值后点「应用」才会写入硬件'
    : '配置已存盘 · 尚未下发新值'
})

// 顶部 async setup 是「切到 GPU 偶发卡顿」的根因：顶层 await 会让本页变成异步组件，
// RightSide 的 <Suspense> 必须等它全部 resolve 才渲染 —— 其中 fetchGpuRanges() 要等 3 个
// NVAPI 值域调用在宿主往返，值域探测期间整页只剩加载圈。改成后台补齐：首屏立即出，
// 值域到位后滑条自行撑开。
void (async () => {
  try {
    if (!configStore.config) await configStore.fetchConfig()
    await fetchGpuRanges()
    // 用户在值域探测往返期间已经动过滑条 → 此时取基准等于把「尚未下发的意图」
    // 当成已应用基准，状态条会说"无待应用"而值其实从未写进硬件。宁可不落基准。
    if (userTouched.value) return
    // 必须在钳制之后取基准，否则首次进入会凭空显示「待应用 2 项」
    captureBaseline()
  } catch (err) {
    console.error('GPU 初始化失败', err)
  }
})()

async function handleApplyNormal() {
  // 前端一致性闸门：NVAPI 侧另有校验，但越界值不该等到驱动才被拒
  const clockGate = writeGate.gpu(GPUData.value!.GpuClock, {
    min: coreClockRange.value.Min,
    max: coreClockRange.value.Max,
  })
  const memGate = writeGate.gpu(GPUData.value!.MemoryClock, {
    min: memClockRange.value.Min,
    max: memClockRange.value.Max,
  })
  if (!clockGate.allowed || !memGate.allowed) {
    Message.error((!clockGate.allowed ? clockGate.reason : memGate.reason) || '值超出允许范围')
    return
  }
  // 用户明确点了应用：此后允许把当前值落盘
  userTouched.value = true
  if (!GPUData.value) return
  loading.value = true
  const gpuClock = GPUData.value.GpuClock
  const memClock = GPUData.value.MemoryClock
  const event = await composite.run({
    source: 'user',
    transport: 'nvapi',
    requestedValue: `${gpuClock}/${memClock} MHz`,
    reversible: 'b',
    compensation: '如需改回，请重新设定频率后再次应用',
    preRead: null,
    steps: [
      {
        label: `锁定核心 ${gpuClock} MHz`,
        transport: 'nvapi',
        requestedValue: gpuClock,
        run: () => NvidiaGpu.LockGpuClock(gpuClock),
      },
      {
        label: `锁定显存 ${memClock} MHz`,
        transport: 'nvapi',
        requestedValue: memClock,
        run: () => NvidiaGpu.LockMemoryClock(memClock),
      },
      {
        label: '保存配置',
        transport: 'config',
        requestedValue: 'save',
        run: async () => {
          const res = await configStore.saveConfig()
          return { accepted: !!res?.Success, message: res?.Message }
        },
      },
    ],
  })
  const { ok, failed } = composite.summary.value
  if (event.partialApplied) {
    Message.warning(`部分应用：${ok} 项已生效，其余未执行。已生效项不会自动撤销。`)
  } else if (failed) {
    Message.error(composite.state.value.message || '应用失败')
  } else {
    Message.success('常规设置已应用并保存')
    appliedSnapshot.value = JSON.stringify([gpuClock, memClock])
  }
  activity.record({
    source: 'user',
    intent: `GPU 锁频 ${gpuClock}/${memClock} MHz`,
    requestedValue: `${gpuClock}/${memClock}`,
    outcome: event.partialApplied ? 'partial' : failed ? 'failed' : 'applied',
    reversible: 'b',
  })
  loading.value = false
}

async function handleResetNormal() {
  loading.value = true
  try {
    const clockRes = await NvidiaGpu.ResetGpuClock()
    if (!clockRes.Success) {
      Message.error(clockRes.Message || 'GPU 频率重置失败')
      return
    }
    const memClockRes = await NvidiaGpu.ResetMemoryClock()
    if (!memClockRes.Success) {
      Message.error(memClockRes.Message || '显存频率重置失败')
      return
    }
    if (GPUData.value) {
      GPUData.value.GpuClock = coreClockRange.value.Max
      GPUData.value.MemoryClock = memClockRange.value.Max
      GPUData.value.PowerLimit = powerLimitRange.value.Max
    }
    const saveRes = await configStore.saveConfig()
    if (saveRes?.Success) {
      Message.info('常规设置已恢复默认')
    } else {
      Message.error(saveRes?.Message || '重置值保存失败')
    }
  } catch {
    Message.error('重置失败，请检查显卡驱动及桥接服务')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <!-- 首屏尚未读完 GPU 静态信息：显示等待，不得闪「GPU 不可用」的错误卡 -->
  <PageShell v-if="gpuPending" title="GPU 设置" subtitle="正在读取显卡信息…">
    <div class="panel-card p-6 max-w-md text-center space-y-3">
      <a-spin dot />
      <p class="text-[13px] text-muted leading-relaxed">正在检测独立 GPU 与 NVAPI 通道…</p>
    </div>
  </PageShell>

  <PageShell
    v-else-if="gpuMissing && !gpuName"
    title="GPU 设置"
    subtitle="管理独立 GPU 的频率与实时状态。"
  >
    <div class="panel-card p-6 max-w-md text-center space-y-2">
      <h1 class="text-lg font-semibold">GPU 不可用</h1>
      <p class="text-[13px] text-muted leading-relaxed">
        未检测到独立 GPU，或 NVAPI
        通道失败。锁频与遥测仅在独显通路可用；独显/混合输出在系统页，切换后需重启。
      </p>
    </div>
  </PageShell>
  <PageShell
    v-else-if="GPUData && gpuName"
    title="GPU 设置"
    subtitle="编辑锁频目标并观察实时状态；输出模式切换位于系统设置，重启后生效。"
  >
    <div class="w-full flex flex-col lg:flex-row gap-6">
      <!-- ==================== 左中：显卡主要设置区==================== -->
      <div class="flex-1 space-y-6">
        <!-- 1. 选择 GPU 与卡片详。-->
        <div class="panel-card p-5 flex flex-col md:flex-row justify-between gap-6">
          <div class="space-y-3 md:w-1/2">
            <span class="text-[11px] text-gray-500 font-semibold block uppercase">当前 GPU</span>
            <span class="flex items-center gap-2">
              <span class="w-1.5 h-1.5 rounded-full bg-[#76B900] font-bold"></span>
              {{ gpuName }}
            </span>
          </div>

          <div
            class="grid grid-cols-2 gap-x-6 gap-y-3 text-[11px] text-gray-400 md:w-1/2 md:border-l md:border-ink/[0.05] md:pl-6 pt-1"
          >
            <div>
              <span class="text-gray-600 block mb-0.5">驱动版本</span>
              <span class="text-ink font-medium font-mono">{{ gpuDriverVersion }}</span>
            </div>
            <div>
              <span class="text-gray-600 block mb-0.5">显存容量</span>
              <span class="text-ink font-medium font-mono">{{ gpuMemoryTotal }}</span>
            </div>
            <div>
              <span class="text-gray-600 block mb-0.5">驱动日期</span>
              <span class="text-ink font-medium font-mono">{{ gpuDriverDate }}</span>
            </div>
            <div>
              <span class="text-gray-600 block mb-0.5">总线宽度</span>
              <span class="text-ink font-medium font-mono">{{ gpuBusWidth }}</span>
            </div>
          </div>
        </div>
        <!-- 常规设置面板（高级超频面板已整段删除，这里不再有标签切换） -->
        <div class="panel-card p-5 space-y-5">
          <div class="space-y-5">
            <div class="space-y-2">
              <div class="flex justify-between items-center text-xs">
                <span class="text-gray-300 flex items-center gap-1"
                  >GPU 频率
                  <span class="text-gray-500 cursor-pointer text-[10px]">。</span>
                </span>
                <span class="text-purple-400 font-medium font-mono"
                  >{{ GPUData.GpuClock }} MHz</span
                >
              </div>
              <a-slider
                v-model="GPUData.GpuClock"
                :min="coreClockRange.Min"
                :max="coreClockRange.Max"
                class="w-full"
                @change="userTouched = true"
              />
            </div>

            <div class="space-y-2">
              <div class="flex justify-between items-center text-xs">
                <span class="text-gray-300 flex items-center gap-1"
                  >显存频率 <span class="text-gray-500 cursor-pointer text-[10px]">。</span></span
                >
                <span class="text-purple-400 font-medium font-mono"
                  >{{ GPUData.MemoryClock }} MHz</span
                >
              </div>
              <a-slider
                v-model="GPUData.MemoryClock"
                :min="memClockRange.Min"
                :max="memClockRange.Max"
                class="w-full"
                @change="userTouched = true"
              />
            </div>

            <!-- 功耗限制：笔记。TGP 由固。EC 管理，驱动接口不可用，暂不提。
                 故此处不提供功耗滑条；但「重置」仍要把 PowerLimit 拉回驱动上限，
                 powerLimitRange 依旧要随 fetchGpuRanges 一起探测并钳制。-->
          </div>

          <div class="flex justify-start items-center pt-2 border-t border-ink/[0.04]">
            <button
              class="flex items-center gap-2 text-xs text-gray-400 hover:text-ink border border-ink/10 hover:border-ink/20 bg-ink/[0.02] hover:bg-ink/[0.05] px-4 py-2 rounded-lg transition-colors pressable"
              @click="handleResetNormal"
            >
              重置
            </button>
          </div>
          <ApplyBar
            :phase="applyPhase"
            :status-text="applyStatus"
            :busy="loading"
            apply-label="应用 GPU 设置"
            @apply="handleApplyNormal"
          />
          <CompositeSteps
            :steps="composite.state.value.steps"
            :partial="composite.state.value.partialApplied"
            :message="composite.state.value.message"
          />
        </div>
      </div>

      <!-- ==================== 右侧：显卡信息与实时监控区==================== -->
      <div class="w-full lg:w-[360px] shrink-0 space-y-6">
        <!-- 2. 实时监控面板 -->
        <div class="panel-card p-5 space-y-4">
          <div class="flex justify-between items-center">
            <h2 class="text-[13px] font-semibold text-gray-300">实时监控</h2>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <!-- GPU 使用。-->
            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[11px] text-muted block">GPU 使用率</span>
                <span class="text-base font-bold text-ink font-mono"
                  >{{ gpuUtilization != null ? gpuUtilization : '—' }}
                  <span class="text-[10px] text-gray-500 font-bold">%</span></span
                >
              </div>
              <svg
                class="w-full h-8 opacity-70 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="g-purple" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#8A2BE2" stop-opacity="0.3" />
                    <stop offset="100%" stop-color="#8A2BE2" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path :d="utilChart.line" fill="none" stroke="#8A2BE2" stroke-width="1.5" />
                <path :d="utilChart.area" fill="url(#g-purple)" />
              </svg>
            </div>

            <!-- 显存使用。-->
            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[11px] text-muted block">显存使用率</span>
                <span class="text-base font-bold text-ink font-mono"
                  >{{ gpuMemoryUtilization != null ? gpuMemoryUtilization : '—' }}
                  <span class="text-[10px] text-gray-500 font-bold">%</span></span
                >
              </div>
              <svg
                class="w-full h-8 opacity-70 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="g-blue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#3B82F6" stop-opacity="0.3" />
                    <stop offset="100%" stop-color="#3B82F6" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path :d="memUtilChart.line" fill="none" stroke="#3B82F6" stroke-width="1.5" />
                <path :d="memUtilChart.area" fill="url(#g-blue)" />
              </svg>
            </div>

            <!-- 核心频率 -->
            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[10px] text-gray-500 block">核心频率</span>
                <span class="text-base font-bold text-ink font-mono"
                  >{{ gpuCoreClock != null ? gpuCoreClock : '—' }}
                  <span class="text-[9px] text-gray-500 font-bold">MHz</span></span
                >
              </div>
              <svg
                class="w-full h-8 opacity-70 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
              >
                <path :d="coreClockChart.line" fill="none" stroke="#8A2BE2" stroke-width="1.5" />
                <path :d="coreClockChart.area" fill="url(#g-purple)" />
              </svg>
            </div>

            <!-- 显存频率 -->
            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[10px] text-gray-500 block">显存频率</span>
                <span class="text-base font-bold text-ink font-mono"
                  >{{ gpuMemoryClock != null ? gpuMemoryClock : '—' }}
                  <span class="text-[9px] text-gray-500 font-bold">MHz</span></span
                >
              </div>
              <svg
                class="w-full h-8 opacity-70 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
              >
                <path :d="memClockChart.line" fill="none" stroke="#3B82F6" stroke-width="1.5" />
                <path :d="memClockChart.area" fill="url(#g-blue)" />
              </svg>
            </div>

            <!-- GPU 温度 -->
            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[10px] text-gray-500 block">GPU 温度</span>
                <span class="text-base font-bold text-ink font-mono"
                  >{{ gpuTemp != null ? gpuTemp : '—' }}
                  <span class="text-[10px] text-gray-500 font-bold">°C</span></span
                >
              </div>
              <svg
                class="w-full h-8 opacity-70 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="g-green" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#10B981" stop-opacity="0.3" />
                    <stop offset="100%" stop-color="#10B981" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path :d="tempChart.line" fill="none" stroke="#10B981" stroke-width="1.5" />
                <path :d="tempChart.area" fill="url(#g-green)" />
              </svg>
            </div>

            <!-- 风扇转。-->
            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[10px] text-gray-500 block">风扇转速</span>
                <span class="text-base font-bold text-ink font-mono"
                  >{{ gpuFanSpeed != null ? gpuFanSpeed : '—' }}
                  <span class="text-[9px] text-gray-500 font-bold">RPM</span></span
                >
              </div>
              <svg
                class="w-full h-8 opacity-70 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
              >
                <path :d="fanChart.line" fill="none" stroke="#3B82F6" stroke-width="1.5" />
                <path :d="fanChart.area" fill="url(#g-blue)" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
  <div v-else class="flex items-center justify-center h-full">
    <a-spin dot />
  </div>
</template>

<style lang="scss" scoped>
:deep(.arco-select-view-value) {
  color: var(--color-text-main);
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}

.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

:deep(.select-dark .arco-select-view-single) {
  background-color: var(--color-panel-elevated) !important;
  border: 1px solid var(--color-line-soft) !important;
  color: var(--color-text-main) !important;
  border-radius: 8px !important;
  height: 32px !important;
}

:deep(.arco-switch-checked) {
  background-color: var(--accent) !important;
}

/* 应用按钮: 只过渡底色。原。shadow-[0_0_15px_紫] 辉光, 。。AI 。定案移除 */
.tok-apply {
  transition: background-color var(--dur-fast) var(--ease-out);
}
</style>
