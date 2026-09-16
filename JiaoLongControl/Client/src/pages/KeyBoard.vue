<script setup lang="ts">
import { ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { Keyboard, KeyboardGradient } from '@/utils/bridge.ts'

const loading = ref(false)
const gradientRunning = ref(false)
const gradientLoading = ref(false)

const color = ref({ red: 0, green: 0, blue: 0 })
const LightBrightness = ref(0)
const colorPicker = ref('#8A2BE2')

// 快捷配色预设
const colorPresets = [
  { name: '炫彩', hex: '#8A2BE2', r: 138, g: 43, b: 226 },
  { name: '冰晶', hex: '#00F0FF', r: 0, g: 240, b: 255 },
  { name: '极光', hex: '#00FF66', r: 0, g: 255, b: 102 },
  { name: '烈焰', hex: '#FF3366', r: 255, g: 51, b: 102 },
  { name: '暖阳', hex: '#FFCC00', r: 255, g: 204, b: 0 },
  { name: '纯净', hex: '#FFFFFF', r: 255, g: 255, b: 255 },
]

async function loadInitialData() {
  // 渐变运行状态独立且优先读取: 不依赖颜。亮度读取结果
  try {
    const gradientRes = await KeyboardGradient.IsRunning()
    gradientRunning.value = gradientRes.Success
  } catch (e) {
    console.error('Failed to load keyboard gradient status', e)
    gradientRunning.value = false
  }
  try {
    const colorRes = await Keyboard.GetColor()
    const brightnessRes = await Keyboard.GetLightBrightness()
    if (colorRes?.Success && colorRes.Data) {
      color.value = { ...colorRes.Data }
      colorPicker.value = rgbToHex(color.value.red, color.value.green, color.value.blue)
    }
    if (brightnessRes?.Success && brightnessRes.Data !== undefined) {
      LightBrightness.value = brightnessRes.Data
    }
  } catch (e) {
    console.error('Failed to load keyboard settings', e)
  }
}

await loadInitialData()

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')}`
}

function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? {
        red: parseInt(result[1]!, 16),
        green: parseInt(result[2]!, 16),
        blue: parseInt(result[3]!, 16),
      }
    : null
}

watch(
  color,
  (val) => {
    colorPicker.value = rgbToHex(val.red, val.green, val.blue)
  },
  { deep: true },
)

watch(colorPicker, (val) => {
  const rgb = hexToRgb(val)
  if (rgb) Object.assign(color.value, rgb)
})

function applyPreset(preset: (typeof colorPresets)[0]) {
  color.value = { red: preset.r, green: preset.g, blue: preset.b }
}

async function handleGradientToggle(newValue: string | number | boolean) {
  gradientLoading.value = true
  try {
    if (newValue) {
      const res = await KeyboardGradient.Start()
      if (res.Success) {
        gradientRunning.value = true
        Message.success(res.Message || '键盘渐变已开启')
      } else {
        Message.error(res.Message || '渐变开启失败')
      }
    } else {
      const res = await KeyboardGradient.Stop()
      gradientRunning.value = false
      if (res.Success) {
        Message.info(res.Message || '键盘渐变已停止')
      } else {
        Message.error(res.Message || '渐变停止失败')
      }
    }
  } catch {
    Message.error('渐变操作异常，请检查日志')
    const runningRes = await KeyboardGradient.IsRunning().catch(() => null)
    gradientRunning.value = !!runningRes?.Success
  } finally {
    gradientLoading.value = false
  }
}

async function handleApply() {
  loading.value = true
  try {
    const [colorRes, brightnessRes] = await Promise.all([
      Keyboard.SetColor(color.value.red, color.value.green, color.value.blue),
      Keyboard.SetLightBrightness(LightBrightness.value),
    ])

    if (colorRes.Success && brightnessRes.Success) {
      Message.success('键盘灯效设置已应用')
    } else {
      const failRes = !colorRes.Success ? colorRes : brightnessRes
      Message.error(failRes.Message || '应用设置失败')
    }
  } catch {
    Message.error('应用设置异常')
  } finally {
    loading.value = false
  }
}

function handleReset() {
  color.value = { red: 138, green: 43, blue: 226 }
  LightBrightness.value = 2
  Message.info('已恢复默认背光设置')
}
</script>

