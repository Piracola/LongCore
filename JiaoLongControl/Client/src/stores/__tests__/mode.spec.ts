import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 模式三分离（v4 §6 + §14.1 答复 1：模式 = 预设选择器）。
 * 只测 store 的判定逻辑 —— 桥接与下发路径全 mock，真机行为不由单测负责。
 * 三条硬约束：pending 不冒充已生效 / 失败不留虚假激活态 / 命令被接受不等于已生效。
 */
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  setCustomMode: vi.fn(),
  applySaved: vi.fn(),
}))

vi.mock('@/utils/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/bridge')>()
  return {
    ...actual,
    PerformanceMode: { Get: mocks.get, Set: mocks.set },
    CPU: { ...actual.CPU, SetCustomMode: mocks.setCustomMode },
  }
})

vi.mock('@/domain/cpuPowerPlan', () => ({ applySavedCpuPower: mocks.applySaved }))

import { useModeStore } from '@/stores/mode'
import { useActivityStore } from '@/stores/activity'
import { SystemPerMode } from '@/utils/bridge'

const ok = (data: unknown) => ({ Success: true, Message: 'ok', Data: data })
const fail = (message = '失败') => ({ Success: false, Message: message, Data: null })

describe('模式三分离 store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.get.mockReset()
    mocks.set.mockReset()
    mocks.setCustomMode.mockReset()
    mocks.applySaved.mockReset()
  })

  it('启动读到三档：观察值落地，selected 跟随', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    const store = useModeStore()

    expect(await store.refreshObserved()).toBe(true)
    expect(store.observedFirmware).toBe('balance')
    expect(store.observedState).toBe('ok')
    expect(store.activeKind).toBe('preset')
  })

  it('读到 CustomMode：拆成「档位未知 + 覆盖开启」，不凭空猜档位', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.CustomMode))
    const store = useModeStore()

    await store.refreshObserved()
    expect(store.customOverride).toBe(true)
    expect(store.observedFirmware).toBeNull()
    expect(store.observedState).toBe('stale')
    expect(store.activeKind).toBe('custom')
  })

  it('读取失败：有旧档位是 stale（不回退成 0/未读取假值）', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.QuietMode))
    const store = useModeStore()
    await store.refreshObserved()

    mocks.get.mockResolvedValue(fail('WMI 超时'))
    expect(await store.refreshObserved()).toBe(false)
    expect(store.observedState).toBe('stale')
    expect(store.observedFirmware).toBe('quiet')
  })

  it('切档成功：命令被接受且回读一致才算成功', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    mocks.set.mockResolvedValue(ok(null))
    const store = useModeStore()
    await store.refreshObserved()

    mocks.get.mockResolvedValue(ok(SystemPerMode.PerformanceMode))
    expect(await store.select({ kind: 'preset', mode: 'performance' })).toBe(true)
    // 断言"发出去的到底是哪个枚举值"：0/1/2 的顺序是历史坑（bridge.ts 有专门注释）
    expect(mocks.set).toHaveBeenCalledWith(SystemPerMode.PerformanceMode)
    expect(store.observedFirmware).toBe('performance')
    expect(store.activeKind).toBe('preset')
    expect(store.lastError).toBeNull()
  })

  it('切档被拒：lastError 落地，selected 回滚为观察值（点亮旧档而非被拒的新档）', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    mocks.set.mockResolvedValue(fail('EC 拒绝'))
    const store = useModeStore()
    await store.refreshObserved()

    expect(await store.select({ kind: 'preset', mode: 'performance' })).toBe(false)
    expect(store.lastError).toBe('EC 拒绝')
    expect(store.selected).toEqual({ kind: 'preset', mode: 'balance' })
    expect(store.activeKind).toBe('preset')
  })

  it('命令被接受但回读未确认：按失败处理，不虚假成功', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    mocks.set.mockResolvedValue(ok(null))
    const store = useModeStore()
    await store.refreshObserved()

    expect(await store.select({ kind: 'preset', mode: 'quiet' })).toBe(false)
    // 只断言状态，不断言文案：改一句话不该让行为正确的测试挂掉
    expect(store.lastError).not.toBeNull()
    expect(store.selected).toEqual({ kind: 'preset', mode: 'balance' })
  })

  it('Fn 热键镜像：只认三档，CustomMode 被丢弃', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    const store = useModeStore()
    await store.refreshObserved()

    store.applyHotkeyMirror(SystemPerMode.CustomMode)
    expect(store.observedFirmware).toBe('balance')

    store.applyHotkeyMirror(SystemPerMode.QuietMode)
    expect(store.observedFirmware).toBe('quiet')
    expect(store.customOverride).toBe(false)
    expect(store.activeKind).toBe('preset')
  })

  it('切换在途：事件镜像不得改写 selected（切出自定义的"退回游戏"中间态）', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    let release: (value: unknown) => void = () => {}
    mocks.set.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const store = useModeStore()
    await store.refreshObserved()

    const inflight = store.select({ kind: 'preset', mode: 'quiet' })
    await Promise.resolve()
    expect(store.syncing).toBe(true)

    // 我们自己关命令 23 时固件回抛的中间态。采信它就会把用户刚点的「办公」改成「游戏」，
    // 紧接着的写后回读看到的正是这个假中间态 —— "首次从自定义切出必失败"就是这么来的。
    store.applyHotkeyMirror(SystemPerMode.BalanceMode)
    expect(store.selected).toEqual({ kind: 'preset', mode: 'quiet' })

    mocks.get.mockResolvedValue(ok(SystemPerMode.QuietMode))
    release(ok(null))
    expect(await inflight).toBe(true)
    expect(store.selected).toEqual({ kind: 'preset', mode: 'quiet' })
    expect(store.activeKind).toBe('preset')
  })

  it('自定义覆盖：下发通过且回读为 CustomMode 才算成功', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    mocks.applySaved.mockResolvedValue({
      accepted: true,
      partialApplied: false,
      failed: 0,
      skipped: 0,
      message: null,
    })
    const store = useModeStore()
    await store.refreshObserved()

    mocks.get.mockResolvedValue(ok(SystemPerMode.CustomMode))
    expect(await store.select({ kind: 'custom' })).toBe(true)
    expect(store.customOverride).toBe(true)
    expect(store.activeKind).toBe('custom')
  })

  it('档位 → 协议枚举的映射：游戏=0 / 狂飙=1 / 办公=2（顺序是历史坑）', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    mocks.set.mockResolvedValue(ok(null))
    const store = useModeStore()
    await store.refreshObserved()

    mocks.get.mockResolvedValue(ok(SystemPerMode.QuietMode))
    await store.select({ kind: 'preset', mode: 'quiet' })
    expect(mocks.set).toHaveBeenLastCalledWith(SystemPerMode.QuietMode)
    expect(SystemPerMode.QuietMode).toBe(2)

    mocks.get.mockResolvedValue(ok(SystemPerMode.PerformanceMode))
    await store.select({ kind: 'preset', mode: 'performance' })
    expect(mocks.set).toHaveBeenLastCalledWith(SystemPerMode.PerformanceMode)
    expect(SystemPerMode.PerformanceMode).toBe(1)

    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    await store.select({ kind: 'preset', mode: 'balance' })
    expect(mocks.set).toHaveBeenLastCalledWith(SystemPerMode.BalanceMode)
    expect(SystemPerMode.BalanceMode).toBe(0)
  })

  it('切换在途：activeKind 必须是 pending（本次踩过的坑，钉住）', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    let release: (value: unknown) => void = () => {}
    mocks.set.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const store = useModeStore()
    await store.refreshObserved()

    const inflight = store.select({ kind: 'preset', mode: 'performance' })
    await Promise.resolve()
    expect(store.syncing).toBe(true)
    expect(store.activeKind).toBe('pending')
    release(ok(null))
    await inflight
    expect(store.syncing).toBe(false)
  })

  it('桥接抛异常：syncing 复位、selected 回滚、失败留痕', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.BalanceMode))
    mocks.set.mockRejectedValue(new Error('桥接超时'))
    const store = useModeStore()
    await store.refreshObserved()

    expect(await store.select({ kind: 'preset', mode: 'quiet' })).toBe(false)
    expect(store.syncing).toBe(false)
    expect(store.lastError).toBe('桥接超时')
    expect(store.selected).toEqual({ kind: 'preset', mode: 'balance' })
    expect(useActivityStore().recent[0]?.outcome).toBe('failed')
  })

  it('自定义覆盖：回读失败时不得报成功（虚假成功防线）', async () => {
    mocks.get.mockResolvedValue(ok(SystemPerMode.CustomMode))
    mocks.applySaved.mockResolvedValue({
      accepted: true,
      partialApplied: false,
      failed: 0,
      skipped: 0,
      message: null,
    })
    const store = useModeStore()
    await store.refreshObserved()
    expect(store.customOverride).toBe(true)

    // 下发被接受，但紧接着的回读失败 —— 旧逻辑会因为 customOverride 仍为 true 而报成功
    mocks.get.mockResolvedValue(fail('WMI 超时'))
    expect(await store.select({ kind: 'custom' })).toBe(false)
    expect(store.lastError).not.toBeNull()
    expect(useActivityStore().recent[0]?.outcome).toBe('accepted')
  })

  it('followFirmware：无观察档位时只关命令 23 覆盖，不猜档位', async () => {
    mocks.get.mockResolvedValue(fail())
    mocks.setCustomMode.mockResolvedValue(ok(null))
    const store = useModeStore()

    expect(await store.followFirmware()).toBe(true)
    expect(mocks.setCustomMode).toHaveBeenCalledWith(false)
    expect(mocks.set).not.toHaveBeenCalled()
    expect(store.observedState).toBe('error')
  })
})
