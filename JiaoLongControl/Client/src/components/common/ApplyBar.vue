<script setup lang="ts">
import { computed } from 'vue'
import type { ApplyPhase, ApplyStateReturn } from '@/composables/useApplyState'

type ExternalApplyPhase = ApplyPhase | 'running' | 'partial' | 'failed'

const props = defineProps<{
  apply?: ApplyStateReturn
  phase?: ExternalApplyPhase
  statusText?: string | null
  busy?: boolean
  disabled?: boolean
  canRetry?: boolean
  applyLabel?: string
  /** 传了才渲染「重置」按钮；重置语义由调用方定义（本组件不下发任何东西） */
  resetLabel?: string
  /**
   * 重置按钮的禁用条件。默认跟随 disabled，但"重置只改表单、不下发硬件"的页面
   * 不该被别的组在途阻塞，可显式传 false（此时仍受本组 busy 约束）。
   */
  resetDisabled?: boolean
  danger?: boolean
}>()

const emit = defineEmits<{
  apply: []
  retry: []
  reset: []
}>()

const currentPhase = computed<ExternalApplyPhase>(
  () => props.apply?.phase.value ?? props.phase ?? 'idle',
)
const currentStatus = computed(
  () =>
    props.apply?.statusText.value ||
    props.statusText ||
    (currentPhase.value === 'idle' ? '就绪' : ''),
)
const isBusy = computed(
  () => props.apply?.isBusy.value ?? props.busy ?? currentPhase.value === 'running',
)
const showRetry = computed(() => props.apply?.canRetry.value ?? props.canRetry ?? false)

const statusClass = computed(() => {
  switch (currentPhase.value) {
    case 'pending':
      return 'st-pending'
    case 'applying':
    case 'running':
      return 'st-applying'
    case 'success':
      return 'st-success'
    case 'fail':
    case 'failed':
      return 'st-fail'
    case 'partial':
      return 'st-partial'
    default:
      return 'st-idle'
  }
})
</script>

<template>
  <div class="apply-bar">
    <div class="apply-status" :class="statusClass" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true" />
      <span class="msg tnum">{{ currentStatus }}</span>
    </div>
    <div class="apply-actions">
      <button v-if="showRetry" class="btn-ghost" type="button" @click="emit('retry')">重试</button>
      <button
        v-if="resetLabel"
        class="btn-ghost"
        type="button"
        :disabled="isBusy || (resetDisabled ?? disabled)"
        @click="emit('reset')"
      >
        {{ resetLabel }}
      </button>
      <button
        class="btn-apply"
        :class="{ 'btn-danger': danger }"
        type="button"
        :disabled="isBusy || disabled"
        @click="emit('apply')"
      >
        {{ isBusy ? '应用中…' : applyLabel || '应用' }}
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.apply-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: auto;
  padding-top: 14px;
  border-top: 1px solid var(--hair);
}

.apply-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: var(--muted);

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--weak);
    flex-shrink: 0;
    transition: background-color var(--dur-base) var(--ease-out);
  }

  .msg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &.st-pending {
    color: var(--accent);

    .dot {
      background: var(--accent);
    }
  }

  &.st-applying {
    color: var(--muted);

    .dot {
      background: var(--accent);
    }
  }

  &.st-success {
    color: #34d399;

    .dot {
      background: #34d399;
    }
  }

  &.st-fail {
    color: var(--temp-critical);

    .dot {
      background: var(--temp-critical);
    }
  }

  &.st-partial {
    color: var(--temp-hot);

    .dot {
      background: var(--temp-hot);
    }
  }
}

.apply-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.btn-ghost {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hair-strong);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);

  &:hover {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.04);
  }
}

.btn-danger {
  background: #e11d48;
  color: #fff;

  &:hover:not(:disabled) {
    filter: brightness(1.08);
  }
}

[data-theme='light'] .btn-ghost:hover {
  background: rgba(13, 14, 21, 0.04);
}

/* 禁用必须有可见反馈：此前按钮只是"点不动"，看不出是被禁用还是坏了 */
.btn-ghost:disabled,
.btn-apply:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-ghost:disabled:hover {
  color: var(--muted);
  background: transparent;
}
</style>
