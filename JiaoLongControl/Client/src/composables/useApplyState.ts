import { computed, ref } from 'vue'

export type ApplyPhase = 'idle' | 'pending' | 'applying' | 'success' | 'fail'

export interface ApplyState {
  phase: ApplyPhase
  message: string
  /** 失败时是否可回读/撤销 */
  canRetry: boolean
}

/**
 * 写操作状态机: idle → pending(有待应用变更) → applying → success | fail
 * 读数瞬时, 状态色变走 --dur-base; 禁装饰脉冲。
 */
export function useApplyState() {
  const phase = ref<ApplyPhase>('idle')
  const message = ref('')
  const canRetry = ref(false)
  const dirty = ref(false)

  const isBusy = computed(() => phase.value === 'applying')
  const statusText = computed(() => {
    switch (phase.value) {
      case 'pending':
        return message.value || '待应用'
      case 'applying':
        return message.value || '应用中…'
      case 'success':
        return message.value || '已应用'
      case 'fail':
        return message.value || '应用失败'
      default:
        return dirty.value ? '有未应用变更' : ''
    }
  })

  function markDirty(note = '有未应用变更') {
    dirty.value = true
    if (phase.value !== 'applying') {
      phase.value = 'pending'
      message.value = note
    }
  }

  function markClean() {
    dirty.value = false
    if (phase.value === 'pending') phase.value = 'idle'
  }

  async function run<T extends { Success: boolean; Message?: string }>(
    label: string,
    action: () => Promise<T>,
    opts?: { onSuccess?: () => void; onFail?: () => void },
  ): Promise<boolean> {
    phase.value = 'applying'
    message.value = label
    canRetry.value = false
    try {
      const res = await action()
      if (res.Success) {
        phase.value = 'success'
        message.value = res.Message || label
        dirty.value = false
        opts?.onSuccess?.()
        return true
      }
      phase.value = 'fail'
      message.value = res.Message || `${label}失败`
      canRetry.value = true
      opts?.onFail?.()
      return false
    } catch (e) {
      phase.value = 'fail'
      message.value = e instanceof Error ? e.message : `${label}失败`
      canRetry.value = true
      opts?.onFail?.()
      return false
    }
  }

  function reset() {
    phase.value = 'idle'
    message.value = ''
    canRetry.value = false
    dirty.value = false
  }

  return {
    phase,
    message,
    canRetry,
    dirty,
    isBusy,
    statusText,
    markDirty,
    markClean,
    run,
    reset,
  }
}

export type ApplyStateReturn = ReturnType<typeof useApplyState>
