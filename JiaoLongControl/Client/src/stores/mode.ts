import { defineStore } from 'pinia'
import { CPU, PerformanceMode, SystemPerMode } from '@/utils/bridge'
import { FIRMWARE_MODE_LABELS, toFirmwareMode, type FirmwareMode } from '@/domain/modes'
import { useActivityStore } from '@/stores/activity'
import { applySavedCpuPower } from '@/domain/cpuPowerPlan'

/**
 * 性能模式 store —— 预设选择器三分离（v4 §6 + §14.1 答复 1，Decision 2026-09-17；
 * Implemented 2026-09-17）。
 *
 * 三个概念严格分离（v4 第一性原则 1：我想设置的值 / 命令已发送 / 硬件实际值）：
 * - selected      我选了什么（用户点选即记；未应用成功前激活态 = pending，不冒充已生效）
 * - observedFirmware  固件真实档位（命令 8，三档）+ 命令 23 自定义子状态
 * - syncing       写入在途标志；失败后 selected 回滚为 observed，不留虚假激活态
 *
 * 冲突 A 裁定落地：Get 的「固件档位 + 命令 23 叠加」观察值仍在服务端返回，
 * 但语义上拆为 observedFirmware（档位）+ customOverride（命令 23 子状态）。
 * 「自定义」不再是第四档，而是 selected 上的一个 pending 覆盖意向。
 *
 * 冲突 B 裁定：Fn 热键物理上只有三档（HotkeyController.cs:145 显式拒绝 mode==3），
 * 本 store 的热键同步只处理 0/1/2。
 *
 * 同步规则（v4 §13 DoD「模式同步」）：Fn 热键（mode-changed 消息）/ 应用内切换 /
 * 启动读取三条路径最终一致；失败不留虚假激活态。
 */

export type ModeSelection = { kind: 'preset'; mode: FirmwareMode } | { kind: 'custom' }

interface ModeState {
  /** 固件观察档位（命令 8；热键事件 15 直接更新它） */
  observedFirmware: FirmwareMode | null
  /** 命令 23 自定义功耗子状态（叠加在固件档位之上的覆盖，不是第四档） */
  customOverride: boolean
  /** 用户当前选择（preset = 三档其一；custom = 开启自定义功耗覆盖） */
  selected: ModeSelection | null
  /** 写入在途 */
  syncing: boolean
  /** 最近一次同步失败消息；null = 无失败 */
  lastError: string | null
  /** 读数四态语义（v4 §7）：观察通道的 ReadingState */
  observedState: 'ok' | 'stale' | 'error'
}

const PER_MODE_NAMES: Record<string, SystemPerMode> = {
  BalanceMode: SystemPerMode.BalanceMode,
  PerformanceMode: SystemPerMode.PerformanceMode,
  QuietMode: SystemPerMode.QuietMode,
  CustomMode: SystemPerMode.CustomMode,
  balance: SystemPerMode.BalanceMode,
  performance: SystemPerMode.PerformanceMode,
  quiet: SystemPerMode.QuietMode,
  custom: SystemPerMode.CustomMode,
}

/** 桥接 JSON 的 Data：数字 / 枚举名 / 误装箱的空对象。非 0/1/2/3 视为无效。 */
function coercePerMode(data: unknown): SystemPerMode | null {
  if (typeof data === 'number' && Number.isFinite(data)) return asPerMode(data)
  if (typeof data === 'string') {
    if (data in PER_MODE_NAMES) return PER_MODE_NAMES[data]!
    return asPerMode(Number(data))
  }
  return null
}

function asPerMode(n: number): SystemPerMode | null {
  if (
    n === SystemPerMode.BalanceMode ||
    n === SystemPerMode.PerformanceMode ||
    n === SystemPerMode.QuietMode ||
    n === SystemPerMode.CustomMode
  ) {
    return n
  }
  return null
}