<template>
  <div class="h-full overflow-y-auto text-ink p-6 no-scrollbar">
    <div class="max-w-[1300px] mx-auto flex flex-col lg:flex-row gap-6">
      <!-- ==================== 左侧：键盘控制区 ==================== -->
      <div class="flex-1 space-y-6">
        <!-- 头部标题 -->
        <div>
          <h1 class="text-2xl font-bold tracking-wide">键盘 RGB 灯效</h1>
          <p class="text-[13px] text-gray-500 mt-1">自定义 RGB 背光颜色与灯光亮度。</p>
        </div>

        <!-- 1. 键盘灯效可视化预览卡。-->
        <div
          class="panel-card p-5"
        >
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-[13px] font-semibold text-gray-300">灯效实时预览</h2>
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-400">颜色拾取器</span>
              <a-color-picker v-model="colorPicker" size="mini" :disabled="gradientRunning">
                <div
                  class="kb-scale w-6 h-6 rounded-md border border-ink/20 cursor-pointer shadow-sm"
                  :style="{ backgroundColor: colorPicker }"
                ></div>
              </a-color-picker>
            </div>
          </div>

          <!-- 模拟键盘面板 -->
          <div class="w-full flex justify-center py-4">
            <div
              class="relative w-full max-w-[640px] h-[190px] bg-[#12131e] rounded-xl p-3.5 border border-ink/10 overflow-hidden"
              :style="{
                boxShadow: `0 10px 30px rgba(0, 0, 0, 0.6), 0 0 ${LightBrightness * 12}px rgba(${color.red}, ${color.green}, ${color.blue}, ${LightBrightness * 0.25})`,
              }"
            >
              <!-- 灯光溢出画幅: 全页唯一一。hue-rotate 滤镜层。
                   原实现同时在 52 个按键内层各挂一份 .gradient-glow, 共 53 层
                   逐帧重算, 是掉帧源 —— 已收敛到这一层。-->
              <div
                class="absolute inset-0 pointer-events-none"
                :class="{ 'gradient-glow': gradientRunning }"
                :style="{
                  background: `radial-gradient(circle at center, rgba(${color.red}, ${color.green}, ${color.blue}, ${LightBrightness * 0.2}) 0%, transparent 85%)`,
                }"
              ></div>

              <!-- 按键矩阵线稿 -->
              <div class="grid grid-cols-13 grid-rows-4 gap-1.5 h-full relative z-10">
                <div
                  v-for="i in 52"
                  :key="i"
                  class="bg-[#1a1b2b]/90 border border-ink/[0.06] rounded flex items-center justify-center relative overflow-hidden"
                >
                  <!-- 亮度由滑块连续拖动产。 连续值不得挂过渡,
                       否则 52 个元素各自追赶"指针 = 滞后 + 逐帧重绘 -->
                  <div
                    class="absolute inset-0 opacity-40 blur-[3px]"
                    :style="{
                      backgroundColor: `rgb(${color.red}, ${color.green}, ${color.blue})`,
                      opacity: LightBrightness > 0 ? (LightBrightness / 3) * 0.6 : 0,
                    }"
                  ></div>
                  <span class="w-1.5 h-1.5 rounded-full bg-ink/20"></span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 2. 快捷配色预设 -->
        <div
          class="panel-card p-5"
        >
          <h2 class="text-[13px] font-semibold text-gray-300 mb-3">快捷预设</h2>
          <div class="grid grid-cols-3 sm:grid-cols-6 gap-3">
            <div
              v-for="preset in colorPresets"
              :key="preset.name"
              class="kb-preset border border-ink/[0.05] hover:border-ink/20 bg-panel hover:bg-panel-active rounded-xl p-3 cursor-pointer flex flex-col items-center gap-2 group"
              :class="{ 'opacity-40 pointer-events-none': gradientRunning }"
              @click="applyPreset(preset)"
            >
              <div
                class="kb-scale-group w-8 h-8 rounded-full border border-ink/20 shadow-md"
                :style="{ backgroundColor: preset.hex, boxShadow: `0 0 10px ${preset.hex}66` }"
              ></div>
              <span class="text-xs text-gray-300 group-hover:text-ink font-medium">{{
                preset.name
              }}</span>
            </div>
          </div>
        </div>

        <!-- 3. 键盘渐变效果 -->
        <div
          class="panel-card p-5"
        >
          <div class="flex items-center justify-between gap-4">
            <div class="space-y-1.5">
              <h2 class="text-[13px] font-semibold text-gray-300">键盘渐变效果</h2>
              <p class="text-xs text-gray-500 leading-relaxed max-w-[440px]">
                开启后以键盘当前颜色为锚点做 360° 色相循环渐变；停止时自动恢复启动前的颜色与模式。
              </p>
              <span
                class="text-xs inline-flex items-center gap-1.5"
                :class="gradientRunning ? 'text-accent' : 'text-weak'"
              >
                <span
                  class="w-1.5 h-1.5 rounded-full"
                  :class="gradientRunning ? 'bg-accent' : 'bg-weak'"
                ></span>
                {{ gradientRunning ? '渐变色环循环中' : '未运行' }}
              </span>
            </div>
            <a-switch
              :model-value="gradientRunning"
              :loading="gradientLoading"
              @change="handleGradientToggle"
            >
              <template #checked-icon><icon-check /></template>
              <template #unchecked-icon><icon-close /></template>
            </a-switch>
          </div>
        </div>

        <!-- 4. 灯光通道与亮度手动调。-->
        <div
          class="panel-card p-5 space-y-6"
          :class="{ 'opacity-40 pointer-events-none': gradientRunning }"
        >
          <h2 class="text-[13px] font-semibold text-gray-300">RGB 通道与亮。</h2>

          <div class="space-y-5">
            <!-- 红色通道 (Red) -->
            <div class="space-y-2">
              <div class="flex justify-between items-center text-xs">
                <span class="text-gray-300 flex items-center gap-1 font-semibold text-red-400"
                  >红色通道 (R)</span
                >
                <span class="text-red-400 font-medium font-mono">{{ color.red }}</span>
              </div>
              <a-slider v-model="color.red" :min="0" :max="255" :disabled="gradientRunning" class="w-full red-slider" />
            </div>

            <!-- 绿色通道 (Green) -->
            <div class="space-y-2">
              <div class="flex justify-between items-center text-xs">
                <span class="text-gray-300 flex items-center gap-1 font-semibold text-green-400"
                  >绿色通道 (G)</span
                >
                <span class="text-green-400 font-medium font-mono">{{ color.green }}</span>
              </div>
              <a-slider v-model="color.green" :min="0" :max="255" :disabled="gradientRunning" class="w-full green-slider" />
            </div>

            <!-- 蓝色通道 (Blue) -->
            <div class="space-y-2">
              <div class="flex justify-between items-center text-xs">
                <span class="text-gray-300 flex items-center gap-1 font-semibold text-blue-400"
                  >蓝色通道 (B)</span
                >
                <span class="text-blue-400 font-medium font-mono">{{ color.blue }}</span>
              </div>
              <a-slider v-model="color.blue" :min="0" :max="255" :disabled="gradientRunning" class="w-full blue-slider" />
            </div>

            <!-- 背光亮度 -->
            <div class="space-y-2 pt-2 border-t border-ink/[0.05]">
              <div class="flex justify-between items-center text-xs">
                <span class="text-gray-300 flex items-center gap-1">背光亮度等级</span>
                <span class="text-purple-400 font-medium font-mono"
                  >Level {{ LightBrightness }}</span
                >
              </div>
              <a-slider v-model="LightBrightness" :min="0" :max="3" :step="1" :disabled="gradientRunning" class="w-full" />
            </div>
          </div>
        </div>

        <!-- 5. 底部动作。-->
        <div class="flex justify-between items-center pt-2">
          <button
            class="flex items-center gap-2 text-xs text-gray-400 hover:text-ink border border-ink/10 hover:border-ink/20 bg-ink/[0.02] hover:bg-ink/[0.05] px-4 py-2 rounded-lg transition-colors pressable"
            :class="{ 'opacity-40 pointer-events-none': gradientRunning }"
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

          <button
            :disabled="loading || gradientRunning"
            class="kb-apply btn-apply text-xs"
            @click="handleApply"
          >
            {{ loading ? '应用中...' : '应用' }}
          </button>
        </div>
      </div>

      <!-- ==================== 右侧：信息与说明区==================== -->
      <div class="w-full lg:w-[360px] shrink-0 space-y-6 lg:pt-[115px]">
        <!-- 1. 当前颜色色板卡片 -->
        <div
          class="panel-card p-5 space-y-4"
        >
          <h2 class="text-[13px] font-semibold text-gray-300">当前配色方案</h2>
          <div
            class="kb-swatch w-full h-24 rounded-xl border border-ink/10 flex flex-col justify-end p-3 shadow-lg relative overflow-hidden"
            :style="{ backgroundColor: `rgb(${color.red}, ${color.green}, ${color.blue})` }"
          >
            <div class="absolute inset-0 bg-black/20 backdrop-blur-[1px]"></div>
            <div
              class="relative z-10 flex justify-between items-center text-xs font-mono font-bold"
              :style="{ color: color.red + color.green + color.blue > 380 ? '#000' : '#fff' }"
            >
              <span>{{ rgbToHex(color.red, color.green, color.blue) }}</span>
              <span>RGB({{ color.red }}, {{ color.green }}, {{ color.blue }})</span>
            </div>
          </div>
          <div class="flex justify-between items-center text-xs text-gray-400">
            <span>当前亮度级别</span>
            <span class="text-ink font-mono font-bold bg-ink/10 px-2 py-0.5 rounded"
              >档位 {{ LightBrightness }}</span
            >
          </div>
        </div>

        <!-- 2. 说明卡片 -->
        <div
          class="panel-card p-5 space-y-2.5"
        >
          <h2 class="text-[13px] font-semibold text-gray-300">使用说明</h2>
          <div class="text-[11px] text-gray-500 leading-relaxed space-y-2">
            <p>通过 R/G/B 三通道滑块、快捷预设或颜色拾取器设置背光颜色。</p>
            <p>背光亮度设置。0 时将关闭键盘灯光。</p>
            <p>点击“应用”即可生效并保存硬件状态。</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}



