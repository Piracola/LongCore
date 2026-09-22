<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useConfigStore } from '@/stores/config'
import { useFanStore } from '@/stores/fan'
import { useModeStore } from '@/stores/mode'
import FanSpeed from '@/components/common/FanSpeed.vue'
import ControlModule from '@/components/common/ControlModule.vue'
import ApplyBar from '@/components/common/ApplyBar.vue'
import PageShell from '@/components/common/PageShell.vue'
import { useApplyState } from '@/composables/useApplyState'
import { FAN_MAX_RPM, FAN_MIN_RPM } from '@/constants'

const visible = ref(false)
const configStore = useConfigStore()
const fanStore = useFanStore()
const modeStore = useModeStore()
const apply = useApplyState()

if (!configStore.config) {
  await configStore.fetchConfig()
}

const FanPageStore = computed(() => configStore.config?.Fan)
const draftSpeed = ref(FanPageStore.value?.ManualFanSpeed ?? 2000)

watch(
  () => FanPageStore.value?.ManualFanSpeed,
  (v) => {
    if (typeof v === 'number' && v !== draftSpeed.value) draftSpeed.value = v
  },
)

watch(draftSpeed, (v) => {
  if (FanPageStore.value && FanPageStore.value.ManualFanSpeed !== v) {
    FanPageStore.value.ManualFanSpeed = v
  }
  apply.markDirty('转速已调整，待应用')
})

/**
 * 门禁（2026-09-21）：固件三档的风扇曲线由 EC 自己的表管理，应用不介入。
 * 只有首页切到「自定义」才解锁手动转速。恢复自动控制不受此限 ——
 * 那是把控制权交还固件的安全出口，在任何档位下都必须可用。
 */
const locked = computed(() => fanStore.customizationLocked)

/** 观察值优先：显示真实转速（读不到显示 —），未应用时才退回草稿目标 */
const observedSpeed = computed(() => {
  const v = fanStore.speed.value
  if (!v) return null
  return Math.max(v.CPUFanSpeed, v.GPUFanSpeed)
})
const displaySpeed = computed(() => {
  if (fanStore.controller === 'manual') return draftSpeed.value
  return observedSpeed.value
})
const speedIsObserved = computed(() => fanStore.controller !== 'manual')

function requestApply() {
  if (!FanPageStore.value) return
  if (locked.value) {
    Message.warning('固件档位下风扇由 EC 管理，请先在概览页切换到自定义')
    return
  }
  if (
    FanPageStore.value.ManualFanSpeed > FAN_MAX_RPM ||
    FanPageStore.value.ManualFanSpeed < FAN_MIN_RPM
  ) {
    visible.value = true
    return
  }
  void doApply()
}

async function doApply() {
  if (!FanPageStore.value) return
  visible.value = false
  let resultMessage = '手动转速已应用'
  const ok = await apply.run('正在应用手动转速…', async () => {
    const result = await fanStore.applyManualSpeed(FanPageStore.value!.ManualFanSpeed, () =>
      configStore.saveConfig(),
    )
    resultMessage = result.message
    return { Success: result.ok, Message: result.message }
  })
  if (ok) {
    Message.success(resultMessage)
    await fanStore.refreshSpeed()
  } else {
    Message.error(resultMessage)
  }
}

/**
 * 恢复自动控制 —— 与转速设定同处一个板块（2026-09-21）。
 * 旧布局把它塞进「安全提示」卡，等于把唯一的出路藏进说明文字里；
 * 用户接管后想交还 EC，最自然的落点就在他当初接管的地方。
 */
async function handleRestoreAuto() {
  const result = await fanStore.restoreAuto()
  if (result.ok) {
    Message.success(result.message)
    apply.reset()
    // 交还 EC 后：清掉手动设定残留，读数回到真实观察值
    if (FanPageStore.value) FanPageStore.value.ManualFanSpeed = 0
    draftSpeed.value = 0
    await fanStore.refreshSpeed()
    await fanStore.resolveController()
  } else {
    Message.error(result.message)
  }
}

