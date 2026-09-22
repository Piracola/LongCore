import { defineStore } from 'pinia'
import { Fan, AutoFanControl, type FanSpeedInfo } from '@/utils/bridge'
import { writeGate } from '@/domain/writeGate'
import { type ActivityRecord } from '@/domain/operations'
import { useActivityStore } from '@/stores/activity'
import { useModeStore } from '@/stores/mode'
import { okReading, staleReading, errorReading, type Reading } from '@/utils/reading'
import { PollingChannel } from '@/utils/reading'
import { POLL_INTERVAL_FAN_SPEED, POLL_INTERVAL_SMART_FAN } from '@/constants'

/**
 * 风扇策略 store —— 第一个垂直切片（UI重构_最终方案_v4.md §11，Implemented 2026-09-17）。
 *
 * FanPolicy 状态机（v4 §6 + §10「自动策略接管必须显示当前由谁控制」）：
 * - auto    EC 固件自动温控（默认；手动转速未设 且 AutoFan 未运行）
 * - curve   应用内曲线接管（AutoFanControl 运行中）
 * - manual  用户手动接管（SetFanSpeed 已下发；AutoFan 已停）
 *
 * 判定权威：AutoFan.IsRunning()（曲线）→ Fan.SetFanSpeed 是否留有手动设定（manual）→ auto。
 * EC 没有可靠 getter 区分「固件自动」与「残留手动值」，manual 判定为推断（Hypothesis），
 * 反证条件：若 EC 存在手动转速查询命令，应以查询为准。
 *
 * 可逆性（v4 §8.2）：风扇手动接管 = C 级 —— 只能「恢复自动控制」，不得出现「回滚/撤销」。
 *
 * 最近活动（v4 §8.5）：200 条环形缓冲，只记用户意图级；
 * 自动风扇曲线 / 温控看门狗的底层写入不得进入（它们的写入不经过本 store）。
 *
 * 常驻监控（2026-09-21）：转速与曲线服务状态由 App.vue 全局起调度，
 * 不再依赖「进入风扇页才开始读」—— 旧实现下切页后曲线页/风扇页读数会假死。
 */

export type FanController = 'auto' | 'manual' | 'curve'

export interface FanApplyResult {
  ok: boolean
  /** 逐项结果（v4 §8.3）：停 AutoFan（如运行中）→ 写转速 → 保存配置 */
  steps: Array<{ label: string; ok: boolean; skipped?: boolean; message?: string }>
  message: string
}

interface FanState {
  /** 四态转速读数（v4 §7.1：失败不得显示 0） */
  speed: Reading<FanSpeedInfo>
  /** 当前控制权 */
  controller: FanController
  /** 状态机判定在途 */
  resolving: boolean
  /**
   * 应用内曲线服务（AutoFanControl）运行状态 —— 四态。
   * 旧实现只有 isRunning: boolean，读取失败时静默 false，页面于是断言
   * 「EC 自动控制」，把「读不到」显示成「已确认的事实」（违反 v4 §7）。
   */
  curveService: Reading<boolean>
  /** 常驻调度是否在跑（App.vue 挂载一次） */
  monitoring: boolean
}

