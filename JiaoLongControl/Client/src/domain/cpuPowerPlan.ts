/**
 * CPU 功耗覆盖的唯一下发口径 —— 首页「自定义」与 CPU 页共用。
 *
 * 边界（刻意写清楚，避免再出现"两个地方各说各话"）：
 * - 固件三档（办公/游戏/狂飙）由 EC 自己的功耗表管理，本模块**不写命令 8**；
 * - 本模块只做「自定义功耗覆盖」：先打开命令 23 自定义功耗子状态，再下发
 *   SPL / SPPT / 温度墙 / 最大频率 / 睿频（顺序与官方实现一致，官方把这三项
 *   严格包在 OpenState 之后，否则 EC 拒绝写入）；
 * - 参数只有一个来源：config.yaml 的 `Cpu.Custom`（改滑条即存盘，点「应用」才下发）。
 */
import { CPU, Power, RyzenSmu } from '@/utils/bridge'
import type { CpuPowerDataType } from '@/types/config'
import { useCompositeWrite } from '@/composables/useCompositeWrite'
import { useConfigStore } from '@/stores/config'
import { writeGate } from '@/domain/writeGate'
import type { OperationSource } from '@/domain/operations'

type CompositeRunOptions = Parameters<ReturnType<typeof useCompositeWrite>['run']>[0]

/** 构造「应用自定义功耗参数」的复合写入计划（CPU 页需要逐步 UI，首页只要最终结果） */
export function buildCpuPowerRun(
  source: OperationSource,
  profile: CpuPowerDataType,
  coValue: number,
): CompositeRunOptions {
  const configStore = useConfigStore()
  return {
    source,
    transport: 'wmi',
    requestedValue: `${profile.CpuLongPower}W / ${profile.CpuShortPower}W / ${profile.CpuTempWall}°C / ${profile.CpuMaxFrequency}MHz / turbo=${profile.CpuTurbo}`,
    reversible: 'b',
    // B 级可逆性：只能重新应用另一组值，不得宣称回滚
    compensation: '如需改回，请重新调整参数后再次应用',
    preRead: null,
    steps: [
      {
        label: '进入自定义功耗模式',
        transport: 'wmi',
        requestedValue: 'OpenState',
        run: () => CPU.SetCustomMode(true),
      },
      {
        label: `温度墙 ${profile.CpuTempWall}°C`,
        transport: 'wmi' as const,
        requestedValue: profile.CpuTempWall,
        run: async () => {
          const gate = writeGate.cpuPower('CpuTempWall', Number(profile.CpuTempWall))
          if (!gate.allowed) {
            return { accepted: false, message: gate.reason ?? '值被写入闸门拒绝' }
          }
          return CPU.SetCPUTempWall(profile.CpuTempWall)
        },
      },
      {
        label: `长时功耗 ${profile.CpuLongPower}W`,
        transport: 'wmi' as const,
        requestedValue: profile.CpuLongPower,
        run: async () => {
          const gate = writeGate.cpuPower('CpuLongPower', Number(profile.CpuLongPower))
          if (!gate.allowed) {
            return { accepted: false, message: gate.reason ?? '值被写入闸门拒绝' }
          }
          return CPU.SetCpuLongPower(profile.CpuLongPower)
        },
      },
      {
        label: `短时功耗 ${profile.CpuShortPower}W`,
        transport: 'wmi' as const,
        requestedValue: profile.CpuShortPower,
        run: async () => {
          const gate = writeGate.cpuPower('CpuShortPower', Number(profile.CpuShortPower))
          if (!gate.allowed) {
            return { accepted: false, message: gate.reason ?? '值被写入闸门拒绝' }
          }
          return CPU.SetCpuShortPower(profile.CpuShortPower)
        },
      },
      {
        label: `最大频率 ${profile.CpuMaxFrequency}MHz`,
        transport: 'wmi' as const,
        requestedValue: profile.CpuMaxFrequency,
        run: async () => {
          const gate = writeGate.cpuPower('CpuMaxFrequency', Number(profile.CpuMaxFrequency))
          if (!gate.allowed) {
            return { accepted: false, message: gate.reason ?? '值被写入闸门拒绝' }
          }
          return Power.SetCPUMaxFrequency(profile.CpuMaxFrequency)
        },
      },
      {
        label: profile.CpuTurbo ? '开启睿频' : '关闭睿频',
        transport: 'wmi',
        requestedValue: profile.CpuTurbo,
        run: () => (profile.CpuTurbo ? Power.EnableTurbo() : Power.DisableTurbo()),
      },
      {
        label: '核心电压偏移 (CO)',
        transport: 'smu' as const,
        requestedValue: coValue,
        // CO=0 的语义是「不偏移」，属无操作 —— 跳过不报失败（避免 PawnIO 缺失误报）
        skippable: () => coValue === 0,
        run: async () => {
          const gate = writeGate.smu('CurveOptimizerAll', Number(coValue))
          if (!gate.allowed) {
            return { accepted: false, message: gate.reason ?? '值被写入闸门拒绝' }
          }
          return RyzenSmu.SetCurveOptimizerAll(coValue)
        },
      },
      {
        label: '保存配置',
        transport: 'config',
        requestedValue: 'save',
        run: async () => {
          const res = await configStore.saveConfig()
          return { accepted: !!res?.Success, message: res?.Message }
        },
      },
    ],
  }
}

export interface CpuPowerApplyResult {
  accepted: boolean
  partialApplied: boolean
  failed: number
  skipped: number
  message: string | null
}

/**
 * 直接下发 config.yaml 里保存的那套 CPU 功耗参数（无 UI 版本）。
 * 首页胶囊的「自定义」走这里 —— 保证「首页自定义 = CPU 页保存的参数」是同一条路径。
 */
export async function applySavedCpuPower(source: OperationSource): Promise<CpuPowerApplyResult> {
  const configStore = useConfigStore()
  if (!configStore.config) await configStore.fetchConfig()

  const profile = configStore.config?.Cpu?.Custom
  if (!profile) {
    return {
      accepted: false,
      partialApplied: false,
      failed: 0,
      skipped: 0,
      message: '未读到 CPU 功耗参数',
    }
  }

  const composite = useCompositeWrite()
  const event = await composite.run(
    buildCpuPowerRun(source, profile, configStore.config?.Smu?.CurveOptimizerAll ?? 0),
  )
  const { failed, skipped } = composite.summary.value
  return {
    accepted: !event.partialApplied && failed === 0,
    partialApplied: event.partialApplied,
    failed,
    skipped,
    message: composite.state.value.message,
  }
}
