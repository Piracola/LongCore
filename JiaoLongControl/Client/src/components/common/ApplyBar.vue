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
  danger?: boolean
}>()

const emit = defineEmits<{
  apply: []
  retry: []
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
</style>
