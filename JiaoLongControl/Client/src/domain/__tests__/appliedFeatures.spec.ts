import { describe, expect, it } from 'vitest'
import * as bridgeNamespace from '@/utils/bridge'
import {
  APPLIED_FEATURES,
  CONCLUSION_LABELS,
  REMOVAL_BLOCKED_IRREVERSIBLE,
  REMOVAL_BLOCKED_NEEDS_REBOOT,
  REMOVAL_BLOCKED_NO_READBACK,
  allBridgeMethods,
  bulkRemovalPlan,
  groupFeatures,
  judgeAll,
  judgeFeature,
  judgeRemoval,
  readByPath,
  resolveBridgeMethod,
  type AppliedFeature,
  type IntentRead,
  type ObservedRead,
} from '@/domain/appliedFeatures'

/**
 * 已应用功能注册表：注册表自身的完整性 + 判定函数的纯逻辑。
 * 这些用例不需要 DOM —— 组件只负责画（data/render 分离）。
 */

const configOn = (value: number | string | boolean): IntentRead => ({
  configLoaded: true,
  found: true,
  value,
})
const noConfig: IntentRead = { configLoaded: false, found: false, value: null }
const readOk = (value: unknown): ObservedRead => ({ state: 'ok', value, message: null })
const readFailed = (message = '桥接调用超时'): ObservedRead => ({
  state: 'error',
  value: null,
  message,
})

function featureById(id: string): AppliedFeature {
  const hit = APPLIED_FEATURES.find((item) => item.id === id)
  if (!hit) throw new Error(`注册表里没有 ${id}`)
  return hit
}

describe('注册表：bridge 方法必须真实存在', () => {
  it('回读方法与移除步骤用到的每个方法名都能在 @/utils/bridge 的导出里解析到', () => {
    const names = allBridgeMethods()
    expect(names.length).toBeGreaterThan(10)
    const missing = names.filter((name) => resolveBridgeMethod(bridgeNamespace, name) === null)
    expect(missing).toEqual([])
  })

  it('解析器本身是判别式的：桥接里不存在的方法名必须解析为 null', () => {
    // Fan.SetMaxFanSpeedSwitch 只在 BridgeApi 类型声明里（bridge.ts:168-169），
    // Fan 导出对象（bridge.ts:456-460）没有它 —— 这正是"手抄名单"会漏掉的那类错。
    expect(resolveBridgeMethod(bridgeNamespace, 'Fan.SetMaxFanSpeedSwitch')).toBeNull()
    expect(resolveBridgeMethod(bridgeNamespace, 'Nope.NotAMethod')).toBeNull()
  })

  it('注册表自洽：id 唯一、名称/理由非空、结论合法、cut 项必须无下发路径', () => {
    const ids = APPLIED_FEATURES.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of APPLIED_FEATURES) {
      expect(item.name.length, item.id).toBeGreaterThan(0)
      expect(item.conclusionReason.length, item.id).toBeGreaterThan(0)
      expect(item.readbackNote.length, item.id).toBeGreaterThan(0)
      expect(['keep', 'review', 'cut']).toContain(item.conclusion)
      expect(Object.keys(CONCLUSION_LABELS)).toContain(item.conclusion)
      // cut = 建议移除：必须真的是"前端没人用"，否则应写 review
      if (item.conclusion === 'cut') expect(item.writePath, item.id).toBeNull()
    }
  })

  it('分组渲染覆盖全部注册项，顺序稳定', () => {
    const grouped = groupFeatures()
    expect(grouped.flatMap((g) => g.items).length).toBe(APPLIED_FEATURES.length)
    expect(grouped.map((g) => g.id)).toEqual(['cpu', 'smu', 'gpu', 'fan', 'keyboard', 'system'])
  })
})

