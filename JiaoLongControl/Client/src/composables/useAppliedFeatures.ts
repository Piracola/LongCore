/**
 * 看板的 I/O 层：读配置意图 + 调桥接 getter 回读 + 执行移除（复合写入逐项结果）。
 *
 * 复用既有机制，不另起第二套：
 * - 写入/逐步结果：`composables/useCompositeWrite.ts`（v4 §8.3）
 * - 用户意图级记录：`stores/activity.ts`（v4 §8.5）
 * - 配置读写：`stores/config.ts`（ConfigCtrl.GetConfig/SetConfig）
 * - 四态读数：`utils/reading.ts`（v4 §7.1；读不到就 error，禁止回退 0/false）
 *
 * 判定逻辑全在 domain/appliedFeatures.ts 的纯函数里；本文件只负责取数与下发。
 */
import { computed, ref } from 'vue'
import * as bridge from '@/utils/bridge'
import { useConfigStore } from '@/stores/config'
import { useActivityStore } from '@/stores/activity'
import { useCompositeWrite, type StepPlan } from '@/composables/useCompositeWrite'
import type { OperationTransport } from '@/domain/operations'
import {
  APPLIED_FEATURES,
  bulkRemovalPlan,
  judgeAll,
  judgeRemoval,
  readByPath,
  resolveBridgeMethod,
  type AppliedFeature,
  type IntentRead,
  type ObservedRead,
} from '@/domain/appliedFeatures'

type RawResult = { Success?: boolean; Message?: string; Data?: unknown }

/** 分组 → 传输通道（v4 §8.1 的操作事件字段） */
const GROUP_TRANSPORT: Record<AppliedFeature['group'], OperationTransport> = {
  cpu: 'wmi',
  smu: 'smu',
  gpu: 'nvapi',
  fan: 'ec',
  keyboard: 'wmi',
  system: 'config',
}

/** 回读值可能不是标量（如 ClockOffsetsInfo），报告里给一个短摘要 */
function summarize(value: unknown): number | string | boolean | null {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return `[${value.length} 项]`
  return JSON.stringify(value)
}

