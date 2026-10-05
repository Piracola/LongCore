import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useFanCurveEditor } from '@/composables/useFanCurveEditor'

/**
 * 曲线页「交还 EC 固件温控」出口（2026-10-06：随「风扇」页删除挪到曲线页）。
 *
 * 这条路径是风扇唯一的 C 级出路，必须真下发、真落盘：
 * 停曲线服务 → Fan.RemoveFanSpeed → Fan.Enabled=false 落盘。
 * 只改前端内存是不够的 —— 下次开机 SelfStart 会按 BootAdvancedFanControlSystem
 * 把曲线重新拉起，用户以为交还了、实际没有。
 *
 * 反向验证：任一步失败都不得报成功，且失败后的步骤不得执行。
 */

interface Call {
  namespace: string
  method: string
}

let calls: Call[] = []
let savedConfigs: Array<Record<string, unknown>> = []
let failOn: (namespace: string, method: string) => boolean = () => false
let isRunning = true

const CONFIG = {
  Version: 'test',
  App: { Theme: 'dark' },
  Fan: { Enabled: true, FanCurveMerge: false, CpuFanCurve: [], GpuFanCurve: [] },
}

function hostOk(data: unknown) {
  return {
    toJson: () =>
      JSON.stringify({ Success: true, Message: 'ok', Data: data === undefined ? null : data }),
  }
}

function hostFail(message: string) {
  return { toJson: () => JSON.stringify({ Success: false, Message: message, Data: null }) }
}

/** 与 appliedFeaturesBoard.spec.ts 同一套宿主桩：键 = bridge.ts 里 raw.* 的真实命名空间 */
function installHost(): void {
  const makeNamespace = (namespace: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== 'string' || method === 'then') return undefined
          return (...args: unknown[]) => {
            calls.push({ namespace, method })
            if (failOn(namespace, method)) return hostFail('注入的失败')
            if (namespace === 'ConfigCtrl' && method === 'GetConfig') {
              return hostOk(JSON.parse(JSON.stringify(CONFIG)))
            }
            if (namespace === 'ConfigCtrl' && method === 'SetConfig') {
              savedConfigs.push(JSON.parse(String(args[0] ?? '{}')))
              return hostOk(null)
            }
            if (namespace === 'AutoFan' && method === 'IsRunning') return hostOk(isRunning)
            return hostOk(null)
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
}

let editor: ReturnType<typeof useFanCurveEditor>

const Harness = defineComponent({
  setup() {
    editor = useFanCurveEditor()
    return () => h('div')
  },
})

async function mountEditor() {
  const wrapper = mount(Harness, { global: { plugins: [createPinia()] } })
  await flushPromises()
  return wrapper
}

function countOf(namespace: string, method: string): number {
  return calls.filter((c) => c.namespace === namespace && c.method === method).length
}

beforeEach(() => {
  calls = []
  savedConfigs = []
  failOn = () => false
  isRunning = true
  setActivePinia(createPinia())
  installHost()
})

describe('曲线页「交还 EC 固件温控」出口', () => {
  it('真发 AutoFanControl.Stop + Fan.RemoveFanSpeed，并把 Fan.Enabled=false 落盘', async () => {
    const wrapper = await mountEditor()

    const ok = await editor.handleHandoffToEc()
    await flushPromises()

    expect(ok).toBe(true)
    expect(countOf('AutoFan', 'Stop')).toBe(1)
    expect(countOf('Fan', 'RemoveFanSpeed')).toBe(1)
    expect(savedConfigs).toHaveLength(1)
    expect((savedConfigs[0]!.Fan as Record<string, unknown>).Enabled).toBe(false)
    // 三步逐项结果都在，没有「只报一句话」
    expect(editor.composite.state.value.steps.map((s) => s.status)).toEqual([
      'success',
      'success',
      'success',
    ])
    expect(editor.composite.state.value.phase).toBe('success')

    wrapper.unmount()
  })

  it('曲线服务没在跑：不停服务，但仍撤掩码 + 落盘', async () => {
    isRunning = false
    const wrapper = await mountEditor()

    expect(await editor.handleHandoffToEc()).toBe(true)
    expect(countOf('AutoFan', 'Stop')).toBe(0)
    expect(countOf('Fan', 'RemoveFanSpeed')).toBe(1)
    expect((savedConfigs[0]!.Fan as Record<string, unknown>).Enabled).toBe(false)

    wrapper.unmount()
  })

  it('停服务失败 → 不得继续撤掩码，也不得报成功', async () => {
    failOn = (ns, m) => ns === 'AutoFan' && m === 'Stop'
    const wrapper = await mountEditor()

    expect(await editor.handleHandoffToEc()).toBe(false)
    expect(countOf('Fan', 'RemoveFanSpeed')).toBe(0)
    expect(savedConfigs).toHaveLength(0)
    expect(editor.composite.state.value.phase).toBe('failed')

    wrapper.unmount()
  })

  it('落盘失败 → 报部分应用（前两步已生效不撤销），绝不报成功', async () => {
    failOn = (ns, m) => ns === 'ConfigCtrl' && m === 'SetConfig'
    const wrapper = await mountEditor()

    expect(await editor.handleHandoffToEc()).toBe(false)
    expect(countOf('AutoFan', 'Stop')).toBe(1)
    expect(countOf('Fan', 'RemoveFanSpeed')).toBe(1)
    expect(editor.composite.state.value.phase).toBe('partial')
    expect(editor.composite.state.value.partialApplied).toBe(true)
    expect(editor.composite.state.value.message).toContain('部分应用')

    wrapper.unmount()
  })
})