export const useModeStore = defineStore('performanceMode', {
  state: (): ModeState => ({
    observedFirmware: null,
    customOverride: false,
    selected: null,
    syncing: false,
    lastError: null,
    observedState: 'error',
  }),

  getters: {
    /**
     * UI 激活态：pending = 已选未确认（命令未接受或未回读），展示为「应用中/待生效」；
     * confirmed = 与观察值一致。**不得在 pending 时渲染成已生效**（v4 §14.2 冲突 A 附带风险）。
     */
    activeKind(state): 'preset' | 'custom' | 'pending' | 'none' {
      if (state.syncing) return 'pending'
      if (!state.selected) return 'none'
      if (state.selected.kind === 'custom') {
        return state.customOverride ? 'custom' : 'pending'
      }
      return state.selected.mode === state.observedFirmware && !state.customOverride
        ? 'preset'
        : 'pending'
    },
    lastErrorOr: (state) => state.lastError,
    /** 固件三档的显示名；尚未读到则为空串 */
    firmwareLabel: (state) =>
      state.observedFirmware ? FIRMWARE_MODE_LABELS[state.observedFirmware] : '',
  },

  actions: {
    /** 启动/进入页面时读取一次观察值。写后独立重读也走这里（v4 §8.4）。 */
    async refreshObserved(): Promise<boolean> {
      try {
        const res = await PerformanceMode.Get()
        if (res.Success) {
          const raw = coercePerMode(res.Data)
          // 服务端 Get 的叠加语义：CustomMode = 固件档位 + 命令 23 OpenState。
          // 拆开呈现：观察到的固件档位保持原值，自定义子状态单列。
          if (raw === SystemPerMode.CustomMode) {
            // 叠加态：固件档位未知于本次响应 —— 视为「观察：自定义覆盖开启」，
            // 档位维持原观察值（不可凭空猜）。
            this.customOverride = true
            this.observedState = this.observedFirmware ? 'ok' : 'stale'
            this.syncSelectedFromObserved()
            return true
          }
          const fw = raw === null ? null : toFirmwareMode(raw)
          if (fw) {
            this.observedFirmware = fw
            this.customOverride = false
            this.observedState = 'ok'
            this.syncSelectedFromObserved()
            return true
          }
        }
        this.observedState = this.observedFirmware ? 'stale' : 'error'
        return false
      } catch {
        this.observedState = this.observedFirmware ? 'stale' : 'error'
        return false
      }
    },

    /** 用户点选。先记 selected（pending），命令被接受后才允许激活态渲染。 */
    async select(sel: ModeSelection): Promise<boolean> {
      if (this.syncing) return false
      this.syncing = true
      this.lastError = null
      this.selected = sel
      try {
        // 两档语义分开：
        // - preset  = 切固件档位（命令 8），由 EC 自己的功耗表接管；
        // - custom  = 首页「自定义」= 下发 CPU 页保存的那套参数（打开命令 23 覆盖 + SPL/SPPT/温度墙/频率）。
        //   走的是同一份 domain/cpuPowerPlan.ts，不在两处各维护一套下发顺序。
        let accepted: boolean
        let failure = '切换失败'
        if (sel.kind === 'custom') {
          const outcome = await applySavedCpuPower('user')
          accepted = outcome.accepted
          failure =
            outcome.message || (outcome.partialApplied ? '自定义功耗参数部分应用' : '切换失败')
        } else {
          const res = await PerformanceMode.Set(
            sel.mode === 'balance'
              ? SystemPerMode.BalanceMode
              : sel.mode === 'performance'
                ? SystemPerMode.PerformanceMode
                : SystemPerMode.QuietMode,
          )
          accepted = !!res.Success
          failure = res.Message || '切换失败'
        }
        // 命令接受 ≠ 已生效（v4 §8.4）：写后独立重读一次确认
        if (accepted) {
          await this.refreshObserved()
        } else {
          this.lastError = failure
        }
        // 失败不留虚假激活态：selected 回滚为观察值
        if (!accepted || this.activeKind === 'pending') {
          this.syncSelectedFromObserved()
        }
        useActivityStore().record({
          source: 'user',
          intent:
            sel.kind === 'custom'
              ? '开启自定义功耗覆盖'
              : `切换性能档位：${FIRMWARE_MODE_LABELS[sel.mode]}`,
          requestedValue: sel.kind === 'custom' ? 'custom' : sel.mode,
          outcome: accepted ? 'applied' : 'failed',
          reversible: 'b',
        })
        return accepted
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : '切换失败'
        this.syncSelectedFromObserved()
        return false
      } finally {
        this.syncing = false
      }
    },

    /** Fn 热键镜像（mode-changed 消息，detail[2] 只有 0/1/2 —— 冲突 B 裁定）。 */
    applyHotkeyMirror(modeByte: number): void {
      const fw = toFirmwareMode(modeByte as SystemPerMode)
      if (!fw) return // 未知档位：热键路径显式拒绝（HotkeyController.cs:145 同款判定）
      this.observedFirmware = fw
      this.customOverride = false
      this.observedState = 'ok'
      // 热键切换固件会关掉自定义子状态（ApplyMirrored），selected 跟随观察值
      this.syncSelectedFromObserved()
      useActivityStore().record({
        source: 'fn-hotkey',
        intent: `Fn 热键切换档位：${FIRMWARE_MODE_LABELS[fw]}`,
        requestedValue: fw,
        outcome: 'applied',
        reversible: 'b',
      })
    },

    /** selected 对齐观察值（失败恢复/热键镜像后调用） */
    syncSelectedFromObserved(): void {
      if (this.observedFirmware && !this.customOverride) {
        this.selected = { kind: 'preset', mode: this.observedFirmware }
      } else if (this.customOverride) {
        this.selected = { kind: 'custom' }
      }
    },

    /**
     * 关闭自定义功耗覆盖，回到固件三档。
     * 有底层观察档则重申该档（命令 8 + 关覆盖）；尚无观察档则只关命令 23，再重读。
     */
    async followFirmware(): Promise<boolean> {
      if (this.observedFirmware) {
        return this.select({ kind: 'preset', mode: this.observedFirmware })
      }
      if (this.syncing) return false
      this.syncing = true
      this.lastError = null
      try {
        const res = await CPU.SetCustomMode(false)
        if (!res.Success) {
          this.lastError = res.Message || '关闭自定义功耗失败'
          useActivityStore().record({
            source: 'user',
            intent: '关闭自定义功耗覆盖',
            requestedValue: 'firmware',
            outcome: 'failed',
            reversible: 'b',
          })
          return false
        }
        await this.refreshObserved()
        this.syncSelectedFromObserved()
        useActivityStore().record({
          source: 'user',
          intent: '关闭自定义功耗覆盖',
          requestedValue: this.observedFirmware ?? 'firmware',
          outcome: 'applied',
          reversible: 'b',
        })
        return true
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : '关闭自定义功耗失败'
        return false
      } finally {
        this.syncing = false
      }
    },
  },
})
