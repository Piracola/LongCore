/**
 * 写入闸门（UI重构_最终方案_v4.md §8.6，Decision 2026-09-17）。
 *
 * 前端单一闸门：全部 setter 收口于此，替代 RyzenSmu.vue 内联的 ZERO_UNWRITABLE。
 * 前端不是唯一防线 —— Server 侧 HwWriteGate（命令白名单/值域/令牌桶）是第二道，
 * 保持并扩展，本文件不碰 Server。
 *
 * 规则表来源：
 * - ZERO_UNWRITABLE 12 项：从 RyzenSmu.vue 原样迁入（限制型 setter 值 0 拒绝写入，
 *   因读取失败会被渲染成 0，直接下发即是把 0 写进固件限制）。
 * - SMU 值域：与 RyzenSmu.vue CONFIG_GROUPS 的滑条 min/max 一致（前端一致性校验；
 *   真机安全上下限待 v4 §14.3 #5 确认后由 Server 侧权威化）。
 * - 风扇手动转速：FAN_MIN_RPM/FAN_MAX_RPM = 1500/5800（constants/index.ts，与
 *   AutoFanControl.cs MIN_FAN_BYTE/MAX_FAN_BYTE 一致）。
 */

export type WriteDomain = 'smu' | 'fan' | 'mode' | 'gpu' | 'keyboard' | 'power' | 'other'

export interface WriteRule {
  /** 值为 0 时拒绝（限制型参数：0 多为读取失败渲染值，非合法意图） */
  zeroUnwritable?: boolean
  /** 前端一致性值域；越界拒绝。null = 本前端不做值域校验（Server 侧仍守门） */
  range?: { min: number; max: number } | null
  /** 可逆性等级（v4 §8.2） */
  reversibility: 'a' | 'b' | 'c' | 'd' | 'e'
}

/** SMU 限制型 setter：0 不可写（原 RyzenSmu.vue ZERO_UNWRITABLE 12 项，原样迁入） */
const SMU_ZERO_UNWRITABLE = new Set([
  'StapmLimit',
  'StapmTime',
  'FastLimit',
  'SlowLimit',
  'SlowTime',
  'PptLimitRsmu',
  'VrmCurrentMp1',
  'VrmCurrentRsmu',
  'EdcLimitMp1',
  'EdcLimitRsmu',
  'TempLimitMp1',
  'TempLimitRsmu',
])

/** SMU 值域（前端一致性，与 RyzenSmu.vue CONFIG_GROUPS 滑条一致） */
const SMU_RANGES: Record<string, { min: number; max: number }> = {
  StapmLimit: { min: 0, max: 200 },
  StapmTime: { min: 0, max: 3600 },
  FastLimit: { min: 0, max: 200 },
  SlowLimit: { min: 0, max: 200 },
  SlowTime: { min: 0, max: 3600 },
  PptLimitRsmu: { min: 0, max: 200 },
  VrmCurrentMp1: { min: 0, max: 300000 },
  VrmCurrentRsmu: { min: 0, max: 300000 },
  EdcLimitMp1: { min: 0, max: 300000 },
  EdcLimitRsmu: { min: 0, max: 300000 },
  TempLimitMp1: { min: 40, max: 100 },
  TempLimitRsmu: { min: 40, max: 100 },
  PboScalar: { min: 1, max: 10 },
  OcClk: { min: -500, max: 500 },
  OcVolt: { min: 0, max: 1550 },
  CurveOptimizerAll: { min: -30, max: 0 },
  CurveOptimizerPerCore: { min: -30, max: 0 },
  // Server 端 arg = (coreIdx << 8) | (mhz & 0xFF)：超过 255 会被静默截断，
  // 写入的将不是用户看到的值 —— 前端必须先把上限卡死在这里。
  PerCoreOcClk: { min: 0, max: 255 },
}

/** CPU 功耗参数值域（与 Server CpuPowerData 的 ConfigRange 注解一致） */
const CPU_POWER_RANGES: Record<string, { min: number; max: number }> = {
  CpuLongPower: { min: 5, max: 120 },
  CpuShortPower: { min: 5, max: 120 },
  CpuTempWall: { min: 40, max: 100 },
  CpuMaxFrequency: { min: 2000, max: 6000 },
}
export interface WriteGateDecision {
  allowed: boolean
  /** 拒绝原因；允许时为 null */
  reason: string | null
}

function check(rule: WriteRule | undefined, value: number): WriteGateDecision {
  if (!rule) return { allowed: true, reason: null }
  if (rule.zeroUnwritable && (!Number.isFinite(value) || value === 0)) {
    return {
      allowed: false,
      reason: '该值当前为 0（多为读取失败），已阻止写入。请先设定有效数值。',
    }
  }
  if (rule.range && (!Number.isFinite(value) || value < rule.range.min || value > rule.range.max)) {
    return {
      allowed: false,
      reason: `值 ${value} 超出范围 ${rule.range.min}–${rule.range.max}，已阻止写入。`,
    }
  }
  return { allowed: true, reason: null }
}

/**
 * 前端写入闸门。所有 setter 调用前必须过此闸；返回的 reason 应直接展示给用户。
 */
export const writeGate = {
  /**
   * CPU 功耗参数（home 的「自定义」与 CPU 页共用 cpuPowerPlan 下发）。
   * 之前这条路径完全绕开闸门：滑条 min/max 只挡 UI 输入，挡不住手工改过的
   * config.yaml 或旧配置残留的越界值 —— 下发前必须同样校验。
   * 范围与 Server CpuPowerData 的 ConfigRange 属性注解保持一致。
   */
  cpuPower(field: string, value: number): WriteGateDecision {
    const range = CPU_POWER_RANGES[field] ?? null
    // 睿频是布尔，不走数值值域
    if (!range) return { allowed: true, reason: null }
    return check({ range, reversibility: 'b' }, value)
  },

  /** SMU setter（RyzenSmu 页 15+ 项） */
  smu(itemKey: string, value: number): WriteGateDecision {
    const zero = SMU_ZERO_UNWRITABLE.has(itemKey)
    const range = SMU_RANGES[itemKey] ?? null
    return check({ zeroUnwritable: zero, range, reversibility: 'b' }, value)
  },

  /** 风扇手动转速（RPM）。C 级：只能恢复自动控制，不得宣称回滚 */
  fanManualSpeed(rpm: number): WriteGateDecision {
    return check({ range: { min: 1500, max: 5800 }, reversibility: 'c' }, rpm)
  },

  /** 性能模式切换（预设选择器）。B 级：只能重新应用（重新选档），非回滚 */
  modeSwitch(): WriteGateDecision {
    return { allowed: true, reason: null }
  },

  /** GPU 锁频/功耗墙/温度墙（前端一致性；NVAPI 侧 Server 另有校验） */
  gpu(value: number, range: { min: number; max: number }): WriteGateDecision {
    return check({ range, reversibility: 'b' }, value)
  },

  /** 键盘颜色（A 级：有 getter + setter，允许「撤销」措辞） */
  keyboardColor(): WriteGateDecision {
    return { allowed: true, reason: null }
  },
}
