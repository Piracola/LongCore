/**
 * 已应用功能注册表（唯一真源）——「它到底动了哪些、还生不生效」+「能不能退出」。
 *
 * 背景（本轮交付）：软件会改写硬件（EC 风扇、CPU 功耗、GPU 超频、SMU、键盘灯、自启），
 * 但用户看不出哪些还生不生效；各页「重置」语义也不一致 —— CPU.vue:184-194 与
 * RyzenSmu.vue:363-372 的重置只改表单+存盘、不下发硬件；Fan.vue:124-126 与
 * GPU.vue:308-337 的重置真下发。本模块把「意图 vs 实测」变成可看见、可退出的两栏。
 *
 * 硬规则（v4 §8.2/§8.4 + 本次交付约束）：
 * - 本文件是纯数据 + 纯函数，不 import Vue，也不 import pinia/桥接调用；
 *   组件只负责画，判定必须能在 vitest 里无 DOM 直接调用。
 * - 回读方法 = null 或可逆级别 = e 的项**禁止**挂可点的「移除」，
 *   只能显示「无法还原 + 原因」（见 canRemoveFeature / REMOVAL_BLOCKED_*）。
 * - 读不到就写「不可回读」/「读取失败」，**禁止回退成 0、false 或默认值**（v4 §7.1）。
 * - 意图与实测不一致时必须显式暴露，尤其是「配置开着、硬件没写进去」。
 * - 「硬件当前是否真的生效」是 `FeatureVerdict.observedActive` 一等字段（读不到/读失败 = null）；
 *   「全部还原」与界面覆盖范围说明只认它，**不得靠 status 白名单反推**（那会同时漏项与误收，见 bulkRemovalPlan）。
 *
 * 可逆级别沿用 domain/operations.ts:21-29 的五级定义（本轮把它从"日志标签"变成真门禁）。
 */
import type { ReversibilityLevel } from '@/domain/operations'
import type { ReadingState } from '@/utils/reading'

/** 结论：本轮只出结论不删功能，cut = 建议移除 */
export type FeatureConclusion = 'keep' | 'review' | 'cut'

export type FeatureGroup = 'cpu' | 'smu' | 'gpu' | 'fan' | 'keyboard' | 'system'

export const FEATURE_GROUP_LABELS: Record<FeatureGroup, string> = {
  cpu: 'CPU 功耗覆盖',
  smu: 'Ryzen SMU / PawnIO',
  gpu: 'GPU / NVAPI',
  fan: '风扇 / EC',
  keyboard: '键盘与灯效',
  system: '系统与开机行为',
}

/** 「意图生效」判据（配置侧） */
export type IntentRule =
  | { kind: 'truthy' }
  | { kind: 'nonzero' }
  /** 值存在（非 null/undefined/空数组）——用于「配置里记着这套值」的语义 */
  | { kind: 'present' }
  /**
   * 精确等于某个值——用于「限制被施加」的语义（如 `cpu.turbo`：生效 = 睿频被关掉，
   * 而不是「睿频开着」——后者在 Windows 上本来就是默认态，不构成本软件的应用痕迹）。
   */
  | { kind: 'equals'; value: number | string | boolean }

/** 「硬件生效」判据（回读侧，pick 之后的值） */
export type ObservedRule = IntentRule

export interface ReadbackSpec {
  /**
   * `src/utils/bridge.ts` 导出对象上的方法名，形如 'AutoFanControl.IsRunning'。
   * 用例会用真实导出对象校验它存在（不手抄名单）。
   */
  method: string
  /** 从回读对象里取字段（点路径，如 'ac' / 'CPUFanSpeed' / 'CurrentWatts'）；不写则用整个值 */
  pick?: string
  /**
   * direct  = 该 getter 直接读回本功能的硬件/服务状态
   * inferred= 只能间接推断（EC 无对应 getter），必须在界面上显式标注「推断」
   */
  kind: 'direct' | 'inferred'
}

export type RemovalStep =
  | {
      kind: 'bridge'
      /** bridge.ts 导出对象上的方法名（用例校验存在） */
      method: string
      args: readonly (number | string | boolean)[]
      label: string
    }
  | {
      /** 清掉配置意图（走既有 configStore.saveConfig()，不另起写入机制） */
      kind: 'config'
      path: string
      value: number | string | boolean
      label: string
    }

export interface AppliedFeature {
  id: string
  name: string
  group: FeatureGroup
  /** config.yaml 字段路径；null = 无配置意图来源（本地逻辑态/纯硬件状态） */
  intentPath: string | null
  /** 回读方法；null = 不可回读 */
  readback: ReadbackSpec | null
  /** 回读口径说明：readback=null 时是「为什么读不到」，否则是「这个 getter 能证明什么」 */
  readbackNote: string
  /** 可逆级别 a–e（domain/operations.ts:21-29） */
  reversibility: ReversibilityLevel
  /** 配置侧「用户想要它生效」判据 */
  intentRule: IntentRule
  /** 回读侧「硬件里生效」判据 */
  observedRule: ObservedRule
  /** true = 回读值必须与配置值逐字一致才算已应用（仅用于可精确比对的标量） */
  exact?: boolean
  /** 移除步骤（有序）。空数组 = 无可执行的移除路径 */
  removal: readonly RemovalStep[]
  /** 移除结果能否靠回读确认；command-only = 只能确认命令被接受（v4 §8.4） */
  removalConfirm: 'readback' | 'command-only'
  /**
   * 前端下发消费点（`文件:行`）；null = 前端当前没有任何地方会下发它。
   * 这是「这个功能在哪里被真正用掉」的证据，也是 cut 结论的依据。
   */
  writePath: string | null
  conclusion: FeatureConclusion
  /** 一行理由（结论依据，带证据） */
  conclusionReason: string
}

/**
 * 注册表。**唯一真源**：加一行，概览页看板就多一行（组件不做任何 if/else 功能清单）。
 */
