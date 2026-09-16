<script setup lang="ts">
/** 控制页统一壳: 页标题 + 内容区。禁止装饰光晕。 */
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <div class="page-shell h-full overflow-y-auto no-scrollbar">
    <div class="page-inner">
      <header class="page-head">
        <h1>{{ title }}</h1>
        <p v-if="subtitle">{{ subtitle }}</p>
      </header>
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
.page-shell {
  background: var(--bg-app);
  color: var(--ink);
}

.page-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 20px 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
}

.page-head {
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: 0.02em;
    color: var(--ink);
  }

  p {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--muted);
  }
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>
