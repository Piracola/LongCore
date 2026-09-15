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
  <div class="glass-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-cyber-card/40">
    <div class="space-y-1">
      <h3 class="text-[15px] font-semibold text-ink tracking-wide flex items-center gap-2">
        {{ title }}
      </h3>
      <p v-if="description" class="text-xs text-gray-400 font-normal leading-relaxed max-w-[550px]">
        {{ description }}
      </p>
      <div v-else class="text-xs text-gray-400 font-normal leading-relaxed max-w-[550px]">
        <slot name="description"></slot>
      </div>
    </div>
    <div class="flex items-center gap-3 shrink-0 self-end sm:self-center">
      <slot name="extra"></slot>
    </div>
  </div>
</template>

<style scoped></style>
