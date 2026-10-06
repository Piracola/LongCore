// 与 C# JiaoLongConfig.cs 保持同步
// 新增字段：在 C# 类中加属性，在此 interface 中加对应字段

export interface FanPoint {
  temp: number
  speed: number
}

export type ThemeMode = 'light' | 'dark' | 'system'

export interface AppSectionType {
  BootMinimized: boolean
  BootAdvancedFanControlSystem: boolean
  BootAdvancedCPUSystem: boolean
  BootAdvancedGPUSystem: boolean
  BootSetRyzenSumCurveOptimizerAll: boolean
  Theme: ThemeMode
  SyncWindowsPowerPlan: boolean
  HotkeyEnabled: boolean
}

/** CPU 功耗参数 —— 只有一套（原「均衡/性能/节能/自定义」四张方案表已废除） */
export interface CpuPowerDataType {
  CpuLongPower: number
  CpuShortPower: number
  CpuTempWall: number
  CpuMaxFrequency: number
  CpuTurbo: boolean
}

export interface CpuSectionType {
  /** 首页「自定义」与 CPU 页共用同一份，随配置持久化 */
  Custom: CpuPowerDataType
}

export interface GpuSectionType {
  GpuClock: number
  MemoryClock: number
  PowerLimit: number
  CoreClockOffset: number
  MemoryClockOffset: number
  VoltageBoostPercent: number
}

export interface FanSectionType {
  /** 应用内风扇曲线总开关(跨重启记住用户意图; 关闭则交还 EC 固件温控) */
  Enabled: boolean
  /** 两风扇同转速, 消除不同转速产生的拍频调制 */
  FanCurveMerge: boolean
  /** 升温跟踪时间常数 (秒, 3~60): 越小跟随越快 */
  TempAttackS: number
  /** 降温跟踪时间常数 (秒, 10~300): 越大风扇在高转速保持越久 */
  TempReleaseS: number
  /** 温度不灵敏带 (℃, 0~15): 温度变化不足此值时不调整转速。选了噪音档位时被档位覆盖 */
  TempHysteresisC: number
  /** 噪音忍耐度: 0=安静 1=均衡(出厂) 2=强冷。同时驱动曲线缩放/不灵敏带/安全下限 */
  NoiseTolerance: number
  CpuFanCurve: FanPoint[]
  GpuFanCurve: FanPoint[]
}

export type LogLevelName = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'OFF'

export interface LogSectionType {
  /** 最低记录级别 */
  Level: LogLevelName
  /** 记录每次数据读取/命令结果 (日志体积的 98% 来源) */
  CommandDebug: boolean
}

export interface SmuSectionType {
  StapmLimit: number
  StapmTime: number
  FastLimit: number
  SlowLimit: number
  SlowTime: number
  PptLimitRsmu: number
  VrmCurrentMp1: number
  VrmCurrentRsmu: number
  TdcLimitMp1: number
  TdcLimitRsmu: number
  EdcLimitMp1: number
  EdcLimitRsmu: number
  TempLimitMp1: number
  TempLimitRsmu: number
  PboScalar: number
  OcClk: number
  OcVolt: number
  CurveOptimizerAll: number
  /** 逐核 CO 偏移（每核一项）。只记录上次成功应用的值，开机不下发 */
  PerCoreCurve: number[]
  /** 逐核超频频率偏移（MHz，每核一项）。同上 */
  PerCoreOcClk: number[]
}

export interface JiaoLongConfigType {
  Version: string
  App: AppSectionType
  Cpu: CpuSectionType
  Gpu: GpuSectionType
  Fan: FanSectionType
  Smu: SmuSectionType
  Log: LogSectionType
}
