<script setup lang="ts">
import useStore, { HomeCardType } from '@/stores'
import { computed } from 'vue'

const store = useStore()
const currentComponent = computed(() => {
  for (let i of HomeCardType) {
    if (i.num === store.$state.SwitchPages) {
      return i.page
    }
  }
  return HomeCardType[0]!.page
})

// 视图切换保持静止 —— 导航是最高频交互面(日常数十次), 不加切换动效。
// 历史实现依赖 magic.min.css 的 @keyframes swap(scale(0) translate(-700px)),
// 但未挂该库的时长基类, animation-duration 回落 0s, 实际等同于硬跳;
// 且 JS 驱动的 animationend 不可中断, 快速连点有卡死风险 —— 已整体移除。
</script>

<template>
  <div class="rightSide relative">
    <Suspense>
      <template #default>
        <component :is="currentComponent" :key="store.$state.SwitchPages" />
      </template>
      <template #fallback>
        <div class="absolute inset-0 flex items-center justify-center bg-page">
          <div class="flex flex-col items-center gap-3">
            <svg
              class="suspense-spinner animate-spin h-8 w-8 text-purple-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              ></circle>
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            <span class="text-sm text-gray-400">Loading Configuration...</span>
          </div>
        </div>
      </template>
    </Suspense>
  </div>
</template>

<style scoped>
.rightSide {
  width: 100%;
  height: 100%;
}
</style>
