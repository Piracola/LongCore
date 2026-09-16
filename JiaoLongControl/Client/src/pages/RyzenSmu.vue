<script setup lang="ts">
import CpuDie from '@/components/common/CpuDie.vue'

import { reactive, ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { Message } from '@arco-design/web-vue'
import { CPU, RyzenSmu, type CommandResult, type SmuTelemetry } from '@/utils/bridge'
import { useConfigStore } from '@/stores/config'
import type { SmuSectionType } from '@/types/config'
import { POLL_INTERVAL_SMU } from '@/constants'
import { buildSparkline, type SparklineResult } from '@/utils/chart'
import { writeGate } from '@/domain/writeGate'

interface ConfigGroupItem {
  label: string
  key: keyof SmuSectionType
  min: number
  max: number
  step?: number
  unit: string
}
interface ConfigGroup {
  title: string
  items: ConfigGroupItem[]
}

const CONFIG_GROUPS: ConfigGroup[] = [
  {
    title: '功耗限制 Power Limits',
    items: [
      { label: 'STAPM 长期功耗上限', key: 'StapmLimit', min: 0, max: 200, unit: 'W' },
      { label: 'STAPM 时间窗口', key: 'StapmTime', min: 0, max: 3600, unit: 's' },
      { label: 'Fast 瞬时功耗上限', key: 'FastLimit', min: 0, max: 200, unit: 'W' },
      { label: 'Slow 持续功耗上限', key: 'SlowLimit', min: 0, max: 200, unit: 'W' },
      { label: 'Slow 功耗时间窗口', key: 'SlowTime', min: 0, max: 3600, unit: 's' },
      { label: 'PPT 功耗限制 (RSMU)', key: 'PptLimitRsmu', min: 0, max: 200, unit: 'W' },
    ],
  },
  {
    title: '电流限制 Current Limits',
    items: [
      {
        label: 'VRM 持续电流限制 (MP1)',
        key: 'VrmCurrentMp1',
        min: 0,
        max: 300000,
        step: 1000,
        unit: 'mA',
      },
      {
        label: 'VRM 持续电流限制 (RSMU)',
        key: 'VrmCurrentRsmu',
        min: 0,
        max: 300000,
        step: 1000,
        unit: 'mA',
      },
      {
        label: 'EDC 瞬间电流限制 (MP1)',
        key: 'EdcLimitMp1',
        min: 0,
        max: 300000,
        step: 1000,
        unit: 'mA',
      },
      {
        label: 'EDC 瞬间电流限制 (RSMU)',
        key: 'EdcLimitRsmu',
        min: 0,
        max: 300000,
        step: 1000,
        unit: 'mA',
      },
    ],
  },
  {
    title: '温度控制 Thermal Control',
    items: [
      { label: '温度墙限制 (MP1)', key: 'TempLimitMp1', min: 40, max: 115, unit: '℃' },
      { label: '温度墙限制 (RSMU)', key: 'TempLimitRsmu', min: 40, max: 115, unit: '℃' },
    ],
  },
  {
    title: '时钟与超频 Clocks & OC',
    items: [
      { label: 'PBO 倍率上限选择', key: 'PboScalar', min: 1, max: 10, unit: 'x' },
      { label: '超频核心频率偏移', key: 'OcClk', min: -500, max: 500, step: 25, unit: 'MHz' },
      { label: '超频核心电压设定', key: 'OcVolt', min: 0, max: 1550, step: 5, unit: 'mV' },
    ],
  },
]

const loadingMap = reactive<Record<string, boolean>>({})
const configStore = useConfigStore()
if (!configStore.config) {
  await configStore.fetchConfig()
}
const smuData = computed(() => configStore.config?.Smu)

const coreCount = ref(0)
const cpuName = ref('AMD Ryzen')
const cpuCoreInfo = ref('')

const perCoreCurve = reactive<number[]>([])
const perCoreOcClk = reactive<number[]>([])

watch(
  coreCount,
  (newCount) => {
    if (newCount <= 0) return
    const currentLen = perCoreCurve.length
    if (newCount > currentLen) {
      for (let i = currentLen; i < newCount; i++) {
        perCoreCurve.push(0)
        perCoreOcClk.push(0)
      }
    } else if (newCount < currentLen) {
      perCoreCurve.splice(newCount)
      perCoreOcClk.splice(newCount)
    }
  },
  { immediate: true },
)

/**
 * 写入闸门收口（v4 §8.6）：ZERO_UNWRITABLE 已抽至 domain/writeGate.ts（单一前端闸门），
 * 本页所有 setter 经 writeGate.smu() 校验；Server 侧 HwWriteGate 为第二道防线。
 */

function smuGate(itemKey: string, value: number | undefined) {
  return writeGate.smu(itemKey, Number(value))
}

function isZeroBlocked(itemKey: string, value: number | undefined): boolean {
  return !smuGate(itemKey, value).allowed
}

/** 把模板里的 loadingMap 键与 applySetting 的 methodName 对齐。
 *  此前模板读 loadingMap[item.key]、写入却落在 loadingMap['Set'+item.key]，
 *  两个键从来不同名 → 按钮禁用态从未生效，连点即连发写入。 */
function setterKey(itemKey: string): string {
  return `Set${itemKey}`
}

const applySetting = async (methodName: keyof typeof RyzenSmu, ...args: number[]) => {
  const itemKey = String(methodName).replace(/^Set/, '')

  // 统一写入闸门（v4 §8.6）：0 值拦截 + 前端一致性值域校验，拒绝原因直接展示
  if (args.length === 1) {
    const gate = smuGate(itemKey, args[0])
    if (!gate.allowed) {
      Message.warning(gate.reason || '该值已被写入闸门阻止')
      return
    }
  }

  loadingMap[methodName] = true
  try {
    const fn = RyzenSmu[methodName] as unknown as (
      ...methodArgs: number[]
    ) => Promise<CommandResult>
    const res = await fn(...args)

    if (res.Success) {
      Message.success(res.Message || '应用成功')
    } else {
      Message.error(res.Message || '应用失败')
    }
    configStore.debouncedSave()
  } catch (e) {
    Message.error('应用执行失败')
    console.error(e)
  } finally {
    loadingMap[methodName] = false
  }
}

const HISTORY_LEN = 24
const telemetry = ref<SmuTelemetry>({
  Ppt: 0,
  Tdc: null,
  Edc: null,
  Temp: 0,
  FreqMhz: 0,
  Usage: 0,
})
const pptHistory = ref<number[]>(Array(HISTORY_LEN).fill(0))
const tdcHistory = ref<number[]>(Array(HISTORY_LEN).fill(0))
const edcHistory = ref<number[]>(Array(HISTORY_LEN).fill(0))
const tempHistory = ref<number[]>(Array(HISTORY_LEN).fill(0))

function pushHistory(arr: number[], value: number) {
  arr.push(value)
  if (arr.length > HISTORY_LEN) arr.shift()
}

function sparkline(history: number[], yMax: number): SparklineResult {
  return buildSparkline(history, { width: 160, height: 40, max: yMax, smooth: true, area: true })
}

const pptChart = computed(() => sparkline(pptHistory.value, 150))
const tdcChart = computed(() => sparkline(tdcHistory.value, 300))
const edcChart = computed(() => sparkline(edcHistory.value, 400))
const tempChart = computed(() => sparkline(tempHistory.value, 110))

let pollingTimer: ReturnType<typeof setInterval> | null = null
/** 在途标志：宿主慢时不得叠加第二次请求（2026-09-16 卡死事故直接成因之一） */
let telemetryInFlight = false
/** 已卸载标志：异步初始化晚于卸载时不得再建定时器，否则泄漏且永不清理 */
let disposed = false
/** 连续失败计数：达上限即停止轮询，避免反复撞击已卡住的宿主 */
let consecutiveFailures = 0
let telemetryStalled = false
const MAX_CONSECUTIVE_FAILURES = 5

async function fetchTelemetry() {
  if (telemetryInFlight || disposed) return
  telemetryInFlight = true
  try {
    const res = await RyzenSmu.GetSmuTelemetry()
    if (res.Success && res.Data) {
      telemetry.value = res.Data
      pushHistory(pptHistory.value, res.Data.Ppt)
      pushHistory(tdcHistory.value, res.Data.Tdc ?? 0)
      pushHistory(edcHistory.value, res.Data.Edc ?? 0)
      pushHistory(tempHistory.value, res.Data.Temp)
      consecutiveFailures = 0
      telemetryStalled = false
    } else {
      consecutiveFailures += 1
    }
  } catch {
    // silent fail — telemetry is best-effort
    consecutiveFailures += 1
  } finally {
    telemetryInFlight = false
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stopPolling()
      telemetryStalled = true
    }
  }
}

