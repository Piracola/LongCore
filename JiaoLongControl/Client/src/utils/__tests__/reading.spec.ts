import { describe, expect, it } from 'vitest'
import {
  errorReading,
  okReading,
  PollingChannel,
  staleReading,
  unavailableReading,
} from '@/utils/reading'

describe('Reading helpers', () => {
  it('ok keeps the value', () => {
    const r = okReading(42)
    expect(r.state).toBe('ok')
    expect(r.value).toBe(42)
    expect(r.lastOkAt).not.toBeNull()
  })

  it('stale keeps last value and never substitutes 0', () => {
    const prev = okReading(3511)
    const stale = staleReading(prev)
    expect(stale.state).toBe('stale')
    expect(stale.value).toBe(3511)
  })

  it('error and unavailable have null value', () => {
    expect(errorReading('x').value).toBeNull()
    expect(unavailableReading().value).toBeNull()
  })
})

describe('PollingChannel', () => {
  it('stops after consecutive failures', async () => {
    let n = 0
    const ch = new PollingChannel(
      async () => {
        n += 1
        return false
      },
      { intervalMs: 5, maxBackoffMs: 10, maxConsecutiveFailures: 3, pauseWhenHidden: false },
    )
    ch.start()
    await new Promise((r) => setTimeout(r, 80))
    expect(ch.isStalled).toBe(true)
    expect(n).toBe(3)
    ch.dispose()
  })

  it('fires the first attempt immediately', async () => {
    let n = 0
    const ch = new PollingChannel(
      async () => {
        n += 1
        return true
      },
      { intervalMs: 10_000, pauseWhenHidden: false },
    )
    ch.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(n).toBe(1)
    ch.dispose()
  })
})
