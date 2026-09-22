import { defineStore } from 'pinia'
import {
  CPU,
  Fan,
  NvidiaGpu,
  type CommandResult,
  type FanSpeedInfo,
  type GpuStats,
} from '@/utils/bridge'
import { POLL_INTERVAL_SYSTEM_INFO, TEMP_HISTORY_CAP, TEMP_HISTORY_INTERVAL_MS } from '@/constants'
import { PollingChannel, freshLoading, okReading, type Reading } from '@/utils/reading'

/**
 * 系统信息 store —— 四态读数版（v4 §7，Implemented 2026-09-17）。
 *
 * 旧版把单项失败转成 0 / '0'（原 :90-110 一排 `: 0`），直接违反第一性原则 1；
 * 唯一没被污染的 `if (fSpeed.Success)` 写法（原 :112）在此推广为全部 16 个通道。
 *
 * 每通道独立四态：成功 → ok；失败/超时 → 有旧值则 stale（带最后成功时刻），
 * 从未成功则 error。读取失败绝不落 0，渲染层对 null 显示「—」并标注过期。
 *
 * 调度（v4 §7.3）：PollingChannel 统一管理 —— 每周期串行（上一轮完成才排下一轮，
 * 天然每通道 1 在途）、不可见暂停、失败退避、连续失败达上界停转；
 * 配合 bridge.ts cached() 的在途去重与失败冷却构成前端侧上界。
 * 宿主侧上界属 Server 职责（v4 §7.3），不在本 store。
 */

/** GPU 动态读数（数值通道；静态信息见 gpuStatic） */
export interface GpuDynamic {
  GpuUtilization: number
  MemoryUtilization: number
  CoreClock: number
  MemoryClock: number
  FanSpeed: number
  GpuTemperature: number
}

/** GPU 静态信息（名称/驱动/显存/位宽；30s TTL 由 bridge 缓存承担） */
export type GpuStatic = Pick<
  GpuStats,
  'GpuName' | 'DriverVersion' | 'DriverDate' | 'MemoryTotal' | 'BusWidth'
>

/** 温度历史采样点。cpu/gpu 为 null 表示该时刻通道不可用，禁止填 0 */
export interface TempSample {
  at: number
  cpu: number | null
  gpu: number | null
}

interface SystemInfoState {
  cpuTemp: Reading<number>
  cpuUsage: Reading<number>
  cpuFreq: Reading<number>
  cpuVolt: Reading<number>
  fanSpeed: Reading<FanSpeedInfo>
  gpuStatic: Reading<GpuStatic>
  gpuDynamic: Reading<GpuDynamic>
  tempHistory: TempSample[]
}

/** 单通道失败 → 有旧值转 stale，从未成功转 error */
function toReading<T>(
  prev: Reading<T>,
  result: PromiseSettledResult<CommandResult<T>>,
): Reading<T> {
  if (result.status === 'fulfilled' && result.value.Success && 'Data' in result.value) {
    return okReading(result.value.Data)
  }
  const message =
    result.status === 'fulfilled'
      ? result.value.Message || '读取失败'
      : result.reason instanceof Error
        ? result.reason.message
        : '读取失败'
  if (prev.state === 'ok' || prev.state === 'stale') {
    return { state: 'stale', value: prev.value, lastOkAt: prev.lastOkAt, message }
  }
  return { state: 'error', value: null, lastOkAt: null, message }
}

function freshError<T>(): Reading<T> {
  return { state: 'error', value: null, lastOkAt: null, message: null }
}