function startPolling() {
  if (disposed || telemetryStalled || pollingTimer !== null) return
  pollingTimer = setInterval(fetchTelemetry, POLL_INTERVAL_SMU)
}

function stopPolling() {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

/** 窗口不可见时停轮询：后台挂着的控制台不该持续敲固件 */
function handleVisibilityChange() {
  if (document.hidden) {
    stopPolling()
    return
  }
  if (!telemetryStalled) {
    void fetchTelemetry()
    startPolling()
  }
}

async function loadCpuInfo() {
  try {
    const coreRes = await CPU.GetPhysicalCoreCount()
    if (disposed) return
    coreCount.value = coreRes.Success && coreRes.Data > 0 ? coreRes.Data : 8
  } catch {
    if (!disposed) coreCount.value = 8
  }

  try {
    const infoRes = await CPU.GetCpuInfo()
    if (disposed) return
    if (infoRes.Success && infoRes.Data) {
      cpuName.value = infoRes.Data.Name || 'AMD Ryzen'
      cpuCoreInfo.value = `${infoRes.Data.Cores} 核心 / ${infoRes.Data.Threads} 线程`
    }
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange)
  // 先起轮询、再取 CPU 信息：任何 await 之后都不再创建定时器，杜绝卸载竞态泄漏
  void fetchTelemetry()
  startPolling()
  void loadCpuInfo()
})