:deep(.red-slider .arco-slider-bar) {
  background: linear-gradient(90deg, #ef4444 0%, #f87171 100%) !important;
}
:deep(.red-slider .arco-slider-button) {
  border-color: #ef4444 !important;
  box-shadow: none !important;
}

:deep(.green-slider .arco-slider-bar) {
  background: linear-gradient(90deg, #22c55e 0%, #4ade80 100%) !important;
}
:deep(.green-slider .arco-slider-button) {
  border-color: #22c55e !important;
  box-shadow: none !important;
}

:deep(.blue-slider .arco-slider-bar) {
  background: linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%) !important;
}
:deep(.blue-slider .arco-slider-button) {
  border-color: #3b82f6 !important;
  box-shadow: none !important;
}

/* 渐变运行。 预览灯层。12s 一圈的色相旋转, 模拟真实色轮循环 */
@keyframes gradient-hue {
  from {
    filter: hue-rotate(0deg);
  }
  to {
    filter: hue-rotate(360deg);
  }
}
.gradient-glow {
  animation: gradient-hue 12s linear infinite;
}

/* ===== 动效令牌驱动的局部过。 替代原先 6 。transition-all duration-300 ===== */
.kb-preset {
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}

.kb-preset:active {
  transform: scale(0.97);
}

.kb-apply {
  transition:
    background-color var(--dur-fast) var(--ease-out),
    transform var(--dur-press) var(--ease-out);
}

.kb-apply:active {
  transform: scale(0.97);
}

/* 当前配色色板: 只过渡底。。transition-all 会连带模。阴影一起动) */
.kb-swatch {
  transition: background-color var(--dur-base) var(--ease-out);
}

/* hover 动效门禁: 无精确指针的设备(触屏)不响。hover,
 * 否则点击后悬停态会粘住不还。*/
@media (hover: hover) and (pointer: fine) {
  .kb-scale,
  .kb-scale-group {
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .kb-scale:hover {
    transform: scale(1.05);
  }

  .group:hover .kb-scale-group {
    transform: scale(1.1);
  }
}
</style>
