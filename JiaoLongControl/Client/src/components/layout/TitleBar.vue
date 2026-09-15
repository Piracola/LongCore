<script setup lang="ts">
import { Window } from '@/utils/bridge'

function handleMouseDown(e: MouseEvent) {
  if (e.button === 0) {
    Window.Drag()
  }
}
</script>

<template>
  <div class="title-bar">
    <div class="drag-region" @mousedown="handleMouseDown">
      <img src="@/assets/logo.svg" class="logo" alt="LongCore" />
      <span class="title">JiaoLong Control</span>
    </div>
    <div class="window-actions">
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
  height: 50px;
  user-select: none;

  .drag-region {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: center;
    padding-left: 12px;
    -webkit-app-region: drag;

    .logo {
      width: 16px;
      height: 16px;
      margin-right: 8px;
    }

    .title {
      color: var(--color-text-main);
      font-size: 12px;
      font-weight: 500;
    }
  }

  .window-actions {
    display: flex;
    align-items: stretch;
    height: 100%;

    -webkit-app-region: no-drag;

    /* Win11 caption 形态: 按钮填满标题栏高度、直角、无圆角。
     * 用真 <button> 而非 div —— div 不可聚焦, 加 :focus-visible 是惰性的;
     * 换成 button 后键盘可用性与焦点环才真正成立。 */
    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      width: 46px;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: background-color var(--dur-press) ease;

      &:hover {
        background-color: var(--color-fill-3);
      }

      &:active {
        background-color: var(--color-overlay-strong);
      }

      &:focus-visible {
        outline: 2px solid var(--color-accent-blue);
        outline-offset: -2px;
      }

      &.close:hover {
        background-color: #e81123;
        color: white;
      }
    }
  }
}
</style>
