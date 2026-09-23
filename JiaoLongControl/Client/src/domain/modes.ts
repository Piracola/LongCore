/**
 * 领域状态对象契约（UI重构_最终方案_v4.md §6，Decision 2026-09-17）。
 *
 * 状态对象清单（v4 §6 + §14.1 答复 1：模式 = 预设选择器）。**只列真实存在的契约**：
 * 没落地的概念写在下面第二段里，不在这里声明空类型（2026-09-24 收口）。
 *
 * | 对象                     | 权威来源                           | 落地位置 |
 * |--------------------------|------------------------------------|----------|
 * | ObservedFirmwareMode     | EC 命令 8 / Fn 热键事件 15         | stores/mode.ts `observedFirmware`（只有三档，见 v4 §14.2 冲突 B 裁定） |
 * | CustomPowerOverride      | EC 命令 23 子状态                  | stores/mode.ts `customOverride`（不是固件第四档） |
 * | SelectedMode（我选了什么）| 前端本地（用户点选）               | stores/mode.ts `selected` + `activeKind`（pending 不冒充已生效） |
 * | FanPolicy                | EC 手动转速寄存器 + AutoFan 运行态 | stores/fan.ts（手动/自动/曲线，显示"当前由谁控制"） |
 *
 * **未落地**（2026-09-24 决定：不为它们声明空类型）：`WindowsPowerPlanState`（powercfg 状态）、
 * `GPUPerformancePolicy`（NVAPI 锁频/输出模式）。设置页只保留「是否联动电源计划」开关；
 * GPU 锁频与输出模式由 GPU 页、显卡直连设置页各自管理。真要接上时，连同权威来源一起补进上表。
 *
 * **已废除**：`SelectedConfigProfile` / `AppliedConfigProfile` —— CPU「均衡/性能/节能/自定义」
 * 四方案表已合并为唯一的 `Cpu.Custom`，这个轴不存在了。
 *
 * 命名映射（Decision 2026-09-17，用户确认）：办公=静音(QuietMode=2) · 游戏=平衡(BalanceMode=0) ·
 * 狂飙=高性能(PerformanceMode=1)。UI 文案层用「办公/游戏/狂飙」，协议层与代码层保留枚举名。
 */

import { SystemPerMode } from '@/utils/bridge'

/** 固件观察档位 —— 命令 8 只有 0/1/2 三档；CustomMode=3 是本地逻辑态，固件不回传 */
export type FirmwareMode = 'balance' | 'performance' | 'quiet'

/** 命令 23 子状态：自定义功耗覆盖，开/关 —— 不是固件第四档 */
export interface CustomPowerOverride {
  active: boolean
}

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
