/**
 * 领域状态对象契约（UI重构_最终方案_v4.md §6，Decision 2026-09-17）。
 *
 * 七个状态对象各自的权威来源（v4 §6 + §14.1 答复 1：模式 = 预设选择器）：
 *
 * | 对象                    | 权威来源                          | 说明 |
 * |-------------------------|-----------------------------------|------|
 * | ObservedFirmwareMode    | EC 命令 8 / Fn 热键事件 15        | 固件真实档位，只有三档（v4 §14.2 冲突 B 裁定：按三档做） |
 * | CustomPowerOverride     | EC 命令 23 子状态                 | 自定义功耗覆盖：开/关，是命令 23 的子状态，不是固件第四档 |
 * | SelectedConfigProfile   | 前端本地（用户点选）              | 我选了什么 ≠ 已应用；选择即记，不产生任何虚假激活态 |
 * | AppliedConfigProfile    | config.yaml（后端持久化）         | 上次完整应用成功的那份配置块 |
 * | WindowsPowerPlanState   | powercfg 查询                     | 独立、可失败；是模式切换的可选联动副作用 |
 * | FanPolicy               | EC 手动转速寄存器 + AutoFan 运行态| 手动接管/自动/曲线，显示"当前由谁控制" |
 * | GPUPerformancePolicy    | NVAPI（锁频/输出模式）            | 输出模式切换需重启，属 D 级可逆性 |
 *
 * 命名映射（Decision 2026-09-17，用户确认）：办公=静音(QuietMode=2) · 游戏=平衡(BalanceMode=0) ·
 * 狂飙=高性能(PerformanceMode=1)。UI 文案层用「办公/游戏/狂飙」，协议层与代码层保留枚举名。
 * 本文件只定义类型与映射常量，不改任何现有行为（v4 §13 Phase 2 的落地在步骤 2 完成）。
 */

import { SystemPerMode } from '@/utils/bridge'

/** 固件观察档位 —— 命令 8 只有 0/1/2 三档；CustomMode=3 是本地逻辑态，固件不回传 */
export type FirmwareMode = 'balance' | 'performance' | 'quiet'

/** 命令 23 子状态：自定义功耗覆盖，开/关 —— 不是固件第四档 */
export interface CustomPowerOverride {
  active: boolean
}

/** 预设档位的持久化配置块（CPU.vue 的 Default/Performance/Saving/Custom），≠ 当前硬件状态 */
export type ConfigProfileKey = 'Default' | 'Performance' | 'Saving' | 'Custom'

/** 我选了什么 —— 用户点选即记录；与「已应用」必须分离（v4 §6） */
export interface SelectedConfigProfile {
  key: ConfigProfileKey
  /** 该选择是否已经成功应用；false = 有未应用的选中变更 */
  applied: boolean
}

/** 已完整应用成功的配置块 —— 写后独立重读或保存成功才可置位 */
export interface AppliedConfigProfile {
  key: ConfigProfileKey
  appliedAt: number
}

/** Windows 电源计划 —— 独立可失败的联动副作用，不阻止固件切换 */
export type WindowsPowerPlanState = 'follow-mode' | 'manual' | 'unavailable'

/**
 * 风扇控制权状态机（v4 §6 FanPolicy + §10「自动策略接管必须显示当前由谁控制」）。
 * - auto    EC 固件自动温控（默认；无手动转速寄存器值且 AutoFan 未运行）
 * - manual  用户手动接管（SetFanSpeed 已下发；AutoFan 已停）
 * - curve   应用内曲线接管（AutoFanControl 正在运行）
 */
export type FanController = 'auto' | 'manual' | 'curve'

export interface FanPolicy {
  controller: FanController
}

/** GPU 性能策略 —— 锁频可逆；输出模式需重启（D 级可逆性，v4 §8.2） */
export interface GPUPerformancePolicy {
  coreClockLocked: boolean
  memoryClockLocked: boolean
  /** hybrid | discrete —— 切换需重启生效，不得伪装即时成功 */
  outputModePendingReboot: boolean
}

/** 固件档位 → UI 显示名（命名映射 Decision 2026-09-17；桥接枚举为权威数值） */
export const FIRMWARE_MODE_LABELS: Record<FirmwareMode, string> = {
  quiet: '办公',
  balance: '游戏',
  performance: '狂飙',
}

/** 桥接 SystemPerMode（0/1/2 三档）→ 领域固件档位；CustomMode=3 / Unknow 不得进入 */
export function toFirmwareMode(mode: SystemPerMode): FirmwareMode | null {
  switch (mode) {
    case SystemPerMode.BalanceMode:
      return 'balance'
    case SystemPerMode.PerformanceMode:
      return 'performance'
    case SystemPerMode.QuietMode:
      return 'quiet'
    default:
      return null
  }
}
