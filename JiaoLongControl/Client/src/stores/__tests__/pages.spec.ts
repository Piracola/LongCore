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
    // 旧 7 号位是「灯效」页，2026-10-06 整页删除且**没有继任页** → 显式映射到概览。
    // 8 号位仍是「系统」：数字键不重新编号，否则存着 '8' 的人会落到别的页面。
    expect(migratePageId('7')).toBe('home')
    expect(migratePageId('8')).toBe('settings')
  })

  it('migrates removed page ids explicitly', () => {
    // 老用户 localStorage 里存的就是字符串 'fan'（内容不可控），必须显式迁移到继任页
    expect(migratePageId('fan')).toBe('fan-curve')
    // 'keyboard' 是已删页面（已知输入），也必须写成显式映射，不靠"未知就回落 home"的兜底
    expect(migratePageId('keyboard')).toBe('home')
  })

  it('has 6 pages', () => {
    expect(PAGE_IDS.length).toBe(6)
    expect(PAGE_IDS).not.toContain('keyboard')
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
