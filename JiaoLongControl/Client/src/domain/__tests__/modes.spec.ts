import { describe, expect, it } from 'vitest'
import { FIRMWARE_MODE_LABELS, toFirmwareMode } from '@/domain/modes'
import { SystemPerMode } from '@/utils/bridge'

describe('firmware mode labels', () => {
  it('maps 办公 / 游戏 / 狂飙', () => {
    expect(FIRMWARE_MODE_LABELS.quiet).toBe('办公')
    expect(FIRMWARE_MODE_LABELS.balance).toBe('游戏')
    expect(FIRMWARE_MODE_LABELS.performance).toBe('狂飙')
  })

  it('drops CustomMode from firmware domain', () => {
    expect(toFirmwareMode(SystemPerMode.QuietMode)).toBe('quiet')
    expect(toFirmwareMode(SystemPerMode.BalanceMode)).toBe('balance')
    expect(toFirmwareMode(SystemPerMode.PerformanceMode)).toBe('performance')
    expect(toFirmwareMode(SystemPerMode.CustomMode)).toBeNull()
  })
})