export const useFanStore = defineStore('fan', {
  state: (): FanState => ({
    speed: errorReading('尚未读取'),
    controller: 'auto',
    resolving: false,
    curveService: errorReading('尚未读取'),
    monitoring: false,
  }),

  getters: {
    /** 活动日志（非响应式对象经 getter 暴露快照） */
    activity(): ActivityRecord[] {
      return useActivityStore().recent
    },
    /** 控制权显示名（v4 §10：必须显示「当前由谁控制」） */
    controllerLabel(): string {
      return { auto: 'EC 自动温控', manual: '手动接管', curve: '应用内曲线' }[this.controller]
    },
    /**
     * 自定义风扇控制是否被性能模式挡住。
     * 固件三档（办公/游戏/狂飙）的风扇曲线由 EC 自己的表管理，应用不介入；
     * 只有首页切到「自定义」后才允许手动转速与应用内曲线接管。
     * 注意：即便被挡住，「恢复自动控制」也必须可用 —— 那是安全出口，不是可选项。
     */
    customizationLocked(): boolean {
      const mode = useModeStore()
      if (mode.customOverride) return false
      return mode.selected?.kind !== 'custom'
    },
    /** 曲线服务是否在跑；读不到返回 null（调用方必须显示「—」而非 false） */
    curveRunning(): boolean | null {
      return this.curveService.value
    },
  },

  actions: {
    /** 四态转速读取：成功 ok；有旧值 stale；从未成功 error。失败绝不落 0。 */
    async refreshSpeed(): Promise<boolean> {
      try {
        const res = await Fan.GetFanSpeed()
        if (res.Success && res.Data) {
          this.speed = okReading(res.Data)
          return true
        }
      } catch {
        /* 落入 stale/error 分支 */
      }
      this.speed =
        this.speed.state === 'ok' || this.speed.state === 'stale'
          ? staleReading(this.speed)
          : errorReading('风扇转速读取失败')
      return false
    },

    /** 曲线服务状态四态读取。失败保留旧值转 stale，从未成功转 error。 */
    async refreshCurveService(): Promise<boolean> {
      try {
        const res = await AutoFanControl.IsRunning()
        if (res.Success && res.Data !== undefined && res.Data !== null) {
          this.curveService = okReading(!!res.Data)
          if (res.Data) this.controller = 'curve'
          return true
        }
      } catch {
        /* 落入 stale/error 分支 */
      }
      this.curveService =
        this.curveService.state === 'ok' || this.curveService.state === 'stale'
          ? staleReading(this.curveService)
          : errorReading('曲线服务状态读取失败')
      return false
    },

    /** 判定当前控制权（AutoFan.IsRunning 是 curve 的权威） */
    async resolveController(): Promise<void> {
      if (this.resolving) return
      this.resolving = true
      try {
        const running = this.curveService.value
        if (running === true) {
          this.controller = 'curve'
          return
        }
        // 曲线服务状态未知时先读一次，不拿 null 当 false 用
        if (running === null) {
          const res = await AutoFanControl.IsRunning()
          if (res.Success && res.Data) {
            this.curveService = okReading(true)
            this.controller = 'curve'
            return
          }
        }
        // AutoFan 未运行 + 配置里有持久化的手动转速 → 推断 manual（Hypothesis，见文件头）
        const { useConfigStore } = await import('@/stores/config')
        const cfg = useConfigStore().config?.Fan?.ManualFanSpeed
        this.controller = typeof cfg === 'number' && cfg > 0 ? 'manual' : 'auto'
      } finally {
        this.resolving = false
      }
    },

    /**
     * 常驻监控：转速 + 曲线服务状态。App.vue 挂载一次，切页不停。
     * 两个通道共用同一个 PollingChannel 周期，避免各页面再起一套定时器。
     */
    startMonitoring(interval = POLL_INTERVAL_FAN_SPEED): () => void {
      this.stopMonitoring()
      channel = new PollingChannel(
        async () => {
          const [speedOk, curveOk] = await Promise.all([
            this.refreshSpeed(),
            this.refreshCurveService(),
          ])
          void curveOk
          return speedOk
        },
        { intervalMs: interval },
      )
      channel.start()
      this.monitoring = true
      return () => this.stopMonitoring()
    },

    /** 本地已知状态被用户动作改变时同步读数，避免等下一拍轮询才反映 */
    setCurveService(running: boolean): void {
      this.curveService = okReading(running)
      if (running) this.controller = 'curve'
    },

    stopMonitoring(): void {
      channel?.dispose()
      channel = null
      this.monitoring = false
    },

    /** 手动设定转速（C 级可逆）。逐项：writeGate → 停 AutoFan → 写转速 → 保存配置。 */
    async applyManualSpeed(
      rpm: number,
      saveConfig: () => Promise<unknown>,
    ): Promise<FanApplyResult> {
      const steps: FanApplyResult['steps'] = []

      // 闸门（v4 §8.6 前端一致性值域 1500–5800）
      const gate = writeGate.fanManualSpeed(rpm)
      if (!gate.allowed) {
        useActivityStore().record({
          source: 'user',
          intent: `风扇手动 ${rpm} RPM`,
          requestedValue: rpm,
          outcome: 'failed',
          reversible: 'c',
        })
        return { ok: false, steps, message: gate.reason || '值被写入闸门拒绝' }
      }

      // 1. 若曲线接管中，先停（否则 EC 写入会被 AutoFan 下一拍覆盖）
      const running = await AutoFanControl.IsRunning()
      if (running.Success && running.Data) {
        const stop = await AutoFanControl.Stop()
        steps.push({ label: '停止应用内曲线', ok: !!stop.Success })
        if (!stop.Success) {
          useActivityStore().record({
            source: 'user',
            intent: `风扇手动 ${rpm} RPM`,
            requestedValue: rpm,
            outcome: 'failed',
            reversible: 'c',
          })
          return { ok: false, steps, message: '停止应用内曲线失败，未写入转速' }
        }
      } else {
        steps.push({ label: '停止应用内曲线', ok: true, skipped: true })
      }

      // 2. 写手动转速
      const set = await Fan.SetFanSpeed(rpm)
      steps.push({ label: `设定转速 ${rpm} RPM`, ok: !!set.Success, message: set.Message })
      if (!set.Success) {
        useActivityStore().record({
          source: 'user',
          intent: `风扇手动 ${rpm} RPM`,
          requestedValue: rpm,
          outcome: 'failed',
          reversible: 'c',
        })
        return { ok: false, steps, message: set.Message || '转速写入失败' }
      }

      // 3. 保存配置（开机恢复）
      const save = await saveConfig()
      steps.push({
        label: '保存配置',
        ok: !!(save as { Success?: boolean } | undefined)?.Success,
      })

      this.controller = 'manual'
      this.curveService = okReading(false)
      useActivityStore().record({
        source: 'user',
        intent: `风扇手动 ${rpm} RPM`,
        requestedValue: rpm,
        outcome: 'applied',
        reversible: 'c',
      })
      return { ok: true, steps, message: '手动转速已应用' }
    },

    /** 恢复自动控制（C 级唯一出路）。逐项：停 AutoFan（曲线场景）→ 移除手动限制。 */
    async restoreAuto(): Promise<FanApplyResult> {
      const steps: FanApplyResult['steps'] = []

      const running = await AutoFanControl.IsRunning()
      if (running.Success && running.Data) {
        const stop = await AutoFanControl.Stop()
        steps.push({ label: '停止应用内曲线', ok: !!stop.Success })
        if (!stop.Success) {
          useActivityStore().record({
            source: 'user',
            intent: '恢复自动风扇控制',
            requestedValue: null,
            outcome: 'failed',
            reversible: 'c',
          })
          return { ok: false, steps, message: '停止应用内曲线失败' }
        }
      } else {
        steps.push({ label: '停止应用内曲线', ok: true, skipped: true })
      }

      const remove = await Fan.RemoveFanSpeed()
      steps.push({ label: '移除手动转速限制', ok: !!remove.Success, message: remove.Message })
      if (!remove.Success) {
        useActivityStore().record({
          source: 'user',
          intent: '恢复自动风扇控制',
          requestedValue: null,
          outcome: 'failed',
          reversible: 'c',
        })
        return { ok: false, steps, message: remove.Message || '移除限制失败' }
      }

      this.controller = 'auto'
      this.curveService = okReading(false)
      useActivityStore().record({
        source: 'user',
        intent: '恢复自动风扇控制',
        requestedValue: null,
        outcome: 'applied',
        reversible: 'c',
      })
      return { ok: true, steps, message: '已恢复自动控制' }
    },
  },
})

/** PollingChannel 不进 pinia 响应式：模块级单例（App.vue 全局挂载一次） */
let channel: PollingChannel | null = null

/** 曲线服务轮询间隔：比转速慢一档，够用且不打扰 */
export const CURVE_SERVICE_INTERVAL = POLL_INTERVAL_SMART_FAN
