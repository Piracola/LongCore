import { describe, expect, it } from 'vitest'
import { migratePageId, PAGE_IDS } from '@/stores/pageIds'

describe('migratePageId', () => {
  it('keeps stable string ids', () => {
    expect(migratePageId('home')).toBe('home')
    expect(migratePageId('smu')).toBe('smu')
    expect(migratePageId('fan-curve')).toBe('fan-curve')
  })

  it('migrates legacy numeric indexes', () => {
    expect(migratePageId('1')).toBe('home')
    expect(migratePageId('2')).toBe('cpu')
    expect(migratePageId('3')).toBe('gpu')
    expect(migratePageId('4')).toBe('smu')
    expect(migratePageId('5')).toBe('fan-curve')
    // 旧 6 号位是「风扇」页，页已删 → 落到它的继任者「风扇曲线」
    expect(migratePageId('6')).toBe('fan-curve')
    expect(migratePageId('7')).toBe('keyboard')
    expect(migratePageId('8')).toBe('settings')
  })

  it('migrates the removed fan page id to fan-curve', () => {
    // 老用户 localStorage 里存的就是字符串 'fan'（内容不可控），必须显式迁移
    expect(migratePageId('fan')).toBe('fan-curve')
  })

  it('has 7 pages', () => {
    expect(PAGE_IDS.length).toBe(7)
  })

  it('falls back to home', () => {
    expect(migratePageId(null)).toBe('home')
    expect(migratePageId('nope')).toBe('home')
    expect(migratePageId('99')).toBe('home')
    // localStorage 的值不可控：别名表不能命中 prototype 上的方法（曾用对象字面量）
    expect(migratePageId('toString')).toBe('home')
    expect(migratePageId('constructor')).toBe('home')
  })
})