describe('硬规则：回读方法为 null 或级别 e 的项禁止挂可点的「移除」', () => {
  it('注册表里 readback=null 的项都没有可执行移除步骤', () => {
    const unreadable = APPLIED_FEATURES.filter((item) => item.readback === null)
    expect(unreadable.length).toBeGreaterThan(0)
    for (const item of unreadable) {
      expect(item.removal, item.id).toHaveLength(0)
      const verdict = judgeFeature(item, configOn(1), readOk(1))
      expect(verdict.canRemove, item.id).toBe(false)
      expect(verdict.blockedReason, item.id).toBe(REMOVAL_BLOCKED_NO_READBACK)
      expect(verdict.status, item.id).toBe('unreadable')
    }
  })

  it('E 级项即使有回读也不给「移除」', () => {
    const synthetic: AppliedFeature = {
      ...featureById('fan.curve'),
      id: 'synthetic.irreversible',
      reversibility: 'e',
    }
    const verdict = judgeFeature(synthetic, configOn(true), readOk(true))
    expect(verdict.canRemove).toBe(false)
    expect(verdict.blockedReason).toBe(REMOVAL_BLOCKED_IRREVERSIBLE)
  })

  it('D 级（需重启）不给「移除」——写后回读不是最终状态', () => {
    const gpuMode = featureById('gpu.direct-mode')
    expect(gpuMode.reversibility).toBe('d')
    expect(gpuMode.removal).toHaveLength(0)
    const verdict = judgeFeature(gpuMode, noConfig, readOk(1))
    expect(verdict.canRemove).toBe(false)
    expect(verdict.blockedReason).toBe(REMOVAL_BLOCKED_NEEDS_REBOOT)
  })

  it('可移除的项必须同时满足：有回读 + 非 e + 有步骤', () => {
    for (const item of APPLIED_FEATURES) {
      const verdict = judgeFeature(item, configOn(1), readOk(1))
      const expected =
        item.readback !== null && item.reversibility !== 'e' && item.removal.length > 0
      expect(verdict.canRemove, item.id).toBe(expected)
    }
  })
})

describe('判定函数：同一份注册表喂不同假状态必须给出不同结论', () => {
  const fanCurve = featureById('fan.curve')

  it('配置开 + 回读开 → 已生效', () => {
    const verdict = judgeFeature(fanCurve, configOn(true), readOk(true))
    expect(verdict.status).toBe('match')
    expect(verdict.mismatch).toBe(false)
    expect(verdict.intentText).toContain('Fan.Enabled')
    expect(verdict.observedText).toContain('AutoFanControl.IsRunning()')
  })

  it('配置开 + 回读关 → 配置开着、硬件没写进去', () => {
    const verdict = judgeFeature(fanCurve, configOn(true), readOk(false))
    expect(verdict.status).toBe('mismatch')
    expect(verdict.mismatch).toBe(true)
    expect(verdict.statusLabel).toContain('硬件没写进去')
  })

  it('配置开 + 回读失败 → 读取失败，且不得回退成 true/false', () => {
    const verdict = judgeFeature(fanCurve, configOn(true), readFailed())
    expect(verdict.status).toBe('read-failed')
    expect(verdict.statusLabel).toBe('读取失败')
    expect(verdict.observedText).toContain('读取失败')
    expect(verdict.observedText).toContain('桥接调用超时')
    // 关键：读不到时不能得出任何"已生效/未生效"的值判断
    expect(verdict.observedText).not.toMatch(/= (true|false|0)\b/)
  })

  it('三种状态两两不同（防静态假看板）', () => {
    const on = judgeFeature(fanCurve, configOn(true), readOk(true))
    const missing = judgeFeature(fanCurve, configOn(true), readOk(false))
    const failed = judgeFeature(fanCurve, configOn(true), readFailed())
    expect(on).not.toEqual(missing)
    expect(missing).not.toEqual(failed)
    expect(on).not.toEqual(failed)
    expect(new Set([on.status, missing.status, failed.status]).size).toBe(3)
  })

  it('数值项按值比对：配置 5400 / 实测 3000 → 值不一致', () => {
    const maxFreq = featureById('cpu.max-frequency')
    const verdict = judgeFeature(maxFreq, configOn(5400), readOk({ ac: 3000, dc: 3000 }))
    expect(verdict.status).toBe('mismatch')
    expect(verdict.detail).toContain('值不一致')
    expect(verdict.observedText).toContain('3000')
  })

  it('回读值经 pick 取出：Power.GetTurboEnabled 只比 AC 侧', () => {
    const turbo = featureById('cpu.turbo')
    expect(judgeFeature(turbo, configOn(true), readOk({ ac: true, dc: false })).status).toBe(
      'match',
    )
    expect(judgeFeature(turbo, configOn(true), readOk({ ac: false, dc: true })).status).toBe(
      'mismatch',
    )
  })

  it('推断口径的行不谎报「硬件仍在生效」（EC 转风扇 ≠ 我们的手动值）', () => {
    const manual = featureById('fan.manual-speed')
    expect(manual.readback?.kind).toBe('inferred')
    const verdict = judgeFeature(manual, configOn(0), readOk({ CPUFanSpeed: 2800 }))
    expect(verdict.status).toBe('inactive')
    expect(verdict.inferred).toBe(true)
  })

  it('无下发路径的项不得显示成「已生效」', () => {
    const powerLimit = featureById('gpu.power-limit')
    expect(powerLimit.writePath).toBeNull()
    const verdict = judgeFeature(powerLimit, configOn(140), readOk({ CurrentWatts: 140 }))
    expect(verdict.status).toBe('no-write-path')
    expect(verdict.statusLabel).toBe('无下发路径')
  })

  it('配置字段读不到 ≠ 未启用', () => {
    const verdict = judgeFeature(fanCurve, noConfig, readOk(true))
    expect(verdict.status).toBe('intent-missing')
    expect(verdict.intentText).toContain('配置未读取')
  })

  it('配置字段不存在时显式说明，而不是当成 false', () => {
    const verdict = judgeFeature(
      fanCurve,
      { configLoaded: true, found: false, value: null },
      readOk(true),
    )
    expect(verdict.status).toBe('intent-missing')
    expect(verdict.intentText).toContain('字段不存在')
  })

  it('不可回读的项（readback=null）优先报「不可回读」，而不是"未启用"', () => {
    const watchdog = featureById('system.watchdog')
    const verdict = judgeFeature(watchdog, noConfig, readOk(true))
    expect(verdict.status).toBe('unreadable')
    expect(verdict.observedText).toContain('不可回读')
  })

  it('批量判定：未读过的项按"未读取"处理，不得凭空变成已生效', () => {
    const verdicts = judgeAll(APPLIED_FEATURES, {}, {})
    expect(verdicts).toHaveLength(APPLIED_FEATURES.length)
    for (const v of verdicts) {
      expect(['read-failed', 'unreadable']).toContain(v.status)
    }
  })
})

