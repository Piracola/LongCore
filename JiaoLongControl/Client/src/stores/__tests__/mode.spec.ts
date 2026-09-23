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
    expect(store.lastError).toContain('回读未确认')
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
