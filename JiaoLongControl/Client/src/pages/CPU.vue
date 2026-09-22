<script setup lang="ts">
import CpuDie from '@/components/common/CpuDie.vue'
import PageShell from '@/components/common/PageShell.vue'
import ApplyBar from '@/components/common/ApplyBar.vue'

import { ref, computed, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { CPU, type CpuInfo } from '@/utils/bridge.ts'
import { useConfigStore } from '@/stores/config'
import { useModeStore } from '@/stores/mode'
import { useSystemInfoStore } from '@/stores/systemInfo'
import type { CpuPowerDataType } from '@/types/config'
import { CPU_CUSTOM_DEFAULTS } from '@/constants'
import { buildCpuPowerRun } from '@/domain/cpuPowerPlan'
import { useCompositeWrite } from '@/composables/useCompositeWrite'
import CompositeSteps from '@/components/common/CompositeSteps.vue'
import { useActivityStore } from '@/stores/activity'

const loading = ref(false)
const configStore = useConfigStore()
const systemInfoStore = useSystemInfoStore()
const modeStore = useModeStore()
void modeStore.refreshObserved().then(() => {
  if (!modeStore.selected) modeStore.syncSelectedFromObserved()
})

// 四态读数裸值（v4 §7）：null = 该通道 error/unavailable，显示「—」；禁止回退 0
const freqMhz = computed(() => systemInfoStore.cpuFreqValue)
const voltV = computed(() => systemInfoStore.cpuVoltValue)
const usagePct = computed(() => systemInfoStore.cpuUsageValue)
const tempC = computed(() => systemInfoStore.cpuTempValue)

if (!configStore.config) {
  await configStore.fetchConfig()
}

const cpuInfo = ref<CpuInfo | null>(null)
const infoResult = await CPU.GetCpuInfo()
if (infoResult.Success) {
  cpuInfo.value = infoResult.Data
}

// 使用 computed 来简化对配置项的访问，并确保响应。
const CPUData = computed(() => configStore.config?.Cpu)
const SmuData = computed(() => configStore.config?.Smu)

// 只有一套功耗参数（原「均衡/性能/节能/自定义」四张方案表已废除）：
// 首页「自定义」与 CPU 页共用 config.yaml 的 Cpu.Custom，模板沿用 activeProfile 命名。
// 只有一套功耗参数（原「均衡/性能/节能/自定义」四张方案表已废除）：
// 首页「自定义」与 CPU 页共用 config.yaml 的 Cpu.Custom，模板沿用 activeProfile 命名。
const activeProfileTitle = '自定义参数'

// 兜底：Custom 可能因旧配置/反序列化缺字段而不存在。旧写法把它断言成非空，
// 模板里 activeProfile.CpuLongPower 会在渲染期抛错白屏 —— 改成取不到就用出厂值，
// 并把「是否存在真实配置」单独暴露给模板，避免假装读到了。
const activeProfile = computed<CpuPowerDataType>(
  () => CPUData.value?.Custom ?? { ...CPU_CUSTOM_DEFAULTS },
)

const trackedProfileFields = [
  'CpuLongPower',
  'CpuShortPower',
  'CpuTempWall',
  'CpuMaxFrequency',
  'CpuTurbo',
] as const
function profileSignature(profile: CpuPowerDataType | undefined, curve: number | undefined) {
  return JSON.stringify([
    ...(profile ? trackedProfileFields.map((key) => profile[key]) : []),
    curve ?? null,
  ])
}
const appliedSnapshot = ref<string | null>(null)
const composite = useCompositeWrite()
const activity = useActivityStore()
const pendingCount = computed(() => {
  if (!activeProfile.value || !appliedSnapshot.value) return 0
  const current = trackedProfileFields.map((key) => activeProfile.value[key])
  const previous = JSON.parse(appliedSnapshot.value) as Array<number | boolean | null>
  return (
    current.reduce<number>(
      (count, value, index) => count + (value !== previous[index] ? 1 : 0),
      0,
    ) + (SmuData.value?.CurveOptimizerAll !== previous[trackedProfileFields.length] ? 1 : 0)
  )
})
const applyPhase = computed(() => {
  switch (composite.state.value.phase) {
    case 'running':
      return 'running' as const
    case 'partial':
      return 'partial' as const
    case 'failed':
      return 'failed' as const
    case 'success':
      return 'success' as const
    default:
      return pendingCount.value > 0 ? ('pending' as const) : ('idle' as const)
  }
})
const applyStatus = computed(() => {
  // 从未成功应用过：不能声称「已存盘/已应用」，那是把未知说成事实
  const neverApplied = appliedSnapshot.value === null
  if (applyPhase.value === 'pending') return `待应用 ${pendingCount.value} 项 · 尚未写入硬件`
  if (applyPhase.value === 'running') return '正在按顺序下发…'
  if (applyPhase.value === 'partial') return '部分应用 · 已生效项不会自动撤销'
  if (applyPhase.value === 'failed') return composite.state.value.message || '应用失败'
  if (applyPhase.value === 'success') return composite.state.value.message || '已应用'
  return neverApplied
    ? '尚未应用 · 改值后点「应用」才会写入硬件'
    : '配置已存盘 · 硬件值需独立读取确认'
})

// 改参数即存盘（只落 config.yaml，不碰硬件）：避免"调完滑条没点应用，重启就没了"。
// 真正的下发只在「应用」里发生（见 buildCpuPowerRun）。
watch(
  () => JSON.stringify([CPUData.value?.Custom, SmuData.value?.CurveOptimizerAll]),
  () => {
    if (!composite.isBusy.value) composite.reset()
    configStore.debouncedSave()
  },
)

// 统一应用逻辑 —— 复合写入逐步结果模型（v4 §8.3）：顺序写 7 项，
// 中途失败立即中止、保留已生效项、显式暴露「部分应用」；不做任何回滚。
async function handleApplyAll() {
  // 缺 HarmonyOS 配置时不静默 return —— 用户点了应用必须有反馈
  if (!CPUData.value?.Custom) {
    Message.error('未读到 CPU 功耗参数（Cpu.Custom），无法应用')
    return
  }
  const p = activeProfile.value
  const coValue = configStore.config?.Smu?.CurveOptimizerAll ?? 0

  loading.value = true
  try {
    // 逐步计划收敛在 domain/cpuPowerPlan.ts —— 首页胶囊的「自定义」走同一份，不再各写一套
    const event = await composite.run(buildCpuPowerRun('user', p, coValue))

    // 结果反馈：逐项摘要 + 部分应用显式提示（v4 §10 复合操作交互模型）
    const { ok, failed, skipped } = composite.summary.value
    if (event.partialApplied) {
      Message.warning(
        `部分应用：${ok} 项已生效，第 ${event.steps.findIndex((s) => s.status === 'failed') + 1} 项「${event.steps.find((s) => s.status === 'failed')?.label}」失败，其余未执行。已生效项不会自动撤销。`,
      )
    } else if (failed) {
      Message.error(composite.state.value.message || '应用失败')
    } else {
      Message.success(`设置应用成功（${ok} 项${skipped > 0 ? `，跳过 ${skipped} 项` : ''}）`)
      appliedSnapshot.value = profileSignature(p, coValue)
    }

    activity.record({
      source: 'user',
      intent: `应用 CPU 功耗参数「${activeProfileTitle}」`,
      requestedValue: `${p.CpuLongPower}W/${p.CpuShortPower}W`,
      outcome: event.partialApplied ? 'partial' : failed ? 'failed' : 'applied',
      reversible: 'b',
    })
  } finally {
    loading.value = false
    // 本页写入以「打开自定义功耗覆盖」为第一步：同步首页胶囊，避免两套选择器各说各话。
    // 放在 finally 里且自带 catch —— 同步胶囊失败不应让本页卡在 busy，
    // 也不应吞掉上面已经向用户报告的结果。
    try {
      await modeStore.refreshObserved()
      modeStore.syncSelectedFromObserved()
    } catch {
      /* 胶囊同步失败不影响本页已完成的写入 */
    }
  }
}

async function followFirmware() {
  const ok = await modeStore.followFirmware()
  if (ok) {
    const label = modeStore.firmwareLabel || '固件档位'
    Message.success(`已关闭自定义功耗覆盖，CPU 功耗改由「${label}」固件表管理`)
  } else {
    Message.error(modeStore.lastErrorOr || '关闭自定义功耗失败')
  }
}

// 重置为出厂默认参数（只改参数并存盘，不下发硬件）
async function handleReset() {
  if (!CPUData.value?.Custom) return
  Object.assign(CPUData.value.Custom, CPU_CUSTOM_DEFAULTS)
  const saveRes = await configStore.saveConfig()
  if (saveRes?.Success) {
    Message.info('功耗参数已恢复为出厂默认')
  } else {
    Message.error(saveRes?.Message || '重置值保存失败')
  }
}
</script>

<template>
  <PageShell
    v-if="CPUData?.Custom"
    title="CPU 设置"
    subtitle="编辑自定义功耗参数；配置自动保存，只有点击应用后才会下发到硬件。"
  >
    <div class="w-full flex flex-col gap-6">
      <div class="policy-banner" :class="modeStore.customOverride ? 'is-overlay' : 'is-firmware'">
        <div class="policy-rows">
          <div>
            <span class="k">平台档位</span>
            <span class="v">{{ modeStore.firmwareLabel || '未读取' }}</span>
          </div>
          <div>
            <span class="k">CPU 功耗</span>
            <span class="v">{{
              modeStore.customOverride ? `自定义覆盖 · ${activeProfileTitle}` : '由固件档位管理'
            }}</span>
          </div>
        </div>
        <p class="policy-hint">
          <template v-if="modeStore.customOverride">
            当前 SPL/SPPT/温度墙由本页参数写入（已存盘）。首页胶囊为「自定义」。要回到办公/游戏/狂飙
            的固件功耗表，请跟随固件档位。
          </template>
          <template v-else>
            办公/游戏/狂飙 使用 EC 固件自己的功耗表；本页参数改完即存盘，但要点「应用」才下发，
            下发时会打开自定义功耗覆盖。
          </template>
        </p>
        <button
          v-if="modeStore.customOverride"
          type="button"
          class="policy-follow"
          :disabled="modeStore.syncing"
          @click="followFirmware"
        >
          {{ modeStore.syncing ? '切换中…' : '跟随固件档位' }}
        </button>
      </div>

      <div class="flex flex-col lg:flex-row gap-6 items-start">
        <!-- ==================== 左中：数值调整 ==================== -->
        <div class="flex-1 space-y-6 min-w-0">
          <!-- 1. 核心设置（唯一一套自定义功耗参数） -->
          <div class="panel-card p-5 space-y-6">
            <h2 class="section-label">核心设置</h2>

            <div class="space-y-6">
              <!-- 短时功耗限制(PL1) -->
              <div class="space-y-2">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-gray-300 flex items-center gap-1"
                    >长时功耗限制(PL1)
                    <span
                      class="text-weak cursor-help text-[10px] hover:text-muted"
                      title="CPU 可持续运行的长时功耗上限"
                      >?</span
                    ></span
                  >
                  <span class="text-accent font-medium tnum"
                    >{{ activeProfile.CpuLongPower }} W</span
                  >
                </div>
                <a-slider
                  v-model="activeProfile.CpuLongPower"
                  :disabled="loading"
                  :min="30"
                  :max="120"
                  class="w-full"
                />
              </div>

              <!-- 长时功耗限制(PL2) -->
              <div class="space-y-2">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-gray-300 flex items-center gap-1"
                    >短时功耗限制(PL2)
                    <span
                      class="text-weak cursor-help text-[10px] hover:text-muted"
                      title="CPU 短时间爆发功耗上限"
                      >?</span
                    ></span
                  >
                  <span class="text-accent font-medium tnum"
                    >{{ activeProfile.CpuShortPower }} W</span
                  >
                </div>
                <a-slider
                  v-model="activeProfile.CpuShortPower"
                  :disabled="loading"
                  :min="30"
                  :max="150"
                  class="w-full"
                />
              </div>

              <!-- 核心电压偏移 (Curve Optimizer) -->
              <div class="space-y-2">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-gray-300 flex items-center gap-1"
                    >核心电压偏移 (CO)
                    <span
                      class="text-weak cursor-help text-[10px] hover:text-muted"
                      title="Curve Optimizer 电压偏移, 负值为降压"
                      >?</span
                    ></span
                  >
                  <span class="text-accent font-medium tnum">{{
                    configStore.config?.Smu?.CurveOptimizerAll ?? 0
                  }}</span>
                </div>
                <a-slider
                  v-if="SmuData"
                  v-model="SmuData.CurveOptimizerAll"
                  :disabled="loading"
                  :min="-30"
                  :max="0"
                  class="w-full"
                />
              </div>

              <!-- CPU 温度。-->
              <div class="space-y-2">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-gray-300 flex items-center gap-1"
                    >CPU 温度墙
                    <span
                      class="text-weak cursor-help text-[10px] hover:text-muted"
                      title="触发降频前的最高核心温度"
                      >?</span
                    ></span
                  >
                  <span class="text-accent font-medium tnum"
                    >{{ activeProfile.CpuTempWall }} °C</span
                  >
                </div>
                <a-slider v-model="activeProfile.CpuTempWall" :min="60" :max="105" class="w-full" />
                :disabled="loading"
              </div>

              <!-- 最大睿频频。-->
              <div class="space-y-2">
                <div class="flex justify-between items-center text-xs">
                  <span class="text-gray-300 flex items-center gap-1"
                    >最大睿频
                    <span
                      class="text-weak cursor-help text-[10px] hover:text-muted"
                      title="CPU 最大加速频率上限"
                      >?</span
                    ></span
                  >
                  <span class="text-accent font-medium tnum"
                    >{{ (activeProfile.CpuMaxFrequency / 1000).toFixed(1) }} GHz</span
                  >
                </div>
                <a-slider
                  v-model="activeProfile.CpuMaxFrequency"
                  :disabled="loading"
                  :min="2000"
                  :max="5400"
                  :step="100"
                  class="w-full"
                />
              </div>
            </div>

            <div class="flex justify-start items-center pt-4 mt-2 border-t border-hair">
              <button
                class="flex items-center gap-2 text-xs text-gray-400 hover:text-ink border border-ink/10 hover:border-ink/20 bg-ink/[0.02] hover:bg-ink/[0.05] px-4 py-2 rounded-lg transition-colors pressable"
                @click="handleReset"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 11l3-3 3 3m-3-3v12"
                  />
                </svg>
                重置
              </button>
            </div>
            <ApplyBar
              :phase="applyPhase"
              :status-text="applyStatus"
              :busy="loading"
              apply-label="应用 CPU 设置"
              @apply="handleApplyAll"
            />
            <CompositeSteps
              :steps="composite.state.value.steps"
              :partial="composite.state.value.partialApplied"
              :message="composite.state.value.message"
            />
          </div>
        </div>

        <!-- ==================== 右侧：信息与说明区，与左侧调整区顶对齐 ==================== -->
        <div class="w-full lg:w-[360px] shrink-0 space-y-6">
          <!-- 1. CPU 信息卡片 -->
          <div class="panel-card p-5">
            <h2 class="text-[13px] font-semibold text-gray-300 mb-4">CPU 信息</h2>
            <div class="flex items-center gap-4 h-[96px]">
              <!-- 高保。3D 芯片矢量线稿 (CpuDie) -->
              <div
                class="w-16 h-16 bg-ink/[0.02] border border-ink/[0.05] rounded-xl flex items-center justify-center relative"
              >
                <CpuDie />
              </div>

              <div class="space-y-1 text-[11px] text-gray-400">
                <div class="text-[13px] font-bold text-ink">
                  {{ cpuInfo?.Name || '未读取' }}
                </div>
                <div>
                  {{
                    cpuInfo ? `${cpuInfo.Cores} 核心 / ${cpuInfo.Threads} 线程` : '核心信息未读取'
                  }}
                </div>
                <div>
                  基础频率
                  {{
                    cpuInfo?.BaseFreqMhz ? `${(cpuInfo.BaseFreqMhz / 1000).toFixed(1)} GHz` : '—'
                  }}
                </div>
              </div>
            </div>
          </div>

          <!-- 2. 实时状态卡。-->
          <div class="panel-card p-5 space-y-4">
            <h2 class="text-sm font-semibold text-ink">实时状态</h2>

            <div class="space-y-3.5">
              <!-- 频率 -->
              <div class="space-y-1.5">
                <div class="flex justify-between text-[11px]">
                  <span class="text-gray-400">频率</span>
                  <span class="text-ink font-mono font-medium"
                    >{{ freqMhz !== null ? (freqMhz / 1000).toFixed(2) : '—' }} GHz</span
                  >
                </div>
                <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                  <div
                    class="bar-fill h-full bg-cyber-purple"
                    :style="{
                      transform: `scaleX(${Math.min((freqMhz || 0) / (activeProfile.CpuMaxFrequency || 5000), 1)})`,
                    }"
                  ></div>
                </div>
              </div>

              <!-- 电压 -->
              <div class="space-y-1.5">
                <div class="flex justify-between text-[11px]">
                  <span class="text-gray-400">电压</span>
                  <span class="text-ink font-mono font-medium"
                    >{{ voltV !== null ? voltV.toFixed(3) : '—' }} V</span
                  >
                </div>
                <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                  <div
                    class="bar-fill h-full bg-cyber-purple"
                    :style="{ transform: `scaleX(${Math.min((voltV || 0) / 1.5, 1)})` }"
                  ></div>
                </div>
              </div>

              <!-- 使用。-->
              <div class="space-y-1.5">
                <div class="flex justify-between text-[11px]">
                  <span class="text-muted">使用率</span>
                  <span class="text-ink font-mono font-medium">{{
                    usagePct !== null ? `${usagePct} %` : '—'
                  }}</span>
                </div>
                <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                  <div
                    class="bar-fill h-full bg-accent"
                    :style="{ transform: `scaleX(${Math.min((usagePct || 0) / 100, 1)})` }"
                  ></div>
                </div>
              </div>

              <!-- 温度 -->
              <div class="space-y-1.5">
                <div class="flex justify-between text-[11px]">
                  <span class="text-gray-400">温度</span>
                  <span class="text-ink font-mono font-medium">{{
                    tempC !== null ? `${tempC} °C` : '—'
                  }}</span>
                </div>
                <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                  <div
                    class="bar-fill h-full bg-cyber-purple"
                    :style="{
                      transform: `scaleX(${Math.min((tempC || 0) / 100, 1)})`,
                    }"
                  ></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 3. 核心分布卡片 -->
          <div class="panel-card p-5 space-y-3.5">
            <div class="flex justify-between items-center">
              <h2 class="text-[13px] font-semibold text-gray-300">核心分布</h2>
              <!-- <button
              class="bg-ink/[0.04] border border-ink/10 hover:bg-ink/[0.08] text-[10px] text-gray-400 hover:text-ink px-2 py-0.5 rounded transition-colors pressable"
            >
              详情
            </button> -->
            </div>

            <div class="space-y-2">
              <p class="text-[11px] text-weak">物理核心编号（只读，非使用率）</p>
              <div class="grid grid-cols-6 gap-1.5">
                <div
                  v-for="i in cpuInfo?.Cores || 0"
                  :key="'core' + i"
                  class="core-tile bg-inset border border-hair rounded-lg py-2 text-center"
                  :aria-label="`物理核心 ${i - 1}`"
                >
                  <div class="text-[8px] text-weak leading-none">核心</div>
                  <div class="text-xs text-ink font-bold tnum mt-0.5">
                    {{ String(i - 1).padStart(2, '0') }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 4. 说明卡片 -->
          <div class="panel-card p-5 space-y-2.5">
            <h2 class="text-[13px] font-semibold text-gray-300">说明</h2>
            <div class="text-[11px] text-gray-500 leading-relaxed space-y-2">
              <p>功耗限制决定了 CPU 可持续运行的最大功耗。</p>
              <p>电压偏移可在保证稳定性的前提下降低功耗和温度。</p>
              <p>修改设置后请点击“应用”以生效。</p>
            </div>
            <div
              class="text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer pt-1 flex items-center gap-0.5 font-medium transition-colors"
            >
              了解更多 <span>&gt;</span>
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
/* 隐藏默认滚动。*/
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.policy-banner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--hair);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
}

