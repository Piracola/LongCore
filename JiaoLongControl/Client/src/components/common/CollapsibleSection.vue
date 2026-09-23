<script setup lang="ts">
import { ref, useId } from 'vue'

/**
 * 可收起分区（v4 §10「渐进披露」在 SMU 页的落地形态）。
 *
 * 硬约束：summary 不是装饰。收起态下用户看不到正文，而正文里带着
 * 「未读取 / 待应用 / 被闸门跳过」这些状态 —— 摘要必须把它们抬到标题行，
 * 否则收起就等于把「其实没下发」藏起来（v4 第一性原则 1）。
 *
 * 用 v-show 而非 v-if：正文里有滑条、输入框与逐核数组，销毁会丢状态。
 * 标题是 <h3> 包 <button>（不是 button 包 h3 —— 后者是非法嵌套），
 * 这样屏幕阅读器既能按标题跳转，按钮也带 aria-expanded / aria-controls。
 */
const props = withDefaults(
  defineProps<{
    title: string
    /** 收起态可见的状态摘要 */
    summary?: string | null
    tone?: 'idle' | 'pending' | 'warn'
    /** 只在首次挂载时读取；父组件后续修改无效（目前无此用法） */
    defaultOpen?: boolean
  }>(),
  { summary: null, tone: 'idle', defaultOpen: false },
)

// useId()（Vue 3.5+）：SSR/多实例下稳定唯一，比自增计数器更稳
const bodyId = `collapsible-body-${useId()}`
const open = ref(props.defaultOpen)
</script>

<template>
  <section class="panel-card collapsible">
    <h3 class="head">
      <button
        class="head-btn"
        type="button"
        :aria-expanded="open"
        :aria-controls="bodyId"
        @click="open = !open"
      >
        <span class="chev" :class="{ open }" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path
              d="M6 3.5 10.5 8 6 12.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="section-label !mb-0">{{ title }}</span>
        <span v-if="summary" class="summary tnum" :class="`t-${tone}`">{{ summary }}</span>
      </button>
    </h3>
    <div v-show="open" :id="bodyId" class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.collapsible {
  padding: 0;
}

.head {
  margin: 0;
  font-size: inherit;
  font-weight: inherit;
}

.head-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 16px 20px;
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}

.head-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.chev {
  display: inline-flex;
  color: var(--weak);
  transition: transform var(--dur-base) var(--ease-out);
}

.chev.open {
  transform: rotate(90deg);
}

.summary {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--hair);
  background: var(--bg-inset);
  color: var(--muted);
  white-space: nowrap;
}

.summary.t-pending {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}

.summary.t-warn {
  color: var(--temp-hot);
  border-color: color-mix(in srgb, var(--temp-hot) 35%, transparent);
}

.body {
  padding: 0 20px 20px;
}
</style>