export const APPLIED_FEATURES: readonly AppliedFeature[] = [
  // ---------------------------------------------------------------- CPU 功耗覆盖
  {
    id: 'cpu.custom-override',
    name: '自定义功耗覆盖（命令 23 子状态）',
    group: 'cpu',
    intentPath: null,
    readback: { method: 'CPU.GetCustomMode', kind: 'direct' },
    readbackNote: 'CPU.GetCustomMode 直接读命令 23 的子状态（True=自定义覆盖生效）',
    reversibility: 'b',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'truthy' },
    removal: [
      {
        kind: 'bridge',
        method: 'CPU.SetCustomMode',
        args: [false],
        label: '关闭自定义功耗覆盖（交还固件档位）',
      },
    ],
    removalConfirm: 'readback',
    writePath: 'src/domain/cpuPowerPlan.ts:40',
    conclusion: 'keep',
    conclusionReason:
      '首页胶囊「自定义」与 CPU 页共用同一份下发口径；有关闭出口（stores/mode.ts:271-289 followFirmware → CPU.SetCustomMode(false)）',
  },
  {
    id: 'cpu.long-power',
    name: '长时功耗 SPL',
    group: 'cpu',
    intentPath: 'Cpu.Custom.CpuLongPower',
    readback: null,
    readbackNote:
      'WMI 命令 8 无 getter：bridge.ts:151-163 的 CPU 命名空间只有 SetCpuLongPower/SetCpuShortPower，没有读回方法',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/domain/cpuPowerPlan.ts:55-65',
    conclusion: 'keep',
    conclusionReason: 'CPU 页「应用」的组成项，语义与官方控制台一致（cpuPowerPlan.ts:5-9）',
  },
  {
    id: 'cpu.short-power',
    name: '短时功耗 SPPT',
    group: 'cpu',
    intentPath: 'Cpu.Custom.CpuShortPower',
    readback: null,
    readbackNote: '同 SPL：命令 8 无读回方法，只能确认命令被接受',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/domain/cpuPowerPlan.ts:66-77',
    conclusion: 'keep',
    conclusionReason: '同上，短时功耗与 SPL 成对下发（EC 拒绝只写其一）',
  },
  {
    id: 'cpu.temp-wall',
    name: 'CPU 温度墙',
    group: 'cpu',
    intentPath: 'Cpu.Custom.CpuTempWall',
    readback: null,
    readbackNote: 'CPU.SetCPUTempWall 有写无读；温度墙只能确认命令被接受（bridge.ts:162）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/domain/cpuPowerPlan.ts:42-53',
    conclusion: 'keep',
    conclusionReason: '过温兜底的第一道参数；闸门值域 40–100（writeGate.ts:69-74）',
  },
  {
    id: 'cpu.max-frequency',
    name: '最大频率上限',
    group: 'cpu',
    intentPath: 'Cpu.Custom.CpuMaxFrequency',
    readback: { method: 'Power.GetCPUMaxFrequency', pick: 'ac', kind: 'direct' },
    readbackNote: 'Power.GetCPUMaxFrequency 读 Windows powercfg 的 AC 侧最大频率（MHz）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    exact: true,
    removal: [
      {
        kind: 'bridge',
        method: 'Power.ResetCPUMaxFrequency',
        args: [],
        label: '移除最大频率限制（powercfg 交还默认）',
      },
    ],
    removalConfirm: 'readback',
    writePath: 'src/domain/cpuPowerPlan.ts:78-89',
    conclusion: 'keep',
    conclusionReason: '唯一可回读的 CPU 功耗项（Power.GetCPUMaxFrequency）；有真实还原路径',
  },
  {
    id: 'cpu.turbo',
    name: '关闭睿频（Turbo 限制）',
    group: 'cpu',
    intentPath: 'Cpu.Custom.CpuTurbo',
    readback: { method: 'Power.GetTurboEnabled', pick: 'ac', kind: 'direct' },
    readbackNote:
      'Power.GetTurboEnabled 读 AC 侧睿频开关（boolean）：false = 睿频被关掉（限制生效）',
    reversibility: 'b',
    // 「已生效」= 限制被施加（睿频被关掉）。用 truthy 会说「睿频开着 = 本软件的应用痕迹」，
    // 而睿频开着是 Windows 默认态，且移除动作（EnableTurbo）写后回读必为 true → 移除永远判不成功。
    intentRule: { kind: 'equals', value: false },
    observedRule: { kind: 'equals', value: false },
    exact: true,
    removal: [
      {
        kind: 'bridge',
        method: 'Power.EnableTurbo',
        args: [],
        label: '恢复睿频（Windows 电源管理默认启用）',
      },
    ],
    removalConfirm: 'readback',
    writePath: 'src/domain/cpuPowerPlan.ts:90-95',
    conclusion: 'keep',
    conclusionReason:
      '「已生效」= 软件把睿频关掉了（限制被施加）：observedRule 与恢复动作（Power.EnableTurbo → 回读 true）自洽，移除可回读确认；配置侧同样以 CpuTurbo=false 为生效条件（2026-10-05 审查 FIX-2）',
  },
  {
    id: 'cpu.boot-apply',
    name: '开机自动应用 CPU 参数',
    group: 'cpu',
    intentPath: 'App.BootAdvancedCPUSystem',
    readback: null,
    readbackNote:
      '开机自动下发是宿主侧行为，没有回读接口；该组参数里 SPL/SPPT/温度墙无 getter，仅最大频率/睿频可读，不足以确认整组已下发',
    reversibility: 'b',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings.vue:29-32（SettingToggle → Config.SetConfig）',
    conclusion: 'keep',
    conclusionReason:
      '设置页开关（Settings.vue:27-32）；关闭后开机不再自动下发（宿主 SelfStart 读取本字段）',
  },

  // ---------------------------------------------------------------- Ryzen SMU
  {
    id: 'smu.stapm-limit',
    name: 'STAPM 长期功耗上限',
    group: 'smu',
    intentPath: 'Smu.StapmLimit',
    readback: null,
    readbackNote: 'SMU 限制值无可靠 getter，只能确认命令被接受（KNOWN_ISSUES.md:64-72、133-136）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:44（applyGroup → RyzenSmu.SetStapmLimit）',
    conclusion: 'keep',
    conclusionReason: '官方控制台同款 SMU 限制项；配置 0 = 未读取，0 被闸门拒绝写入',
  },
  {
    id: 'smu.stapm-time',
    name: 'STAPM 时间窗口',
    group: 'smu',
    intentPath: 'Smu.StapmTime',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:45',
    conclusion: 'keep',
    conclusionReason: '与 STAPM 功耗成对的时域参数（ryzenadj 同源 mailbox）',
  },
  {
    id: 'smu.fast-limit',
    name: 'Fast 瞬时功耗上限',
    group: 'smu',
    intentPath: 'Smu.FastLimit',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:46',
    conclusion: 'keep',
    conclusionReason: '官方控制台同款；与 Slow 成对出现',
  },
  {
    id: 'smu.slow-limit',
    name: 'Slow 持续功耗上限',
    group: 'smu',
    intentPath: 'Smu.SlowLimit',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:47',
    conclusion: 'keep',
    conclusionReason: '同上',
  },
  {
    id: 'smu.slow-time',
    name: 'Slow 功耗时间窗口',
    group: 'smu',
    intentPath: 'Smu.SlowTime',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:48',
    conclusion: 'keep',
    conclusionReason: '同上',
  },
  {
    id: 'smu.ppt-rsmu',
    name: 'PPT 功耗限制 (RSMU)',
    group: 'smu',
    intentPath: 'Smu.PptLimitRsmu',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:49',
    conclusion: 'keep',
    conclusionReason: 'RSMU 侧功耗上限；与 MP1 通道成对，是 SMU 页主要功能',
  },
  {
    id: 'smu.vrm-mp1',
    name: 'VRM 持续电流限制 (MP1)',
    group: 'smu',
    intentPath: 'Smu.VrmCurrentMp1',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:55-62',
    conclusion: 'keep',
    conclusionReason: '过流保护参数；KNOWN_ISSUES 第 9 条明确不提供重置（无固件读回的原值）',
  },
  {
    id: 'smu.vrm-rsmu',
    name: 'VRM 持续电流限制 (RSMU)',
    group: 'smu',
    intentPath: 'Smu.VrmCurrentRsmu',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:63-70',
    conclusion: 'keep',
    conclusionReason: '同上',
  },
  {
    id: 'smu.edc-mp1',
    name: 'EDC 瞬间电流限制 (MP1)',
    group: 'smu',
    intentPath: 'Smu.EdcLimitMp1',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:71-78',
    conclusion: 'keep',
    conclusionReason: '同上',
  },
  {
    id: 'smu.edc-rsmu',
    name: 'EDC 瞬间电流限制 (RSMU)',
    group: 'smu',
    intentPath: 'Smu.EdcLimitRsmu',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:79-86',
    conclusion: 'keep',
    conclusionReason: '同上',
  },
  {
    id: 'smu.pbo-scalar',
    name: 'PBO 倍率上限选择',
    group: 'smu',
    intentPath: 'Smu.PboScalar',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:92',
    conclusion: 'keep',
    conclusionReason: '官方控制台同款 PBO 参数；可由应用页的「填入推荐值」兜底语义',
  },
  {
    id: 'smu.oc-clk',
    name: '超频核心频率偏移',
    group: 'smu',
    intentPath: 'Smu.OcClk',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:93',
    conclusion: 'keep',
    conclusionReason: '与 ENABLE_OC/温度墙联动；页面提供 DisableOc 出口（RyzenSmu.vue:966-971）',
  },
  {
    id: 'smu.oc-volt',
    name: '超频核心电压设定',
    group: 'smu',
    intentPath: 'Smu.OcVolt',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:94',
    conclusion: 'keep',
    conclusionReason: '同上；值域 0–1550 mV（writeGate.ts:60）',
  },
  {
    id: 'smu.curve-optimizer-all',
    name: '全核曲线偏移（Curve Optimizer All）',
    group: 'smu',
    intentPath: 'Smu.CurveOptimizerAll',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:110-116（独立提交卡）',
    conclusion: 'keep',
    conclusionReason:
      '置顶独立提交（v4 §14.4 裁定）；CPU 页「应用」也会带上它（cpuPowerPlan.ts:96-109）',
  },
  {
    id: 'smu.per-core-curve',
    name: '逐核曲线偏移（CO per core）',
    group: 'smu',
    intentPath: 'Smu.PerCoreCurve',
    readback: null,
    readbackNote: '同上：无回读接口；配置里那份只是「上次成功应用的值」的软件记录',
    reversibility: 'b',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'present' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:288-321（applyPerCore）',
    conclusion: 'review',
    conclusionReason:
      '配置只记录、开机不下发（Decision 2026-09-24，KNOWN_ISSUES.md:74-79）；冷启动后硬件是否保留那套值未经真机验证（同条），故不做"重启即生效"的表述',
  },
  {
    id: 'smu.per-core-occlk',
    name: '逐核超频频率偏移',
    group: 'smu',
    intentPath: 'Smu.PerCoreOcClk',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'present' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:307-320',
    conclusion: 'review',
    conclusionReason:
      '16 核 × 2 参数 = 32 条无人值守写入的风险收益比未经评估；值域上限 255 会被 Server 端 arg 打包静默截断（writeGate.ts:63-65），需真机确认真实可用上限',
  },
  {
    id: 'smu.tdc-mp1',
    name: 'TDC 电流限制 (MP1)',
    group: 'smu',
    intentPath: 'Smu.TdcLimitMp1',
    readback: null,
    readbackNote: '无回读接口（该字段连写入路径都不存在）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: null,
    conclusion: 'cut',
    conclusionReason:
      '前端零消费点：RyzenSmu.vue 的 CONFIG_GROUPS（RyzenSmu.vue:40-97）没有 TDC 项，bridge.ts 的 RyzenSmu 包装对象（bridge.ts:612-637）也没有 SetTdcLimitMp1/RSmu —— 只有类型声明里有（bridge.ts:276-277），config.yaml 里却存着这两个字段（JiaoLongConfig.cs:303-306）',
  },
  {
    id: 'smu.tdc-rsmu',
    name: 'TDC 电流限制 (RSMU)',
    group: 'smu',
    intentPath: 'Smu.TdcLimitRsmu',
    readback: null,
    readbackNote: '无回读接口（该字段连写入路径都不存在）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: null,
    conclusion: 'cut',
    conclusionReason: '同 TDC (MP1)：类型与配置模型都有，前端无人消费',
  },
  {
    id: 'smu.temp-limit-mp1',
    name: '温度墙限制 (MP1)',
    group: 'smu',
    intentPath: 'Smu.TempLimitMp1',
    readback: null,
    readbackNote: 'SMU 温度墙无 getter；页面上的 99℃ 是应用推荐值，不是固件读回值',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:120-126（独立提交卡）',
    conclusion: 'keep',
    conclusionReason:
      '过温保护参数；页面只提供「填入推荐值 99℃」而非"恢复默认"（KNOWN_ISSUES.md:64-72）',
  },
  {
    id: 'smu.temp-limit-rsmu',
    name: '温度墙限制 (RSMU)',
    group: 'smu',
    intentPath: 'Smu.TempLimitRsmu',
    readback: null,
    readbackNote: '同上：无回读接口',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/RyzenSmu.vue:120-126',
    conclusion: 'keep',
    conclusionReason: '同上',
  },

  // ---------------------------------------------------------------- GPU / NVAPI
  {
    id: 'gpu.core-lock',
    name: '核心频率锁定',
    group: 'gpu',
    intentPath: 'Gpu.GpuClock',
    readback: null,
    readbackNote:
      'bridge 没有锁频读回：NvidiaGpu.GetGpuCoreClock 报的是瞬时频率（GPU.vue:100 用它画曲线），不能证明锁定值',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/GPU.vue:266-277',
    conclusion: 'keep',
    conclusionReason:
      'GPU 页「应用」的实际下发项；桥接虽有 ResetGpuClock 可作逆操作，但无回读 → 按硬规则不给「移除」',
  },
  {
    id: 'gpu.memory-lock',
    name: '显存频率锁定',
    group: 'gpu',
    intentPath: 'Gpu.MemoryClock',
    readback: null,
    readbackNote: '同核心频率：无锁频读回（GetGpuMemoryClock 是瞬时频率）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/GPU.vue:266-277',
    conclusion: 'keep',
    conclusionReason: '同上；与核心频率一起提交（GPU.vue:258-288）',
  },
  {
    id: 'gpu.core-offset',
    name: '核心频率偏移',
    group: 'gpu',
    intentPath: 'Gpu.CoreClockOffset',
    readback: { method: 'NvidiaGpu.GetClockOffsets', pick: 'CoreMhz', kind: 'direct' },
    readbackNote: 'NvidiaGpu.GetClockOffsets 直接读驱动里当前生效的核心偏移（MHz）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    exact: true,
    removal: [
      {
        kind: 'bridge',
        method: 'NvidiaGpu.ResetClockOffsets',
        args: [],
        label: '把核心/显存偏移交还驱动默认（ResetClockOffsets）',
      },
    ],
    removalConfirm: 'readback',
    writePath: null,
    conclusion: 'cut',
    conclusionReason:
      '前端零消费点：高级超频面板整段被注释（GPU.vue:501-624 含 handleApplyAdvanced），SetCoreClockOffset/ApplyClockOffsets 只剩桥接声明（bridge.ts:239-241、577-578）',
  },
  {
    id: 'gpu.memory-offset',
    name: '显存频率偏移',
    group: 'gpu',
    intentPath: 'Gpu.MemoryClockOffset',
    readback: { method: 'NvidiaGpu.GetClockOffsets', pick: 'MemoryMhz', kind: 'direct' },
    readbackNote: '同上（MemoryMhz）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    exact: true,
    removal: [
      {
        kind: 'bridge',
        method: 'NvidiaGpu.ResetClockOffsets',
        args: [],
        label: '把核心/显存偏移交还驱动默认（ResetClockOffsets）',
      },
    ],
    removalConfirm: 'readback',
    writePath: null,
    conclusion: 'cut',
    conclusionReason: '同核心偏移：写路径只在被注释的面板里',
  },
  {
    id: 'gpu.voltage-boost',
    name: '核心电压提升',
    group: 'gpu',
    intentPath: 'Gpu.VoltageBoostPercent',
    readback: { method: 'NvidiaGpu.GetVoltageBoostPercent', kind: 'direct' },
    readbackNote: 'NvidiaGpu.GetVoltageBoostPercent 读驱动当前电压提升百分比',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    exact: true,
    removal: [
      {
        kind: 'bridge',
        method: 'NvidiaGpu.SetVoltageBoostPercent',
        args: [0],
        label: '把电压提升归零',
      },
    ],
    removalConfirm: 'readback',
    writePath: null,
    conclusion: 'cut',
    conclusionReason:
      '前端零消费点：SetVoltageBoostPercent 只有桥接声明（bridge.ts:243、586-587），面板已注释（GPU.vue:562-584）',
  },
  {
    id: 'gpu.power-limit',
    name: '功耗限制（TGP）',
    group: 'gpu',
    intentPath: 'Gpu.PowerLimit',
    readback: { method: 'NvidiaGpu.GetGpuPowerPolicy', pick: 'CurrentWatts', kind: 'direct' },
    readbackNote: 'NvidiaGpu.GetGpuPowerPolicy 读驱动当前功耗墙（W）',
    reversibility: 'b',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: null,
    conclusion: 'cut',
    conclusionReason:
      '前端零消费点且已明示（GPU.vue:467-476 注释："TGP 由 EC 管理，驱动接口不可用"）；配置默认值 140（JiaoLongConfig.cs:121）会被误读成"已下发"，看板因此标「无下发路径」',
  },
  {
    id: 'gpu.direct-mode',
    name: '独显直连输出模式',
    group: 'gpu',
    intentPath: null,
    readback: { method: 'GPU.Get', kind: 'direct' },
    readbackNote: 'GPU.Get 读 EC 里的显卡模式（0=混合 1=独显直连）',
    reversibility: 'd',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'equals', value: 1 },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings/components/GPUDirectConnection.vue:21-23',
    conclusion: 'keep',
    conclusionReason:
      'D 级可逆：切换后必须重启，写后回读不是最终状态（GPUDirectConnection.vue:25 明示），因此不提供「移除」——只有一个重启后才有意义的逆操作',
  },

  // ---------------------------------------------------------------- 风扇 / EC
  {
    id: 'fan.curve',
    name: '应用内风扇曲线接管',
    group: 'fan',
    intentPath: 'Fan.Enabled',
    readback: { method: 'AutoFanControl.IsRunning', kind: 'direct' },
    readbackNote: 'AutoFanControl.IsRunning 直接读曲线服务是否在跑（曲线接管的权威判据）',
    reversibility: 'c',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    exact: true,
    removal: [
      { kind: 'bridge', method: 'AutoFanControl.Stop', args: [], label: '停止应用内曲线服务' },
      { kind: 'config', path: 'Fan.Enabled', value: false, label: '清掉「开机自动拉起」意图' },
    ],
    removalConfirm: 'readback',
    writePath: 'src/composables/useFanCurveEditor.ts:112-151',
    conclusion: 'keep',
    conclusionReason:
      'KNOWN_ISSUES 第 5 条的刻意取舍：固件温控表形状不可改，接管是唯一手段；有兜底（ThermalWatchdog + EcGuard）与真实还原路径',
  },
  {
    id: 'fan.manual-speed',
    name: '风扇手动转速接管',
    group: 'fan',
    intentPath: 'Fan.ManualFanSpeed',
    readback: { method: 'Fan.GetFanSpeed', pick: 'CPUFanSpeed', kind: 'inferred' },
    readbackNote:
      'EC 没有「手动掩码」getter：无法区分固件自动与残留手动值。按 stores/fan.ts:20-22、154-157 的口径推断（AutoFan 未运行 + 配置里留着手动转速）；反证条件：EC 若提供手动转速查询命令，应以查询为准',
    reversibility: 'c',
    intentRule: { kind: 'nonzero' },
    observedRule: { kind: 'nonzero' },
    removal: [
      {
        kind: 'bridge',
        method: 'AutoFanControl.Stop',
        args: [],
        label: '停止应用内曲线（如在跑）',
      },
      { kind: 'bridge', method: 'Fan.RemoveFanSpeed', args: [], label: '移除手动转速限制' },
      { kind: 'config', path: 'Fan.ManualFanSpeed', value: 0, label: '清掉配置里的手动转速目标' },
    ],
    // 回读只能看到转速，看不到"手动掩码"，因此移除结果无法回读确认（v4 §8.4）
    removalConfirm: 'command-only',
    writePath: 'src/stores/fan.ts:197-273',
    conclusion: 'keep',
    conclusionReason:
      'C 级唯一出路「恢复自动控制」已实现（stores/fan.ts:275-320）；转速区间单一真源 FAN_MIN_RPM/FAN_MAX_RPM',
  },
  {
    id: 'fan.curve-merge',
    name: '风扇曲线合并',
    group: 'fan',
    intentPath: 'Fan.FanCurveMerge',
    readback: null,
    readbackNote:
      '合并只影响曲线服务的内部计算，没有回读接口；用 Config.GetConfig 读回自己等于自证，不进看板',
    reversibility: 'c',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings.vue:110-116（SettingToggle → Config.SetConfig）',
    conclusion: 'keep',
    conclusionReason:
      '消除两风扇拍频的既定手段（Settings.vue:20-26 开关 + 曲线服务消费）；无可回读接口，故只显示意图',
  },

  // ---------------------------------------------------------------- 键盘与灯效
  {
    id: 'keyboard.color',
    name: '键盘背光颜色',
    group: 'keyboard',
    intentPath: null,
    readback: { method: 'Keyboard.GetColor', kind: 'direct' },
    readbackNote:
      'Keyboard.GetColor 直接读硬件当前 RGB；但它读不出「这值是不是本软件写的」（固件原色无处可查），移除只能命令确认',
    reversibility: 'a',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'present' },
    removal: [
      {
        kind: 'bridge',
        method: 'Keyboard.SetColor',
        args: [138, 43, 226],
        label: '写回应用默认色 #8A2BE2（KeyBoard.vue:244 的页面默认值，非固件原值）',
      },
    ],
    // 回读判据是 present：任何颜色都 present → 移除后回读永远"仍然生效"。
    // 没有可靠的出厂默认色可写回，所以只能命令确认，不得渲染成失败态（2026-10-05 审查 FIX-2）。
    removalConfirm: 'command-only',
    writePath: 'src/pages/KeyBoard.vue:196-214',
    conclusion: 'keep',
    conclusionReason:
      'A 级：有 getter + setter，允许「撤销」措辞（operations.ts:23）；但颜色不落 config.yaml、固件原色不可查，写回的是页面默认值 → 移除只报「仅命令确认，未确认已恢复」',
  },
  {
    id: 'keyboard.brightness',
    name: '键盘背光亮度',
    group: 'keyboard',
    intentPath: null,
    readback: { method: 'Keyboard.GetLightBrightness', kind: 'direct' },
    readbackNote:
      'Keyboard.GetLightBrightness 直接读亮度档位（0–3）；但它读不出「这档位是不是本软件写的」，移除只能命令确认',
    reversibility: 'a',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'present' },
    removal: [
      {
        kind: 'bridge',
        method: 'Keyboard.SetLightBrightness',
        args: [2],
        label: '写回页面默认档位 2（KeyBoard.vue:245，非固件原值）',
      },
    ],
    // 同颜色：present 判据下移除后回读必然"仍然生效"，没有可靠的出厂档位可写回。
    removalConfirm: 'command-only',
    writePath: 'src/pages/KeyBoard.vue:215-220',
    conclusion: 'keep',
    conclusionReason:
      '同上；亮度与颜色同一次「应用」下发（KeyBoard.vue:186-241）；移除只报「仅命令确认，未确认已恢复」',
  },
  {
    id: 'keyboard.mode',
    name: '键盘灯效模式',
    group: 'keyboard',
    intentPath: null,
    readback: { method: 'Keyboard.GetMode', kind: 'direct' },
    readbackNote: 'Keyboard.GetMode 直接读灯效模式（0=关闭 2=固定色）',
    reversibility: 'a',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'equals', value: 2 },
    removal: [
      {
        kind: 'bridge',
        method: 'Keyboard.SetMode',
        args: [0],
        label: '把灯效模式切到关闭（RGBKeyboardMode.Mode_Off）',
      },
    ],
    removalConfirm: 'readback',
    writePath: null,
    conclusion: 'review',
    conclusionReason:
      '前端零消费点：KeyBoard.vue 只调用 GetColor/SetColor/GetLightBrightness/SetLightBrightness（KeyBoard.vue:60-75、196-220），GetMode/SetMode 只有桥接声明（bridge.ts:182-183）；模式在灯效页无任何入口 → 建议补入口或标为桥接预留',
  },
  {
    id: 'keyboard.gradient',
    name: '键盘渐变（色相循环）',
    group: 'keyboard',
    intentPath: 'App.BootKeyboardGradient',
    readback: { method: 'KeyboardGradient.IsRunning', kind: 'direct' },
    readbackNote: 'KeyboardGradient.IsRunning 直接读渐变服务是否在跑',
    reversibility: 'a',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    exact: true,
    removal: [
      { kind: 'bridge', method: 'KeyboardGradient.Stop', args: [], label: '停止渐变服务' },
      {
        kind: 'config',
        path: 'App.BootKeyboardGradient',
        value: false,
        label: '清掉「开机自动开启」意图',
      },
    ],
    removalConfirm: 'readback',
    writePath: 'src/pages/KeyBoard.vue:157-184',
    conclusion: 'review',
    conclusionReason:
      '渐变服务停止时会恢复启动前的颜色/亮度/模式快照（KeyboardGradientController.cs:127-132），移除路径本身是诚实的；但它在运行中每约 100ms 持续写颜色（KeyboardGradientController.cs:158-164），与灯效页「应用颜色/亮度」（KeyBoard.vue:196-220）争夺同一通道，且与厂商灯效软件/系统 RGB 生态功能重叠 —— 建议明确二者互斥或交由厂商软件',
  },
  {
    id: 'keyboard.logo-light',
    name: 'Logo 灯',
    group: 'keyboard',
    intentPath: null,
    readback: { method: 'LogoLight.Get', kind: 'direct' },
    readbackNote: 'LogoLight.Get 直接读 Logo 灯开关状态',
    reversibility: 'a',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'equals', value: 1 },
    removal: [
      {
        kind: 'bridge',
        method: 'LogoLight.Set',
        args: [0],
        label: '关闭 Logo 灯（ResultState.OFF）',
      },
    ],
    removalConfirm: 'readback',
    writePath: 'src/pages/Settings/components/LogoLight.vue:10-17',
    conclusion: 'keep',
    conclusionReason: 'A 级：Get/Set 成对（bridge.ts:467-470），有真实还原路径',
  },

  // ---------------------------------------------------------------- 系统与开机行为
  {
    id: 'system.performance-mode',
    name: '性能档位（命令 8）',
    group: 'system',
    intentPath: null,
    readback: { method: 'PerformanceMode.Get', kind: 'direct' },
    readbackNote: 'PerformanceMode.Get 直接读 EC 当前档位（0=游戏 1=狂飙 2=办公）',
    reversibility: 'b',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'present' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/stores/mode.ts:169-175',
    conclusion: 'keep',
    conclusionReason:
      '硬件必有的状态，不存在「移除」：只能重新选档（B 级）。档位不落 config.yaml，故无配置意图可比',
  },
  {
    id: 'system.autostart',
    name: '开机自启（Windows 计划任务）',
    group: 'system',
    intentPath: null,
    readback: { method: 'Boot.IsEnabled', kind: 'direct' },
    readbackNote: 'Boot.IsEnabled 直接读计划任务是否存在',
    reversibility: 'a',
    intentRule: { kind: 'present' },
    observedRule: { kind: 'truthy' },
    removal: [{ kind: 'bridge', method: 'Boot.Disable', args: [], label: '删除开机自启计划任务' }],
    removalConfirm: 'readback',
    writePath: 'src/pages/Settings/components/BootAutoStart.vue:29-44',
    conclusion: 'keep',
    conclusionReason: 'A 级：Enable/Disable/IsEnabled 成对；这是"退出入口"的一部分',
  },
  {
    id: 'system.boot-fan',
    name: '开机自动拉起风扇曲线',
    group: 'system',
    intentPath: 'App.BootAdvancedFanControlSystem',
    readback: null,
    readbackNote:
      '配置说的是"开机时自动接管"，此刻曲线是否在跑是另一件事（fan.curve 行负责），二者含义不等同，故不回读',
    reversibility: 'c',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings.vue:13-19（SettingToggle → Config.SetConfig）',
    conclusion: 'keep',
    conclusionReason:
      '开机恢复意图开关（Settings.vue:13-19）；若要停掉当前接管，用 fan.curve 那行的「移除」',
  },
  {
    id: 'system.boot-gpu',
    name: '开机自动应用 GPU 参数',
    group: 'system',
    intentPath: 'App.BootAdvancedGPUSystem',
    readback: null,
    readbackNote:
      '开机自动下发是宿主行为；锁频/偏移的当前值由 GPU 分组各行分别回读，本行只表达意图',
    reversibility: 'b',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings.vue:33-39（SettingToggle → Config.SetConfig）',
    conclusion: 'keep',
    conclusionReason: '设置页开关（Settings.vue:33-39）；与 GPU 页「应用」共用同一份 config.yaml',
  },
  {
    id: 'system.boot-smu-co',
    name: '开机自动应用全核降压',
    group: 'system',
    intentPath: 'App.BootSetRyzenSumCurveOptimizerAll',
    readback: null,
    readbackNote: 'SMU 无回读接口（KNOWN_ISSUES.md:64-72），开机下发结果无从确认',
    reversibility: 'b',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings.vue:40-46（SettingToggle → Config.SetConfig）',
    conclusion: 'keep',
    conclusionReason: '设置页开关（Settings.vue:40-46）；曲线偏移本身不可回读，只能确认开关意图',
  },
  {
    id: 'system.power-plan-sync',
    name: '联动 Windows 电源计划',
    group: 'system',
    intentPath: 'App.SyncWindowsPowerPlan',
    readback: null,
    readbackNote:
      'PowerController 只有最大频率/睿频的读写（bridge.ts:253-262），没有"当前电源计划"查询接口：Windows 电源计划读不到',
    reversibility: 'b',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath:
      'src/pages/Settings.vue:67-73（SettingToggle → Config.SetConfig；powercfg 联动在宿主侧）',
    conclusion: 'review',
    conclusionReason:
      '与 Windows 自带「电源模式」重叠（系统设置里可手动选计划），且无可回读接口：面板只能显示配置开关，无法确认当前生效计划；建议保留开关但在 UI 标注"不可回读"',
  },
  {
    id: 'system.hotkey',
    name: 'Fn 性能模式热键接管',
    group: 'system',
    intentPath: 'App.HotkeyEnabled',
    readback: null,
    readbackNote: 'Fn 键接管是宿主侧行为，没有回读接口（只能看 OSD 是否弹出）',
    reversibility: 'b',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings.vue:60-66（SettingToggle → Config.SetConfig；接管在宿主侧）',
    conclusion: 'keep',
    conclusionReason:
      'KNOWN_ISSUES 第 4 条：只接管性能模式键（事件 15），其余 Fn 复合键保持固件行为；可整体关闭',
  },
  {
    id: 'system.watchdog',
    name: '过温看门狗',
    group: 'system',
    intentPath: 'Safety.ThermalWatchdogEnabled',
    readback: null,
    readbackNote:
      '无回读接口（宿主后台服务，只有日志）；注意前端 types/config.ts 缺 Safety 段，设置页的 SettingToggle 读不到真实值（Settings.vue:55-59 与 types/config.ts:98-106），本看板直接从桥接返回的 JSON 取值',
    reversibility: 'b',
    intentRule: { kind: 'truthy' },
    observedRule: { kind: 'truthy' },
    removal: [],
    removalConfirm: 'command-only',
    writePath: 'src/pages/Settings.vue:54-59',
    conclusion: 'keep',
    conclusionReason:
      '唯一在紧急时刻覆盖手动转速的保护（KNOWN_ISSUES.md:23-29）；默认开启，关闭需用户明确操作',
  },
]

