/** 稳定页面 ID（v4 §9）。旧版 1..8 下标必须能迁到这些字符串。 */
export type PageId = 'home' | 'cpu' | 'gpu' | 'smu' | 'fan-curve' | 'keyboard' | 'settings'

export type PageGroup = 'overview' | 'perf' | 'thermal' | 'light' | 'advanced' | 'system'

export const PAGE_IDS: readonly PageId[] = [
  'home',
  'cpu',
  'gpu',
  'smu',
  'fan-curve',
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
  6: 'fan-curve',
  7: 'keyboard',
  8: 'settings',
}

/**
 * 已删除的页面 id → 现役 id（Decision 2026-10-06：删掉「风扇手动设定风速档位」）。
 * 老用户 localStorage 里存着 'fan'，不迁移就会被弹回概览页 —— 那等于把
 * 「风扇控制」页删掉的同时也删掉了他的落点。
 * 用 Map 而不是对象字面量：localStorage 的值不可控，`obj['toString']` 会命中
 * prototype 上的方法，把一个函数当成 PageId 返回（页面就白了）。
 */
const LEGACY_PAGE_ID_ALIAS = new Map<string, PageId>([['fan', 'fan-curve']])

function isPageId(value: string): value is PageId {
  return (PAGE_IDS as readonly string[]).includes(value)
}

export function migratePageId(raw: string | null): PageId {
  if (!raw) return 'home'
  if (isPageId(raw)) return raw
  const alias = LEGACY_PAGE_ID_ALIAS.get(raw)
  if (alias) return alias
  const n = Number(raw)
  if (Number.isInteger(n) && n in LEGACY_INDEX_TO_ID) return LEGACY_INDEX_TO_ID[n]!
  return 'home'
}
