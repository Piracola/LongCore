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
  removalScope,
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
  // Logo 灯走 EC 的 Ambientlight 命令(15)，即 WMI 通道
  lighting: 'wmi',
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

  /** 覆盖范围（覆盖哪些 / 不覆盖哪些、各为什么）——界面必须逐类说清，不许只报一个数字 */
  const scope = computed(() => removalScope(APPLIED_FEATURES, intents.value, observed.value))

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

  /**
   * 同一轮刷新的在途去重（2026-10-05 审查 FIX-6）：一次刷新并发 17 个 getter，
   * 反复点「重新读取」会把在途请求叠加（本仓库有过无上界在途请求把宿主卡死的 P0，v4 §4.2）。
   * 不引入新机制：按钮在 `loading` 期间已禁用，这里再挡住程序化调用。
   */
  let inflight: Promise<void> | null = null

  async function refresh(): Promise<void> {
    if (inflight) return inflight
    loading.value = true
    inflight = (async () => {
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
        inflight = null
      }
    })()
    return inflight
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
            if (res?.Success === true) return { accepted: true, message: res?.Message }
            // 命令报失败 ≠ 没生效（v4 §8.4）：真停成功的判据是写后独立重读。
            // 但**只有在回读明确读到「已停」时才继续**：没有证据就往下走，
            // 下一步撤掉的 0xB20 手动掩码会被曲线下一拍写回来（AGENTS.md 风扇控制边界）。
            if (!step.confirmStoppedBy) return { accepted: false, message: res?.Message }
            const read = resolveBridgeMethod(bridge, step.confirmStoppedBy)
            if (!read) throw new Error(`桥接方法不存在：${step.confirmStoppedBy}`)
            let observed: unknown
            try {
              // 契约（v4 §14.11，2026-10-06 起）：确认用的 getter 恒 Success=true，运行态在 Data。
              // Success !== true 表示这次读本身失败（或契约又被写反）——此时 Data 一个字都不采信，
              // 按"未确认已停止"中止：没有证据就撤 0xB20 掩码，曲线下一拍会把它写回来。
              const readback = (await read()) as RawResult | null
              observed = readback?.Success === true ? readback.Data : undefined
            } catch (err) {
              return {
                accepted: false,
                message: `${res?.Message ?? '命令报失败'}；回读异常，未确认已停止：${err instanceof Error ? err.message : '未知错误'}`,
              }
            }
            if (observed === false) {
              return {
                accepted: true,
                message: `${res?.Message ?? '命令报失败'}；独立回读 ${step.confirmStoppedBy}() 确认已停止`,
              }
            }
            return {
              accepted: false,
              message:
                observed === true
                  ? `${res?.Message ?? '命令报失败'}；独立回读 ${step.confirmStoppedBy}() 确认仍在运行`
                  : `${res?.Message ?? '命令报失败'}；回读无数据，未确认已停止`,
            }
          },
        }
      }
      return {
        label: step.label,
        transport: 'config',
        requestedValue: step.value,
        run: async () => {
          const current = configStore.config
          if (!current) return { accepted: false, message: '配置未加载' }
          // 先算后提交（2026-10-05 审查 FIX-5）：改的是克隆副本，保存成功才让共享对象变成新值。
          // 原地改共享对象再保存，一旦保存失败，意图栏会显示一个**没落盘**的值。
          const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>
          const path = step.path.split('.')
          let node = next
          for (let i = 0; i < path.length - 1; i++) {
            const key = path[i] ?? ''
            if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
            node = node[key] as Record<string, unknown>
          }
          node[path[path.length - 1] ?? ''] = step.value
          configStore.config = next as typeof current
          const res = (await configStore.saveConfig()) as RawResult | undefined
          if (res?.Success === true) return { accepted: true, message: res.Message }
          // 保存失败：回滚显示值，再强制重拉一次配置（以磁盘为准），不留"没落盘的值"
          configStore.config = current
          await configStore.refresh()
          return { accepted: false, message: res?.Message ?? '配置保存失败，已回滚为磁盘上的值' }
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
        ? '命令已接受 · 仅命令确认，未确认已恢复（该项没有能证明「已还原」的回读判据）'
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
    scope,
    composite,
    refresh,
    removeOne,
    restoreAll,
  }
}
