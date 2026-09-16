<script setup lang="ts">
/**
 * 控制模块三段式: 读数头 + 控件区 + 应用确认条。
 * 所有写操作页统一用本壳, 禁止再堆玻璃卡。
 */
defineProps<{
  title: string
  eyebrow?: string
  badge?: string
}>()
</script>

<template>
  <section class="control-module">
    <header class="cm-head">
      <div class="cm-title">
        <span v-if="eyebrow" class="eyebrow">{{ eyebrow }}</span>
        <h2>{{ title }}</h2>
      </div>
      <div class="cm-head-right">
        <slot name="head-right" />
        <span v-if="badge" class="badge">{{ badge }}</span>
      </div>
    </header>

    <div class="cm-readout">
      <slot name="readout" />
    </div>

    <div class="cm-body">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="cm-footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped lang="scss">
.control-module {
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--hair);
  border-radius: var(--radius-lg);
  min-height: 0;
}

.cm-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--hair);
}

.cm-title {
  min-width: 0;

  .eyebrow {
    display: block;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 4px;
  }

  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: 0.02em;
  }
}

.cm-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.badge {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 2px 6px;
  border-radius: 3px;
}

.cm-readout {
  padding: 14px 16px 0;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.cm-body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
}

.cm-footer {
  padding: 0 16px 16px;
}
</style>
