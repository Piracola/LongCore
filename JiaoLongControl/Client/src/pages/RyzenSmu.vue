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
import { PollingChannel } from '@/utils/reading'
import { useCompositeWrite } from '@/composables/useCompositeWrite'
import CompositeSteps from '@/components/common/CompositeSteps.vue'
import ApplyBar from '@/components/common/ApplyBar.vue'
import PageShell from '@/components/common/PageShell.vue'
import { useActivityStore } from '@/stores/activity'

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
      { label: '温度墙限制 (MP1)', key: 'TempLimitMp1', min: 40, max: 100, unit: '℃' },
      { label: '温度墙限制 (RSMU)', key: 'TempLimitRsmu', min: 40, max: 100, unit: '℃' },
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

const limitGroups = CONFIG_GROUPS.filter((g) => !g.title.includes('Clocks'))
const clockGroup = CONFIG_GROUPS.find((g) => g.title.includes('Clocks'))!
// 全核 CO 与时钟设置同批提交；滑块本身不再放置独立写入按钮。
clockGroup.items.push({
  label: '全核曲线偏移（Curve Optimizer All）',
  key: 'CurveOptimizerAll',
  min: -30,
  max: 0,
  unit: '',
})

const loadingMap = reactive<Record<string, boolean>>({})
const composite = useCompositeWrite()
const activity = useActivityStore()
const applyingGroup = ref<string | null>(null)
const lastAppliedGroup = ref<string | null>(null)
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
const dirtyPerCoreCurve = reactive(new Set<number>())
const dirtyPerCoreOcClk = reactive(new Set<number>())
const perCoreGroup = { title: '逐核设置', items: [] as ConfigGroupItem[] }
const perCorePendingCount = computed(() => dirtyPerCoreCurve.size + dirtyPerCoreOcClk.size)

function markPerCoreDirty(index: number, kind: 'curve' | 'clock') {
  if (kind === 'curve') dirtyPerCoreCurve.add(index)
  else dirtyPerCoreOcClk.add(index)
}

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

/** 限制型参数当前为 0：当作未读取。滑条仍可拖，0 只在下发时拦截。 */
const SMU_UNREAD_KEYS = new Set([
  'StapmLimit',
  'StapmTime',
  'FastLimit',
  'SlowLimit',
  'SlowTime',
  'PptLimitRsmu',
  'VrmCurrentMp1',
  'VrmCurrentRsmu',
  'EdcLimitMp1',
  'EdcLimitRsmu',
  'TempLimitMp1',
  'TempLimitRsmu',
])

function isUnread(itemKey: string, value: number | undefined): boolean {
  return SMU_UNREAD_KEYS.has(itemKey) && (!Number.isFinite(Number(value)) || Number(value) === 0)
}

async function applyGroup(group: ConfigGroup) {
  if (!smuData.value || composite.isBusy.value) return
  applyingGroup.value = group.title
  const data = smuData.value
  const event = await composite.run({
    source: 'user',
    transport: 'smu',
    requestedValue: group.title,
    reversible: 'b',
    compensation: '无可靠 getter，只能重新应用',
    preRead: null,
    steps: group.items.map((item) => ({
      label: item.label,
      transport: 'smu' as const,
      requestedValue: Number(data[item.key]),
      skippable: () => isZeroBlocked(item.key, Number(data[item.key])),
      run: async () => {
        const methodName = `Set${item.key}` as keyof typeof RyzenSmu
        const fn = RyzenSmu[methodName] as unknown as (
          ...methodArgs: number[]
        ) => Promise<CommandResult>
        return fn(Number(data[item.key]))
      },
    })),
  })
  if (event.commandAccepted) configStore.debouncedSave()
  const { ok, failed, skipped } = composite.summary.value
  // 一项都没发出去却报「已提交」是谎报：整组为 0/越界时 skipped 顶满了 ok，
  // 旧实现照旧弹 success，用户以为写进去了，实际一条命令都没发。
  const nothingSent = ok === 0 && skipped > 0
  if (nothingSent) {
    const reasons = event.steps
      .filter((s) => s.status === 'skipped')
      .map((s) => s.label)
      .join('、')
    Message.warning(`未下发任何命令：${skipped} 项被闸门拒绝（${reasons}）。请先设定有效值。`)
  } else if (event.partialApplied) {
    Message.warning(`部分应用：${ok} 项已生效，其余未执行。已生效项不会自动撤销。`)
  } else if (failed) {
    Message.error(composite.state.value.message || '本组应用失败')
  } else {
    Message.success(
      `本组已提交（${ok} 项${skipped ? `，跳过 ${skipped} 项` : ''}）。仅命令确认，不可回读。`,
    )
  }
  activity.record({
    source: 'user',
    intent: `SMU 应用「${group.title}」`,
    requestedValue: group.title,
    outcome: nothingSent
      ? 'failed'
      : event.partialApplied
        ? 'partial'
        : failed
          ? 'failed'
          : 'applied',
    reversible: 'b',
  })
  lastAppliedGroup.value = group.title
  applyingGroup.value = null
}

