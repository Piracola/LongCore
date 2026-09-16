<script setup lang="ts">
import RightSide from '@/components/layout/RightSide.vue'
import TitleBar from '@/components/layout/TitleBar.vue'
import useStore, { HomeCardType } from '@/stores'

const store = useStore()

function onClickMenuItem(key: number) {
  store.setPage(key)
}

// 设置固定在轨底, 其余主导航按注册顺序
const mainNavItems = HomeCardType.filter((item) => item.num !== 8)
const settingsItem = HomeCardType.find((item) => item.num === 8)
</script>

<template>
  <div class="flex flex-col h-screen text-ink overflow-hidden select-none bg-[var(--bg-app)]">
    <TitleBar class="z-50" />

    <div class="flex flex-1 overflow-hidden">
      <!-- 60px 图标轨: 仪器面板导航, 替代 240px SaaS 侧栏 -->
      <aside class="rail" aria-label="主导航">
        <button
          v-for="item in mainNavItems"
          :key="item.num"
          :class="['rail-btn', store.SwitchPages === item.num ? 'active' : '']"
          :aria-current="store.SwitchPages === item.num ? 'page' : undefined"
          :aria-label="item.title"
          @click="onClickMenuItem(Number(item.num))"
        >
          <component :is="item.icon" :stroke-width="1.75" class="rail-icon" />
          <span class="rail-tip">{{ item.title }}</span>
        </button>

        <div class="rail-spacer" />

        <button
          v-if="settingsItem"
          :class="['rail-btn', store.SwitchPages === 8 ? 'active' : '']"
          :aria-current="store.SwitchPages === 8 ? 'page' : undefined"
          aria-label="设置"
          @click="onClickMenuItem(8)"
        >
          <component :is="settingsItem.icon" :stroke-width="1.75" class="rail-icon" />
          <span class="rail-tip">设置</span>
        </button>
      </aside>

      <main class="flex-1 relative overflow-hidden bg-[var(--bg-app)]">
        <div class="relative h-full z-10">
          <RightSide />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped lang="scss">
.rail {
  width: 60px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 4px;
  background: var(--bg-inset);
  border-right: 1px solid var(--hair);
}

.rail-btn {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  display: grid;
  place-items: center;
  color: var(--weak);
  position: relative;
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}

.rail-btn:hover {
  color: var(--ink);
  background: rgba(255, 255, 255, 0.04);
}

.rail-btn.active {
  color: var(--accent);
  background: var(--accent-dim);
}

.rail-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}

.rail-icon {
  width: 20px;
  height: 20px;
}

.rail-spacer {
  flex: 1;
}

.rail-tip {
  position: absolute;
  left: 52px;
  top: 50%;
  transform: translateY(-50%);
  background: var(--bg-raised);
  border: 1px solid var(--hair-strong);
  color: var(--ink);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-press) var(--ease-out);
  z-index: 20;
}

.rail-btn:hover .rail-tip,
.rail-btn:focus-visible .rail-tip {
  opacity: 1;
}
</style>
