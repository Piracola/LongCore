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
  'Fan.GetFanSpeed': { CPUFanSpeed: 2800, GPUFanSpeed: 2100 },
  'Keyboard.GetColor': { red: 138, green: 43, blue: 226 },
  'Keyboard.GetLightBrightness': 2,
  'Keyboard.GetMode': 2,
  'KeyboardGradient.IsRunning': false,
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
      BootKeyboardGradient: false,
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
      ManualFanSpeed: 2800,
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

  it('不可回读的项显示原因而不是移除按钮', async () => {
    const wrapper = mountBoard()
    await flushPromises()
    const row = rowOf(wrapper, '长时功耗 SPL')
    expect(row.text()).toContain('不可回读')
    expect(row.text()).toContain('无法还原')
    expect(row.find('button').exists()).toBe(false)
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
})
