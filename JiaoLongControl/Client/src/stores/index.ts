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
import { migratePageId, type PageGroup, type PageId } from '@/stores/pageIds'

export type { PageGroup, PageId }
export { migratePageId } from '@/stores/pageIds'

const PAGE_STORAGE_KEY = 'jl-ui-page'

const useStore = defineStore('store', {
  state: () => {
    let initialPage: PageId = 'home'
    try {
      initialPage = migratePageId(localStorage.getItem(PAGE_STORAGE_KEY))
    } catch {
      /* localStorage 不可用时使用默认页 */
    }
    return {
      SwitchPages: initialPage as PageId,
    }
  },
  actions: {
    setPage(page: PageId) {
      this.SwitchPages = page
      try {
        localStorage.setItem(PAGE_STORAGE_KEY, page)
      } catch {
        /* 忽略持久化失败 */
      }
    },
  },
})

export interface HomeCardItem {
  id: PageId
  title: string
  group: PageGroup
  icon: Component
  page: Component
}

const HomeCardType: HomeCardItem[] = [
  { id: 'home', title: '概览', group: 'overview', icon: markRaw(Home), page: HOME_Page },
  { id: 'cpu', title: 'CPU', group: 'perf', icon: markRaw(Cpu), page: CPU_Page },
  { id: 'gpu', title: 'GPU', group: 'perf', icon: markRaw(MonitorCog), page: GPU_Page },
  {
    id: 'fan-curve',
    title: '风扇曲线',
    group: 'thermal',
    icon: markRaw(ChartLine),
    page: FanCurveEditor,
  },
  { id: 'fan', title: '风扇', group: 'thermal', icon: markRaw(Fan), page: Fan_Page },
  { id: 'keyboard', title: '灯效', group: 'light', icon: markRaw(Keyboard), page: Keyboard_Page },
  { id: 'smu', title: 'SMU', group: 'advanced', icon: markRaw(Microchip), page: RyzenSmu_Page },
  { id: 'settings', title: '系统', group: 'system', icon: markRaw(Settings), page: Settings_Page },
]

export { HomeCardType }
export default useStore