function handleCancel() {
  visible.value = false
}

/**
 * 重置 = 把风扇交还固件自动温控（2026-09-21）。
 * 旧实现只把草稿拉回 1500 RPM：既不写硬件也不落盘，页面显示 1500
 * 而 EC 仍按自己的表转 —— 数字和事实对不上，是该页最反直觉的一处。
 */
function handleReset() {
  void handleRestoreAuto()
}

onMounted(() => {
  void fanStore.resolveController()
})
</script>

<template>
  <PageShell v-if="FanPageStore" title="风扇控制" subtitle="手动调节风扇转速或恢复自动控制">
    <div class="fan-layout">
      <ControlModule title="目标转速设定" eyebrow="Manual Control" badge="EC">
        <template #readout>
          <div class="big-readout">
            <span class="num tnum">{{ displaySpeed ?? '—' }}</span>
            <span class="unit">RPM</span>
          </div>
          <div class="readout-meta">
            <template v-if="speedIsObserved">实测 · 范围 1500–5800</template>
            <template v-else>目标值 · 范围 1500–5800 · 步进 100</template>
          </div>
        </template>

        <!-- 当前由谁控制（v4 §10：自动策略接管必须显示） -->
        <div class="controller-banner" :class="fanStore.controller">
          <span class="dot" />
          当前由{{ fanStore.controllerLabel }}控制
        </div>

        <!-- 门禁：固件三档的风扇由 EC 自己的表管理，应用不介入 -->
        <div v-if="locked" class="gate-note">
          <span>
            当前档位为{{ modeStore.firmwareLabel || '固件档位' }}，风扇转速由 EC
            固件表管理，应用不改写。需要自定义转速或曲线，请先在概览页切到「自定义」。
          </span>
        </div>

        <a-slider
          v-model="FanPageStore.ManualFanSpeed"
          :min="1500"
          :max="5800"
          :step="100"
          :disabled="locked"
          class="w-full"
        />

        <p class="hint">手动设定会接管 EC 自动温控并锁定转速。重载时过低转速可能导致降频。</p>

        <template #footer>
          <div class="fan-actions">
            <!-- 重置 = 把风扇交还 EC 固件自动温控 -->
            <button
              class="btn-restore"
              type="button"
              title="把风扇交还 EC 固件自动温控"
              @click="handleReset"
            >
              重置
            </button>
            <!-- 交还控制权的出口与接管动作放在一起：在哪里接管，就在哪里交还 -->
            <button
              class="btn-restore"
              type="button"
              :disabled="fanStore.controller === 'auto'"
              @click="handleRestoreAuto"
            >
              恢复自动控制
            </button>
            <ApplyBar
              :apply="apply"
              apply-label="应用设定"
              :disabled="locked"
              @apply="requestApply"
              @retry="requestApply"
            />
          </div>
          <p class="reset-note">恢复自动控制 = 把风扇交还 EC 固件温控，手动转速随之失效。</p>
        </template>
      </ControlModule>

      <div class="fan-side">
        <ControlModule title="实时遥测" eyebrow="Live" badge="2s">
          <FanSpeed />
        </ControlModule>

        <ControlModule title="安全提示" eyebrow="Safety">
          <ul class="safety-list">
            <li>手动设定会关闭自动风扇温控后台。</li>
            <li>长时间超过 5800 RPM 可能缩短电机寿命。</li>
            <li>重载时转速过低会导致过热降频。</li>
          </ul>
        </ControlModule>

        <ControlModule title="最近活动" eyebrow="Recent" badge="用户操作">
          <ul v-if="fanStore.activity.length" class="activity-list">
            <li v-for="item in fanStore.activity" :key="item.seq" class="activity-item">
              <span class="t">{{ item.intent }}</span>
              <span :class="['o', item.outcome]">
                {{
                  { applied: '已应用', accepted: '已接受', failed: '失败', partial: '部分应用' }[
                    item.outcome
                  ]
                }}
              </span>
            </li>
          </ul>
          <p v-else class="hint">暂无用户操作记录（自动温控的底层写入不进入此处）</p>
        </ControlModule>
      </div>
    </div>

    <a-modal
      v-model:visible="visible"
      simple
      :mask-closable="false"
      @ok="doApply"
      @cancel="handleCancel"
    >
      <template #title>安全警告</template>
      <div class="modal-body">
        设定目标转速高于
        <span class="tnum crit">5800 RPM</span>
        或低于
        <span class="tnum crit">1500 RPM</span>
        ，可能引起噪音剧增或热量积攒。确认后继续。
      </div>
    </a-modal>
  </PageShell>

  <div v-else class="flex items-center justify-center h-full bg-[var(--bg-app)]">
    <a-spin dot />
  </div>
