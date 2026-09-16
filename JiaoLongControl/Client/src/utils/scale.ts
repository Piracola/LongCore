/**
 * 刻度 / 读数的**组件语法** —— 注意：不是业务权威。
 *
 * 见 `docs/UI重构_最终方案_v4.md` §7（状态真实性契约）与 §12（视觉层）。
 *
 * 本文件的前一版内置了一张 SCALES 权威表，把温度/功耗/转速/噪声统一成
 * 「同一套零点 + 分档 + 阈值」。**该做法已被否决** —— 各量纲语义不同：
 *   · 温度有明确的危险阈值
 *   · 使用率 100% 不一定危险
 *   · CPU 功耗的合理区间取决于性能模式与机型
 *   · 电压不是「越高越危险」
 *   · 噪声是由 RPM 插值出的**估算值**，不是声压测量
 * 而且那张表**复制**了 `temperature.ts` 的阈值、却用了 `>=` 边界（70℃ 恰好落在
 * 两侧），并丢掉了 `tempLevelHys` 的滞回 —— 制造了第二个真相源。
 *
 * 因此本文件只提供**语法**：量程与阈值必须由调用方从**可追溯的来源**传入。
 * **温度的量程与分档必须来自 `src/utils/temperature.ts`，不得在此复制。**
 *
 * 硬约束：
 * 1. 纯计算、无副作用、无动效 —— 组件才能对读数做「零过渡」（docs/07）。
 * 2. **无法判定时返回 null，绝不返回 0。** 传 0 与传 null 是两件事：
 *    前者是「真的是 0」，后者是「没读到」。这是 0 值写入事故的机制化防线。
 */

/** 读数的四态（§7）。不是布尔。 */
export type ReadingState = 'ok' | 'stale' | 'unavailable' | 'error'

/**
 * 某量纲的刻度量程。**必须由调用方提供，且必须可追溯到来源。**
 * 不要在这里建全局表。
 */
export type QuantitySpec = {
  readonly min: number
  readonly max: number
  /**
   * 分档阈值（升序）。
   * 无安全语义的量纲请传空数组 —— 不要强行分红黄绿。
   */
  readonly thresholds?: readonly number[]
}

export type Reading = {
  /** 0..1，已钳制 */
  readonly ratio: number
  /** 0..thresholds.length */
  readonly band: number
  /** 阈值在刻度上的位置（0..1）—— 这是「刻度条」区别于「进度条」的唯一东西 */
  readonly markers: readonly number[]
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * 归一化一次读数。**无法判定时返回 null，不返回 0。**
 * 调用方必须显式处理 null —— 渲染「未读取」，或整条刻度置灰。
 */
export function resolveReading(
  spec: QuantitySpec,
  value: number | null | undefined,
): Reading | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null

  const thresholds = spec.thresholds ?? []
  const span = spec.max - spec.min
  if (span <= 0) return { ratio: 0, band: 0, markers: [] }

  let band = 0
  for (const t of thresholds) {
    if (value >= t) band += 1
  }

  return {
    ratio: clamp01((value - spec.min) / span),
    band,
    markers: thresholds.map((t) => clamp01((t - spec.min) / span)),
  }
}

/** 该值是否不可判定。用于空态渲染与禁用依赖它的操作。 */
export function isUnread(value: number | null | undefined): boolean {
  return (
    value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)
  )
}

/** 未读取状态的统一文案。全站一份，避免各页各写「--」/「N/A」/「0」。 */
export const UNREAD_LABEL = '未读取'