async function applyPerCore() {
  if (composite.isBusy.value || perCorePendingCount.value === 0) return
  const steps: Parameters<typeof composite.run>[0]['steps'] = []
  for (const index of [...dirtyPerCoreCurve].sort((a, b) => a - b)) {
    steps.push({
      label: `核心 ${String(index).padStart(2, '0')} 曲线偏移`,
      transport: 'smu',
      requestedValue: perCoreCurve[index] ?? 0,
      run: async () => {
        const v = Number(perCoreCurve[index] ?? 0)
        // 逐核 CO 与全核同规则：仅允许降压，不允许加压
        const gate = writeGate.smu('CurveOptimizerPerCore', v)
        if (!gate.allowed) {
          return { accepted: false, message: gate.reason ?? '值被写入闸门拒绝' }
        }
        return RyzenSmu.SetCurveOptimizerPerCore(index, v)
      },
    })
  }
  for (const index of [...dirtyPerCoreOcClk].sort((a, b) => a - b)) {
    steps.push({
      label: `核心 ${String(index).padStart(2, '0')} 超频频率`,
      transport: 'smu',
      requestedValue: perCoreOcClk[index] ?? 0,
      run: async () => {
        const v = Number(perCoreOcClk[index] ?? 0)
        const gate = writeGate.smu('PerCoreOcClk', v)
        if (!gate.allowed) {
          return { accepted: false, message: gate.reason ?? '值被写入闸门拒绝' }
        }
        return RyzenSmu.SetPerCoreOcClk(index, v)
      },
    })
  }
  applyingGroup.value = perCoreGroup.title
  const event = await composite.run({
    source: 'user',
    transport: 'smu',
    requestedValue: perCoreGroup.title,
    reversible: 'b',
    compensation: '无可靠 getter，只能重新应用',
    preRead: null,
    steps,
  })
  const { ok, failed, skipped } = composite.summary.value
  if (event.partialApplied) {
    Message.warning(`部分应用：${ok} 项已生效，其余未执行。已生效项不会自动撤销。`)
  } else if (failed) {
    Message.error(composite.state.value.message || '逐核设置应用失败')
  } else {
    Message.success(
      `逐核设置已提交（${ok} 项${skipped ? `，跳过 ${skipped} 项` : ''}）。仅命令确认，不可回读。`,
    )
    dirtyPerCoreCurve.clear()
    dirtyPerCoreOcClk.clear()
  }
  activity.record({
    source: 'user',
    intent: 'SMU 应用逐核设置',
    requestedValue: perCoreGroup.title,
    outcome: event.partialApplied ? 'partial' : failed ? 'failed' : 'applied',
    reversible: 'b',
  })
  lastAppliedGroup.value = perCoreGroup.title
  applyingGroup.value = null
}

type SmuApplyPhase = 'idle' | 'running' | 'success' | 'partial' | 'failed'

function groupApplyPhase(group: ConfigGroup): SmuApplyPhase {
  if (applyingGroup.value === group.title) return 'running'
  if (lastAppliedGroup.value !== group.title) return 'idle'
  return composite.state.value.phase
}