.policy-rows {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 28px;
}

.policy-rows .k {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--weak);
  margin-bottom: 2px;
}

.policy-rows .v {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.policy-hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

.policy-follow {
  align-self: flex-start;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hair-strong);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.policy-follow:hover:not(:disabled) {
  color: var(--ink);
  background: var(--color-overlay);
}

.policy-follow:disabled {
  opacity: 0.5;
  cursor: wait;
}

.policy-banner.is-overlay {
  border-color: var(--accent-line);
}

/* 选中配置卡片: 冷青描边 + 微底, 文字保持 ink 可读 */
.profile-active {
  border-color: var(--accent) !important;
  background: var(--accent-dim) !important;
  box-shadow: none;
}

[data-theme='light'] .profile-active {
  background: color-mix(in srgb, var(--accent) 8%, #ffffff) !important;
  border-color: var(--accent) !important;
}

/* 浅色下核心分布磁贴: 统一中性 inset, 不引入第二强调色 */

/* 深度重写 Arco Slider 为高透炫光紫。*/

/* Arco Switch 选中。 统一冷青 */
:deep(.arco-switch-checked) {
  background-color: var(--accent) !important;
}

/* 重写下拉菜单为深色模式样。*/
:deep(.select-dark .arco-select-view-single) {
  background-color: var(--color-panel-elevated) !important;
  border: 1px solid var(--color-line-soft) !important;
  color: var(--color-text-main) !important;
  border-radius: 8px !important;
  height: 32px !important;
}

/* ===== 动效令牌驱动的局部过。(替代。transition-all duration-300) ===== */
/* 配置档卡。 颜色/边框/底色 + 按压缩放 */
.pf-card {
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}

.pf-card:active {
  transform: scale(0.97);
}

/* 应用按钮: 只过渡底。+ 按压缩放。原。shadow-[0_0_15px_紫] 辉光, 。。AI 。定案移除 */
.tok-apply {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}

.tok-apply:active {
  transform: scale(0.97);
}

/* 四个实时。频率/电压/使用率温度):
 * 。transform:scaleX 而非 width —。width 是非合成属。 会触发布局;
 * 填充层自身不。border-radius, 圆角由父。rounded-full + overflow-hidden 裁剪,
 * 因此 scaleX 不会把圆角拉伸变形。轮询周。5s, 250ms 过渡占空比约 5%。*/
.bar-fill {
  transform-origin: left;
  transition: transform var(--dur-slow) var(--ease-out);
}
</style>
