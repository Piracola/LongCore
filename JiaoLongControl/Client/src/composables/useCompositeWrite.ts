import { ref, computed } from 'vue'
import type {
  OperationEvent,
  OperationSource,
  OperationStep,
  PostReadVerify,
} from '@/domain/operations'

/**
 * 复合写入逐步结果模型（UI重构_最终方案_v4.md §8.3，Implemented 2026-09-17）。
 *
 * 替代「回滚」：复合操作（如 CPU 应用 = 顺序写 7 项）中途失败时，
 * 前面已生效的项不会也无法撤销 —— 必须逐项报告成功/失败/跳过，
 * 并显式暴露「部分应用」状态（partialApplied），让用户知道硬件此刻处于什么状态。
 *
 * 回读校验约束（v4 §8.4）：写响应回显不可作校验依据（命令 23 合法不回显），
 * 校验 = 写后独立重读；无可靠 getter 的步骤 verify = { verifiable: false, ... }，
 * UI 只能标注「命令已接受」，不得渲染成「已生效」。
 */

export type CompositePhase = 'idle' | 'running' | 'success' | 'partial' | 'failed'

export interface StepPlan {
  /** 步骤名（UI 逐项显示），如「温度墙 85°C」 */
  label: string
  transport: OperationStep['transport']
  requestedValue: number | string | boolean | null
  /**
   * 执行该步。可直接返回 CommandResult（Success 即 accepted），
   * 或返回 { accepted, message } 自定义判定。
   */
  run: () => Promise<
    { Success: boolean; Message?: string } | { accepted: boolean; message?: string }
  >
  /**
   * 写后独立重读（可选）：存在可靠 getter 时提供；缺失 = 仅命令确认，不可回读。
   * expected 为该步请求值；重读结果会与 expected 严格比对。
   */
  verify?: () => Promise<PostReadVerify>
  /** 是否可安全跳过（如 CO=0 的「无操作」语义）；默认 false */
  skippable?: () => boolean
}

/** 归一 run() 的返回：CommandResult → { accepted, message } */
function normalize(res: {
  Success?: boolean
  Message?: string
  accepted?: boolean
  message?: string
}): {
  accepted: boolean
  message?: string
} {
  if (typeof res.Success === 'boolean') return { accepted: res.Success, message: res.Message }
  return { accepted: !!res.accepted, message: res.message }
}

/** 把请求值/回读值格式化为可比对的短字符串（颜色等复合值也能读） */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export interface CompositeWriteState {
  phase: CompositePhase
  /** 每步实时结果（running 时逐项追加） */
  steps: OperationStep[]
  partialApplied: boolean
  /** 失败中断处的步骤索引；null = 未中断 */
  failedAt: number | null
  message: string | null
}

export function useCompositeWrite() {
  const state = ref<CompositeWriteState>({
    phase: 'idle',
    steps: [],
    partialApplied: false,
    failedAt: null,
    message: null,
  })

  const isBusy = computed(() => state.value.phase === 'running')
  /** v4 §10：逐项报告成功/失败/跳过，部分应用必须显式可感知 */
  const summary = computed(() => {
    const s = state.value.steps
    const ok = s.filter((x) => x.status === 'success').length
    const failed = s.filter((x) => x.status === 'failed').length
    const skipped = s.filter((x) => x.status === 'skipped').length
    return { total: s.length, ok, failed, skipped }
  })

  /**
   * 顺序执行复合写入。策略：遇失败立即中止（后续步骤不执行），
   * 已成功步骤保持原样，partialApplied = true。**不做任何回滚**。
   *
   * @returns 最终 OperationEvent（供 ActivityLog.record 与诊断展示）
   */
  async function run(opts: {
    source: OperationSource
    transport: OperationEvent['transport']
    requestedValue: OperationEvent['requestedValue']
    reversible: OperationEvent['reversible']
    compensation: string | null
    preRead: OperationEvent['preRead']
    steps: StepPlan[]
    /** 全部步骤完成后的整体重读（可选） */
    finalVerify?: () => Promise<PostReadVerify>
  }): Promise<OperationEvent> {
    state.value = {
      phase: 'running',
      steps: [],
      partialApplied: false,
      failedAt: null,
      message: null,
    }

    const steps: OperationStep[] = []
    let aborted = false

    for (const plan of opts.steps) {
      if (aborted) break

      if (plan.skippable?.()) {
        steps.push({
          label: plan.label,
          transport: plan.transport,
          requestedValue: plan.requestedValue,
          commandAccepted: false,
          verify: { verifiable: false, value: null, matches: null },
          status: 'skipped',
          message: '已跳过（无操作语义）',
        })
        state.value.steps = [...steps]
        continue
      }

      try {
        const res = normalize(await plan.run())
        const verify: PostReadVerify =
          res.accepted && plan.verify
            ? await plan.verify()
            : { verifiable: plan.verify !== undefined, value: null, matches: null }

        // 回读不一致 = 命令被接受但值没生效。旧实现只按 accepted 判成败，
        // 于是「硬件没吃下颜色」也会显示成功 —— 这正是 v4 §8.4 禁止的伪装成功。
        // 有可靠 getter 且比对不符时，该步必须判 failed 并给出请求值/实读值。
        const mismatched = res.accepted && verify.verifiable && verify.matches === false
        const stepFailed = !res.accepted || mismatched
        const stepMessage = mismatched
          ? `已发送但回读不一致：请求 ${formatValue(plan.requestedValue)} / 实读 ${formatValue(verify.value)}`
          : (res.message ?? null)

        steps.push({
          label: plan.label,
          transport: plan.transport,
          requestedValue: plan.requestedValue,
          commandAccepted: res.accepted,
          verify,
          status: stepFailed ? 'failed' : 'success',
          message: stepMessage,
        })
        if (stepFailed) {
          aborted = true
          state.value.failedAt = steps.length - 1
          state.value.message = stepMessage || res.message || `${plan.label}失败`
        }
      } catch (err) {
        steps.push({
          label: plan.label,
          transport: plan.transport,
          requestedValue: plan.requestedValue,
          commandAccepted: false,
          verify: { verifiable: false, value: null, matches: null },
          status: 'failed',
          message: err instanceof Error ? err.message : '执行异常',
        })
        aborted = true
        state.value.failedAt = steps.length - 1
        state.value.message = err instanceof Error ? err.message : `${plan.label}执行异常`
      }
      state.value.steps = [...steps]
    }

    const succeeded = steps.filter((s) => s.status === 'success').length
    const failed = steps.some((s) => s.status === 'failed')
    // 中止在非首步 → 前面已生效 → 部分应用；首步即败不算部分应用
    const partial = aborted && succeeded > 0

    let postRead: PostReadVerify | null = null
    if (!aborted && opts.finalVerify) {
      postRead = await opts.finalVerify()
    }

    const event: OperationEvent = {
      source: opts.source,
      transport: opts.transport,
      requestedValue: opts.requestedValue,
      preRead: opts.preRead,
      commandAccepted: steps.some((s) => s.commandAccepted),
      postRead,
      reversible: opts.reversible,
      compensation: opts.compensation,
      steps,
      partialApplied: partial,
    }

    state.value.partialApplied = partial
    state.value.phase = failed ? (partial ? 'partial' : 'failed') : 'success'
    if (!failed) state.value.message = '全部步骤已应用'
    else if (partial) state.value.message = `部分应用：前 ${succeeded} 项已生效，其余未执行`
    return event
  }

  function reset(): void {
    state.value = { phase: 'idle', steps: [], partialApplied: false, failedAt: null, message: null }
  }

  return { state, isBusy, summary, run, reset }
}
