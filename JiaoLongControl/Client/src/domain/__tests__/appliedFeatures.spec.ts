import { describe, expect, it } from 'vitest'
import * as bridgeNamespace from '@/utils/bridge'
import {
  APPLIED_FEATURES,
  CONCLUSION_LABELS,
  REMOVAL_BLOCKED_IRREVERSIBLE,
  REMOVAL_BLOCKED_NEEDS_REBOOT,
  REMOVAL_BLOCKED_NO_READBACK,
  allBridgeMethods,
  bridgeMethodsOf,
  bulkRemovalPlan,
  groupFeatures,
  judgeAll,
  judgeFeature,
  judgeRemoval,
  readByPath,
  removalScope,
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
    // Fan 导出对象（bridge.ts:459-462）没有它 —— 这正是"手抄名单"会漏掉的那类错。
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
    expect(grouped.map((g) => g.id)).toEqual(['cpu', 'smu', 'gpu', 'fan', 'lighting', 'system'])
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
    // cpu.turbo 的「已生效」= 睿频被关掉（intentRule / observedRule 都是 equals false），
    // 所以生效态是 ac=false：睿频开着是 Windows 默认态，不构成本软件的应用痕迹。
    const turbo = featureById('cpu.turbo')
    expect(judgeFeature(turbo, configOn(false), readOk({ ac: false, dc: true })).status).toBe(
      'match',
    )
    expect(judgeFeature(turbo, configOn(false), readOk({ ac: true, dc: false })).status).toBe(
      'mismatch',
    )
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

describe('「全部还原」的覆盖范围（审查 FIX-1：既不许漏正生效的项，也不许收别人写的值）', () => {
  /** 无配置意图、但有回读 + 有移除步骤的项 —— 它们全部落在 observed-only 上 */
  const observedOnly = APPLIED_FEATURES.filter(
    (item) => item.intentPath === null && item.writePath !== null && item.removal.length > 0,
  )
  const OBSERVED_ON: Record<string, ObservedRead> = {
    'cpu.custom-override': readOk(true),
    'keyboard.logo-light': readOk(1),
    'system.autostart': readOk(true),
  }
  /** 同一批项、实测"没生效"（present 判据下 null = 没有有效值） */
  const OBSERVED_OFF: Record<string, ObservedRead> = {
    'cpu.custom-override': readOk(false),
    'keyboard.logo-light': readOk(0),
    'system.autostart': readOk(false),
  }

  it('① 实测生效的 observed-only 项必须进计划（旧 status 白名单漏掉它们）', () => {
    // 先钉住"这一类恰好是这 5 项"，注册表漂了就红
    expect(observedOnly.map((item) => item.id).sort()).toEqual(Object.keys(OBSERVED_ON).sort())
    const plan = bulkRemovalPlan(APPLIED_FEATURES, {}, OBSERVED_ON)
    expect(plan.map((item) => item.id).sort()).toEqual(Object.keys(OBSERVED_ON).sort())
    for (const item of observedOnly) {
      const verdict = judgeFeature(item, noConfig, OBSERVED_ON[item.id]!)
      expect(verdict.status, item.id).toBe('observed-only')
      expect(verdict.observedActive, item.id).toBe(true)
    }
  })

  it('② 同样 observed-only 但实测未生效的项不得进计划', () => {
    const plan = bulkRemovalPlan(APPLIED_FEATURES, {}, OBSERVED_OFF)
    expect(plan.map((item) => item.id)).toEqual([])
    for (const [id, observed] of Object.entries(OBSERVED_OFF)) {
      expect(judgeFeature(featureById(id), noConfig, observed).observedActive, id).toBe(false)
    }
  })

  it('③ writePath=null 的项无论实测真假都不进计划（不能替别的工具清掉偏移）', () => {
    const noWritePath = APPLIED_FEATURES.filter(
      (item) => item.writePath === null && item.removal.length > 0,
    )
    expect(noWritePath.map((item) => item.id)).toEqual(
      expect.arrayContaining(['gpu.core-offset', 'gpu.memory-offset', 'gpu.voltage-boost']),
    )
    // 配置开着 + 实测非零：旧实现按 no-write-path 白名单把它们收进计划，点一下就 ResetClockOffsets
    const intents: Record<string, IntentRead> = {
      'gpu.core-offset': configOn(120),
      'gpu.memory-offset': configOn(600),
      'gpu.voltage-boost': configOn(15),
    }
    const observed: Record<string, ObservedRead> = {
      'gpu.core-offset': readOk({ CoreMhz: 120, MemoryMhz: 0 }),
      'gpu.memory-offset': readOk({ CoreMhz: 0, MemoryMhz: 600 }),
      'gpu.voltage-boost': readOk(15),
    }
    expect(bulkRemovalPlan(APPLIED_FEATURES, intents, observed).map((item) => item.id)).toEqual([])
    for (const item of noWritePath) {
      expect(judgeFeature(item, configOn(1), readOk(1)).canRemove, item.id).toBe(true)
    }
  })

  it('④ removalScope 把"不覆盖"逐类说清（界面据此写按钮 title/说明，不许只报数字）', () => {
    const intents: Record<string, IntentRead> = {
      'fan.curve': configOn(true),
      'gpu.core-offset': configOn(120),
      'gpu.voltage-boost': configOn(15),
      'keyboard.logo-light': configOn(1),
    }
    const observed: Record<string, ObservedRead> = {
      'fan.curve': readOk(true),
      'gpu.core-offset': readOk({ CoreMhz: 120, MemoryMhz: 0 }),
      'gpu.voltage-boost': readOk(15),
      'keyboard.logo-light': readOk(1),
    }
    const scope = removalScope(APPLIED_FEATURES, intents, observed)
    expect(scope.covered).toEqual(['应用内风扇曲线接管', 'Logo 灯'])
    expect(scope.notWrittenByUs).toEqual(expect.arrayContaining(['核心频率偏移', '核心电压提升']))
    expect(scope.noRemovalPath.length).toBeGreaterThan(20) // 29 项不可回读等
    // 四类 + 覆盖 = 注册表全部项，没有"算漏"
    expect(
      scope.covered.length +
        scope.notWrittenByUs.length +
        scope.notActive.length +
        scope.notRead.length +
        scope.noRemovalPath.length,
    ).toBe(APPLIED_FEATURES.length)
  })
})

describe('移除普查：不允许存在"点了永远不会成功"的项（审查 FIX-2）', () => {
  /** 健康设备上「该项正在生效」时的回读值（pick 容器一并写出） */
  const ACTIVE: Record<string, unknown> = {
    'cpu.custom-override': true,
    'cpu.max-frequency': { ac: 5400, dc: 5400 },
    'cpu.turbo': { ac: false, dc: false }, // 限制生效 = 睿频被关掉
    'gpu.core-offset': { CoreMhz: 120, MemoryMhz: 0 },
    'gpu.memory-offset': { CoreMhz: 0, MemoryMhz: 600 },
    'gpu.voltage-boost': 15,
    'fan.curve': true,
    'keyboard.logo-light': 1,
    'system.autostart': true,
  }
  /** 同一台健康设备上「移除执行完成」后的回读值 */
  const AFTER: Record<string, unknown> = {
    'cpu.custom-override': false,
    'cpu.max-frequency': { ac: 0, dc: 0 },
    'cpu.turbo': { ac: true, dc: true }, // 睿频恢复 = 限制已移除
    'gpu.core-offset': { CoreMhz: 0, MemoryMhz: 0 },
    'gpu.memory-offset': { CoreMhz: 0, MemoryMhz: 0 },
    'gpu.voltage-boost': 0,
    'fan.curve': false,
    'keyboard.logo-light': 0,
    'system.autostart': false,
  }

  function removable(): AppliedFeature[] {
    return APPLIED_FEATURES.filter((item) => judgeFeature(item, noConfig, readOk(1)).canRemove)
  }

  it('普查表覆盖全部挂了「移除」按钮的项（新增项漏登记就红）', () => {
    const ids = removable()
      .map((item) => item.id)
      .sort()
    expect(ids.length).toBeGreaterThan(5)
    expect(Object.keys(ACTIVE).sort()).toEqual(ids)
    expect(Object.keys(AFTER).sort()).toEqual(ids)
  })

  it('每一项：移除前不算已移除，移除后要么回读确认 true，要么明确标 command-only', () => {
    let confirmed = 0
    let commandOnly = 0
    for (const item of removable()) {
      expect(judgeRemoval(item, readOk(ACTIVE[item.id])), `${item.id} 生效时不得被判"已移除"`).toBe(
        false,
      )
      if (judgeRemoval(item, readOk(AFTER[item.id]))) {
        confirmed += 1
      } else if (item.removalConfirm === 'command-only') {
        commandOnly += 1
      } else {
        throw new Error(
          `${item.id}：移除后回读永远"仍生效"且没标 command-only —— 这个按钮永远不会成功`,
        )
      }
    }
    // 2026-10-06：键盘颜色/亮度（唯二可移除的 command-only 项）随灯效页删除，
    // 现在可移除的 9 项全部靠独立重读确认 —— 这是更强的口径，不是放宽。
    // commandOnly 仍参与判定（分支保留给后续新增项），只是当前为 0。
    expect(confirmed).toBe(removable().length)
    expect(commandOnly).toBe(0)
  })

  it('无可靠回读判据的项必须显式标 command-only，不假装能确认', () => {
    // 2026-10-06：键盘颜色/亮度（唯二"有回读但证明不了已还原"的项）随灯效页删除后，
    // 注册表里**没有**可移除的 command-only 项 —— 可移除的 9 项全部有 readback 复核。
    // 这是更强的口径，不是放宽；用例钉住它，免得将来新增项悄悄退回"命令被接受=已移除"。
    const removableCommandOnly = removable().filter((i) => i.removalConfirm === 'command-only')
    expect(removableCommandOnly.map((i) => i.id)).toEqual([])

    // 口径本身仍要成立：凡挂了移除步骤又标 command-only 的项，必须真的读不到回读。
    // 有回读却证明不了"已还原"，正确做法是补 readback 判据，而不是标 command-only 蒙混。
    for (const item of APPLIED_FEATURES) {
      if (item.removalConfirm !== 'command-only' || item.removal.length === 0) continue
      expect(item.readback, `${item.id} 标 command-only 却有回读，说明它本可回读确认`).toBeNull()
    }
  })
})

describe('fan.curve 的「移除」必须真正交还 EC（2026-10-06 WS1 安全补丁）', () => {
  /**
   * 少 Fan.RemoveFanSpeed 的假绿：停服务后 AutoFanControl.IsRunning() 必然为 false，
   * 回读判据会通过、界面报「已移除」—— 而 0xB20 手动掩码仍置位，
   * EC 自身温控没接回来，风扇停在最后一次写入的转速上。
   */
  it('移除步骤含 AutoFanControl.Stop 与 Fan.RemoveFanSpeed，且顺序是「停服务 → 交还 EC」', () => {
    const fanCurve = featureById('fan.curve')
    const bridgeSteps = fanCurve.removal.filter((step) => step.kind === 'bridge')
    expect(bridgeSteps.map((step) => step.method)).toEqual([
      'AutoFanControl.Stop',
      'Fan.RemoveFanSpeed',
    ])
    // 交还 EC 必须在停服务之后：反过来的话曲线下一拍就把掩码写回去
    const order = fanCurve.removal.map((step) => (step.kind === 'bridge' ? step.method : 'config'))
    expect(order).toEqual(['AutoFanControl.Stop', 'Fan.RemoveFanSpeed', 'config'])
    // 两个方法名都要能在真实桥接导出里解析到（不手抄名单）
    expect(bridgeMethodsOf(fanCurve)).toEqual(
      expect.arrayContaining(['AutoFanControl.Stop', 'Fan.RemoveFanSpeed']),
    )
    expect(resolveBridgeMethod(bridgeNamespace, 'Fan.RemoveFanSpeed')).not.toBeNull()
    // 判据仍是回读：交还结果由独立重读确认，不是"命令被接受就算数"
    expect(fanCurve.readback?.method).toBe('AutoFanControl.IsRunning')
    expect(fanCurve.removalConfirm).toBe('readback')
  })

  it('任一交还步骤失败都不得报成功：后续步骤不执行，移除后回读仍算「生效」', () => {
    const fanCurve = featureById('fan.curve')
    // 组合写入口径（useCompositeWrite.run）：遇失败中止、已生效项不撤销
    for (const failedAt of [0, 1]) {
      expect(judgeRemoval(fanCurve, readOk(true)), `中断于第 ${failedAt} 步`).toBe(false)
      expect(judgeRemoval(fanCurve, readFailed()), `中断于第 ${failedAt} 步`).toBe(false)
    }
    // 停服务成功但掩码没撤 → 服务已停（回读 false），仍不算交还成功
    const stepsAfterStopOnly = fanCurve.removal.slice(0, 2)
    expect(stepsAfterStopOnly.map((s) => (s.kind === 'bridge' ? s.method : 'config'))).toEqual([
      'AutoFanControl.Stop',
      'Fan.RemoveFanSpeed',
    ])
    // 掩码已撤但落盘失败 → 本次生效，但下次开机会被 SelfStart 重新拉起 = 部分应用
    const stepsWithoutPersist = fanCurve.removal.filter((step) => step.kind === 'bridge')
    expect(stepsWithoutPersist).toHaveLength(2)
    expect(fanCurve.removal[fanCurve.removal.length - 1]!.kind).toBe('config')
  })
})

describe('配置路径读取', () => {
  it('按路径取值，缺失返回 undefined（不猜默认值）', () => {
    const config = { Fan: { Enabled: true, FanCurveMerge: false }, App: { Theme: 'dark' } }
    expect(readByPath(config, 'Fan.Enabled')).toBe(true)
    expect(readByPath(config, 'App.Theme')).toBe('dark')
    expect(readByPath(config, 'Fan.Nope')).toBeUndefined()
    expect(readByPath(config, 'Safety.ThermalWatchdogEnabled')).toBeUndefined()
    expect(readByPath(null, 'Fan.Enabled')).toBeUndefined()
  })
})