// ------------------------------------------------------------------ 纯判定

export type FeatureStatus =
  /** 配置意图与回读一致 */
  | 'match'
  /** 配置开着、硬件没写进去（本轮核心价值） */
  | 'mismatch'
  /** 硬件/服务在生效，但配置里没开（也不是本软件写的） */
  | 'hardware-only'
  /** 未启用 */
  | 'inactive'
  /** 无配置意图来源，只有实测值 */
  | 'observed-only'
  /** 配置字段读不到（配置未加载 / 字段缺失） */
  | 'intent-missing'
  /** 不可回读（注册表未声明回读方法） */
  | 'unreadable'
  /** 回读失败（bridge 报错/超时） */
  | 'read-failed'
  /** 前端没有任何下发路径（cut 项） */
  | 'no-write-path'

export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  match: '已生效',
  mismatch: '配置开着·硬件没写进去',
  'hardware-only': '硬件仍在生效',
  inactive: '未启用',
  'observed-only': '仅实测',
  'intent-missing': '配置字段读不到',
  unreadable: '不可回读',
  'read-failed': '读取失败',
  'no-write-path': '无下发路径',
}

export const CONCLUSION_LABELS: Record<FeatureConclusion, string> = {
  keep: '保留',
  review: '待复核',
  cut: '建议移除',
}

