<script setup lang="ts">
/**
 * 设置项说明气泡：替代裸 title="..." 的「?」占位。
 * 悬停即显、点击/键盘焦点可切换，弹层跟随主题令牌（bg-raised/hair）。
 * pointer-events:none 让鼠标滑向弹层不闪断（父 span 的 mouseleave 才是关闭条件）。
 */
import { ref } from 'vue'

defineProps<{
  /** 说明正文（1–2 句，讲清该项改的是什么、有什么后果） */
  text: string
  /** 无障碍标签，缺省「查看说明」 */
  label?: string
}>()

const open = ref(false)
</script>

<template>
  <span class="info-hint" @mouseenter="open = true" @mouseleave="open = false">
    <button
      type="button"
      class="hint-btn"
      :aria-label="label ?? '查看说明'"
      :aria-expanded="open"
      @click.stop="open = !open"
      @focus="open = true"
      @blur="open = false"
    >
      ?
    </button>
    <Transition name="hint-fade">
      <span v-if="open" class="hint-pop" role="tooltip">{{ text }}</span>
    </Transition>
  </span>
</template>

<style scoped>
.info-hint {
  position: relative;
  display: inline-flex;
  margin-left: 2px;
}

.hint-btn {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--hair-strong);
  border-radius: 50%;
  background: transparent;
  color: var(--weak);
  font-size: 10px;
  line-height: 1;
  cursor: help;
  transition:
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out);
}

.hint-btn:hover,
.hint-btn[aria-expanded='true'] {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

.hint-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  width: 240px;
  padding: 8px 10px;
  border: 1px solid var(--hair-strong);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  box-shadow: 0 8px 24px var(--color-shadow-pop);
  z-index: 30;
  pointer-events: none;
  white-space: normal;
}

/* 箭头 */
.hint-pop::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: var(--hair-strong);
}

.hint-fade-enter-active,
.hint-fade-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.hint-fade-enter-from,
.hint-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(2px);
}
</style>
