import { defineStore } from 'pinia'
import { markRaw, type Component } from 'vue'
import { ChartLine, Cpu, Fan, Home, Keyboard, Microchip, MonitorCog, Settings } from '@lucide/vue'
import HOME_Page from '@/pages/Home.vue'
import CPU_Page from '@/pages/CPU.vue'
import Fan_Page from '@/pages/Fan.vue'
import Keyboard_Page from '@/pages/KeyBoard.vue'
import Settings_Page from '@/pages/Settings.vue'
import GPU_Page from '@/pages/GPU.vue'
import RyzenSmu_Page from '@/pages/RyzenSmu.vue'
import FanCurveEditor from '@/pages/FanCurveEditor.vue'

const PAGE_STORAGE_KEY = 'jl-ui-page'
const useStore = defineStore('store', {
  state: () => {
    // 页面状态持久化：记住上次停留的页面，重启后恢复
    let initialPage = HomeCardType[0]!.num
    try {
      const saved = Number(localStorage.getItem(PAGE_STORAGE_KEY))
      if (Number.isInteger(saved) && saved >= 1 && saved <= HomeCardType.length) {
        initialPage = saved
      }
    } catch {
      /* localStorage 不可用时使用默认页 */
    }
    return {
      SwitchPages: initialPage,
    }
  },
  actions: {
    setPage(page: number) {
      this.SwitchPages = page
      try {
        localStorage.setItem(PAGE_STORAGE_KEY, String(page))
      } catch {
        /* 忽略持久化失败 */
      }
    },
  },
})

// 线性图标统一走 @lucide/vue(组件以 markRaw 包装, 避免响应式代理开销);
// 隐喻约定: 主页=Home, CPU=Cpu, GPU=MonitorCog, SMU=Microchip, 曲线=ChartLine, 风扇=Fan
export interface HomeCardItem {
  title: string
  icon: Component
  page: Component
  num: number
}

const HomeCardType = (
  [
    { title: '主页', icon: markRaw(Home), page: HOME_Page },
    { title: '中央处理器', icon: markRaw(Cpu), page: CPU_Page },
    { title: '图形处理器', icon: markRaw(MonitorCog), page: GPU_Page },
    { title: 'Ryzen SMU', icon: markRaw(Microchip), page: RyzenSmu_Page },
    { title: '风扇曲线', icon: markRaw(ChartLine), page: FanCurveEditor },
    { title: '风扇', icon: markRaw(Fan), page: Fan_Page },
    { title: '键盘', icon: markRaw(Keyboard), page: Keyboard_Page },
    { title: '设置', icon: markRaw(Settings), page: Settings_Page },
  ] as Array<Omit<HomeCardItem, 'num'>>
).map((item, index) => ({
  ...item,
  num: index + 1,
})) as Array<HomeCardItem>

export { HomeCardType }
export default useStore
