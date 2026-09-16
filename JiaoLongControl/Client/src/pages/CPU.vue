<script setup lang="ts">
import CpuDie from '@/components/common/CpuDie.vue'

import { ref, computed } from 'vue'
import { Message } from '@arco-design/web-vue'
import { CPU, Power, RyzenSmu, type CpuInfo } from '@/utils/bridge.ts'
import { useConfigStore } from '@/stores/config'
import { useSystemInfoStore } from '@/stores/systemInfo'
import type { CpuProfileDataType } from '@/types/config'
import { CPU_PROFILE_DEFAULTS } from '@/constants'

const loading = ref(false)
const configStore = useConfigStore()
const systemInfoStore = useSystemInfoStore()

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
const cpuStats = computed(() => systemInfoStore.cpuStats)

// 页面内部交互状。
const selectedProfile = ref('default')

// 配置文件卡片: 从配置恢复上次选中的档位（不覆盖已保存的值）
const profiles = [
  { key: 'default', title: '默认配置', desc: '平衡性能与功耗' },
  { key: 'performance', title: '高性能模式', desc: '释放最大性能' },
  { key: 'saving', title: '节能模式', desc: '降低功耗与温度' },
  { key: 'custom', title: '自定义配置', desc: '自定义参数设置' },
] as const

// 从配置恢复上次选中的档位（不覆盖已保存的值）。C# 侧可能是 PascalCase, 统一小写匹配卡片 key
if (CPUData.value?.CpuProfile) {
  selectedProfile.value = String(CPUData.value.CpuProfile).toLowerCase()
}

// 档位。-> 配置块字段名（config.yaml 。Cpu 下的 Default/Performance/Saving/Custom。
function profileKey(profile: string): 'Default' | 'Performance' | 'Saving' | 'Custom' {
  const map: Record<string, 'Default' | 'Performance' | 'Saving' | 'Custom'> = {
    default: 'Default',
    performance: 'Performance',
    saving: 'Saving',
    custom: 'Custom',
  }
  return map[profile] ?? 'Default'
}

// 当前选中档位的参数块（滑块直接绑定它；切换档位即切换绑定的数据源。
const activeProfile = computed<CpuProfileDataType>(() => {
  const cpu = CPUData.value
  return (cpu?.[profileKey(selectedProfile.value)] ?? cpu?.Default) as CpuProfileDataType
})

// 切换档位：只改选中标记，界面滑块绑定的 activeProfile 随之指向该档位块
function selectProfile(profile: string) {
  selectedProfile.value = profile
  if (CPUData.value) CPUData.value.CpuProfile = profile
}

// 统一应用逻辑
async function handleApplyAll() {
  if (!CPUData.value || !activeProfile.value) return
  loading.value = true
  let smuWarning: string | null = null
  try {
    // 0. 必须先打开自定义功耗子状。命令 23 = OpenState), 再下。SPL/SPPT/温度墙。
    //    协议要求: 只有 CPUPower=OpenState 时这三个值才会被 EC 接受并生。
    //    官方把三个写入严格包。if (m == OpenState) 。decompiled/main.cs:2386 SetSP_CustomMode)。
    //    注意 PerformanceMode.Set 切换标准档时会写 CloseState, 之后这三个写入会全部失效,
    //    所以这里必须无条件先开 —。四个档位一视同。 否则非自定义档必然失败。
    //    代价: 应用后首页胶囊会呈现"自定。(功耗值确实已是自定义。 属诚实反。。
    const customRes = await CPU.SetCustomMode(true)
    if (!customRes.Success) {
      Message.error(customRes.Message || '进入自定义功耗模式失败')
      return
    }

    // 1. 设置温度。(官方顺序: OpenState 。温度。4) 。SPL(2) 。SPPT(3))
    const tempWallRes = await CPU.SetCPUTempWall(activeProfile.value.CpuTempWall)
    if (!tempWallRes.Success) {
      Message.error(tempWallRes.Message || '温度墙设置失败')
      return
    }
    // 2. 设置长时功耗限制SPL (PL1)
    const longPowerRes = await CPU.SetCpuLongPower(activeProfile.value.CpuLongPower)
    if (!longPowerRes.Success) {
      Message.error(longPowerRes.Message || '长时功耗限制设置失败')
      return
    }
    // 3. 设置短时功耗限制SPPT (PL2)
    const shortPowerRes = await CPU.SetCpuShortPower(activeProfile.value.CpuShortPower)
    if (!shortPowerRes.Success) {
      Message.error(shortPowerRes.Message || '短时功耗限制设置失败')
      return
    }
    // 4. 设置最大频。
    const maxFreqRes = await Power.SetCPUMaxFrequency(activeProfile.value.CpuMaxFrequency)
    if (!maxFreqRes.Success) {
      Message.error(maxFreqRes.Message || '最大频率设置失败')
      return
    }
    // 5. 设置睿频开。
    if (activeProfile.value.CpuTurbo) {
      const turboRes = await Power.EnableTurbo()
      if (!turboRes.Success) {
        Message.error(turboRes.Message || '睿频开启失败')
        return
      }
    } else {
      const turboRes = await Power.DisableTurbo()
      if (!turboRes.Success) {
        Message.error(turboRes.Message || '睿频关闭失败')
        return
      }
    }
    // 6. 设置核心电压偏移 (Curve Optimizer All)
    //    CO=0 的语义是"不偏。, 属无操作 —。直接跳过。
    //    这样可避免在未安。PawnIO 内核驱动的机器上因驱动缺失而误报失。
    //    (SMU 读写依赖 PawnIO, 是用户可选安装的组件)。
    //    即便确有偏移要写而失。 也不中止前面已生效的功。频率设置, 只做提示。
    const coValue = configStore.config?.Smu?.CurveOptimizerAll ?? 0
    if (coValue !== 0) {
      const curveRes = await RyzenSmu.SetCurveOptimizerAll(coValue)
      if (!curveRes.Success) {
        smuWarning = curveRes.Message || '核心电压偏移设置失败'
      }
    }

    // 7. 保存主配置（含当前档位块参数与选中档位，供开机自启等使用率
    const saveRes = await configStore.saveConfig()
    if (!saveRes?.Success) {
      Message.error(saveRes?.Message || '设置保存失败')
      return
    }
    if (smuWarning) {
      Message.warning(`功耗与频率设置已生效；核心电压偏移未应用：${smuWarning}`)
    } else {
      Message.success('设置应用成功')
    }
  } catch {
    Message.error('应用设置失败，请检查桥接服务')
  } finally {
    loading.value = false
  }
}

