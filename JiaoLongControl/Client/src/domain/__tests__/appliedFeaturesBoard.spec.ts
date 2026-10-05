import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AppliedFeaturesBoard from '@/components/common/AppliedFeaturesBoard.vue'
import { APPLIED_FEATURES } from '@/domain/appliedFeatures'

/**
 * 看板组件：注册表驱动（行数 === 注册表长度）+ 反向验证。
 *
 * 反向验证（本轮验收要求，可复现）：让 fan.curve 的回读 getter（AutoFan.IsRunning）失败，
 * 该行必须显示「读取失败」，点「移除」后**不得**出现「已移除/已生效」。
 * 复现：`npm run test -- -t "反向验证"`。
 */

/** 注入到宿主桥的假数据（键 = bridge.ts 里 raw.* 的真实命名空间，如 AutoFanControl 包装层调用 raw.AutoFan） */
const RAW_DATA: Record<string, unknown> = {
  'CPU.GetCustomMode': true,
  'Power.GetCPUMaxFrequency': { ac: 5400, dc: 5400 },
  'Power.GetTurboEnabled': { ac: true, dc: true },
  'AutoFan.IsRunning': true,
  'LogoLight.Get': 1,
  'AutoStart.IsEnabled': true,
  'PerformanceMode.Get': 2,
  'GPU.Get': 1,
  'NvidiaGpu.GetClockOffsets': { CoreMhz: 0, MemoryMhz: 0 },
  'NvidiaGpu.GetVoltageBoostPercent': 0,
  'NvidiaGpu.GetGpuPowerPolicy': {
    CurrentWatts: 140,
    MinWatts: 80,
    DefaultWatts: 140,
    MaxWatts: 160,
  },
  'ConfigCtrl.GetConfig': {
    Version: 'test',
    App: {
      BootMinimized: false,
      BootAdvancedFanControlSystem: true,
      BootAdvancedCPUSystem: true,
      BootAdvancedGPUSystem: true,
      BootSetRyzenSumCurveOptimizerAll: false,
      Theme: 'dark',
      SyncWindowsPowerPlan: true,
      HotkeyEnabled: true,
    },
    Cpu: {
      Custom: {
        CpuLongPower: 55,
        CpuShortPower: 80,
        CpuTempWall: 90,
        CpuMaxFrequency: 5400,
        CpuTurbo: true,
      },
    },
    Gpu: {
      GpuClock: 1800,
      MemoryClock: 8000,
      PowerLimit: 140,
      CoreClockOffset: 0,
      MemoryClockOffset: 0,
      VoltageBoostPercent: 0,
    },
    Fan: {
      Enabled: true,
      FanCurveMerge: true,
      TempAttackS: 5,
      TempReleaseS: 60,
      TempHysteresisC: 5,
      CpuFanCurve: [],
      GpuFanCurve: [],
    },
    Smu: { StapmLimit: 54, CurveOptimizerAll: -15, PerCoreCurve: [-15], PerCoreOcClk: [0] },
    Safety: { ThermalWatchdogEnabled: true },
    Log: { Level: 'INFO', CommandDebug: false },
  },
}

let shouldFail: (namespace: string, method: string) => boolean = () => false
/**
 * 契约回归用（安全网，不是常态路径）：把某方法伪装成**旧契约形状** ——
 * `Success=false` 但 `Data` 里仍带着业务取值。后端 `AutoFanControl.IsRunning()` 曾把运行态
 * **同时**当 `Success` 与 `Data` 传出去（于是没在跑 = `Success:false` + `Data:false`）。
 * 契约见 v4 §14.11：`Success` 只表达"这次查询/命令本身成不成功"，取值在 `Data`。
 */
let legacyContractOn: (namespace: string, method: string) => boolean = () => false
/** 回读直接抛异常：让 `toJson()` 抛 → `call()` 返回 rejected promise（宿主 IPC 异常的形态） */
let throwOn: (namespace: string, method: string) => boolean = () => false
/** 宿主被真正调用到的方法（按 namespace.method 记录，用于断言「移除到底下发了什么」） */
let hostCalls: string[] = []

function hostOk(data: unknown) {
  return {
    toJson: () =>
      JSON.stringify({ Success: true, Message: 'ok', Data: data === undefined ? null : data }),
  }
}

function hostFail(message: string) {
  return { toJson: () => JSON.stringify({ Success: false, Message: message, Data: null }) }
}

