<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <!-- 容器本身不是可点元素, 因此对 hover 完全无响应:
   * 原有 hover:border/hover:shadow 会暗示"可点"= 误导, 且是紫辉光(AI 味)。
   * 也去掉 transition-all(无界属性动画)。 -->
  <div class="panel-card p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
    <div class="flex-1 min-w-0 space-y-1.5">
      <h3 class="text-[15px] font-semibold text-ink tracking-wide">
        {{ title }}
      </h3>
      <p v-if="description" class="text-[13px] text-muted font-normal leading-relaxed">
        {{ description }}
      </p>
      <div v-else class="text-[13px] text-muted font-normal leading-relaxed">
        <slot name="description"></slot>
      </div>
    </div>
    <div class="flex items-center gap-3 shrink-0 self-center sm:mt-0.5">
      <slot name="extra"></slot>
    </div>
  </div>
</template>

<style scoped></style>
