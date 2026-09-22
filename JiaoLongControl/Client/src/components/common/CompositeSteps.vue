<script setup lang="ts">
import type { OperationStep } from '@/domain/operations'

defineProps<{
  steps: OperationStep[]
  partial?: boolean
  message?: string | null
}>()

const STATUS_LABEL: Record<OperationStep['status'], string> = {
  success: '成功',
  failed: '失败',
  skipped: '跳过',
}
</script>

<template>
  <div v-if="steps.length" class="steps">
    <ul>
      <li v-for="(s, i) in steps" :key="`${i}-${s.label}`" :class="s.status">
        <span class="lbl">{{ s.label }}</span>
        <span class="st">
          {{ STATUS_LABEL[s.status] }}
          <template v-if="s.status === 'success' && s.verify.verifiable === false">
            · 仅命令确认
          </template>
        </span>
      </li>
    </ul>
    <p v-if="partial" class="warn">部分应用：已生效项不会自动撤销，请按项核对后重试失败步骤。</p>
    <p v-else-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<style scoped lang="scss">
.steps {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--hair);
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  padding: 3px 0;
  color: var(--muted);

  &.success .st {
    color: var(--temp-cool);
  }
  &.failed .st {
    color: var(--temp-critical);
  }
  &.skipped .st {
    color: var(--weak);
  }
}

.lbl {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.warn,
.msg {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.45;
}

.warn {
  color: var(--temp-hot);
}

.msg {
  color: var(--muted);
}
</style>
