import { defineStore } from 'pinia'
import { CPU, NvidiaGpu } from '@/utils/bridge'
import { useFanStore } from '@/stores/fan'
import { PollingChannel } from '@/utils/reading'
import { POLL_INTERVAL_FAN_SPEED, TELEMETRY_CAP } from '@/constants'

/**
 * 遥测环形缓冲 store —— 风扇曲线页「实时运行状态遥测」的数据源。
 *
 * 问题背景：旧实现把采样定时器放在 FanSpeed.vue 组件里，onUnmounted 即销毁，
 * 切页后历史清零，回到页面图表只剩最近一段。这与首页温度历史
 * （systemInfo.tempHistory，App.vue 全局挂载、切页不停）是同一问题的第二处实例，
 * 因此按同一模式收敛：采样进 store、调度挂 App.vue，组件只做纯渲染。
 *
 * 转速复用 fan store 的常驻读数（fan.speed，同为 2s 节拍），不再对
 * Fan.GetFanSpeed 发第二条轮询 —— bridge 缓存 TTL 只有 1s，双通道各 2s
 * 等于每 2s 打两次硬件；复用读数是零额外开销。
 *
 * 样本级 null 语义（v4 §7.1）：某通道本轮读取失败 → 该字段记 null，
 * 图表断线显示；绝不回填 0、也绝不沿用旧值（那会把「没读到」画成「没变化」）。
 */

/** 单点遥测样本。null = 该通道本轮不可用 */
export interface TelemetrySample {
  at: number
  cpuFan: number | null
  gpuFan: number | null
  cpuTemp: number | null
  gpuTemp: number | null
}

export type TelemetryState = 'loading' | 'ok' | 'stale' | 'error'

interface TelemetryStateModel {
  samples: TelemetrySample[]
  state: TelemetryState
  /** 常驻调度是否在跑（App.vue 挂载一次） */
  recording: boolean
}

export const useTelemetryStore = defineStore('telemetry', {
  state: (): TelemetryStateModel => ({
    samples: [],
    state: 'loading',
    recording: false,
  }),

  getters: {
    stateLabel(s): string {
      switch (s.state) {
        case 'ok':
          return '数据正常'
        case 'stale':
          return '数据过期'
        case 'error':
          return '读取失败'
        default:
          return '正在读取'
      }
    },
    /** x 轴时间标签（HH:MM:SS），与 samples 一一对应 */
    times(s): string[] {
      return s.samples.map((sample) => {
        const d = new Date(sample.at)
        const pad = (n: number) => String(n).padStart(2, '0')
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      })
    },
  },

  actions: {
    /** 追加样本并截断到环形上限（只留最近 cap 条，与 tempHistory 同款截取） */
    record(sample: TelemetrySample): void {
      this.samples.push(sample)
      if (this.samples.length > TELEMETRY_CAP) {
        this.samples.splice(0, this.samples.length - TELEMETRY_CAP)
      }
    },

    /**
     * 一拍采样：转速取 fan store 快照，温度独立读取。
     * 全部通道失败 → 有旧样本 stale、从未成功 error，且不追加空样本；
     * 任一通道成功 → 追加样本（失败通道记 null）。
     */
    async poll(): Promise<boolean> {
      const fanStore = useFanStore()
      const speed = fanStore.speed
      const fanOk = speed.state === 'ok' && speed.value !== null
      let anyOk = fanOk
      let cpuTemp: number | null = null
      let gpuTemp: number | null = null

      try {
        const t = await CPU.GetCPUThermometer()
        if (t.Success && t.Data !== undefined && t.Data !== null) {
          cpuTemp = Number(t.Data)
          anyOk = true
        }
      } catch {
        /* 该通道本轮缺失，样本记 null */
      }
      try {
        const g = await NvidiaGpu.GetGpuTemperature()
        if (g.Success && g.Data !== undefined && g.Data !== null) {
          gpuTemp = Number(g.Data)
          anyOk = true
        }
      } catch {
        /* 同上 */
      }

      if (!anyOk) {
        this.state = this.samples.length > 0 ? 'stale' : 'error'
        return false
      }
      this.record({
        at: Date.now(),
        cpuFan: fanOk && speed.value ? speed.value.CPUFanSpeed : null,
        gpuFan: fanOk && speed.value ? speed.value.GPUFanSpeed : null,
        cpuTemp,
        gpuTemp,
      })
      this.state = 'ok'
      return true
    },

    /** App.vue 全局挂载一次，切页不停（与 systemInfo/fan 同款调度）。返回停止函数。 */
    startRecording(interval = POLL_INTERVAL_FAN_SPEED): () => void {
      this.stopRecording()
      channel = new PollingChannel(() => this.poll(), { intervalMs: interval })
      channel.start()
      this.recording = true
      return () => this.stopRecording()
    },

    stopRecording(): void {
      channel?.dispose()
      channel = null
      this.recording = false
    },
  },
})

/** PollingChannel 不进 pinia 响应式：模块级单例（App.vue 全局挂载一次） */
let channel: PollingChannel | null = null