function groupApplyStatus(group: ConfigGroup): string {
  const phase = groupApplyPhase(group)
  if (phase === 'running') return '正在逐项下发…'
  if (phase === 'partial') return '部分应用 · 已接受项不会自动撤销'
  if (phase === 'failed') return composite.state.value.message || '本组应用失败'
  if (phase === 'success') return '仅命令确认 · 无可靠回读'
  return '目标值暂存于配置 · 应用后仅确认命令是否被接受'
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
const telemetry = ref<SmuTelemetry | null>(null)
const telemetryState = ref<'loading' | 'ok' | 'stale' | 'error'>('loading')
const telemetryStateLabel = computed(() => {
  switch (telemetryState.value) {
    case 'ok':
      return '数据正常'
    case 'stale':
      return '数据过期'
    case 'error':
      return '读取失败'
    default:
      return '正在读取'
  }
})
const pptHistory = ref<number[]>([])
const tdcHistory = ref<number[]>([])
const edcHistory = ref<number[]>([])
const tempHistory = ref<number[]>([])

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

/** 在途标志：宿主慢时不得叠加第二次请求（2026-09-16 卡死事故直接成因之一） */
let telemetryInFlight = false
/** 已卸载标志：异步初始化晚于卸载时不得再建定时器，否则泄漏且永不清理 */
let disposed = false
let poll: PollingChannel | null = null

async function fetchTelemetry(): Promise<boolean> {
  if (telemetryInFlight || disposed) return false
  telemetryInFlight = true
  try {
    const res = await RyzenSmu.GetSmuTelemetry()
    if (res.Success && res.Data) {
      telemetry.value = res.Data
      telemetryState.value = 'ok'
      pushHistory(pptHistory.value, res.Data.Ppt)
      if (res.Data.Tdc != null) pushHistory(tdcHistory.value, res.Data.Tdc)
      if (res.Data.Edc != null) pushHistory(edcHistory.value, res.Data.Edc)
      pushHistory(tempHistory.value, res.Data.Temp)
      return true
    }
    telemetryState.value = telemetry.value ? 'stale' : 'error'
    return false
  } catch {
    telemetryState.value = telemetry.value ? 'stale' : 'error'
    return false
  } finally {
    telemetryInFlight = false
  }
}

async function loadCpuInfo() {
  try {
    const coreRes = await CPU.GetPhysicalCoreCount()
    if (disposed) return
    coreCount.value = coreRes.Success && coreRes.Data > 0 ? Number(coreRes.Data) : 0
  } catch {
    // 读失败就是读失败：保留 0 并在 UI 标注「未读取」，绝不回填一个假的 8
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
  // PollingChannel.start() 内部会立即打第一拍；此处再手动调一次会重复触发，
  // 第二次命中 telemetryInFlight 返回 false，被 tick 误计一次失败并启动退避。
  poll = new PollingChannel(() => fetchTelemetry(), { intervalMs: POLL_INTERVAL_SMU })
  poll.start()
  void loadCpuInfo()
})

onUnmounted(() => {
  disposed = true
  poll?.dispose()
  poll = null
})

function tempClass(celsius: number) {
  if (celsius > 90) return 'text-temp-critical'
  if (celsius > 80) return 'text-temp-hot'
  return 'text-ink'
}
</script>

<template>
  <PageShell
    v-if="smuData"
    title="Ryzen SMU"
    subtitle="高级高风险设置：目标值写入 SMU 固件；当前限制无法可靠回读，只能确认命令是否被接受。"
  >
    <div class="w-full flex flex-col gap-6">
      <div class="smu-split">
        <div class="smu-main space-y-5 min-w-0">
          <div
            v-for="group in limitGroups"
            :key="group.title"
            class="panel-card p-5 flex flex-col justify-between"
          >
            <div>
              <h3 class="section-label">{{ group.title }}</h3>

              <div class="space-y-4">
                <div v-for="item in group.items" :key="item.key" class="space-y-1.5">
                  <div class="flex justify-between items-center gap-3 text-xs">
                    <span class="text-muted min-w-0">{{ item.label }}</span>
                    <div class="flex items-center gap-2 shrink-0">
                      <span v-if="isUnread(item.key, smuData[item.key])" class="unread-tag"
                        >未读取</span
                      >
                      <a-input-number
                        v-model="smuData[item.key]"
                        :min="item.min"
                        :max="item.max"
                        :step="item.step || 1"
                        size="mini"
                        hide-button
                        class="smu-num tnum"
                      />
                      <span class="text-weak w-7">{{ item.unit }}</span>
                    </div>
                  </div>
                  <a-slider
                    v-model="smuData[item.key]"
                    :min="item.min"
                    :max="item.max"
                    :step="item.step || 1"
                    class="w-full"
                  />
                </div>
              </div>
            </div>

            <div class="mt-5 pt-4 border-t border-hair space-y-3">
              <p
                v-if="group.items.some((item) => isUnread(item.key, smuData?.[item.key]))"
                class="unread-hint"
              >
                「未读取」项当前是 0，先拖动或输入目标值。0 不会下发。
              </p>
              <ApplyBar
                :phase="groupApplyPhase(group)"
                :status-text="groupApplyStatus(group)"
                :busy="applyingGroup === group.title"
                :disabled="!!applyingGroup && applyingGroup !== group.title"
                apply-label="应用本组"
                @apply="applyGroup(group)"
              />
              <CompositeSteps
                v-if="lastAppliedGroup === group.title"
                :steps="composite.state.value.steps"
                :partial="composite.state.value.partialApplied"
                :message="composite.state.value.message"
              />
            </div>
          </div>
        </div>

        <aside class="smu-side space-y-5">
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
                <div v-if="coreCount > 0">Curve Optimizer 已加载 {{ coreCount }} 核</div>
                <div v-else class="text-weak">核心数未读取 · 逐核功能暂不可用</div>
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
                {{
                  telemetry
                    ? `${telemetry.FreqMhz} MHz · ${telemetry.Usage}% 负载 · ${telemetryStateLabel}`
                    : telemetryStateLabel
                }}
              </span>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="bg-inset border border-hair p-3 rounded-lg flex flex-col justify-between">
                <div>
                  <span class="text-[11px] text-muted block">PPT 封装功耗</span>
                  <span class="text-base font-bold text-ink tnum"
                    >{{ telemetry ? telemetry.Ppt.toFixed(1) : '—' }}
                    <span class="text-[11px] text-weak font-semibold">W</span></span
                  >
                </div>
                <svg
                  v-if="pptHistory.length > 1"
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
                    >{{ telemetry?.Tdc != null ? telemetry.Tdc.toFixed(1) : '—' }}
                    <span class="text-[11px] text-weak font-semibold">A</span></span
                  >
                </div>
                <svg
                  v-if="tdcHistory.length > 1"
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
                    >{{ telemetry?.Edc != null ? telemetry.Edc.toFixed(1) : '—' }}
                    <span class="text-[11px] text-weak font-semibold">A</span></span
                  >
                </div>
                <svg
                  v-if="edcHistory.length > 1"
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
                  <span
                    class="text-base font-bold tnum"
                    :class="telemetry ? tempClass(telemetry.Temp) : 'text-weak'"
                    >{{ telemetry ? telemetry.Temp.toFixed(1) : '—' }}
                    <span class="text-[11px] text-weak font-semibold">°C</span></span
                  >
                </div>
                <svg
                  v-if="tempHistory.length > 1"
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
        </aside>
      </div>

      <section class="panel-card p-5">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 class="section-label !mb-0">时钟、超频与逐核</h3>
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

        <div class="clocks-block">
          <h4 class="clocks-kicker">{{ clockGroup.title }}</h4>
          <div class="clocks-grid">
            <div
              v-for="item in clockGroup.items.filter((entry) => entry.key !== 'CurveOptimizerAll')"
              :key="item.key"
              class="space-y-1.5"
            >
              <div class="flex justify-between items-center gap-3 text-xs">
                <span class="text-muted min-w-0">{{ item.label }}</span>
                <div class="flex items-center gap-2 shrink-0">
                  <a-input-number
                    v-model="smuData[item.key]"
                    :min="item.min"
                    :max="item.max"
                    :step="item.step || 1"
                    size="mini"
                    hide-button
                    class="smu-num tnum"
                  />
                  <span class="text-weak w-7">{{ item.unit }}</span>
                </div>
              </div>
              <a-slider
                v-model="smuData[item.key]"
                :min="item.min"
                :max="item.max"
                :step="item.step || 1"
                class="w-full"
              />
            </div>
          </div>
          <div class="clocks-actions">
            <button
              class="btn-ghost flex-1 pressable"
              :disabled="loadingMap['EnableOc'] || !!applyingGroup"
              @click="applySetting('EnableOc')"
            >
              启用超频
            </button>
            <button
              class="btn-danger flex-1 pressable"
              :disabled="loadingMap['DisableOc'] || !!applyingGroup"
              @click="applySetting('DisableOc')"
            >
              禁用超频
            </button>
          </div>
          <ApplyBar
            :phase="groupApplyPhase(clockGroup)"
            :status-text="groupApplyStatus(clockGroup)"
            :busy="applyingGroup === clockGroup.title"
            :disabled="!!applyingGroup && applyingGroup !== clockGroup.title"
            apply-label="应用时钟组"
            @apply="applyGroup(clockGroup)"
          />
          <CompositeSteps
            v-if="lastAppliedGroup === clockGroup.title"
            :steps="composite.state.value.steps"
            :partial="composite.state.value.partialApplied"
            :message="composite.state.value.message"
          />
        </div>

        <div class="bg-inset border border-hair p-3.5 rounded-lg mb-5">
          <div class="flex justify-between items-center mb-1 text-xs">
            <span class="font-semibold text-ink">全核曲线偏移（Curve Optimizer All）</span>
            <span class="tnum text-accent font-semibold">{{ smuData.CurveOptimizerAll }}</span>
          </div>
          <div class="flex items-center gap-3">
            <a-slider v-model="smuData.CurveOptimizerAll" :min="-30" :max="0" class="flex-1" />
          </div>
        </div>

        <div class="core-grid">
          <div v-for="(_, index) in perCoreCurve" :key="index" class="core-card">
            <div class="core-id">CORE {{ String(index).padStart(2, '0') }}</div>
            <div class="core-row">
              <span class="core-k">CO</span>
              <a-input-number
                v-model="perCoreCurve[index]"
                :min="-50"
                :max="50"
                size="mini"
                hide-button
                class="core-num tnum"
                @change="markPerCoreDirty(index, 'curve')"
              />
            </div>
            <div class="core-row">
              <span class="core-k">OC</span>
              <a-input-number
                v-model="perCoreOcClk[index]"
                :min="0"
                :max="1000"
                :step="25"
                size="mini"
                hide-button
                class="core-num tnum"
                @change="markPerCoreDirty(index, 'clock')"
              />
              <span class="core-unit">MHz</span>
            </div>
          </div>
        </div>
        <ApplyBar
          :phase="groupApplyPhase(perCoreGroup)"
          :status-text="
            perCorePendingCount > 0
              ? `待应用 ${perCorePendingCount} 项`
              : groupApplyStatus(perCoreGroup)
          "
          :busy="applyingGroup === perCoreGroup.title"
          :disabled="
            perCorePendingCount === 0 || (!!applyingGroup && applyingGroup !== perCoreGroup.title)
          "
          apply-label="应用逐核设置"
          @apply="applyPerCore"
        />
      </section>
    </div>
  </PageShell>
  <div v-else class="flex items-center justify-center h-full">
    <a-spin dot />
  </div>
</template>

<style scoped>
.unread-hint {
  margin: 0;
  font-size: 11px;
  color: var(--temp-hot);
  line-height: 1.45;
}

.clocks-block {
  margin-bottom: 20px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--hair);
}

.clocks-kicker {
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--weak);
}

.clocks-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.clocks-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

@media (max-width: 900px) {
  .clocks-grid {
    grid-template-columns: 1fr;
  }

  .clocks-actions {
    flex-direction: column;
  }
}

.smu-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  align-items: start;
}

@media (max-width: 1100px) {
  .smu-split {
    grid-template-columns: 1fr;
  }
}

.unread-tag {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--temp-hot);
  background: var(--temp-hot-bg, rgba(245, 158, 11, 0.12));
  border: 1px solid color-mix(in srgb, var(--temp-hot) 35%, transparent);
  padding: 1px 6px;
  border-radius: 999px;
}

.smu-num {
  width: 72px;
}

.smu-num :deep(.arco-input-number) {
  background: var(--bg-inset);
  border-color: var(--hair);
}

.core-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}

.core-card {
  background: var(--bg-inset);
  border: 1px solid var(--hair);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.core-id {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--weak);
}

.core-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.core-k {
  font-size: 11px;
  color: var(--muted);
  width: 22px;
  flex-shrink: 0;
}

.core-num {
  width: 64px;
  flex: 1;
}

.core-unit {
  font-size: 10px;
  color: var(--weak);
}

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
