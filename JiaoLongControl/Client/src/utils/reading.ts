/**
 * ReadingState 四态契约（UI重构_最终方案_v4.md §7.1，Decision 2026-09-17）。
 *
 * 读数必须四态，不是布尔：
 * - ok          本次成功读取
 * - stale       保留最后一次有效值，并必须明确标注过期
 * - unavailable 通道不存在（如无独显）
 * - error       读取失败
 *
 * 硬规则：读取失败不得显示为真实 0；过期值必须标注，不得静默沿用。
 * 本文件是唯一权威源；消费方一律 import 此处类型，不得复制定义。
 */

export type ReadingState = 'ok' | 'stale' | 'unavailable' | 'error' | 'loading'

/**
 * 四态读数容器。value 仅在 state === 'ok' | 'stale' 时有业务意义：
 * - ok     → 最近一次成功读取的值
 * - stale  → 最后一次有效值（调用方必须渲染"过期"标注）
 * - unavailable / error → value 为 null，渲染层不得回退到 0
 */
export interface Reading<T> {
  state: ReadingState
  /** 最后一次有效值；unavailable/error 恒为 null */
  value: T | null
  /** state === 'stale' 时：最后一次 ok 的时刻（epoch ms），供"Xs 前"标注 */
  lastOkAt: number | null
  /** state === 'error' 时的失败原因（已含超时/桥接不可用等），供诊断展示 */
  message: string | null
}

export function okReading<T>(value: T): Reading<T> {
  return { state: 'ok', value, lastOkAt: Date.now(), message: null }
}

export function staleReading<T>(previous: Reading<T>): Reading<T> {
  return { state: 'stale', value: previous.value, lastOkAt: previous.lastOkAt, message: null }
}

export function freshLoading<T>(): Reading<T> {
  return { state: 'loading', value: null, lastOkAt: null, message: null }
}

export function unavailableReading<T>(message = '通道不存在'): Reading<T> {
  return { state: 'unavailable', value: null, lastOkAt: null, message }
}

export function errorReading<T>(message: string): Reading<T> {
  return { state: 'error', value: null, lastOkAt: null, message }
}

/**
 * 每通道监测调度契约（v4 §7.3）。所有轮询通道必须满足：
 * 1. 每通道最多 1 个在途请求（in-flight 锁）
 * 2. 窗口不可见时暂停
 * 3. 失败退避（连续失败翻倍，不超过上界；达硬上界停止并标记 stalled）
 * 4. 明确上界——注意：前端 8s 超时只拒绝前端 Promise，不取消已进入
 *    WebView2/COM/宿主的调用（v4 §7.2）；本调度器通过"在途不释放就不发下一发"
 *    限制新请求进入，配合 bridge.ts 的 cached() 在途去重构成前端侧上界。
 *    宿主侧上界属 Server 职责，另行落实（v4 §7.3）。
 */
export interface PollingChannelOptions {
  /** 基础轮询间隔 ms */
  intervalMs: number
  /** 失败退避上界 ms（默认 30s） */
  maxBackoffMs?: number
  /** 连续失败达到该次数后停止轮询并进入 stalled（默认 5） */
  maxConsecutiveFailures?: number
  /** 是否在窗口不可见时暂停（默认 true） */
  pauseWhenHidden?: boolean
}

export const POLL_DEFAULTS = {
  maxBackoffMs: 30_000,
  maxConsecutiveFailures: 5,
  pauseWhenHidden: true,
} as const

/**
 * 统一监测调度器。替代各页面自建的裸 setInterval（v4 §3.2：systemInfo.ts:124-128）。
 * 一次 tick = 一次 attempt()；attempt 内部自行做在途判重，返回是否成功。
 */
export class PollingChannel {
  private timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null
  private backoffMs = 0
  private consecutiveFailures = 0
  private stalled = false
  private disposed = false
  private readonly opts: Required<PollingChannelOptions>

  constructor(
    private readonly attempt: () => Promise<boolean>,
    options: PollingChannelOptions,
  ) {
    this.opts = {
      maxBackoffMs: POLL_DEFAULTS.maxBackoffMs,
      maxConsecutiveFailures: POLL_DEFAULTS.maxConsecutiveFailures,
      pauseWhenHidden: POLL_DEFAULTS.pauseWhenHidden,
      ...options,
    }
    if (this.opts.pauseWhenHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }
  }

  /** 启动；重复调用幂等。stalled 后需先 reset() 才能再启动。立即打第一拍，避免首屏空等一个间隔。 */
  start(): void {
    if (this.disposed || this.stalled || this.timer !== null) return
    this.schedule(0)
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 失败停转后的手动复活入口（如用户重新进入页面） */
  reset(): void {
    this.consecutiveFailures = 0
    this.backoffMs = 0
    this.stalled = false
  }

  get isStalled(): boolean {
    return this.stalled
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
    }
  }

  private onVisibilityChange = (): void => {
    if (!this.opts.pauseWhenHidden) return
    if (document.hidden) {
      this.stop()
    } else if (!this.stalled) {
      this.start()
    }
  }

  /** tick 完成后按结果调度下一次：成功回基础间隔，失败按退避翻倍 */
  private tick = async (): Promise<void> => {
    this.timer = null
    if (this.disposed || this.stalled) return
    let success: boolean
    try {
      success = await this.attempt()
    } catch {
      success = false
    }
    if (this.disposed) return
    if (success) {
      this.consecutiveFailures = 0
      this.backoffMs = 0
    } else {
      this.consecutiveFailures += 1
      this.backoffMs = Math.min(
        this.backoffMs === 0 ? this.opts.intervalMs : this.backoffMs * 2,
        this.opts.maxBackoffMs,
      )
    }
    if (this.consecutiveFailures >= this.opts.maxConsecutiveFailures) {
      this.stalled = true
      return
    }
    this.schedule(this.backoffMs > 0 ? this.backoffMs : this.opts.intervalMs)
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return
    this.timer = setTimeout(this.tick, delayMs)
  }
}