/** 配置侧读取结果：读不到就是读不到，绝不用默认值顶替 */
export interface IntentRead {
  /** Config.GetConfig() 是否成功 */
  configLoaded: boolean
  /** 路径是否存在 */
  found: boolean
  value: number | string | boolean | null
}

/** 回读侧读取结果（沿用 utils/reading.ts 的四态） */
export interface ObservedRead {
  state: ReadingState
  /** pick 之前的原始回读值；未读到时必须是 null，不得填 0/false */
  value: unknown
  message: string | null
}

export interface FeatureVerdict {
  id: string
  status: FeatureStatus
  statusLabel: string
  /** 是否「配置开着、硬件没写进去」 */
  mismatch: boolean
  /**
   * 「硬件当前是否真的生效」——一等字段，「全部还原」与界面覆盖范围说明都只认它：
   * - `true` / `false`：回读成功（ok/stale）且判据可判定；
   * - `null`：不可回读（注册表未声明 getter）或回读失败（error/unavailable/loading）
   *   —— **不知道**，不得当成 false（v4 §7.1：读不到不猜值）。
   * 它独立于 status：`unreadable` / `read-failed` / `intent-missing` / `no-write-path` /
   * `observed-only` 这些状态下，status 本身说不出「硬件里到底生不生效」。
   */
  observedActive: boolean | null
  /** 意图栏文本（camelCase 路径 + 值） */
  intentText: string
  /** 实测栏文本（bridge 方法名 + 回读值） */
  observedText: string
  /** 不一致/失败时的补充说明 */
  detail: string | null
  /** 回读是推断口径（EC 无 getter）——必须在界面上显式标出 */
  inferred: boolean
  canRemove: boolean
  /** 不能移除的原因；可移除时为 null */
  blockedReason: string | null
}

