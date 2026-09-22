import { describe, expect, it } from 'vitest'
import { ActivityLog } from '@/domain/operations'

describe('ActivityLog', () => {
  it('keeps newest first and caps capacity', () => {
    const log = new ActivityLog(3)
    log.record({
      source: 'user',
      intent: 'a',
      requestedValue: 1,
      outcome: 'applied',
      reversible: 'c',
    })
    log.record({
      source: 'user',
      intent: 'b',
      requestedValue: 2,
      outcome: 'failed',
      reversible: 'c',
    })
    log.record({
      source: 'fn-hotkey',
      intent: 'c',
      requestedValue: 3,
      outcome: 'applied',
      reversible: 'b',
    })
    log.record({
      source: 'user',
      intent: 'd',
      requestedValue: 4,
      outcome: 'partial',
      reversible: 'b',
    })
    expect(log.size).toBe(3)
    expect(log.recent().map((r) => r.intent)).toEqual(['d', 'c', 'b'])
  })
})