</template>

<style scoped lang="scss">
.fan-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.9fr);
  gap: 12px;
  align-items: start;
  flex: 1;
  min-width: 0;
}

.fan-layout > * {
  min-width: 0;
}

@media (max-width: 1100px) {
  .fan-layout {
    grid-template-columns: 1fr;
  }
}

.fan-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.big-readout {
  display: flex;
  align-items: baseline;
  gap: 6px;

  .num {
    font-size: 40px;
    font-weight: 650;
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--ink);
  }

  .unit {
    font-size: 13px;
    color: var(--weak);
    font-family: var(--font-mono);
  }
}

.readout-meta {
  font-size: 11px;
  color: var(--weak);
  font-family: var(--font-mono);
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

.fan-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 4px;
}

.fan-actions :deep(.apply-bar) {
  flex: 1;
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}

.btn-restore {
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hair-strong);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);

  &:hover:not(:disabled) {
    color: var(--temp-cool);
    border-color: color-mix(in srgb, var(--temp-cool) 45%, transparent);
    background: color-mix(in srgb, var(--temp-cool) 10%, transparent);
  }

  /* 已经是 EC 自动时没有可交还的东西 —— 置灰而不是消失，位置不跳 */
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.gate-note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
  background: var(--bg-inset);
  border: 1px solid var(--hair);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}

.reset-note {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--weak);
  line-height: 1.5;
}

.controller-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hair);
  background: var(--bg-inset);
  font-size: 12px;
  color: var(--muted);

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }

  &.auto .dot {
    background: var(--temp-cool);
  }

  &.manual .dot {
    background: var(--temp-hot);
  }

  &.curve .dot {
    background: var(--accent);
  }
}

.activity-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
}

.activity-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--hair);
  font-size: 12px;

  &:last-child {
    border-bottom: 0;
  }

  .t {
    color: var(--ink);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .o {
    flex-shrink: 0;
    font-size: 11px;

    &.applied {
      color: var(--temp-cool);
    }

    &.failed {
      color: var(--temp-critical);
    }

    &.partial {
      color: var(--temp-hot);
    }

    &.accepted {
      color: var(--muted);
    }
  }
}

.safety-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}

.btn-ghost-block {
  width: 100%;
  height: 32px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hair-strong);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);

  &:hover {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.04);
  }
}

.modal-body {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;

  .crit {
    color: var(--temp-critical);
    font-weight: 600;
  }
}

:deep(.arco-modal) {
  background-color: var(--bg-panel) !important;
  border: 1px solid var(--hair) !important;
  border-radius: var(--radius-lg) !important;

  .arco-modal-header {
    border-bottom: 1px solid var(--hair) !important;

    .arco-modal-title {
      color: var(--ink) !important;
      font-size: 13px !important;
    }
  }

  .arco-modal-footer {
    border-top: 1px solid var(--hair) !important;

    .arco-btn-primary {
      background-color: #e11d48 !important;
      border: none !important;
      color: #fff !important;
      border-radius: var(--radius-md) !important;
      box-shadow: none !important;
    }
  }
}
</style>
