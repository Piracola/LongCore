import { describe, expect, it } from 'vitest'
import { migratePageId } from '@/stores/pageIds'

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
    expect(migratePageId('6')).toBe('fan')
    expect(migratePageId('7')).toBe('keyboard')
    expect(migratePageId('8')).toBe('settings')
  })

  it('falls back to home', () => {
    expect(migratePageId(null)).toBe('home')
    expect(migratePageId('nope')).toBe('home')
    expect(migratePageId('99')).toBe('home')
  })
})
