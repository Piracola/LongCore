/** 稳定页面 ID（v4 §9）。旧版 1..8 下标必须能迁到这些字符串。 */
export type PageId = 'home' | 'cpu' | 'gpu' | 'smu' | 'fan-curve' | 'settings'

export type PageGroup = 'overview' | 'perf' | 'thermal' | 'advanced' | 'system'

export const PAGE_IDS: readonly PageId[] = ['home', 'cpu', 'gpu', 'smu', 'fan-curve', 'settings']

/**
 * 旧版 1-based 下标 → 稳定 ID。顺序按改 IA 之前的 HomeCardType。
 *
 * 数字键**不重新编号**（2026-10-06 删掉灯效页后仍留 7 号位）：老用户 localStorage 里
 * 存的就是裸数字，把 8 挪成 7 等于让所有存着 '8'（系统页）的人落到别的页面。
 * 空出来的号位全部显式指向 'home' —— 见下面 LEGACY_INDEX_TO_ID[7]。
 */
export const LEGACY_INDEX_TO_ID: Record<number, PageId> = {
  1: 'home',
  2: 'cpu',
  3: 'gpu',
  4: 'smu',
  5: 'fan-curve',
  6: 'fan-curve',
  7: 'home',
  8: 'settings',
}

/**
 * 已删除的页面 id → 现役 id（Decision 2026-10-06）。
 *
 * - `'fan'`（2026-10-06 删「风扇手动设定风速档位」）→ `'fan-curve'`：风扇控制的**继任者**
 *   就是曲线页，不迁移等于把页删掉的同时也删掉用户的落点。
 * - `'keyboard'`（2026-10-06 删整个「灯效」页）→ `'home'`：**没有继任页**（Logo 灯在设置页里，
 *   不是一个可导航的灯效页），所以显式写回概览页。写成显式映射而不是靠「未知即回落 home」
 *   的兜底偶然生效：兜底是给不可控输入用的，已删页面是**已知**输入，必须写明意图，
 *   否则将来改了兜底策略，这条路径会静默漂到别处。
 *
 * 用 Map 而不是对象字面量：localStorage 的值不可控，`obj['toString']` 会命中
 * prototype 上的方法，把一个函数当成 PageId 返回（页面就白了）。
 */
const LEGACY_PAGE_ID_ALIAS = new Map<string, PageId>([
  ['fan', 'fan-curve'],
  ['keyboard', 'home'],
])

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
