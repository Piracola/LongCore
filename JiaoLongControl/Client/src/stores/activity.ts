import { defineStore } from 'pinia'
import { ActivityLog, type ActivityRecord, type OperationSource } from '@/domain/operations'

/**
 * 全局最近活动（v4 §8.5 / Phase 5）。
 * 环形缓冲只记用户意图级；自动风扇 / 看门狗底层写入不得进入。
 * 形态：标题栏抽屉，不占一级导航。
 */

const log = new ActivityLog(200)

export const OUTCOME_LABEL: Record<ActivityRecord['outcome'], string> = {
  applied: '已应用',
  accepted: '已接受',
  failed: '失败',
  partial: '部分应用',
}

export const SOURCE_LABEL: Record<OperationSource, string> = {
  user: '用户',
  'startup-restore': '启动恢复',
  'auto-fan': '自动风扇',
  'thermal-watchdog': '温控看门狗',
  'fn-hotkey': 'Fn 热键',
}

export const useActivityStore = defineStore('activity', {
  state: () => ({
    /** 递增以驱动 recent 重新取值（ActivityLog 本身非响应式） */
    revision: 0,
    open: false,
  }),

  getters: {
    recent(state): ActivityRecord[] {
      void state.revision
      return log.recent(50)
    },
    size(state): number {
      void state.revision
      return log.size
    },
  },

  actions: {
    record(entry: Omit<ActivityRecord, 'seq' | 'at'>): void {
      log.record(entry)
      this.revision += 1
    },
    toggle(): void {
      this.open = !this.open
    },
    close(): void {
      this.open = false
    },
  },
})