// 重置当前选中档位的出厂默认参。(不切换档。
async function handleReset() {
  const key = profileKey(selectedProfile.value)
  const defaults = CPU_PROFILE_DEFAULTS[key]
  if (!CPUData.value || !defaults) return
  Object.assign(CPUData.value[key], defaults)
  const saveRes = await configStore.saveConfig()
  const profileTitle = profiles.find((p) => p.key === selectedProfile.value)?.title ?? ''
  if (saveRes?.Success) {
    Message.info(`「${profileTitle}」参数已恢复为出厂默认`)
  } else {
    Message.error(saveRes?.Message || '重置值保存失败')
  }
}

// 取消修改：强制从后端重新加载原始配置
async function handleCancel() {
  await configStore.fetchConfig(true) // 重新加载 store 原始配置
  Message.info('已取消修改')
}
</script>

<template>
  <div v-if="CPUData" class="h-full overflow-y-auto text-ink p-6 no-scrollbar">
    <div class="max-w-[1300px] mx-auto flex flex-col lg:flex-row gap-6">
      <!-- ==================== 左中：CPU 设置区域 ==================== -->
      <div class="flex-1 space-y-6">
        <!-- 头部标题 -->
        <div>
          <h1 class="text-2xl font-bold tracking-wide">CPU 设置</h1>
          <p class="text-[13px] text-gray-500 mt-1">调整 CPU 的性能参数，发挥处理器最佳性能。</p>
        </div>

        <!-- 1. CPU 配置文件 -->
        <div
          class="panel-card p-5"
        >
          <div class="flex justify-between items-center mb-4">
            <h2 class="section-label !mb-0">CPU 配置文件</h2>
          </div>

          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div
              v-for="p in profiles"
              :key="p.key"
              :class="[
                'pf-card border rounded-lg p-4 cursor-pointer flex flex-col justify-between h-[96px]',
                selectedProfile === p.key
                  ? 'profile-active'
                  : 'border-hair bg-panel hover:border-ink/15',
              ]"
              @click="selectProfile(p.key)"
            >
              <span
                class="text-xs font-semibold"
                :class="selectedProfile === p.key ? 'text-ink' : 'text-gray-300'"
                >{{ p.title }}</span
              >
              <span class="text-[11px] text-gray-500">{{ p.desc }}</span>
            </div>
          </div>
        </div>

        <!-- 2. 核心设置 -->
        <div
          class="panel-card p-5 space-y-6"
        >
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
              <a-slider v-model="activeProfile.CpuLongPower" :min="30" :max="120" class="w-full" />
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
              <a-slider v-model="activeProfile.CpuShortPower" :min="30" :max="150" class="w-full" />
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
                :min="2000"
                :max="5400"
                :step="100"
                class="w-full"
              />
            </div>
          </div>
        </div>
        <!-- 4. 底部全局控制。-->
        <div class="flex justify-between items-center pt-2">
          <button
            class="flex items-center gap-2 text-xs text-gray-400 hover:text-ink border border-ink/10 hover:border-ink/20 bg-ink/[0.02] hover:bg-ink/[0.05] px-4 py-2 rounded-lg transition-colors pressable"
            @click="handleReset"
          >
            <!-- 刷新旋转小图。-->
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

          <div class="flex gap-3">
            <button
              class="text-xs text-gray-400 hover:text-ink border border-ink/5 bg-transparent hover:bg-ink/[0.03] px-5 py-2 rounded-lg transition-colors"
              @click="handleCancel"
            >
              取消
            </button>
            <button
              :disabled="loading"
              class="tok-apply btn-apply text-xs"
              @click="handleApplyAll"
            >
              {{ loading ? '应用中...' : '应用' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ==================== 右侧：信息与说明区==================== -->
      <div class="w-full lg:w-[360px] shrink-0 space-y-6 lg:pt-[115px]">
        <!-- 1. CPU 信息卡片 -->
        <div
          class="panel-card p-5"
        >
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
                {{ cpuInfo?.Name || 'Unknown CPU' }}
              </div>
              <div>{{ cpuInfo?.Cores || 0 }} 核心 / {{ cpuInfo?.Threads || 0 }} 线程</div>
              <div>
                基础频率
                {{ cpuInfo?.BaseFreqMhz ? (cpuInfo.BaseFreqMhz / 1000).toFixed(1) : 0 }} GHz
              </div>
            </div>
          </div>
        </div>

        <!-- 2. 实时状态卡。-->
        <div
          class="panel-card p-5 space-y-4"
        >
          <h2 class="text-sm font-semibold text-ink">实时状态</h2>

          <div class="space-y-3.5">
            <!-- 频率 -->
            <div class="space-y-1.5">
              <div class="flex justify-between text-[11px]">
                <span class="text-gray-400">频率</span>
                <span class="text-ink font-mono font-medium"
                  >{{
                    cpuStats?.FrequencyMhz ? (cpuStats.FrequencyMhz / 1000).toFixed(2) : '0.00'
                  }}
                  GHz</span
                >
              </div>
              <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                <div
                  class="bar-fill h-full bg-cyber-purple"
                  :style="{
                    transform: `scaleX(${Math.min((cpuStats?.FrequencyMhz || 0) / (activeProfile.CpuMaxFrequency || 5000), 1)})`,
                  }"
                ></div>
              </div>
            </div>

            <!-- 电压 -->
            <div class="space-y-1.5">
              <div class="flex justify-between text-[11px]">
                <span class="text-gray-400">电压</span>
                <span class="text-ink font-mono font-medium"
                  >{{ cpuStats?.Voltage ? cpuStats.Voltage.toFixed(3) : '0.000' }} V</span
                >
              </div>
              <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                <div
                  class="bar-fill h-full bg-cyber-purple"
                  :style="{ transform: `scaleX(${Math.min((cpuStats?.Voltage || 0) / 1.5, 1)})` }"
                ></div>
              </div>
            </div>

            <!-- 使用。-->
            <div class="space-y-1.5">
              <div class="flex justify-between text-[11px]">
                <span class="text-muted">使用率</span>
                <span class="text-ink font-mono font-medium">{{ cpuStats?.Usage || 0 }} %</span>
              </div>
              <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                <div
                  class="bar-fill h-full bg-accent"
                  :style="{ transform: `scaleX(${Math.min((cpuStats?.Usage || 0) / 100, 1)})` }"
                ></div>
              </div>
            </div>

            <!-- 温度 -->
            <div class="space-y-1.5">
              <div class="flex justify-between text-[11px]">
                <span class="text-gray-400">温度</span>
                <span class="text-ink font-mono font-medium"
                  >{{ cpuStats?.Temperature || 0 }} °C</span
                >
              </div>
              <div class="h-1.5 bg-ink/[0.03] rounded-full overflow-hidden">
                <div
                  class="bar-fill h-full bg-cyber-purple"
                  :style="{
                    transform: `scaleX(${Math.min((cpuStats?.Temperature || 0) / 100, 1)})`,
                  }"
                ></div>
              </div>
            </div>
          </div>
        </div>

        <!-- 3. 核心分布卡片 -->
        <div
          class="panel-card p-5 space-y-3.5"
        >
          <div class="flex justify-between items-center">
            <h2 class="text-[13px] font-semibold text-gray-300">核心分布</h2>
            <!-- <button
              class="bg-ink/[0.04] border border-ink/10 hover:bg-ink/[0.08] text-[10px] text-gray-400 hover:text-ink px-2 py-0.5 rounded transition-colors pressable"
            >
              详情
            </button> -->
          </div>

          <div class="space-y-2">
            <!-- 动态渲染所有核。-->
            <div class="grid grid-cols-6 gap-1.5">
              <div
                v-for="i in cpuInfo?.Cores || 0"
                :key="'core' + i"
                class="core-tile bg-inset border border-hair rounded-lg py-2 text-center"
              >
                <div class="text-[8px] text-weak leading-none">C</div>
                <div class="text-xs text-ink font-bold tnum mt-0.5">
                  {{ String(i - 1).padStart(2, '0') }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 4. 说明卡片 -->
        <div
          class="panel-card p-5 space-y-2.5"
        >
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
