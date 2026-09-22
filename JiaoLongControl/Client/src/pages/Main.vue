<script setup lang="ts">
import RightSide from '@/components/layout/RightSide.vue'
import TitleBar from '@/components/layout/TitleBar.vue'
import ActivityDrawer from '@/components/layout/ActivityDrawer.vue'
import useStore, { HomeCardType, type PageId } from '@/stores'

const store = useStore()

function onClickMenuItem(id: PageId) {
  store.setPage(id)
}

const mainNavItems = HomeCardType.filter((item) => item.id !== 'settings')
const settingsItem = HomeCardType.find((item) => item.id === 'settings')

function showDivider(index: number): boolean {
  if (index <= 0) return false
  return mainNavItems[index]!.group !== mainNavItems[index - 1]!.group
}
</script>

<template>
  <div class="flex flex-col h-screen text-ink overflow-hidden select-none bg-[var(--bg-app)]">
    <TitleBar class="z-50" />

    <div class="flex flex-1 overflow-hidden">
      <aside class="rail" aria-label="主导航">
        <template v-for="(item, index) in mainNavItems" :key="item.id">
          <div v-if="showDivider(index)" class="rail-div" aria-hidden="true" />
          <button
            :class="['rail-btn', store.SwitchPages === item.id ? 'active' : '']"
            :aria-current="store.SwitchPages === item.id ? 'page' : undefined"
            :aria-label="item.title"
            @click="onClickMenuItem(item.id)"
          >
            <component :is="item.icon" :stroke-width="1.75" class="rail-icon" />
            <span class="rail-tip">{{ item.title }}</span>
          </button>
        </template>

        <div class="rail-spacer" />

        <button
          v-if="settingsItem"
          :class="['rail-btn', store.SwitchPages === 'settings' ? 'active' : '']"
          :aria-current="store.SwitchPages === 'settings' ? 'page' : undefined"
          aria-label="系统"
          @click="onClickMenuItem('settings')"
        >
          <component :is="settingsItem.icon" :stroke-width="1.75" class="rail-icon" />
          <span class="rail-tip">系统</span>
        </button>
      </aside>

      <main class="flex-1 relative overflow-hidden bg-[var(--bg-app)]">
        <div class="relative h-full z-10">
          <RightSide />
        </div>
      </main>
    </div>

    <ActivityDrawer />
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

.rail-div {
  width: 20px;
  height: 1px;
  margin: 4px 0;
  background: var(--hair);
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
