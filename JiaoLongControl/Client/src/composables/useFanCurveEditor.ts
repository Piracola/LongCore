import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { AutoFanControl, Fan } from '@/utils/bridge'
import { useConfigStore } from '@/stores/config'
import { useActivityStore } from '@/stores/activity'
import { useFanStore } from '@/stores/fan'
import { useCompositeWrite } from '@/composables/useCompositeWrite'
import { FAN_MAX_RPM, FAN_MIN_RPM } from '@/constants'

export interface FanCurvePoint {
  temp: number
  speed: number
}

/**
 * 风扇曲线编辑器逻辑: 节点数据/坐标映射/拖拽与右键菜单/编辑弹窗/自动保存/服务开关.
 * 模板所需的全部状态与动作由此统一暴露, 组件只负责渲染.
 */
export function useFanCurveEditor() {
  const configStore = useConfigStore()
  const activity = useActivityStore()
  const fanStore = useFanStore()
  const composite = useCompositeWrite()

  const activeTab = ref<'CPU' | 'GPU'>('CPU')
  // 占位默认值, 挂载后会立刻被 config.Fan.*FanCurve 覆盖。
  // 数值与后端 JiaoLongConfig.FanSection 的出厂曲线保持一致, 避免"打开页面先跳一下"。
  const cpuPoints = ref<FanCurvePoint[]>([
    { temp: 60, speed: 1500 },
    { temp: 65, speed: 1800 },
    { temp: 70, speed: 2600 },
    { temp: 75, speed: 3000 },
    { temp: 80, speed: 3300 },
    { temp: 85, speed: 3600 },
    { temp: 90, speed: 4500 },
    { temp: 95, speed: 5800 },
  ])

  const gpuPoints = ref<FanCurvePoint[]>([
    { temp: 60, speed: 1500 },
    { temp: 65, speed: 2000 },
    { temp: 70, speed: 2800 },
    { temp: 75, speed: 3000 },
    { temp: 80, speed: 3600 },
    { temp: 84, speed: 5000 },
    { temp: 87, speed: 5800 },
  ])
  const currentPoints = computed(() =>
    activeTab.value === 'CPU' ? cpuPoints.value : gpuPoints.value,
  )
  const currentTempRange = computed(() => (activeTab.value === 'CPU' ? [60, 95] : [60, 87]))

  // 纵轴上限对齐硬件真实上限 5800: 驱动侧 FanSpeedRawMax(Blding64)=58 会拒绝更高值,
  // 允许拖到 6800 只会得到一个永远不会被下发、还会被 ConfigRange 收敛的假值。
  const speedRange = [FAN_MIN_RPM, FAN_MAX_RPM]
  const padding = { top: 40, right: 60, bottom: 40, left: 60 }

  const containerRef = ref<HTMLDivElement | null>(null)
  const width = ref(0)
  const height = ref(0)
  let resizeObserver: ResizeObserver | null = null

  const draggingIndex = ref<number | null>(null)
  const menuVisible = ref(false)
  const menuPos = reactive({ x: 0, y: 0 })
  const selectedIndex = ref<number | null>(null)
  const showEdit = ref(false)
  const editForm = reactive({ temp: 0, speed: 0 })
  // 曲线服务运行状态：镜像 fanStore 的常驻四态读数（null = 读不到，不得当 false 用）
  const isServiceRunning = computed(() => fanStore.curveService.value ?? false)
  const serviceLoading = ref(false)
  const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const lastSavedAt = ref<number | null>(null)

  let autoSaveTimer: number | null = null

  const canDelete = computed(() => selectedIndex.value !== null && currentPoints.value.length > 2)

  const isValidRender = computed(() => {
    return (
      width.value > 0 &&
      height.value > 0 &&
      currentPoints.value.every((p) => !isNaN(p.temp) && !isNaN(p.speed))
    )
  })

  function onTabChange() {
    closeMenu()
    draggingIndex.value = null
    selectedIndex.value = null
  }

  const checkServiceStatus = async () => {
    // 曲线服务状态由 App.vue 常驻轮询维护（fanStore.curveService），这里只借用，
    // 不再自立一套 —— 否则切页回来读数会假死，且多一路查询打扰 EC。
    await fanStore.refreshCurveService()
  }

  /**
   * 把「要应用内曲线」这个用户意图落盘, 供 SelfStart 在下次开机时遵循。
   * 没有这一步, BootAdvancedFanControlSystem 会在每次开机把用户刚关掉的接管重新拉起。
   * 落盘失败不阻断本地的启停结果 —— 本地状态才是用户当下看到的真相。
   * 只用于**开启**方向：关闭方向由交还 EC 三步里的落盘步骤负责（那一步失败必须报出来）。
   */
  const persistServiceIntent = async (enabled: boolean) => {
    try {
      if (!configStore.config) return
      configStore.config.Fan.Enabled = enabled
      await configStore.saveConfig()
    } catch (e) {
      console.error('风扇曲线接管意图保存失败:', e)
    }
  }

  const handleServiceToggle = async (newValue: string | number | boolean): Promise<boolean> => {
    serviceLoading.value = true
    try {
      if (newValue) {
        const result = await AutoFanControl.Start()
        if (!result.Success) throw new Error(result.Message || '自动风扇控制启用失败')
        Message.success('自动风扇控制已启用')
        await persistServiceIntent(true)
      } else {
        // 关掉曲线开关**就是**交还 EC（README「与 EC 固件的关系」/ KNOWN_ISSUES 第 5 条
        // 的口径）：只停服务 + 落盘是假交还 —— 0xB20 手动掩码还置位、EC 温控仍被绕开。
        // 与看板 fan.curve 的「移除」、本页「交还 EC 固件温控」共用同一组三步（顺序即语义）。
        if (!(await runHandoffToEcSteps())) {
          throw new Error(composite.state.value.message || '交还 EC 未完成，曲线开关未关闭')
        }
        Message.info('自动风扇控制已停止，已交还 EC 固件温控')
      }
      await AutoFanControl.IsRunning()
      await fanStore.refreshCurveService()
      const matches = isServiceRunning.value === !!newValue
      activity.record({
        source: 'user',
        intent: newValue ? '启用风扇曲线控制' : '停止风扇曲线控制',
        requestedValue: !!newValue,
        outcome: matches ? 'applied' : 'failed',
        reversible: 'c',
      })
      return matches
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '操作失败，请检查日志')
      await AutoFanControl.IsRunning()
      await fanStore.refreshCurveService().catch(() => undefined)
      activity.record({
        source: 'user',
        intent: newValue ? '启用风扇曲线控制' : '停止风扇曲线控制',
        requestedValue: !!newValue,
        outcome: 'failed',
        reversible: 'c',
      })
      return false
    } finally {
      serviceLoading.value = false
    }
  }
  const autoSave = async () => {
    saveState.value = 'saving'
    try {
      if (configStore.config) {
        configStore.config.Fan.CpuFanCurve = cpuPoints.value
        configStore.config.Fan.GpuFanCurve = gpuPoints.value
        const result = (await configStore.saveConfig()) as
          { Success?: boolean; Message?: string } | undefined
        if (!result?.Success) throw new Error(result?.Message || '曲线保存失败')
        lastSavedAt.value = Date.now()
        saveState.value = 'saved'
      }
    } catch (e) {
      saveState.value = 'error'
      console.error('Save failed:', e)
    }
  }
  watch(
    [cpuPoints, gpuPoints],
    () => {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer)
      }
      autoSaveTimer = window.setTimeout(() => {
        autoSave()
      }, 500)
    },
    { deep: true },
  )

  function safeMapX(val: number): number {
    if (isNaN(val) || width.value <= 0) return 0
    const result = mapX(val)
    return isNaN(result) ? 0 : result
  }

  function safeMapY(val: number): number {
    if (isNaN(val) || height.value <= 0) return 0
    const result = mapY(val)
    return isNaN(result) ? 0 : result
  }

  function mapX(temp: number) {
    const innerWidth = width.value - padding.left - padding.right
    const range = currentTempRange.value
    const ratio = (temp - range[0]!) / (range[1]! - range[0]!)
    return padding.left + ratio * innerWidth
  }

  function mapY(speed: number) {
    const innerHeight = height.value - padding.top - padding.bottom
    const ratio = (speed - speedRange[0]!) / (speedRange[1]! - speedRange[0]!)
    return padding.top + (1 - ratio) * innerHeight
  }

  function unmapX(x: number) {
    const innerWidth = width.value - padding.left - padding.right
    const range = currentTempRange.value
    const ratio = (x - padding.left) / innerWidth
    return range[0]! + ratio * (range[1]! - range[0]!)
  }

  function unmapY(y: number) {
    const innerHeight = height.value - padding.top - padding.bottom
    const ratio = (y - padding.top) / innerHeight
    return speedRange[0]! + (1 - ratio) * (speedRange[1]! - speedRange[0]!)
  }

  const polylinePoints = computed(() => {
    return currentPoints.value.map((p) => `${safeMapX(p.temp)},${safeMapY(p.speed)}`).join(' ')
  })

  // 计算面积渐变闭合多边形的坐标点
  const polygonPoints = computed(() => {
    if (currentPoints.value.length === 0) return ''
    const pts = currentPoints.value.map((p) => `${safeMapX(p.temp)},${safeMapY(p.speed)}`)
    // 投影右下角点与左下角点以闭合底部
    const lastPt = currentPoints.value[currentPoints.value.length - 1]
    const firstPt = currentPoints.value[0]
    pts.push(`${safeMapX(lastPt!.temp)},${safeMapY(speedRange[0]!)}`)
    pts.push(`${safeMapX(firstPt!.temp)},${safeMapY(speedRange[0]!)}`)
    return pts.join(' ')
  })

  function parseConfigPoints(rawData: unknown): FanCurvePoint[] | null {
    if (!rawData || !Array.isArray(rawData)) return null
    const cleanData = rawData.map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>
      const t = Number(rec.temp ?? rec.Temp ?? rec.Temperature ?? rec.temperature ?? 0)
      const s = Number(rec.speed ?? rec.Speed ?? rec.FanSpeed ?? rec.rpm ?? 0)
      return { temp: t, speed: s }
    })
    const validData = cleanData.filter(
      (p: FanCurvePoint) => !isNaN(p.temp) && !isNaN(p.speed) && p.temp > 0,
    )
    return validData.length > 0 ? validData : null
  }

  onMounted(async () => {
    if (containerRef.value) {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (entry!.contentRect.width > 0 && entry!.contentRect.height > 0) {
          width.value = entry!.contentRect.width
          height.value = entry!.contentRect.height
        }
      })
      resizeObserver.observe(containerRef.value)
    }

    await checkServiceStatus()
    try {
      if (!configStore.config) {
        await configStore.fetchConfig()
      }
      const advancedConfig = configStore.config?.Fan
      const parsedCpu = parseConfigPoints(advancedConfig?.CpuFanCurve)
      if (parsedCpu) cpuPoints.value = parsedCpu
      const parsedGpu = parseConfigPoints(advancedConfig?.GpuFanCurve)
      if (parsedGpu) gpuPoints.value = parsedGpu
    } catch (e) {
      console.error(e)
    }
  })

  onUnmounted(() => {
    resizeObserver?.disconnect()
    if (autoSaveTimer) clearTimeout(autoSaveTimer)
  })

  function onDragStart(index: number, e: MouseEvent) {
    if (e.button !== 0) return
    draggingIndex.value = index
    menuVisible.value = false
  }

  function onSvgMouseMove(e: MouseEvent) {
    if (draggingIndex.value === null) return

    const rect = containerRef.value!.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    let newTemp = Math.round(unmapX(mouseX))
    let newSpeed = Math.round(unmapY(mouseY))

    newSpeed = Math.max(speedRange[0]!, Math.min(newSpeed, speedRange[1]!))

    const idx = draggingIndex.value
    const pointsRef = currentPoints.value
    const range = currentTempRange.value

    const minT = idx === 0 ? range[0] : pointsRef[idx - 1]!.temp + 1
    const maxT = idx === pointsRef.length - 1 ? range[1] : pointsRef[idx + 1]!.temp - 1
    newTemp = Math.max(minT!, Math.min(newTemp, maxT!))

    pointsRef[idx]!.temp = newTemp
    pointsRef[idx]!.speed = newSpeed
  }

  function onDragEnd() {
    draggingIndex.value = null
  }

  const menuStyle = computed(() => ({
    left: `${menuPos.x}px`,
    top: `${menuPos.y}px`,
    // 从点击点左上角生长(popover origin-aware)
    transformOrigin: 'top left',
  }))

  function openContextMenu(index: number, e: MouseEvent) {
    selectedIndex.value = index
    menuVisible.value = true

    const rect = containerRef.value!.getBoundingClientRect()
    menuPos.x = e.clientX - rect.left + 10
    menuPos.y = e.clientY - rect.top
  }

  function closeMenu() {
    menuVisible.value = false
  }

  function getMinTemp(index: number) {
    if (index === 0) return currentTempRange.value[0]
    return currentPoints.value[index - 1]!.temp + 1
  }

  function getMaxTemp(index: number) {
    if (index === currentPoints.value.length - 1) return currentTempRange.value[1]
    return currentPoints.value[index + 1]!.temp - 1
  }

  function onAddNode() {
    if (selectedIndex.value === null) return
    const pointsRef = currentPoints.value
    const curr = pointsRef[selectedIndex.value]
    const next = pointsRef[selectedIndex.value + 1]

    if (curr == undefined) return
    if (!next || next.temp <= curr.temp + 1) return

    pointsRef.splice(selectedIndex.value + 1, 0, {
      temp: Math.floor((curr.temp + next.temp) / 2),
      speed: Math.floor((curr.speed + next.speed) / 2),
    })
    closeMenu()
  }

  function onRemoveNode() {
    if (!canDelete.value || selectedIndex.value === null) return
    currentPoints.value.splice(selectedIndex.value, 1)
    closeMenu()
    selectedIndex.value = null
  }

  function openEditModal() {
    if (selectedIndex.value === null) return
    const p = currentPoints.value[selectedIndex.value]
    editForm.temp = p!.temp
    editForm.speed = p!.speed
    showEdit.value = true
    closeMenu()
  }

  function onEditConfirm() {
    if (selectedIndex.value === null) return
    currentPoints.value[selectedIndex.value]!.temp = editForm.temp
    currentPoints.value[selectedIndex.value]!.speed = editForm.speed
    showEdit.value = false
  }

  /**
   * 停曲线服务，并用**独立回读**确认「真的停了」（v4 §8.4：命令被接受 ≠ 已生效）。
   *
   * 两个方向都不能偷懒：
   * - 只看 Stop() 的返回值会假红：命令报失败 ≠ 没生效（后端曾在真停成功时返回 false），
   *   而这里一判失败就会中止后面的撤掩码/落盘，交还 EC 整条路断掉（安全问题）。
   * - 不看返回值直接往下走会假绿：没确认停掉就去撤掩码，曲线下一拍又把掩码写回来。
   *
   * 判据取 Data 而不是 Success —— `AutoFanControl.IsRunning()` 的 Success 就是运行态本身
   * （没在跑时 Success=false、Data=false），拿 Success 当"读取成功"会正好读反。
   */
  async function stopCurveService(): Promise<{ stopped: boolean; message: string }> {
    let beforeData: unknown
    try {
      beforeData = (await AutoFanControl.IsRunning()).Data
    } catch {
      // 读不到运行态 → 当作"不知道"，仍去发停止命令（幂等），绝不跳过停止这一步
      beforeData = undefined
    }
    if (beforeData === false) return { stopped: true, message: '曲线服务未在运行' }

    const stop = await AutoFanControl.Stop()
    if (stop.Success === true) return { stopped: true, message: stop.Message }

    let observed: unknown
    try {
      observed = (await AutoFanControl.IsRunning()).Data
    } catch (err) {
      return {
        stopped: false,
        message: `${stop.Message}；回读异常，未确认已停止：${err instanceof Error ? err.message : '未知错误'}`,
      }
    }
    if (observed === false) {
      return { stopped: true, message: `${stop.Message}；独立回读确认已停止` }
    }
    return {
      stopped: false,
      message:
        observed === true
          ? `${stop.Message}；独立回读确认仍在运行`
          : `${stop.Message}；回读无数据，未确认已停止`,
    }
  }

  /**
   * 交还 EC 固件温控的三步（顺序即语义，与看板注册表 fan.curve.removal 同一口径）：
   * 停曲线服务 → `Fan.RemoveFanSpeed`（撤 0xB20 手动掩码）→ `Fan.Enabled=false` 落盘。
   *
   * 三个入口共用它，避免任何一处少发一步：
   * 曲线页「交还 EC 固件温控」、曲线开关关掉（handleServiceToggle(false)）、
   * 概览页看板 fan.curve 的「移除」。
   *
   * @returns true = 三步都生效
   */
  async function runHandoffToEcSteps(): Promise<boolean> {
    const event = await composite.run({
      source: 'user',
      transport: 'ec',
      requestedValue: null,
      reversible: 'c',
      compensation: '交还 EC 固件温控',
      preRead: {
        value: fanStore.curveService.value,
        readable: fanStore.curveService.state === 'ok',
      },
      steps: [
        {
          label: '停止应用内曲线服务',
          transport: 'ec',
          requestedValue: false,
          run: async () => {
            // 现读而不是拿 5s 轮询的镜像：刚起来的服务会被漏掉，
            // 那样下一步的 RemoveFanSpeed 立刻被曲线写回。
            const stopped = await stopCurveService()
            return { accepted: stopped.stopped, message: stopped.message }
          },
        },
        {
          label: '移除转速设置（撤掉手动掩码，EC 温控重新生效）',
          transport: 'ec',
          requestedValue: null,
          run: async () => {
            const remove = await Fan.RemoveFanSpeed()
            return { accepted: remove.Success === true, message: remove.Message }
          },
        },
        {
          label: '关闭「开机自动拉起曲线」意图并保存配置',
          transport: 'config',
          requestedValue: false,
          run: async () => {
            if (!configStore.config) return { accepted: false, message: '配置未加载，意图未落盘' }
            configStore.config.Fan.Enabled = false
            const res = (await configStore.saveConfig()) as
              { Success?: boolean; Message?: string } | undefined
            return { accepted: res?.Success === true, message: res?.Message ?? '配置保存失败' }
          },
        },
      ],
    })

    return !event.steps.some((s) => s.status === 'failed')
  }

  /**
   * 「交还 EC 固件温控」—— 曲线页的那个按钮。
   *
   * 三步都必须真发出去，缺一不可：
   * 1. 停曲线服务（否则 RemoveFanSpeed 下一拍就被曲线写回去）
   * 2. Fan.RemoveFanSpeed —— 撤掉 0xB20 手动掩码，EC 固件温控重新生效
   * 3. Fan.Enabled = false **并保存**：只改前端内存的话，下次开机 SelfStart 会按
   *    BootAdvancedFanControlSystem 把曲线重新拉起，用户以为交还了、实际没有。
   *
   * 逐项结果与「失败不报成功」沿用 useCompositeWrite 的既有口径（遇失败中止、
   * 已生效项不撤销、partialApplied 显式暴露），不另起一套。
   */
  async function handleHandoffToEc(): Promise<boolean> {
    const ok = await runHandoffToEcSteps()

    if (!ok) {
      // 不得报成功：部分应用时也要让用户看见「哪一步没有生效」
      Message.error(`交还 EC 未完成：${composite.state.value.message ?? '有步骤失败'}`)
    } else {
      Message.success('已交还 EC 固件温控')
      fanStore.setCurveService(false)
    }
    activity.record({
      source: 'user',
      intent: '交还 EC 固件温控',
      requestedValue: null,
      outcome: ok ? 'applied' : 'failed',
      reversible: 'c',
    })
    return ok
  }

  /**
   * 控制策略显示值 —— 四态。服务状态读不到时返回「未知」，绝不把 null 当 false 显示成
   * 「EC 自动控制」那样的事实断言（v4 §7：读不到必须显式标注）。
   */
  /**
   * 门禁：固件三档（办公/游戏/狂飙）下风扇由 EC 自己的表管理，曲线编辑不开放。
   */
  /**
   * 曲线接管不再按性能档位设限。
   * 固件三档的 EC 温控表在低负载区压得极低、临近温度墙才跳变("平时很静、95℃ 才猛拉"),
   * 要让风扇随温度平缓跟随, 必须由应用接管; 因此三档与自定义档一视同仁。
   * 保留这个 computed 只是为了让模板与禁用条件少改一处, 恒为 false。
   */
  const locked = computed(() => false)

  const strategyLabel = computed(() => {
    const r = fanStore.curveService
    if (r.value === true) return '应用内曲线接管'
    if (r.value === false) return 'EC 自动控制'
    return r.state === 'error' ? '读取失败' : '未知'
  })

  return {
    activeTab,
    cpuPoints,
    gpuPoints,
    currentPoints,
    currentTempRange,
    speedRange,
    padding,
    containerRef,
    width,
    height,
    draggingIndex,
    menuVisible,
    menuPos,
    selectedIndex,
    showEdit,
    editForm,
    isServiceRunning,
    locked,
    strategyLabel,
    serviceLoading,
    saveState,
    lastSavedAt,
    canDelete,
    isValidRender,
    onTabChange,
    checkServiceStatus,
    handleServiceToggle,
    handleHandoffToEc,
    composite,
    safeMapX,
    safeMapY,
    mapX,
    mapY,
    unmapX,
    unmapY,
    polylinePoints,
    polygonPoints,
    onDragStart,
    onSvgMouseMove,
    onDragEnd,
    menuStyle,
    openContextMenu,
    closeMenu,
    getMinTemp,
    getMaxTemp,
    onAddNode,
    onRemoveNode,
    openEditModal,
    onEditConfirm,
  }
}
