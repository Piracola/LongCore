/**
 * 统一操作事件模型（UI重构_最终方案_v4.md §8.1/§8.2/§8.4，Decision 2026-09-17）。
 *
 * 核心区分（v4 §2 第一性原则 1）：用户必须能区分
 * 「我想设置的值」(requestedValue) / 「命令已发送」(commandAccepted) / 「硬件实际值」(postRead)。
 *
 * 回读校验的真实约束（v4 §8.4，源自 MethodServices.cs:92-100 的刻意决定）：
 * - 写响应回显不可用作校验依据（命令 23 合法不回显命令码，硬比对会把成功写成失败）
 * - 校验 = 写后独立重读（verify 字段独立发起 Get）
 * - 无可靠 getter 的参数 → verifiable = false，只能标注「仅命令确认，不可回读」
 * - 不得把「命令已接受」渲染成「已生效」
 */

/** 操作来源 —— 来源不同，权限与提示不同（v4 §8.1） */
export type OperationSource = 'user' | 'startup-restore' | 'auto-fan' | 'thermal-watchdog' | 'fn-hotkey'

/** 传输通道（v4 §8.1） */
export type OperationTransport = 'wmi' | 'ec' | 'smu' | 'nvapi' | 'powercfg' | 'config'

/**
 * 可逆性五级（v4 §8.2）。硬规则：只有 level === 'a' 才允许 UI 出现「回滚/撤销」字样。
 * - a  可安全逆转：有 getter + setter（如键盘颜色）→ 「撤销」
 * - b  只能重新应用：SMU 限制（原值未必可读）→ 「改回 …」
 * - c  只能恢复默认/自动：风扇手动接管 → 「恢复自动控制」
 * - d  需要重启：GPU 输出模式 → 「重启后生效」+ 重启引导
 * - e  不可逆：前置二次确认，不得提供撤销
 */
export type ReversibilityLevel = 'a' | 'b' | 'c' | 'd' | 'e'

/** 写后校验：独立重读的结果（不是比对写响应回显） */
export interface PostReadVerify {
  /** 是否存在可靠 getter（无则只能 commandAccepted 级） */
  verifiable: boolean
  /** 写后独立重读到的值；verifiable=false 或未执行时为 null */
  value: number | string | boolean | null
  /** 校验结论：null=未执行；true=重读值与请求一致；false=不一致或重读失败 */
  matches: boolean | null
}

/** 复合操作中的单步结果（v4 §8.3：逐步报告成功/失败/跳过） */
export interface OperationStep {
  label: string
  transport: OperationTransport
  requestedValue: number | string | boolean | null
  /** 命令是否被接受（不等于写入生效） */
  commandAccepted: boolean
  /** 写后独立重读（存在可靠 getter 时） */
  verify: PostReadVerify
  /** skipped：复合操作中因前置失败/无操作语义(如 CO=0)而跳过 */
  status: 'success' | 'failed' | 'skipped'
  message: string | null
}

/** 统一操作事件（v4 §8.1 十字段） */
export interface OperationEvent {
  source: OperationSource
  transport: OperationTransport
  /** 用户想设置的值 */
  requestedValue: number | string | boolean | null
  /** 写入前原值，以及它是否可靠可读（null + readable=false = 无 getter） */
  preRead: { value: number | string | boolean | null; readable: boolean } | null
  /** 命令是否被接受 —— 与「已生效」严格区分 */
  commandAccepted: boolean
  /** 写后重读（复合操作为最后一步的重读；单步操作即本步） */
  postRead: PostReadVerify | null
  reversible: ReversibilityLevel
  /** 安全补偿动作描述（如「恢复自动风扇」「重启后生效」）；null=无 */
  compensation: string | null
  /** 复合操作中每一步的结果；单步操作为一元素数组 */
  steps: OperationStep[]
  /** 当前是否处于部分应用状态（复合操作中途失败） */
  partialApplied: boolean
}

/** 最近活动环形缓冲条目（v4 §8.5：只承载「用户意图级」第一层，不得被看门狗写入冲掉） */
export interface ActivityRecord {
  /** 单调递增序号 */
  seq: number
  at: number
  source: OperationSource
  /** 人类可读的一句话意图，如「风扇手动 3200 RPM」「切到狂飙」 */
  intent: string
  /** 请求值（若有） */
  requestedValue: number | string | boolean | null
  outcome: 'accepted' | 'applied' | 'failed' | 'partial'
  reversible: ReversibilityLevel
}

/**
 * 最近活动环形缓冲（v4 §8.5，建议 200 条）。
 * 只记录用户意图级事件：record() 由用户操作路径调用；
 * auto-fan / thermal-watchdog 的底层写入不得进入本缓冲。
 */
export class ActivityLog {
  private readonly buffer: ActivityRecord[] = []
  private nextSeq = 1

  constructor(private readonly capacity = 200) {}

  record(entry: Omit<ActivityRecord, 'seq' | 'at'>): void {
    this.buffer.push({ ...entry, seq: this.nextSeq++, at: Date.now() })
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity)
    }
  }

  /** 最新在前，便于直接渲染 */
  recent(count = 50): ActivityRecord[] {
    return this.buffer.slice(-count).reverse()
  }

  get size(): number {
    return this.buffer.length
  }
}

/**
 * 写后独立重读辅助：执行一次 getter 并产出 PostReadVerify。
 * 与写响应回显无关 —— 命令 23 不回显命令码，硬比对会把成功报成失败（v4 §4.5）。
 */
export async function verifyAfterWrite(
  getter: () => Promise<{ Success: boolean; Data?: unknown; Message?: string }>,
  expected: number | string | boolean | null,
): Promise<PostReadVerify> {
  try {
    const res = await getter()
    if (!res.Success) {
      return { verifiable: true, value: null, matches: false }
    }
    const read = (res.Data ?? null) as number | string | boolean | null
    return { verifiable: true, value: read, matches: read === expected }
  } catch {
    return { verifiable: true, value: null, matches: false }
  }
}
