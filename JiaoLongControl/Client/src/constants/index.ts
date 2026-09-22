/** 业务常量: 硬件限值与轮询间隔 (与 Server 端 C#/Python 约定保持一致) */

import type { CpuPowerDataType } from '@/types/config'

/** 风扇手动转速区间 (RPM) */
export const FAN_MAX_RPM = 5800
export const FAN_MIN_RPM = 1500

/** 遥测轮询间隔 (ms) */
export const POLL_INTERVAL_SYSTEM_INFO = 5000
export const POLL_INTERVAL_SMU = 3000
export const POLL_INTERVAL_FAN_SPEED = 2000

/** 应用内曲线服务（AutoFanControl）运行状态轮询间隔 (ms)：比转速慢一档 */
export const POLL_INTERVAL_SMART_FAN = 5000

/** 首页温度历史：全局持续采样，切页不丢。2s × 60 = 120s 窗口 */
export const TEMP_HISTORY_INTERVAL_MS = 2000
/** 2 秒采样保留 1 小时，概览页可切换 2 分钟 / 10 分钟 / 1 小时。 */
export const TEMP_HISTORY_CAP = 1800

/** CPU 功耗参数出厂默认值 (与 Server CpuPowerData 的属性默认值保持一致) */
export const CPU_CUSTOM_DEFAULTS: CpuPowerDataType = {
  CpuLongPower: 45,
  CpuShortPower: 55,
  CpuTempWall: 95,
  CpuMaxFrequency: 5400,
  CpuTurbo: true,
}