export const REMOVAL_BLOCKED_NO_READBACK = '无可靠回读方法：移除结果无法确认（v4 §8.4）'
export const REMOVAL_BLOCKED_IRREVERSIBLE = 'E 级不可逆：不提供移除'
export const REMOVAL_BLOCKED_NEEDS_REBOOT = 'D 级需重启：写后回读不是最终状态，不提供移除'
export const REMOVAL_BLOCKED_NO_STEPS = '无可执行的移除步骤（无可靠还原值）'

/** 按路径取值；任一层缺失返回 undefined（不猜默认值） */
export function readByPath(root: unknown, path: string): unknown {
  let node: unknown = root
  for (const seg of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

/** 从回读对象里取字段（点路径）；缺失返回 undefined */
export function pickField(value: unknown, pick: string | undefined): unknown {
  if (!pick) return value
  return readByPath(value, pick)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function evalRule(rule: IntentRule | ObservedRule, value: unknown): boolean {
  switch (rule.kind) {
    case 'truthy':
      return value === true
    case 'nonzero':
      return typeof value === 'number' ? value !== 0 : false
    case 'present':
      if (value === null || value === undefined) return false
      if (Array.isArray(value)) return value.length > 0
      return true
    case 'equals':
      return value === rule.value
    default:
      return false
  }
}

/** 供界面渲染的短值文本；读不到必须是显式文本，不得回退 0/false */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.length} 项]`
  }
  if (isRecord(value)) {
    // 固定键序，避免对象键顺序影响展示与快照可比性
    const keys = Object.keys(value).sort()
    return keys.map((k) => `${k}=${formatValue(value[k])}`).join(' ')
  }
  return '—'
}

function describeIntent(item: AppliedFeature, intent: IntentRead): string {
  if (item.intentPath === null) return '无（不落 config.yaml）'
  const pathText = item.intentPath
  if (!intent.configLoaded) return `${pathText} = 配置未读取`
  if (!intent.found) return `${pathText} = 字段不存在`
  // equals 判据（如关睿频）：光看字段值看不出「为什么这算生效」，把生效条件一并写出
  const suffix =
    item.intentRule.kind === 'equals' ? `（生效 = ${formatValue(item.intentRule.value)}）` : ''
  return `${pathText} = ${formatValue(intent.value)}${suffix}`
}

function describeObserved(item: AppliedFeature, observed: ObservedRead, picked: unknown): string {
  if (item.readback === null) return `不可回读 · ${item.readbackNote}`
  const call = `${item.readback.method}()`
  if (observed.state === 'error') return `${call} 读取失败（${observed.message ?? '未说明'}）`
  if (observed.state === 'unavailable') return `${call} 通道不存在`
  if (observed.state === 'loading') return `${call} 读取中`
  if (observed.state === 'stale') return `${call} = ${formatValue(picked)}（读数过期）`
  return `${call} = ${formatValue(picked)}`
}

function removalBlockedReason(item: AppliedFeature): string | null {
  // 硬规则（本轮交付约束）：回读方法为 null 或级别 e 的项禁止挂可点的「移除」
  if (item.readback === null) return REMOVAL_BLOCKED_NO_READBACK
  if (item.reversibility === 'e') return REMOVAL_BLOCKED_IRREVERSIBLE
  if (item.removal.length === 0) {
    // D 级（需重启）单独说清楚：不是"没有还原值"，而是"此刻回读不算数"
    if (item.reversibility === 'd') return REMOVAL_BLOCKED_NEEDS_REBOOT
    return REMOVAL_BLOCKED_NO_STEPS
  }
  return null
}

/**
 * 单项判定：把「配置意图」与「硬件实测」两栏合成一条结论。
 * 纯函数——vitest 里无 DOM 直接调用（data/render 分离）。
 */
export function judgeFeature(
  item: AppliedFeature,
  intent: IntentRead,
  observed: ObservedRead,
): FeatureVerdict {
  const picked = item.readback ? pickField(observed.value, item.readback.pick) : null
  const inferred = item.readback?.kind === 'inferred'
  const blockedReason = removalBlockedReason(item)

  // 「硬件当前是否真的生效」——一等字段：不可回读 / 回读失败一律是 null（不知道），
  // 绝不用 status 白名单去反推（那正是「全部还原」既漏项又误收的根因）。
  const readable = observed.state === 'ok' || observed.state === 'stale'
  const observedActive =
    item.readback === null || !readable ? null : evalRule(item.observedRule, picked)

  const base = {
    id: item.id,
    inferred: inferred === true,
    canRemove: blockedReason === null,
    blockedReason,
    observedActive,
    intentText: describeIntent(item, intent),
    observedText: describeObserved(item, observed, picked),
  }

  const verdict = (status: FeatureStatus, detail: string | null = null): FeatureVerdict => ({
    ...base,
    status,
    statusLabel: FEATURE_STATUS_LABELS[status],
    mismatch: status === 'mismatch',
    detail,
  })

  // 1. 不可回读：注册表自己声明读不到 → 不猜值。
  //    detail 留空：readbackNote 已由「实测」栏的 observedText 承载，两栏不重复同一段长文。
  if (item.readback === null) return verdict('unreadable', null)

  // 2. 回读失败（error/unavailable/loading）：不得当成 false/0
  if (observed.state !== 'ok' && observed.state !== 'stale') {
    return verdict('read-failed', observed.message ?? '回读未成功')
  }

  const observedOn = observedActive === true

  // 3. 有意图来源但读不到配置字段
  if (item.intentPath !== null && (!intent.configLoaded || !intent.found)) {
    return verdict(
      'intent-missing',
      intent.configLoaded ? `${item.intentPath} 不存在于 config.yaml` : '配置未加载',
    )
  }

  // 4. 前端没有下发路径：硬件里的值不是本软件写的
  if (item.writePath === null) {
    return verdict(
      'no-write-path',
      observedOn ? '前端无下发路径（见注册表 writePath=null），硬件侧的值非本软件所写' : null,
    )
  }

  // 5. 无配置意图来源：只报实测
  if (item.intentPath === null) {
    return verdict('observed-only', null)
  }

  const intentOn = evalRule(item.intentRule, intent.value)

  if (!intentOn) {
    // 推断口径的行（如风扇手动转速）不能只凭回读判"硬件仍在生效"：
    // EC 固件自己转风扇与残留手动值在读数上无法区分（fan.ts:20-22）
    if (observedOn && !inferred) {
      return verdict('hardware-only', `配置里没开，但 ${item.name} 仍在硬件上生效`)
    }
    return verdict('inactive', null)
  }

  if (!observedOn) {
    return verdict('mismatch', `配置开着、硬件没写进去：${item.readback.method}() 未读出该项生效`)
  }

  if (item.exact && picked !== intent.value) {
    return verdict(
      'mismatch',
      `值不一致：配置 ${formatValue(intent.value)} / 实测 ${formatValue(picked)}`,
    )
  }

  return verdict('match', null)
}

/** 未读到的输入：显式缺失，绝不用默认值顶替（v4 §7.1） */
const MISSING_INTENT: IntentRead = { configLoaded: false, found: false, value: null }
const MISSING_OBSERVED: ObservedRead = { state: 'loading', value: null, message: null }

/** 取一项的判定结果（缺失的输入按「未读」处理） */
function verdictOf(
  item: AppliedFeature,
  intents: Readonly<Record<string, IntentRead>>,
  observed: Readonly<Record<string, ObservedRead>>,
): FeatureVerdict {
  return judgeFeature(
    item,
    intents[item.id] ?? MISSING_INTENT,
    observed[item.id] ?? MISSING_OBSERVED,
  )
}

/** 批量判定（组件只消费这个结果） */
export function judgeAll(
  items: readonly AppliedFeature[],
  intents: Readonly<Record<string, IntentRead>>,
  observed: Readonly<Record<string, ObservedRead>>,
): FeatureVerdict[] {
  return items.map((item) => verdictOf(item, intents, observed))
}

/**
 * 「全部还原」名单。三条**同时**满足才收（判据是「硬件当前真的生效」，不是 status 白名单）：
 * 1. `canRemove`：有可靠回读、非 E 级、有移除步骤（见 removalBlockedReason）；
 * 2. `writePath !== null`：前端确实下发得出去 —— `writePath === null` 只读回读得出来，
 *    硬件里的值**不是本软件写的**（如 MSI Afterburner 设的 GPU 偏移），点一下就把它清掉；
 * 3. `observedActive === true`，或 `observedActive === null`（读不到回读值）**且**配置意图明确为开
 *    —— 后者保留「一次读取失败不该卡住用户」的口径，其结果由移除后的独立重读判定。
 */
export function bulkRemovalPlan(
  items: readonly AppliedFeature[],
  intents: Readonly<Record<string, IntentRead>>,
  observed: Readonly<Record<string, ObservedRead>>,
): AppliedFeature[] {
  return items.filter((item) => {
    const v = verdictOf(item, intents, observed)
    if (!v.canRemove) return false
    if (item.writePath === null) return false
    if (v.observedActive === true) return true
    if (v.observedActive === null) {
      const intent = intents[item.id]
      return intent?.found === true && evalRule(item.intentRule, intent.value)
    }
    return false
  })
}

/** 「全部还原」的覆盖范围（界面必须逐类说明，不能只报一个数字） */
export interface RemovalScope {
  /** 本次会下发的项名（"全部还原"按钮实际覆盖到的） */
  covered: string[]
  /** 不覆盖：`writePath === null` —— 前端没有下发路径，硬件里的值不是本软件写的，不能替别的工具清掉 */
  notWrittenByUs: string[]
  /** 不覆盖：本软件写过，但实测当前不生效 */
  notActive: string[]
  /** 不覆盖：回读没读到（读失败/不可回读），且配置意图也没明确开着 —— 不知道，不猜 */
  notRead: string[]
  /** 不覆盖：本行根本不给「移除」（不可回读 / E 级 / 无还原值），逐行有自己的原因 */
  noRemovalPath: string[]
}

/** 把「覆盖哪些 / 不覆盖哪些、各为什么」算成数据（纯函数，组件只渲染） */
export function removalScope(
  items: readonly AppliedFeature[],
  intents: Readonly<Record<string, IntentRead>>,
  observed: Readonly<Record<string, ObservedRead>>,
): RemovalScope {
  const planIds = new Set(bulkRemovalPlan(items, intents, observed).map((item) => item.id))
  const scope: RemovalScope = {
    covered: [],
    notWrittenByUs: [],
    notActive: [],
    notRead: [],
    noRemovalPath: [],
  }
  for (const item of items) {
    if (planIds.has(item.id)) {
      scope.covered.push(item.name)
      continue
    }
    const v = verdictOf(item, intents, observed)
    if (!v.canRemove) scope.noRemovalPath.push(item.name)
    else if (item.writePath === null) scope.notWrittenByUs.push(item.name)
    else if (v.observedActive === false) scope.notActive.push(item.name)
    else scope.notRead.push(item.name)
  }
  return scope
}

/** 移除后的独立重读判据：必须读到该项**已不再生效**才算移除成功 */
export function judgeRemoval(item: AppliedFeature, observed: ObservedRead): boolean {
  if (item.readback === null) return false
  if (observed.state !== 'ok') return false
  const picked = pickField(observed.value, item.readback.pick)
  return !evalRule(item.observedRule, picked)
}

/** 移除步骤里用到的 bridge 方法名（用例据此校验它们在 bridge.ts 里真实存在） */
export function bridgeMethodsOf(item: AppliedFeature): string[] {
  const names: string[] = []
  if (item.readback) names.push(item.readback.method)
  for (const step of item.removal) {
    if (step.kind === 'bridge') names.push(step.method)
  }
  return names
}

/** 注册表里出现的所有 bridge 方法名（去重排序） */
export function allBridgeMethods(items: readonly AppliedFeature[] = APPLIED_FEATURES): string[] {
  return [...new Set(items.flatMap((item) => bridgeMethodsOf(item)))].sort()
}

/** 按注册表顺序分组（组件按组渲染，不做任何功能清单硬编码） */
export function groupFeatures(
  items: readonly AppliedFeature[] = APPLIED_FEATURES,
): Array<{ id: FeatureGroup; label: string; items: AppliedFeature[] }> {
  const order: FeatureGroup[] = ['cpu', 'smu', 'gpu', 'fan', 'keyboard', 'system']
  return order
    .map((id) => ({
      id,
      label: FEATURE_GROUP_LABELS[id],
      items: items.filter((item) => item.group === id),
    }))
    .filter((g) => g.items.length > 0)
}

/**
 * 把 'AutoFanControl.IsRunning' 这样的名字解析成 bridge 导出对象上的真实函数。
 * 纯函数（命名空间由调用方注入）——用例用真实的 `@/utils/bridge` 导出校验注册表，
 * 不手抄一份方法名单。找不到返回 null，绝不静默降级成假成功。
 */
export function resolveBridgeMethod(
  namespace: unknown,
  name: string,
): ((...args: unknown[]) => Promise<unknown>) | null {
  let node: unknown = namespace
  for (const seg of name.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return null
    node = (node as Record<string, unknown>)[seg]
  }
  return typeof node === 'function' ? (node as (...args: unknown[]) => Promise<unknown>) : null
}
