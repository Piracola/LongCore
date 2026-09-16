<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useConfigStore } from '@/stores/config'
import { useFanStore } from '@/stores/fan'
import FanSpeed from '@/components/common/FanSpeed.vue'
import ControlModule from '@/components/common/ControlModule.vue'
import ApplyBar from '@/components/common/ApplyBar.vue'
import PageShell from '@/components/common/PageShell.vue'
import { useApplyState } from '@/composables/useApplyState'

const visible = ref(false)
const configStore = useConfigStore()
const fanStore = useFanStore()
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

const displaySpeed = computed(() => draftSpeed.value)

// 危险确认：超出 1500–5800 闸门值域即弹确认（v4 §11 第 3 项）
function requestApply() {
  if (!FanPageStore.value) return
  if (
    FanPageStore.value.ManualFanSpeed > 5800 ||
    FanPageStore.value.ManualFanSpeed < 1500
  ) {
    visible.value = true
    return
  }
  void doApply()
}

async function doApply() {
  if (!FanPageStore.value) return
  visible.value = false
  const result = await fanStore.applyManualSpeed(FanPageStore.value.ManualFanSpeed, () =>
    configStore.saveConfig(),
  )
  if (result.ok) {
    Message.success(result.message)
    apply.markClean()
  } else {
    Message.error(result.message)
    apply.canRetry.value = true
  }
}

// 「恢复自动控制」常驻可达（v4 §11 第 3 项；C 级可逆性唯一出路）
async function handleRemoveFanClick() {
  const result = await fanStore.restoreAuto()
  if (result.ok) {
    Message.success(result.message)
  } else {
    Message.error(result.message)
  }
}

function handleCancel() {
  visible.value = false
}

// 进入页面：判定当前控制权 + 起四态转速读取
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void fanStore.resolveController()
  void fanStore.refreshSpeed()
  pollTimer = setInterval(() => {
    if (!document.hidden) void fanStore.refreshSpeed()
  }, 2000)
})
onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <PageShell v-if="FanPageStore" title="风扇控制" subtitle="手动调节风扇转速或恢复自动控制">
    <div class="fan-layout">
      <ControlModule title="目标转速设定" eyebrow="Manual Control" badge="EC">
        <template #readout>
          <div class="big-readout">
            <span class="num tnum">{{ displaySpeed }}</span>
            <span class="unit">RPM</span>
          </div>
          <div class="readout-meta">范围 1500–5800 · 步进 100</div>
        </template>

        <!-- 当前由谁控制（v4 §10：自动策略接管必须显示） -->
        <div class="controller-banner" :class="fanStore.controller">
          <span class="dot" />
          当前由{{ fanStore.controllerLabel }}控制
        </div>

        <a-slider
          v-model="FanPageStore.ManualFanSpeed"
          :min="1500"
          :max="5800"
          :step="100"
          class="w-full"
        />

        <p class="hint">
          手动设定会关闭自动温控后台并锁定转速。重载时过低转速可能导致降频。
        </p>

        <template #footer>
          <ApplyBar
            :apply="apply"
            apply-label="应用设定"
            @apply="requestApply"
            @retry="requestApply"
          />
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
          <template #footer>
            <button class="btn-ghost-block" type="button" @click="handleRemoveFanClick">
              恢复自动控制
            </button>
          </template>
        </ControlModule>

        <ControlModule title="最近活动" eyebrow="Recent" badge="用户操作">
          <ul v-if="fanStore.activity.length" class="activity-list">
            <li v-for="item in fanStore.activity" :key="item.seq" class="activity-item">
              <span class="t">{{ item.intent }}</span>
              <span :class="['o', item.outcome]">
                {{ { applied: '已应用', accepted: '已接受', failed: '失败', partial: '部分应用' }[item.outcome] }}
              </span>
            </li>
          </ul>
          <p v-else class="hint">暂无用户操作记录（自动温控的底层写入不进入此处）</p>
        </ControlModule>
      </div>
    </div>

    <a-modal v-model:visible="visible" simple :mask-closable="false" @ok="doApply" @cancel="handleCancel">
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
  grid-template-columns: 1.2fr 0.9fr;
  gap: 12px;
  align-items: start;
  flex: 1;
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
