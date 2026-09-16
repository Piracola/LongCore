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
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-page">
          <div class="suspense-orb" aria-hidden="true"></div>
          <span class="text-xs text-gray-400 tracking-wide">Loading Configuration...</span>
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

/* 加载环: 单色冷青, 无辉光 */
.suspense-orb {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: var(--accent);
  border-right-color: var(--accent-line);
  animation: orb-spin 0.8s linear infinite;
}

@keyframes orb-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .suspense-orb {
    animation-duration: 1.6s;
  }
}
</style>
