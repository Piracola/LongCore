<script setup lang="ts">
import { ref } from 'vue'

/**
 * 可收起分区（v4 §10「渐进披露」在 SMU 页的落地形态）。
 *
 * 硬约束：summary 不是装饰。收起态下用户看不到正文，而本页的正文里带着
 * 「未读取 / 待应用 / 被闸门拒绝」这些状态 —— 摘要必须把它们抬到标题行，
 * 否则收起就等于把「其实没下发」藏起来（v4 第一性原则 1）。
 *
 * 用 v-show 而非 v-if：正文里有滑条、输入框与逐核数组，销毁会丢状态。
 */
const props = withDefaults(
  defineProps<{
    title: string
    /** 收起态可见的状态摘要 */
    summary?: string | null
    tone?: 'idle' | 'pending' | 'warn'
    defaultOpen?: boolean
  }>(),
  { summary: null, tone: 'idle', defaultOpen: false },
)

const open = ref(props.defaultOpen)
</script>

<template>
  <section class="panel-card collapsible">
    <button class="head" type="button" :aria-expanded="open" @click="open = !open">
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
    <div v-show="open" class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.collapsible {
  padding: 0;
}

.head {
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
}

.head:focus-visible {
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
