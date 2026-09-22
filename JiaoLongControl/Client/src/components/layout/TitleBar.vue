<script setup lang="ts">
import { History } from '@lucide/vue'
import { Window } from '@/utils/bridge'
import { useActivityStore } from '@/stores/activity'

const activity = useActivityStore()

function handleMouseDown(e: MouseEvent) {
  if (e.button === 0) {
    Window.Drag()
  }
}
</script>

<template>
  <div class="title-bar">
    <div class="drag-region" @mousedown="handleMouseDown">
      <div class="mark" aria-hidden="true">LC</div>
      <span class="title">LongCore</span>
      <span class="sub">蛟龙 16 Pro · 硬件控制台</span>
    </div>
    <div class="window-actions">
      <button
        class="action-btn"
        :aria-pressed="activity.open"
        aria-label="最近活动"
        title="最近活动"
        @click="activity.toggle"
      >
        <History class="w-3.5 h-3.5" :stroke-width="2" />
      </button>
      <button class="action-btn" aria-label="最小化" @click="Window.Minimize()">
        <icon-minus />
      </button>
      <button class="action-btn" aria-label="最大化或还原" @click="Window.Maximize()">
        <icon-fullscreen />
      </button>
      <button class="action-btn close" aria-label="关闭" @click="Window.Close()">
        <icon-close />
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 36px;
  flex-shrink: 0;
  user-select: none;
  background: var(--bg-app);
  border-bottom: 1px solid var(--hair);

  .drag-region {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 14px;
    -webkit-app-region: drag;

    .mark {
      width: 18px;
      height: 18px;
      border-radius: 3px;
      background: var(--accent-dim);
      border: 1px solid var(--accent-line);
      display: grid;
      place-items: center;
      color: var(--accent);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }

    .title {
      color: var(--ink);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }

    .sub {
      color: var(--weak);
      font-size: 11px;
      font-weight: 400;
    }
  }

  .window-actions {
    display: flex;
    align-items: stretch;
    height: 100%;
    -webkit-app-region: no-drag;

    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      width: 42px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      cursor: pointer;
      transition: background-color var(--dur-press) var(--ease-out);

      &:hover {
        background-color: rgba(255, 255, 255, 0.05);
        color: var(--ink);
      }

      &:active {
        background-color: var(--color-overlay-strong);
      }

      &:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }

      &.close:hover {
        background-color: #e81123;
        color: white;
      }
    }
  }
}

[data-theme='light'] .title-bar {
  .sub {
    color: var(--weak);
  }

  .window-actions .action-btn:hover {
    background-color: rgba(13, 14, 21, 0.05);
  }
}
</style>
