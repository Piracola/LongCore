<script async setup lang="ts">
import { onMounted, ref } from 'vue'
import { GPU, GPUMode } from '@/utils/bridge.ts'
import { Message } from '@arco-design/web-vue'
import SettingCardComponent from '@/components/common/SettingCardComponent.vue'

const loading = ref(false)
const GPUDirectConnection = ref(false)
onMounted(async () => {
  try {
    GPUDirectConnection.value = (await GPU.Get()).Data === GPUMode.DiscreteMode
  } catch (e) {
    GPUDirectConnection.value = false
    Message.error(`获取独显直连状态失败：${(e as Error)?.message ?? e}`)
  }
})

async function GPUDirectConnection_handleClick() {
  loading.value = true
  try {
    const result = await GPU.Set(
      GPUDirectConnection.value ? GPUMode.DiscreteMode : GPUMode.HybridMode,
    )
    if (result.Success) {
      Message.warning('命令已接受，独显/混合输出需重启后生效，当前显示不是最终状态')
    } else {
      Message.error(result.Message)
      GPUDirectConnection.value = !GPUDirectConnection.value
    }
  } catch (e) {
    Message.error(`设置失败：${(e as Error)?.message ?? e}`)
    GPUDirectConnection.value = !GPUDirectConnection.value
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <setting-card-component
    title="独显直连（重启后生效）"
    description="输出模式属 D 级可逆：命令接受 ≠ 已生效。切换后必须重启电脑，当前开关只表示已下发的请求。"
  >
    <template #extra>
      <a-switch
        v-model="GPUDirectConnection"
        :loading="loading"
        @change="GPUDirectConnection_handleClick"
      >
        <template #checked-icon>
          <icon-check />
        </template>
        <template #unchecked-icon>
          <icon-close />
        </template>
      </a-switch>
    </template>
  </setting-card-component>
</template>

<style scoped></style>