beforeAll(() => {
  const makeNamespace = (namespace: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined
          return () => {
            hostCalls.push(`${namespace}.${method}`)
            if (throwOn(namespace, method)) {
              return {
                toJson: () => {
                  throw new Error('注入的宿主异常')
                },
              }
            }
            if (legacyContractOn(namespace, method)) {
              return {
                toJson: () =>
                  JSON.stringify({
                    Success: false,
                    Message: '旧契约形状',
                    Data: RAW_DATA[`${namespace}.${method}`],
                  }),
              }
            }
            if (shouldFail(namespace, method)) return hostFail('注入的读取失败')
            return hostOk(RAW_DATA[`${namespace}.${method}`])
          }
        },
      },
    )
  const bridge = new Proxy(
    {},
    {
      get: (_target, namespace) => {
        if (typeof namespace !== 'string' || namespace === 'then') return undefined
        return makeNamespace(namespace)
      },
    },
  )
  Object.defineProperty(window, 'chrome', {
    configurable: true,
    writable: true,
    value: {
      webview: {
        hostObjects: { bridge },
        postMessage: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    },
  })
})

beforeEach(() => {
  shouldFail = () => false
  legacyContractOn = () => false
  throwOn = () => false
  hostCalls = []
})

function mountBoard(): VueWrapper {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(AppliedFeaturesBoard, { global: { plugins: [pinia] } })
}

function rowOf(wrapper: VueWrapper, name: string) {
  const row = wrapper
    .findAll('[data-testid="applied-feature-row"]')
    .find((w) => w.text().includes(name))
  if (!row) throw new Error(`看板里没有这一行：${name}`)
  return row
}

