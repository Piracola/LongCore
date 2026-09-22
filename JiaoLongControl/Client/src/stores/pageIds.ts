/** 稳定页面 ID（v4 §9）。旧版 1..8 下标必须能迁到这些字符串。 */
export type PageId = 'home' | 'cpu' | 'gpu' | 'smu' | 'fan-curve' | 'fan' | 'keyboard' | 'settings'

export type PageGroup = 'overview' | 'perf' | 'thermal' | 'light' | 'advanced' | 'system'

export const PAGE_IDS: readonly PageId[] = [
  'home',
  'cpu',
  'gpu',
  'smu',
  'fan-curve',
  'fan',
  'keyboard',
  'settings',
]

/** 旧版 1-based 下标 → 稳定 ID。顺序按改 IA 之前的 HomeCardType。 */
export const LEGACY_INDEX_TO_ID: Record<number, PageId> = {
  1: 'home',
  2: 'cpu',
  3: 'gpu',
  4: 'smu',
  5: 'fan-curve',
  6: 'fan',
  7: 'keyboard',
  8: 'settings',
}

function isPageId(value: string): value is PageId {
  return (PAGE_IDS as readonly string[]).includes(value)
}

export function migratePageId(raw: string | null): PageId {
  if (!raw) return 'home'
  if (isPageId(raw)) return raw
  const n = Number(raw)
  if (Number.isInteger(n) && n in LEGACY_INDEX_TO_ID) return LEGACY_INDEX_TO_ID[n]!
  return 'home'
}
