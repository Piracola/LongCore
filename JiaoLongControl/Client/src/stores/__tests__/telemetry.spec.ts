import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 遥测环形缓冲 store（风扇曲线页历史图的数据源）。
 * 只测判定逻辑 —— 桥接全 mock；两条硬约束：
 * 1. 失败样本记 null，绝不回填 0（v4 §7.1）；
 * 2. 全通道失败不追加空样本：有旧数据 stale / 从未成功 error。
 */
const mocks = vi.hoisted(() => ({
  thermometer: vi.fn(),
  gpuTemp: vi.fn(),
}))

vi.mock('@/utils/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/bridge')>()
  return {
    ...actual,
    CPU: { ...actual.CPU, GetCPUThermometer: mocks.thermometer },
    NvidiaGpu: { ...actual.NvidiaGpu, GetGpuTemperature: mocks.gpuTemp },
  }
})

vi.mock('@/stores/fan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/fan')>()
  const pinia = createPinia()
  return {
    ...actual,
    // useFanStore 必须在活动 pinia 上取；这里借真实实现但由外层提供 pinia
    useFanStore: actual.useFanStore,
    __pinia: pinia,
  }
})

import { useTelemetryStore } from '@/stores/telemetry'
import { useFanStore } from '@/stores/fan'

const ok = (data: unknown) => ({ Success: true, Message: 'ok', Data: data })
const fail = () => ({ Success: false, Message: '读取失败', Data: null })

function seedFanSpeed(cpu: number, gpu: number, state: 'ok' | 'error' = 'ok') {
  const fanStore = useFanStore()
  if (state === 'ok') {
    // 直接写 state：speed 的产出由 fan store 自己的单测负责
    fanStore.speed = {
      state: 'ok',
      value: { CPUFanSpeed: cpu, GPUFanSpeed: gpu },
      lastOkAt: Date.now(),
      message: null,
    }
  } else {
    fanStore.speed = { state: 'error', value: null, lastOkAt: null, message: 'x' }
  }
  return fanStore
}

describe('遥测环形缓冲 store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.thermometer.mockReset()
    mocks.gpuTemp.mockReset()
  })

  it('全部通道成功：四个字段都落值，state=ok', async () => {
    seedFanSpeed(2100, 1800)
    mocks.thermometer.mockResolvedValue(ok(72))
    mocks.gpuTemp.mockResolvedValue(ok(56))
    const store = useTelemetryStore()

    expect(await store.poll()).toBe(true)
    expect(store.samples).toHaveLength(1)
    expect(store.samples[0]).toMatchObject({ cpuFan: 2100, gpuFan: 1800, cpuTemp: 72, gpuTemp: 56 })
    expect(store.state).toBe('ok')
  })

  it('温度通道失败：样本记 null 而不是 0，转速仍落值', async () => {
    seedFanSpeed(2100, 1800)
    mocks.thermometer.mockResolvedValue(fail())
    mocks.gpuTemp.mockResolvedValue(fail())
    const store = useTelemetryStore()

    expect(await store.poll()).toBe(true)
    expect(store.samples[0]?.cpuFan).toBe(2100)
    expect(store.samples[0]?.cpuTemp).toBeNull()
    expect(store.samples[0]?.gpuTemp).toBeNull()
  })

  it('全通道失败：不追加样本；有旧数据转 stale，从未成功是 error', async () => {
    const store = useTelemetryStore()
    // 风扇也失败：speed 处于 error 态
    seedFanSpeed(0, 0, 'error')
    mocks.thermometer.mockResolvedValue(fail())
    mocks.gpuTemp.mockResolvedValue(fail())

    expect(await store.poll()).toBe(false)
    expect(store.samples).toHaveLength(0)
    expect(store.state).toBe('error')

    // 成功一拍后再全失败 → stale，样本数不变
    seedFanSpeed(2000, 1700)
    mocks.thermometer.mockResolvedValue(ok(70))
    mocks.gpuTemp.mockResolvedValue(ok(55))
    await store.poll()
    expect(store.samples).toHaveLength(1)

    seedFanSpeed(0, 0, 'error')
    mocks.thermometer.mockResolvedValue(fail())
    mocks.gpuTemp.mockResolvedValue(fail())
    expect(await store.poll()).toBe(false)
    expect(store.samples).toHaveLength(1)
    expect(store.state).toBe('stale')
  })

  it('环形截断：超过上限只留最近 cap 条', () => {
    const store = useTelemetryStore()
    for (let i = 0; i < 305; i++) {
      store.record({ at: i, cpuFan: i, gpuFan: i, cpuTemp: i, gpuTemp: i })
    }
    expect(store.samples).toHaveLength(300)
    expect(store.samples[0]?.at).toBe(5)
    expect(store.samples[299]?.at).toBe(304)
  })
})