describe('已应用功能看板', () => {
  it('渲染行数 === 注册表长度（注册表驱动，不是硬编码清单）', async () => {
    const wrapper = mountBoard()
    await flushPromises()
    const rows = wrapper.findAll('[data-testid="applied-feature-row"]')
    expect(rows.length).toBe(APPLIED_FEATURES.length)
    expect(APPLIED_FEATURES.length).toBeGreaterThan(30)
  })

  it('每行都有意图栏与实测栏（两栏语义）', async () => {
    const wrapper = mountBoard()
    await flushPromises()
    const row = rowOf(wrapper, '应用内风扇曲线接管')
    const cells = row.findAll('td')
    expect(cells[1]!.text()).toContain('Fan.Enabled')
    expect(cells[2]!.text()).toContain('AutoFanControl.IsRunning()')
    // 该行配置 true + 回读 true → 已生效
    expect(cells[3]!.text()).toContain('已生效')
  })

  it('意图栏绑到配置的值：换一组 mockConfig，意图文本必须随之改变（写死就红）', async () => {
    const base = RAW_DATA['ConfigCtrl.GetConfig'] as {
      Fan: Record<string, unknown>
      Cpu: { Custom: Record<string, unknown> }
    }

    const first = mountBoard()
    await flushPromises()
    const intentA = rowOf(first, '应用内风扇曲线接管').findAll('td')[1]!.text()
    expect(intentA).toContain('Fan.Enabled = true')
    expect(rowOf(first, '长时功耗 SPL').findAll('td')[1]!.text()).toContain(
      'Cpu.Custom.CpuLongPower = 55',
    )

    RAW_DATA['ConfigCtrl.GetConfig'] = {
      ...base,
      Fan: { ...base.Fan, Enabled: false },
      Cpu: { Custom: { ...base.Cpu.Custom, CpuLongPower: 77 } },
    }
    try {
      const second = mountBoard()
      await flushPromises()
      const intentB = rowOf(second, '应用内风扇曲线接管').findAll('td')[1]!.text()
      expect(intentB).toContain('Fan.Enabled = false')
      expect(intentB).not.toBe(intentA)
      expect(rowOf(second, '长时功耗 SPL').findAll('td')[1]!.text()).toContain(
        'Cpu.Custom.CpuLongPower = 77',
      )
    } finally {
      RAW_DATA['ConfigCtrl.GetConfig'] = base
    }
  })

  it('不可回读行的原因只渲染一处，不在「实测」与「状态」两栏重复同一段长文', async () => {
    const wrapper = mountBoard()
    await flushPromises()
    const item = APPLIED_FEATURES.find((f) => f.id === 'cpu.long-power')!
    const text = rowOf(wrapper, item.name).text()
    expect(text).toContain('不可回读')
    expect(text.split(item.readbackNote).length - 1, 'readbackNote 出现次数').toBe(1)
  })

  it('「全部还原」按钮逐项说明覆盖范围（aria-label = title，含覆盖项名与不覆盖原因）', async () => {
    const wrapper = mountBoard()
    await flushPromises()
    const btn = wrapper.find('.btn-restore')
    const label = btn.attributes('aria-label') ?? ''
    expect(label.length).toBeGreaterThan(20)
    expect(label).toBe(btn.attributes('title'))
    expect(label).toMatch(/本次覆盖 \d+ 项：/)
    expect(label).toContain('应用内风扇曲线接管') // 本次覆盖到的项，按名字列出
    expect(label).toContain('非本软件下发') // 不覆盖的原因（GPU 偏移/灯效模式）
    expect(label).toContain('核心频率偏移')
    expect(wrapper.find('[data-testid="restore-scope"]').text()).toBe(label)
    // 不是只有一个数字：按钮文字仍是「全部还原（N 项）」，覆盖范围另有说明
    expect(btn.text()).toMatch(/全部还原（\d+ 项）/)
  })

  it('不可回读的项显示原因而不是移除按钮', async () => {
    const wrapper = mountBoard()
    await flushPromises()
    const row = rowOf(wrapper, '长时功耗 SPL')
    expect(row.text()).toContain('不可回读')
    expect(row.text()).toContain('无法还原')
    expect(row.find('button').exists()).toBe(false)
  })

  it('不可回读的行没有移除按钮：只给原因，不给一个永远不会成功的按钮', async () => {
    // 2026-10-06：本条原为「command-only 的行（键盘颜色）」，该行随灯效页删除。
    // 现注册表里可移除的项全部是 removalConfirm=readback（command-only 分支已无行消费，
    // 只留作后续新增项的口径）。这里钉住硬规则的反面：不可回读 → 不给按钮。
    const wrapper = mountBoard()
    await flushPromises()
    for (const name of ['风扇曲线合并', '长时功耗 SPL']) {
      const row = rowOf(wrapper, name)
      expect(row.text()).toContain('不可回读')
      expect(row.text()).toContain('无法还原')
      expect(row.find('button').exists(), name).toBe(false)
    }
    // 可移除的行必须写明结果要被独立重读确认，而不是"点一下就算成功"
    expect(rowOf(wrapper, '应用内风扇曲线接管').find('button').attributes('title')).toContain(
      '写后独立重读',
    )
  })

  it('配置步骤保存失败 → 先算后提交：意图栏不显示没落盘的值', async () => {
    const base = RAW_DATA['ConfigCtrl.GetConfig'] as { Fan: Record<string, unknown> }
    RAW_DATA['ConfigCtrl.GetConfig'] = { ...base, Fan: { ...base.Fan, Enabled: true } }
    shouldFail = (namespace, method) => namespace === 'ConfigCtrl' && method === 'SetConfig'
    try {
      const wrapper = mountBoard()
      await flushPromises()
      const before = rowOf(wrapper, '应用内风扇曲线接管').findAll('td')[1]!.text()
      expect(before).toContain('Fan.Enabled = true')

      await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
      await flushPromises()

      // 保存失败 → 回滚显示值 + 重拉配置；绝不让意图栏显示一个没落盘的值
      const after = rowOf(wrapper, '应用内风扇曲线接管').findAll('td')[1]!.text()
      expect(after).toBe(before)
      expect(wrapper.find('.board-result').text()).toContain('未确认移除成功')
    } finally {
      RAW_DATA['ConfigCtrl.GetConfig'] = base
      shouldFail = () => false
    }
  })

  it('反向验证：getter 失败 → 该行显示读取失败，移除不得报「已移除」', async () => {
    shouldFail = (namespace, method) => namespace === 'AutoFan' && method === 'IsRunning'
    const wrapper = mountBoard()
    await flushPromises()

    const row = rowOf(wrapper, '应用内风扇曲线接管')
    const before = row.text().replace(/\s+/g, ' ')
    expect(before).toContain('读取失败')
    expect(before).not.toContain('已生效')
    expect(row.find('button').exists()).toBe(true) // 该行本可移除

    await row.find('button').trigger('click')
    await flushPromises()

    const whole = wrapper.text()
    const steps = wrapper.find('.steps').exists() ? wrapper.find('.steps').text() : '(无步骤)'
    const result = wrapper.find('.board-result').exists()
      ? wrapper.find('.board-result').text()
      : '(无结果)'
    console.log(`[反向验证] 行状态: ${before}`)
    console.log(`[反向验证] 移除步骤: ${steps.replace(/\s+/g, ' ')}`)
    console.log(`[反向验证] 移除结论: ${result.replace(/\s+/g, ' ')}`)

    expect(whole).not.toContain('已移除')
    expect(rowOf(wrapper, '应用内风扇曲线接管').text()).toContain('读取失败')
    // 复合写入把"回读不一致"记为 failed，而不是成功
    expect(steps).toContain('失败')
  })

  it('移除 fan.curve 会依次下发停服务 + 撤手动掩码（交还 EC 缺一不可）', async () => {
    const wrapper = mountBoard()
    await flushPromises()

    hostCalls = []
    await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
    await flushPromises()

    // 掩码必须先于失败判据被撤掉：这一步以前整个缺失，界面却是绿的
    const removalCalls = hostCalls.filter((c) => c !== 'AutoFan.IsRunning')
    expect(removalCalls).toEqual(['AutoFan.Stop', 'Fan.RemoveFanSpeed', 'ConfigCtrl.SetConfig'])
    const steps = wrapper.find('.steps').text().replace(/\s+/g, ' ')
    expect(steps).toContain('移除转速设置（撤掉手动掩码，EC 温控重新生效）')
    expect(steps).toContain('关闭「开机自动拉起曲线」意图并保存配置')
  })

  it('撤手动掩码失败 → 中止后续步骤，界面绝不报「已移除」', async () => {
    shouldFail = (namespace, method) => namespace === 'Fan' && method === 'RemoveFanSpeed'
    const wrapper = mountBoard()
    await flushPromises()

    await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
    await flushPromises()

    const steps = wrapper.find('.steps').text().replace(/\s+/g, ' ')
    const result = wrapper.find('.board-result').text()
    console.log(`[掩码失败] 移除步骤: ${steps}`)
    console.log(`[掩码失败] 移除结论: ${result.replace(/\s+/g, ' ')}`)

    expect(steps).toContain('失败')
    // 第三步没执行：意图不能显示成"已清掉"
    expect(steps).not.toContain('关闭「开机自动拉起曲线」意图并保存配置')
    expect(result).toContain('未确认移除成功')
    expect(wrapper.text()).not.toContain('已移除并回读确认')
  })

  it('FIX-1：Stop 报失败但回读 IsRunning=false → 视为已停，照常撤掩码 + 落盘', async () => {
    // 后端历史上「真停成功」也会报 Success=false。只看返回值 → 第一步判 failed →
    // 撤掩码与落盘永不执行，而界面只说「未确认移除成功」（EC 温控接不回来）。
    const base = RAW_DATA['AutoFan.IsRunning']
    RAW_DATA['AutoFan.IsRunning'] = false
    shouldFail = (namespace, method) => namespace === 'AutoFan' && method === 'Stop'
    try {
      const wrapper = mountBoard()
      await flushPromises()

      hostCalls = []
      await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
      await flushPromises()

      const removalCalls = hostCalls.filter((c) => c !== 'AutoFan.IsRunning')
      expect(removalCalls).toEqual(['AutoFan.Stop', 'Fan.RemoveFanSpeed', 'ConfigCtrl.SetConfig'])
      const steps = wrapper.find('.steps').text().replace(/\s+/g, ' ')
      // 三步全绿（CompositeSteps 只渲染状态，逐项 message 在 composable 里，见曲线页用例）
      expect(steps).not.toContain('失败')
      expect(steps).toContain('停止应用内曲线服务成功')
      // 判据来自回读：三步都跑完，最终结论是"已移除并回读确认"
      expect(wrapper.find('.board-result').text()).toContain('已移除并回读确认')
    } finally {
      RAW_DATA['AutoFan.IsRunning'] = base
      shouldFail = () => false
    }
  })

  it('FIX-1：Stop 报失败且回读确认仍在跑 → 中止后续步骤（不撤掩码、不落盘）', async () => {
    shouldFail = (namespace, method) => namespace === 'AutoFan' && method === 'Stop'
    try {
      const wrapper = mountBoard()
      await flushPromises()

      hostCalls = []
      await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
      await flushPromises()

      expect(hostCalls).toContain('AutoFan.Stop')
      // 没确认停掉就撤掩码，曲线下一拍会把掩码写回来 —— 后两步一个都不许发
      expect(hostCalls).not.toContain('Fan.RemoveFanSpeed')
      expect(hostCalls).not.toContain('ConfigCtrl.SetConfig')
      const steps = wrapper.find('.steps').text().replace(/\s+/g, ' ')
      expect(steps).toContain('独立回读 AutoFanControl.IsRunning() 确认仍在运行')
      expect(wrapper.find('.board-result').text()).toContain('未确认移除成功')
      expect(wrapper.text()).not.toContain('已移除并回读确认')
    } finally {
      shouldFail = () => false
    }
  })

  it('FIX-1：回读本身失败 → 按「未确认已停止」处理，中止且不撤掩码（unknown ≠ stopped）', async () => {
    shouldFail = (namespace, method) =>
      namespace === 'AutoFan' && (method === 'Stop' || method === 'IsRunning')
    try {
      const wrapper = mountBoard()
      await flushPromises()

      hostCalls = []
      await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
      await flushPromises()

      expect(hostCalls).not.toContain('Fan.RemoveFanSpeed')
      expect(hostCalls).not.toContain('ConfigCtrl.SetConfig')
      const steps = wrapper.find('.steps').text().replace(/\s+/g, ' ')
      expect(steps).toContain('回读无数据，未确认已停止')
      expect(wrapper.text()).not.toContain('已移除并回读确认')
    } finally {
      shouldFail = () => false
    }
  })

  it('契约回归：IsRunning 返回 Success=false（契约被写反）→ 判读取失败，且不得撤掩码/落盘', async () => {
    // **这是防"契约再次被写反"的安全网，不是常态路径**（常态路径见上一条：Success:true + Data）。
    // 后端曾把运行态塞进 Success（没在跑 = Success:false + Data:false），而前端 readOne 以
    // `Success !== true` 判"读取失败" —— 于是看板 fan.curve 行在正常态显示读取失败（假红）。
    // 契约见 v4 §14.11：Success 只表达"这次查询本身成不成功"，运行态在 Data。
    // 万一又被写反：这次读必须算失败，Data 一个字都不采信 → 保守方向（不撤 0xB20 掩码、
    // 不落盘、不报成功），既不假绿也不拿旧契约的 Data=false 当"已停"的证据。
    legacyContractOn = (ns, m) => ns === 'AutoFan' && m === 'IsRunning'
    shouldFail = (ns, m) => ns === 'AutoFan' && m === 'Stop' // 走「Stop 报失败 → 独立回读确认」这条分支
    // 旧后端的真实形状：曲线没在跑 = Success:false **且** Data:false（同一个 bool 传了两遍）。
    // Data 必须是 false，否则这条用例不判别：拿 Data 当证据的实现照样会中止。
    const base = RAW_DATA['AutoFan.IsRunning']
    RAW_DATA['AutoFan.IsRunning'] = false
    try {
      const wrapper = mountBoard()
      await flushPromises()

      expect(rowOf(wrapper, '应用内风扇曲线接管').text().replace(/\s+/g, ' ')).toContain('读取失败')

      hostCalls = []
      await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
      await flushPromises()

      expect(hostCalls).toContain('AutoFan.Stop')
      // Data=false 看着像"没在跑"，但这次读本身是失败的 —— 没有证据就不许撤掩码
      expect(hostCalls).not.toContain('Fan.RemoveFanSpeed')
      expect(hostCalls).not.toContain('ConfigCtrl.SetConfig')
      // 保守分支：读失败 ≠ 已停止（不能拿旧契约的 Data=false 当停止证据）
      expect(wrapper.find('.steps').text().replace(/\s+/g, ' ')).toContain('未确认已停止')
      expect(wrapper.find('.board-result').text()).toContain('未确认移除成功')
      expect(wrapper.text()).not.toContain('已移除并回读确认')
    } finally {
      RAW_DATA['AutoFan.IsRunning'] = base
      legacyContractOn = () => false
      shouldFail = () => false
    }
  })

  it('回读抛异常（reject）→ 行显示读取失败，移除中止且不撤掩码、不报成功', async () => {
    // 补 catch 分支的覆盖：以前只有 hostFail（`{Success:false, Data:null}`），
    // 把 `catch { return stopped: true }` 这类危险实现写进去，一条用例都不会红。
    shouldFail = (ns, m) => ns === 'AutoFan' && m === 'Stop'
    throwOn = (ns, m) => ns === 'AutoFan' && m === 'IsRunning'
    try {
      const wrapper = mountBoard()
      await flushPromises()

      // 读不到 ≠ 没在跑：行必须显示读取失败，不是"未生效"
      const before = rowOf(wrapper, '应用内风扇曲线接管').text().replace(/\s+/g, ' ')
      expect(before).toContain('读取失败')
      expect(before).not.toContain('已生效')

      hostCalls = []
      await rowOf(wrapper, '应用内风扇曲线接管').find('button').trigger('click')
      await flushPromises()

      expect(hostCalls).not.toContain('Fan.RemoveFanSpeed')
      expect(hostCalls).not.toContain('ConfigCtrl.SetConfig')
      expect(wrapper.find('.steps').text().replace(/\s+/g, ' ')).toContain('回读异常')
      expect(wrapper.text()).not.toContain('已移除并回读确认')
    } finally {
      throwOn = () => false
      shouldFail = () => false
    }
  })
})
