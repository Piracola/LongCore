import { describe, expect, it } from 'vitest'

/** 与 systemInfo.snapshotTemps 相同的环形截取：只留最近 cap 条，禁止用 0 填洞 */
function capHistory<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items
  return items.slice(items.length - cap)
}

describe('temp history ring', () => {
  it('keeps insertion order under the cap', () => {
    const buf = [1, 2, 3]
    expect(capHistory(buf, 5)).toEqual([1, 2, 3])
  })

  it('drops the oldest when over cap', () => {
    const buf = [1, 2, 3, 4, 5, 6]
    expect(capHistory(buf, 4)).toEqual([3, 4, 5, 6])
  })

  it('preserves null samples instead of substituting 0', () => {
    const buf = [
      { cpu: 68, gpu: null },
      { cpu: null, gpu: 62 },
    ]
    const kept = capHistory(buf, 8)
    expect(kept[0]?.gpu).toBeNull()
    expect(kept[1]?.cpu).toBeNull()
  })
})