onUnmounted(() => {
  disposed = true
  stopPolling()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})

function tempClass(celsius: number) {
  if (celsius > 90) return 'text-temp-critical'
  if (celsius > 80) return 'text-temp-hot'
  return 'text-ink'
}
</script>

<template>
  <div v-if="smuData" class="h-full overflow-y-auto text-ink p-6 no-scrollbar">
    <div class="max-w-[1300px] mx-auto flex flex-col lg:flex-row gap-6">
      <div class="flex-1 space-y-6">
        <div>
          <h1 class="text-2xl font-bold tracking-wide">Ryzen SMU</h1>
          <p class="text-[13px] text-muted mt-1">
            高级电源、电流及频率限制调整（AMD Ryzen 平台专用）
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div
            v-for="group in CONFIG_GROUPS"
            :key="group.title"
            class="panel-card p-5 flex flex-col justify-between"
          >
            <div>
              <h3 class="section-label">{{ group.title }}</h3>

              <div class="space-y-4">
                <div v-for="item in group.items" :key="item.key" class="space-y-1.5">
                  <div class="flex justify-between items-center text-xs">
                    <span class="text-muted">{{ item.label }}</span>
                    <span class="text-ink tnum font-medium">{{
                      isZeroBlocked(item.key, smuData[item.key])
                        ? '未读取'
                        : smuData[item.key] + ' ' + item.unit
                    }}</span>
                  </div>
                  <div class="flex items-center gap-3">
                    <a-slider
                      v-model="smuData[item.key]"
                      :min="item.min"
                      :max="item.max"
                      :step="item.step || 1"
                      class="flex-1"
                    />
                    <button
                      class="btn-apply btn-apply-sm pressable shrink-0"
                      :disabled="
                        loadingMap[setterKey(item.key)] ||
                        isZeroBlocked(item.key, smuData[item.key])
                      "
                      @click="
                        applySetting(('Set' + item.key) as keyof typeof RyzenSmu, smuData[item.key])
                      "
                    >
                      {{ loadingMap[setterKey(item.key)] ? '…' : '应用' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div
              v-if="group.title.includes('Clocks')"
              class="mt-5 flex gap-3 pt-4 border-t border-hair"
            >
              <button
                class="btn-ghost flex-1 pressable"
                :disabled="loadingMap['EnableOc']"
                @click="applySetting('EnableOc')"
              >
                启用超频
              </button>
              <button
                class="btn-danger flex-1 pressable"
                :disabled="loadingMap['DisableOc']"
                @click="applySetting('DisableOc')"
              >
                禁用超频
              </button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div class="panel-card p-5">
            <div class="flex justify-between items-center mb-4">
              <h3 class="section-label !mb-0">Curve Optimizer 曲线优化</h3>
              <div class="flex items-center gap-2">
                <span class="text-[11px] font-medium text-weak uppercase">Cores</span>
                <a-input-number
                  v-model="coreCount"
                  :min="1"
                  :max="64"
                  size="mini"
                  class="!w-14 !bg-ink/5 !border-ink/10 !text-ink rounded-md"
                  hide-button
                />
              </div>
            </div>

            <div class="bg-inset border border-hair p-3.5 rounded-lg mb-4">
              <div class="flex justify-between items-center mb-1 text-xs">
                <span class="font-semibold text-ink">All Core Offset（全核心偏移量）</span>
                <span class="tnum text-accent font-semibold">{{ smuData.CurveOptimizerAll }}</span>
              </div>
              <div class="flex items-center gap-3">
                <a-slider v-model="smuData.CurveOptimizerAll" :min="-30" :max="0" class="flex-1" />
                <button
                  class="btn-apply btn-apply-sm pressable shrink-0"
                  :disabled="loadingMap['SetCurveOptimizerAll']"
                  @click="applySetting('SetCurveOptimizerAll', smuData.CurveOptimizerAll)"
                >
                  应用
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2 max-h-[160px] overflow-y-auto no-scrollbar">
              <div
                v-for="(_, index) in perCoreCurve"
                :key="index"
                class="bg-inset p-2.5 rounded-lg border border-hair flex items-center justify-between"
              >
                <span class="text-[10px] font-semibold text-weak uppercase">CORE {{ index }}</span>
                <div class="flex items-center gap-1.5">
                  <a-input-number
                    v-model="perCoreCurve[index]"
                    :min="-50"
                    :max="50"
                    size="mini"
                    class="!w-12 !bg-transparent !border-none !text-ink p-0 text-center tnum"
                    hide-button
                  />
                  <button
                    class="btn-apply btn-apply-sm !h-6 !w-6 !p-0 pressable"
                    :disabled="loadingMap['SetCurveOptimizerPerCore']"
                    title="应用此核心"
                    @click="
                      applySetting('SetCurveOptimizerPerCore', index, perCoreCurve[index] ?? 0)
                    "
                  >
                    ✓
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="panel-card p-5">
            <h3 class="section-label">Per Core OC Clocks（单核超频限制）</h3>

            <div class="grid grid-cols-2 gap-2 max-h-[240px] overflow-y-auto no-scrollbar">
              <div
                v-for="(_, index) in perCoreOcClk"
                :key="index"
                class="bg-inset p-2.5 rounded-lg border border-hair flex items-center justify-between"
              >
                <span class="text-[10px] font-semibold text-weak uppercase">CORE {{ index }}</span>
                <div class="flex items-center gap-1.5">
                  <a-input-number
                    v-model="perCoreOcClk[index]"
                    :min="0"
                    :max="1000"
                    :step="25"
                    size="mini"
                    class="!w-14 !bg-transparent !border-none !text-ink p-0 text-center tnum"
                    hide-button
                  />
                  <button
                    class="btn-apply btn-apply-sm !h-6 !w-6 !p-0 pressable"
                    :disabled="loadingMap['SetPerCoreOcClk']"
                    title="应用此核心"
                    @click="applySetting('SetPerCoreOcClk', index, perCoreOcClk[index] ?? 0)"
                  >
                    ✓
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="w-full lg:w-[360px] shrink-0 space-y-5">
        <div class="panel-card p-5">
          <h2 class="text-sm font-semibold text-ink mb-4">Ryzen 芯片架构</h2>
          <div class="flex items-center gap-4">
            <div
              class="w-16 h-16 bg-inset border border-hair rounded-lg flex items-center justify-center shrink-0"
            >
              <CpuDie />
            </div>

            <div class="space-y-1 text-xs text-muted">
              <div class="text-[13px] font-bold text-ink">
                <span v-if="cpuName">{{ cpuName }}</span>
                <span v-else class="text-weak">检测中…</span>
              </div>
              <div>AMD Ryzen 架构 / AM5 接口</div>
              <div>
                <span v-if="cpuCoreInfo">{{ cpuCoreInfo }}</span>
                <span v-else class="text-weak">{{
                  coreCount > 0 ? `${coreCount} 物理核心` : '检测中…'
                }}</span>
              </div>
              <div>Curve Optimizer 已加载 {{ coreCount }} 核</div>
              <div>支持 PBO2 曲线优化</div>
            </div>
          </div>
        </div>

        <div class="panel-card p-5 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-ink">SMU 电源遥测</h2>
            <span
              class="text-[11px] text-weak bg-inset border border-hair px-2 py-0.5 rounded-full tnum"
            >
              {{ telemetry.FreqMhz }} MHz · {{ telemetry.Usage }}% 负载
            </span>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[11px] text-muted block">PPT 封装功耗</span>
                <span class="text-base font-bold text-ink tnum"
                  >{{ telemetry.Ppt.toFixed(1) }}
                  <span class="text-[11px] text-weak font-semibold">W</span></span
                >
              </div>
              <svg
                class="w-full h-8 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id="smu-g-accent" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28" />
                    <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path
                  :d="pptChart.line"
                  fill="none"
                  stroke="var(--accent)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
                <path :d="pptChart.area" fill="url(#smu-g-accent)" />
              </svg>
            </div>

            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[11px] text-muted block">TDC 供电电流</span>
                <span class="text-base font-bold text-ink tnum"
                  >{{ (telemetry.Tdc ?? 0).toFixed(1) }}
                  <span class="text-[11px] text-weak font-semibold">A</span></span
                >
              </div>
              <svg
                class="w-full h-8 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  :d="tdcChart.line"
                  fill="none"
                  stroke="var(--accent)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
                <path :d="tdcChart.area" fill="url(#smu-g-accent)" />
              </svg>
            </div>

            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[11px] text-muted block">EDC 峰值电流</span>
                <span class="text-base font-bold text-ink tnum"
                  >{{ (telemetry.Edc ?? 0).toFixed(1) }}
                  <span class="text-[11px] text-weak font-semibold">A</span></span
                >
              </div>
              <svg
                class="w-full h-8 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  :d="edcChart.line"
                  fill="none"
                  stroke="var(--accent)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
                <path :d="edcChart.area" fill="url(#smu-g-accent)" />
              </svg>
            </div>

            <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
              <div>
                <span class="text-[11px] text-muted block">核心温度</span>
                <span class="text-base font-bold tnum" :class="tempClass(telemetry.Temp)"
                  >{{ telemetry.Temp.toFixed(1) }}
                  <span class="text-[11px] text-weak font-semibold">°C</span></span
                >
              </div>
              <svg
                class="w-full h-8 mt-1"
                viewBox="0 0 160 40"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id="smu-g-temp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--temp-hot)" stop-opacity="0.28" />
                    <stop offset="100%" stop-color="var(--temp-hot)" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <path
                  :d="tempChart.line"
                  fill="none"
                  stroke="var(--temp-hot)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
                <path :d="tempChart.area" fill="url(#smu-g-temp)" />
              </svg>
            </div>
          </div>
        </div>

        <div class="panel-card p-5 space-y-2.5">
          <h2 class="text-sm font-semibold text-ink">名词解释</h2>
          <div class="text-xs text-muted leading-relaxed space-y-2">
            <p>
              <strong>STAPM</strong>：根据设备表面温度自适应调整 CPU
              功耗分配（在移动端设备和掌机上尤为明显）。
            </p>
            <p>
              <strong>Curve Optimizer (PBO2)</strong>
              ：通过调校不同内核的电压频率曲线（降压超频），实现在更低温度下达到更高运行频率。
            </p>
            <p>
              <strong>RSMU / MP1</strong>
              ：芯片内部不同模块的系统级微处理器，两者的限制参数相互协调。
            </p>
          </div>
          <a
            target="_blank"
            href="https://www.amd.com/zh-cn/developer/browse-by-resource-type/documentation.html"
            class="text-xs text-accent hover:opacity-80 cursor-pointer pt-1 inline-flex items-center font-medium transition-opacity"
          >
            参考 AMD PBO 手册
          </a>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="flex items-center justify-center h-full">
    <a-spin dot />
  </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.text-temp-hot {
  color: var(--temp-hot);
}
.text-temp-critical {
  color: var(--temp-critical);
}
</style>
