import { defineStore } from 'pinia'
import { Fan, AutoFanControl, type FanSpeedInfo } from '@/utils/bridge'
import { type ActivityRecord } from '@/domain/operations'
import { useActivityStore } from '@/stores/activity'
import { okReading, staleReading, errorReading, type Reading } from '@/utils/reading'
import { PollingChannel } from '@/utils/reading'
import type { FanController } from '@/domain/modes'
import { POLL_INTERVAL_FAN_SPEED, POLL_INTERVAL_SMART_FAN } from '@/constants'

/**
 * 风扇策略 store —— 第一个垂直切片（UI重构_最终方案_v4.md §11，Implemented 2026-09-17）。
 *
 * FanPolicy 状态机（v4 §6 + §10「自动策略接管必须显示当前由谁控制」）：
 * - auto    EC 固件自动温控（默认；AutoFan 未运行）
 * - curve   应用内曲线接管（AutoFanControl 运行中）
 *
 * 判定权威：AutoFan.IsRunning()（曲线）→ auto。
 * 「手动设定转速」已在 2026-10-06 删除（机主 Decision），原 manual 态与它的
 * Hypothesis 判定一并消失：EC 本来就区分不出「固件自动」与「残留手动值」。
 *
 * 唯一出口（v4 §8.2 C 级）：曲线页「交还 EC 固件温控」—— 停曲线服务 + `Fan.RemoveFanSpeed`
 * 撤 0xB20 手动掩码 + 把 `Fan.Enabled` 落盘为 false（`useFanCurveEditor.handleHandoffToEc`，
 * 与看板 fan.curve 的「移除」同一组三步）。不得出现「回滚/撤销」措辞。
 * 2026-10-06：本 store 原有的 `restoreAuto()` 是这一出口的第二份实现，其唯一调用方
 * （「风扇」页）随该页删除已在 72b1325 消失；零引用 + 与曲线页口径重复 + 只按
 * `AutoFanControl.Stop().Success` 判成败（正是 FIX-1 的假失败），故整个删除，出口只留一处。
 *
 * 最近活动（v4 §8.5）：200 条环形缓冲，只记用户意图级；
 * 自动风扇曲线 / 温控看门狗的底层写入不得进入（它们的写入不经过本 store）。
 *
 * 常驻监控（2026-09-21）：转速与曲线服务状态由 App.vue 全局起调度，
 * 不再依赖「进入风扇页才开始读」—— 旧实现下切页后曲线页/风扇页读数会假死。
 */

// 控制权枚举的单一源在 domain/modes.ts（v4 §6 FanPolicy）；这里只做转出，
// 避免出现第二份定义（两处各写一次，迟早分叉）。
// 注意：只写 export type {…} from 不会建立本地绑定，本文件自己要用就得再 import 一次。
export type { FanController }

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
      return { auto: 'EC 自动温控', curve: '应用内曲线' }[this.controller]
    },
    /**
     * 应用内曲线能否接管风扇。
     *
     * 历史上这里按性能档位设限（固件三档交给 EC 的温控表）。实测与官方日志表明：
     * EC 那张表在低负载区把转速压得极低、临近温度墙（默认 95℃）才跳变，
     * 表现就是"平时很静、到墙才猛拉"，而这正是本项目要解决的问题。
     * 因此该限制已取消：三档与自定义档一视同仁，控制权归谁由曲线服务本身决定。
     * 恒为 false 只是保留调用点的语义，不再参与禁用判断。
     */
    customizationLocked(): boolean {
      return false
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
        // 契约（v4 §14.11，2026-10-06 起）：IsRunning 恒 Success=true，运行态在 Data。
        // 旧契约把运行态塞进 Success，于是"曲线没在跑"（Success=false, Data=false）会被这里
        // 判成"读取失败"——正常的"没在跑"读不回来，只能显示 stale/error。
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
        // 曲线服务未运行 → EC 固件自动温控（唯一剩下的第二种控制权）
        this.controller = 'auto'
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
  },
})

/** PollingChannel 不进 pinia 响应式：模块级单例（App.vue 全局挂载一次） */
let channel: PollingChannel | null = null

/** 曲线服务轮询间隔：比转速慢一档，够用且不打扰 */
export const CURVE_SERVICE_INTERVAL = POLL_INTERVAL_SMART_FAN