export const useSystemInfoStore = defineStore('systemInfo', {
  state: (): SystemInfoState => ({
    cpuTemp: freshError(),
    cpuUsage: freshError(),
    cpuFreq: freshError(),
    cpuVolt: freshError(),
    fanSpeed: freshError(),
    gpuStatic: freshLoading(),
    gpuDynamic: freshLoading(),
    tempHistory: [],
  }),

  getters: {
    /** 兼容显示层：数值读数的裸值（null = 不可显示，禁止回退 0） */
    cpuTempValue: (s) => s.cpuTemp.value,
    cpuUsageValue: (s) => s.cpuUsage.value,
    cpuFreqValue: (s) => s.cpuFreq.value,
    cpuVoltValue: (s) => s.cpuVolt.value,
    fanSpeedValue: (s) => s.fanSpeed.value,
    gpuDynamicValue: (s) => s.gpuDynamic.value,

    /** GPU 静态信息单项（null = 不可显示，渲染层显示「—」） */
    gpuName: (s) => s.gpuStatic.value?.GpuName ?? null,
    gpuDriverVersion: (s) => s.gpuStatic.value?.DriverVersion ?? null,
    gpuDriverDate: (s) => s.gpuStatic.value?.DriverDate ?? null,
    gpuMemoryTotal: (s) => s.gpuStatic.value?.MemoryTotal ?? null,
    gpuBusWidth: (s) => s.gpuStatic.value?.BusWidth ?? null,
    gpuUtilization: (s) => s.gpuDynamic.value?.GpuUtilization ?? null,
    gpuMemoryUtilization: (s) => s.gpuDynamic.value?.MemoryUtilization ?? null,
    gpuCoreClock: (s) => s.gpuDynamic.value?.CoreClock ?? null,
    gpuMemoryClock: (s) => s.gpuDynamic.value?.MemoryClock ?? null,
    gpuFanSpeed: (s) => s.gpuDynamic.value?.FanSpeed ?? null,
    gpuTemp: (s) => s.gpuDynamic.value?.GpuTemperature ?? null,
  },

  actions: {
    /**
     * 一轮全通道刷新。通道间互相独立：任何通道失败只降级该通道，
     * 不再像旧版那样被 Promise.all 一锅端或被 `: 0` 兜底污染。
     */
    async fetchSystemInfo(): Promise<boolean> {
      const results = await Promise.allSettled([
        CPU.GetCPUThermometer(),
        CPU.GetCpuUsage(),
        CPU.GetCpuFrequency(),
        CPU.GetCpuVoltage(),
        Fan.GetFanSpeed(),
        NvidiaGpu.GetGpuName(),
        NvidiaGpu.GetGpuDriverVersion(),
        NvidiaGpu.GetGpuDriverDate(),
        NvidiaGpu.GetGpuMemoryTotal(),
        NvidiaGpu.GetGpuBusWidth(),
        NvidiaGpu.GetGpuUtilization(),
        NvidiaGpu.GetGpuMemoryUtilization(),
        NvidiaGpu.GetGpuCoreClock(),
        NvidiaGpu.GetGpuMemoryClock(),
        NvidiaGpu.GetGpuFanSpeed(),
        NvidiaGpu.GetGpuTemperature(),
      ])
      const [
        temp,
        usage,
        freq,
        volt,
        fan,
        name,
        driver,
        date,
        mem,
        bus,
        util,
        memUtil,
        coreClk,
        memClk,
        gpuFan,
        gpuT,
      ] = results

      this.cpuTemp = toReading(this.cpuTemp, temp as PromiseSettledResult<CommandResult<number>>)
      this.cpuUsage = toReading(this.cpuUsage, usage as PromiseSettledResult<CommandResult<number>>)
      this.cpuFreq = toReading(this.cpuFreq, freq as PromiseSettledResult<CommandResult<number>>)
      this.cpuVolt = toReading(this.cpuVolt, volt as PromiseSettledResult<CommandResult<number>>)
      this.fanSpeed = toReading(
        this.fanSpeed,
        fan as PromiseSettledResult<CommandResult<FanSpeedInfo>>,
      )

      // GPU 静态通道聚合为一个读数：全部成功才 ok，部分失败按 stale/error 降级
      const staticSettled = [name, driver, date, mem, bus] as Array<
        PromiseSettledResult<CommandResult<string>>
      >
      this.gpuStatic = this.aggregateReading(this.gpuStatic, staticSettled, (parts) => ({
        GpuName: String(parts[0]),
        DriverVersion: String(parts[1]),
        DriverDate: String(parts[2]),
        MemoryTotal: String(parts[3]),
        BusWidth: String(parts[4]),
      }))

      // GPU 动态通道聚合；util/memUtil 为 0–100 整数，时钟/转速为数值
      const dynSettled = [util, memUtil, coreClk, memClk, gpuFan, gpuT] as Array<
        PromiseSettledResult<CommandResult<number>>
      >
      this.gpuDynamic = this.aggregateReading(this.gpuDynamic, dynSettled, (parts) => ({
        GpuUtilization: Number(parts[0]),
        MemoryUtilization: Number(parts[1]),
        CoreClock: Number(parts[2]),
        MemoryClock: Number(parts[3]),
        FanSpeed: Number(parts[4]),
        GpuTemperature: Number(parts[5]),
      }))

      return results.some((r) => r.status === 'fulfilled' && r.value.Success)
    },

    /** 多子命令聚合：全 ok → ok；否则有旧值 → stale；从未成功 → error */
    aggregateReading(
      prev: Reading<unknown>,
      settled: Array<PromiseSettledResult<CommandResult<number | string>>>,
      compose: (parts: Array<number | string>) => unknown,
    ): Reading<never> {
      const okParts: Array<number | string> = []
      let message: string | null = null
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value.Success && 'Data' in r.value) {
          okParts.push(r.value.Data)
        } else if (message === null) {
          message =
            r.status === 'fulfilled'
              ? r.value.Message || '读取失败'
              : r.reason instanceof Error
                ? r.reason.message
                : '读取失败'
        }
      }
      if (okParts.length === settled.length) {
        return okReading(compose(okParts) as never)
      }
      if (prev.state === 'ok' || prev.state === 'stale') {
        return {
          state: 'stale',
          value: prev.value,
          lastOkAt: prev.lastOkAt,
          message,
        } as Reading<never>
      }
      return { state: 'error', value: null, lastOkAt: null, message }
    },

    /** 把当前读数记入环形缓冲。不额外打硬件，切页也不停。 */
    snapshotTemps() {
      this.tempHistory.push({
        at: Date.now(),
        cpu: this.cpuTemp.value,
        gpu: this.gpuDynamic.value?.GpuTemperature ?? null,
      })
      if (this.tempHistory.length > TEMP_HISTORY_CAP) {
        this.tempHistory.splice(0, this.tempHistory.length - TEMP_HISTORY_CAP)
      }
    },

    /**
     * 启动统一监测（App.vue 全局挂载一次）。返回停止函数，签名与旧版一致。
     */
    startPolling(interval = POLL_INTERVAL_SYSTEM_INFO): () => void {
      this.stopPolling()
      channel = new PollingChannel(
        async () => {
          const ok = await this.fetchSystemInfo()
          if (this.tempHistory.length === 0) this.snapshotTemps()
          return ok
        },
        { intervalMs: interval },
      )
      channel.start()
      historyTimer = setInterval(() => this.snapshotTemps(), TEMP_HISTORY_INTERVAL_MS)
      return () => this.stopPolling()
    },

    stopPolling(): void {
      channel?.dispose()
      channel = null
      if (historyTimer !== null) {
        clearInterval(historyTimer)
        historyTimer = null
      }
    },
  },
})

/** PollingChannel 不进 pinia 响应式：模块级单例（App.vue 全局挂载一次） */
let channel: PollingChannel | null = null
let historyTimer: ReturnType<typeof setInterval> | null = null
