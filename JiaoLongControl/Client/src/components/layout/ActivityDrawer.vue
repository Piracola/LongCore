<script setup lang="ts">
import { OUTCOME_LABEL, SOURCE_LABEL, useActivityStore } from '@/stores/activity'

const activity = useActivityStore()

function formatTime(at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="activity.open" class="scrim" @click="activity.close" />
    <aside
      class="drawer"
      :class="{ open: activity.open }"
      role="dialog"
      aria-label="最近活动"
      :aria-hidden="!activity.open"
    >
      <header class="head">
        <div>
          <h2>最近活动</h2>
          <p>用户意图级记录，不含自动温控底层写入</p>
        </div>
        <button type="button" class="close" aria-label="关闭" @click="activity.close">×</button>
      </header>

      <ul v-if="activity.recent.length" class="list">
        <li v-for="item in activity.recent" :key="item.seq" class="row">
          <div class="meta">
            <span class="src">{{ SOURCE_LABEL[item.source] }}</span>
            <time>{{ formatTime(item.at) }}</time>
          </div>
          <div class="body">
            <span class="intent">{{ item.intent }}</span>
            <span :class="['out', item.outcome]">{{ OUTCOME_LABEL[item.outcome] }}</span>
          </div>
        </li>
      </ul>
      <p v-else class="empty">暂无记录。切换档位、应用功耗或手动风扇会出现在这里。</p>
    </aside>
  </Teleport>
</template>

<style scoped lang="scss">
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  z-index: 80;
}

.drawer {
  position: fixed;
  top: 36px;
  right: 0;
  bottom: 0;
  width: min(360px, 100vw);
  background: var(--bg-panel);
  border-left: 1px solid var(--hair);
  z-index: 90;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform var(--dur-base, 180ms) var(--ease-out, ease);
  pointer-events: none;

  &.open {
    transform: translateX(0);
    pointer-events: auto;
  }
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--hair);

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 650;
    color: var(--ink);
  }

  p {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--weak);
    line-height: 1.4;
  }
}

.close {
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  border-radius: var(--radius-sm);

  &:hover {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.04);
  }

  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  flex: 1;
}

.row {
  padding: 10px 16px;
  border-bottom: 1px solid var(--hair);
}

.meta {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--weak);
  margin-bottom: 4px;
}

.intent {
  color: var(--ink);
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.out {
  flex-shrink: 0;
  font-size: 11px;

  &.applied {
    color: var(--temp-cool);
  }
  &.failed {
    color: var(--temp-critical);
  }
  &.partial {
    color: var(--temp-hot);
  }
  &.accepted {
    color: var(--muted);
  }
}

.empty {
  margin: 24px 16px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

@media (prefers-reduced-motion: reduce) {
  .drawer {
    transition: none;
  }
}
</style>