export function useAppliedFeatures() {
  const configStore = useConfigStore()
  const activity = useActivityStore()
  const composite = useCompositeWrite()

  const observed = ref<Record<string, ObservedRead>>({})
  const loading = ref(false)
  const removing = ref(false)
  /** 移除结果摘要（每项一行；只讲"确认到什么程度"，不把命令接受说成已生效） */
  const removalLog = ref<Array<{ id: string; name: string; message: string; ok: boolean }>>([])

  const intents = computed<Record<string, IntentRead>>(() => {
    const config = configStore.config
    const out: Record<string, IntentRead> = {}
    for (const item of APPLIED_FEATURES) {
      if (item.intentPath === null) {
        out[item.id] = { configLoaded: config !== null, found: false, value: null }
        continue
      }
      const raw = config ? readByPath(config, item.intentPath) : undefined
      let value: number | string | boolean | null = null
      if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') {
        value = raw
      } else if (Array.isArray(raw)) {
        value = `[${raw.length} 项]`
      }
      out[item.id] = { configLoaded: config !== null, found: raw !== undefined, value }
    }
    return out
  })

  const verdicts = computed(() => judgeAll(APPLIED_FEATURES, intents.value, observed.value))

  const rows = computed(() =>
    APPLIED_FEATURES.map((item, index) => ({
      item,
      verdict: verdicts.value[index]!,
    })),
  )

  /** 计数徽章：不一致 / 读取失败 / 不可回读 / 无下发路径 */
  const summary = computed(() => {
    const counts: Record<string, number> = {}
    for (const v of verdicts.value) counts[v.status] = (counts[v.status] ?? 0) + 1
    return {
      total: verdicts.value.length,
      counts,
      mismatch: counts.mismatch ?? 0,
      readFailed: counts['read-failed'] ?? 0,
      unreadable: counts.unreadable ?? 0,
      noWritePath: counts['no-write-path'] ?? 0,
    }
  })

  const restorePlan = computed(() =>
    bulkRemovalPlan(APPLIED_FEATURES, intents.value, observed.value),
  )

  async function readOne(item: AppliedFeature): Promise<ObservedRead> {
    const spec = item.readback
    if (!spec) return { state: 'error', value: null, message: '注册表未声明回读方法' }
    const fn = resolveBridgeMethod(bridge, spec.method)
    if (!fn) return { state: 'error', value: null, message: `桥接方法不存在：${spec.method}` }
    try {
      const res = (await fn()) as RawResult | null
      if (!res || res.Success !== true) {
        return { state: 'error', value: null, message: res?.Message ?? '命令被拒绝' }
      }
      if (res.Data === undefined || res.Data === null) {
        // 回读成功但没数据 —— 也按读取失败处理，不填默认值
        return { state: 'error', value: null, message: '回读无数据' }
      }
      return { state: 'ok', value: res.Data, message: null }
    } catch (err) {
      return {
        state: 'error',
        value: null,
        message: err instanceof Error ? err.message : '回读异常',
      }
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      if (!configStore.config) await configStore.fetchConfig()
      const withReadback = APPLIED_FEATURES.filter((item) => item.readback !== null)
      const entries = await Promise.all(
        withReadback.map(async (item): Promise<[string, ObservedRead]> => [
          item.id,
          await readOne(item),
        ]),
      )
      observed.value = Object.fromEntries(entries)
    } finally {
      loading.value = false
    }
  }

  function buildRemovalSteps(item: AppliedFeature): StepPlan[] {
    const transport = GROUP_TRANSPORT[item.group]
    const steps: StepPlan[] = item.removal.map((step) => {
      if (step.kind === 'bridge') {
        return {
          label: step.label,
          transport,
          requestedValue: step.args.length > 0 ? step.args.join(',') : null,
          run: async () => {
            const fn = resolveBridgeMethod(bridge, step.method)
            if (!fn) throw new Error(`桥接方法不存在：${step.method}`)
            const res = (await fn(...step.args)) as RawResult
            return { accepted: res?.Success === true, message: res?.Message }
          },
        }
      }
      return {
        label: step.label,
        transport: 'config',
        requestedValue: step.value,
        run: async () => {
          if (!configStore.config) return { accepted: false, message: '配置未加载' }
          const path = step.path.split('.')
          let node = configStore.config as unknown as Record<string, unknown>
          for (let i = 0; i < path.length - 1; i++) {
            node = (node[path[i] ?? ''] ?? {}) as Record<string, unknown>
          }
          node[path[path.length - 1] ?? ''] = step.value
          const res = (await configStore.saveConfig()) as RawResult | undefined
          return { accepted: res?.Success === true, message: res?.Message }
        },
      }
    })

    // 移除后的独立重读（v4 §8.4）：命令被接受 ≠ 已移除。挂成一个显式步骤，
    // 让"复核失败"直接出现在逐项结果里，而不是藏在某一步的备注里。
    // command-only 的项（EC 无 getter，如手动转速掩码）不挂复核：
    // 界面只能显示「仅命令确认」，绝不写「已移除」。
    if (item.removalConfirm === 'readback' && item.readback) {
      steps.push({
        label: `复核：独立重读 ${item.readback.method}()`,
        transport,
        requestedValue: null,
        run: async () => ({ accepted: true }),
        verify: async () => {
          const after = await readOne(item)
          if (after.state !== 'ok') {
            return { verifiable: true, value: null, matches: false }
          }
          return {
            verifiable: true,
            value: summarize(after.value),
            matches: judgeRemoval(item, after),
          }
        },
      })
    }
    return steps
  }

  async function removeOne(item: AppliedFeature): Promise<boolean> {
    if (item.removal.length === 0) return false
    const transport = GROUP_TRANSPORT[item.group]
    const before = observed.value[item.id]
    const event = await composite.run({
      source: 'user',
      transport,
      requestedValue: item.id,
      reversible: item.reversibility,
      compensation: null,
      preRead: before ? { value: summarize(before.value), readable: before.state === 'ok' } : null,
      steps: buildRemovalSteps(item),
    })
    const failed = event.steps.some((s) => s.status === 'failed')
    const commandOnly = item.removalConfirm === 'command-only'
    const message = failed
      ? `未确认移除成功：${composite.state.value.message ?? '回读未确认'}`
      : commandOnly
        ? '命令已接受 · 该项无可靠回读，无法确认是否已移除'
        : '已移除并回读确认'
    removalLog.value = [
      { id: item.id, name: item.name, message, ok: !failed && !commandOnly },
      ...removalLog.value,
    ].slice(0, 10)
    activity.record({
      source: 'user',
      intent: `移除已应用功能：${item.name}`,
      requestedValue: item.id,
      outcome: failed ? 'failed' : commandOnly ? 'accepted' : 'applied',
      reversible: item.reversibility,
    })
    return !failed
  }

  /** 页内「全部还原」：按注册表声明的顺序逐项执行，逐项给结果 */
  async function restoreAll(): Promise<{
    total: number
    confirmed: number
    unconfirmed: number
    failed: number
  }> {
    const plan = restorePlan.value
    const result = { total: plan.length, confirmed: 0, unconfirmed: 0, failed: 0 }
    if (removing.value) return result
    removing.value = true
    try {
      for (const item of plan) {
        const ok = await removeOne(item)
        const entry = removalLog.value.find((e) => e.id === item.id)
        if (!ok) result.failed += 1
        else if (entry?.ok) result.confirmed += 1
        else result.unconfirmed += 1
      }
      await refresh()
    } finally {
      removing.value = false
    }
    return result
  }

  return {
    rows,
    verdicts,
    summary,
    intents,
    observed,
    loading,
    removing,
    removalLog,
    restorePlan,
    composite,
    refresh,
    removeOne,
    restoreAll,
  }
}
