import { describe, expect, it } from 'vitest'
import { writeGate } from '@/domain/writeGate'

describe('writeGate.smu', () => {
  it('rejects zero on limit setters', () => {
    expect(writeGate.smu('StapmLimit', 0).allowed).toBe(false)
    expect(writeGate.smu('FastLimit', 0).allowed).toBe(false)
    expect(writeGate.smu('TempLimitMp1', 0).allowed).toBe(false)
  })

  it('allows in-range limit values', () => {
    expect(writeGate.smu('StapmLimit', 54).allowed).toBe(true)
    expect(writeGate.smu('TempLimitMp1', 90).allowed).toBe(true)
    expect(writeGate.smu('TempLimitMp1', 100).allowed).toBe(true)
    expect(writeGate.smu('PboScalar', 2).allowed).toBe(true)
  })

  it('rejects out of range', () => {
    expect(writeGate.smu('StapmLimit', 201).allowed).toBe(false)
    expect(writeGate.smu('TempLimitMp1', 101).allowed).toBe(false)
    expect(writeGate.smu('CurveOptimizerAll', 1).allowed).toBe(false)
    expect(writeGate.smu('OcClk', -501).allowed).toBe(false)
  })
})

describe('writeGate.fanManualSpeed', () => {
  it('allows 1500–5800', () => {
    expect(writeGate.fanManualSpeed(1500).allowed).toBe(true)
    expect(writeGate.fanManualSpeed(5800).allowed).toBe(true)
  })

  it('rejects outside', () => {
    expect(writeGate.fanManualSpeed(1499).allowed).toBe(false)
    expect(writeGate.fanManualSpeed(5801).allowed).toBe(false)
  })
})