describe('还原计划与移除判定', () => {
  it('「全部还原」只收可移除且当前看似生效的项', () => {
    const intents: Record<string, IntentRead> = { 'fan.curve': configOn(true) }
    const observed: Record<string, ObservedRead> = { 'fan.curve': readOk(true) }
    const plan = bulkRemovalPlan(APPLIED_FEATURES, intents, observed)
    const ids = plan.map((item) => item.id)
    expect(ids).toContain('fan.curve')
    expect(ids).not.toContain('cpu.long-power') // 不可回读
    expect(ids).not.toContain('gpu.direct-mode') // D 级
    for (const item of plan) expect(item.removal.length).toBeGreaterThan(0)
  })

  it('回读失败但配置明确开着时仍列入计划（不能被一次读取失败卡住）', () => {
    const intents: Record<string, IntentRead> = { 'fan.curve': configOn(true) }
    const observed: Record<string, ObservedRead> = { 'fan.curve': readFailed() }
    expect(bulkRemovalPlan(APPLIED_FEATURES, intents, observed).map((i) => i.id)).toContain(
      'fan.curve',
    )
  })

  it('移除成功的判据是"独立重读到不再生效"，回读失败一律不算成功', () => {
    const fanCurve = featureById('fan.curve')
    expect(judgeRemoval(fanCurve, readOk(false))).toBe(true)
    expect(judgeRemoval(fanCurve, readOk(true))).toBe(false)
    expect(judgeRemoval(fanCurve, readFailed())).toBe(false)
    const offsets = featureById('gpu.core-offset')
    expect(judgeRemoval(offsets, readOk({ CoreMhz: 0, MemoryMhz: 0 }))).toBe(true)
    expect(judgeRemoval(offsets, readOk({ CoreMhz: 50, MemoryMhz: 0 }))).toBe(false)
  })
})

describe('配置路径读取', () => {
  it('按路径取值，缺失返回 undefined（不猜默认值）', () => {
    const config = { Fan: { Enabled: true, ManualFanSpeed: 0 }, App: { Theme: 'dark' } }
    expect(readByPath(config, 'Fan.Enabled')).toBe(true)
    expect(readByPath(config, 'App.Theme')).toBe('dark')
    expect(readByPath(config, 'Fan.Nope')).toBeUndefined()
    expect(readByPath(config, 'Safety.ThermalWatchdogEnabled')).toBeUndefined()
    expect(readByPath(null, 'Fan.Enabled')).toBeUndefined()
  })
})
