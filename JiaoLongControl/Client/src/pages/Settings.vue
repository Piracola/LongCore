<script setup lang="ts">
import SettingToggle from '@/components/common/SettingToggle.vue'
import LogoLight from './Settings/components/LogoLight.vue'
import GPUDirectConnection from './Settings/components/GPUDirectConnection.vue'
import PawnIODriverMode from './Settings/components/PawnIODriverMode.vue'
import ThemeSetting from './Settings/components/ThemeSetting.vue'
import BootAutoStart from './Settings/components/BootAutoStart.vue'
import PageShell from '@/components/common/PageShell.vue'

const toggleCards = [
  {
    group: 'auto',
    title: '自启动高级风扇控制系统',
    description:
      '启用后，软件将在后台实时监控硬件温度，并依据【风扇曲线】页面中用户自定义的策略来动态调整风扇转速',
    configPath: 'App.BootAdvancedFanControlSystem',
  },
  {
    group: 'fan',
    title: '风扇曲线合并',
    description:
      '启用后，软件将在【风扇曲线】页面中将所有风扇的曲线合并为一条曲线，方便用户统一调整风扇转速',
    configPath: 'Fan.FanCurveMerge',
  },
  {
    group: 'auto',
    title: 'CPU 参数自动应用',
    description: '在软件启动时，自动载入并应用【CPU】设置页面中保存的功耗、频率、温度墙等高级参数',
    configPath: 'App.BootAdvancedCPUSystem',
  },
  {
    group: 'auto',
    title: 'GPU 参数自动应用',
    description:
      '在软件启动时，自动载入并应用【GPU】设置页面中保存的核心与显存超频、电压曲线、功耗目标等参数',
    configPath: 'App.BootAdvancedGPUSystem',
  },
  {
    group: 'auto',
    title: 'RyzenSMU 全核降压自动应用',
    description:
      '在软件启动时，自动应用【Ryzen SMU】页面中保存的 Curve Optimizer 全核心负压（降压超频）设定',
    configPath: 'App.BootSetRyzenSumCurveOptimizerAll',
  },
  {
    group: 'auto',
    title: '自启动键盘渐变',
    description: '启用后，开机及睡眠唤醒时自动开启键盘渐变（以启动时键盘当前颜色为锚点循环渐变）',
    configPath: 'App.BootKeyboardGradient',
  },
  {
    group: 'safety',
    title: '过温看门狗',
    description:
      'CPU 温度达到 98℃ 并持续 10 秒时，强制风扇以最大转速（5800 RPM）运行；温度回落至 92℃ 并持续 30 秒后，自动交还 EC 温控。这是唯一会在紧急时刻覆盖你手动转速的保护，建议保持开启',
    configPath: 'Safety.ThermalWatchdogEnabled',
  },
  {
    group: 'system',
    title: 'Fn 性能模式热键',
    description:
      '接管键盘上的性能模式切换 Fn 键：按下后循环 狂飙 → 游戏 → 办公，并在屏幕上方显示 OSD 提示；关闭后保持该键的固件默认行为',
    configPath: 'App.HotkeyEnabled',
  },
  {
    group: 'system',
    title: '联动 Windows 电源计划',
    description:
      '切换性能模式时同步系统电源计划：办公→节电、游戏→平衡、狂飙→高性能；关闭后仅改硬件档位，不动 powercfg',
    configPath: 'App.SyncWindowsPowerPlan',
  },
]

function inGroup(group: string) {
  return toggleCards.filter((c) => c.group === group)
}
</script>

<template>
  <PageShell title="系统设置" subtitle="管理 LongCore 的全局参数、自启动行为及显示偏好。">
    <div class="settings-stack space-y-5">
      <section class="space-y-3">
        <h2 class="group-title">外观</h2>
        <ThemeSetting />
        <LogoLight />
      </section>

      <section class="space-y-3">
        <h2 class="group-title">驱动与硬件</h2>
        <GPUDirectConnection />
        <PawnIODriverMode />
      </section>

      <section class="space-y-3">
        <h2 class="group-title">自启动与自动应用</h2>
        <BootAutoStart />
        <SettingToggle
          v-for="card in inGroup('auto')"
          :key="card.configPath"
          :title="card.title"
          :description="card.description"
          :config-path="card.configPath"
        />
      </section>

      <section class="space-y-3">
        <h2 class="group-title">风扇</h2>
        <SettingToggle
          v-for="card in inGroup('fan')"
          :key="card.configPath"
          :title="card.title"
          :description="card.description"
          :config-path="card.configPath"
        />
      </section>

      <section class="space-y-3">
        <h2 class="group-title">安全</h2>
        <SettingToggle
          v-for="card in inGroup('safety')"
          :key="card.configPath"
          :title="card.title"
          :description="card.description"
          :config-path="card.configPath"
        />
      </section>

      <section class="space-y-3">
        <h2 class="group-title">系统集成</h2>
        <SettingToggle
          v-for="card in inGroup('system')"
          :key="card.configPath"
          :title="card.title"
          :description="card.description"
          :config-path="card.configPath"
        />
      </section>
    </div>
  </PageShell>
</template>

<style scoped>
.group-title {
  margin: 0 0 2px;
  padding-left: 10px;
  border-left: 2px solid var(--accent);
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--ink);
  line-height: 1.35;
}

.settings-stack > section {
  animation: settings-card-in 280ms var(--ease-out) both;
}

.settings-stack > section:nth-child(1) {
  animation-delay: 0ms;
}
.settings-stack > section:nth-child(2) {
  animation-delay: 40ms;
}
.settings-stack > section:nth-child(3) {
  animation-delay: 80ms;
}
.settings-stack > section:nth-child(4) {
  animation-delay: 120ms;
}
.settings-stack > section:nth-child(5) {
  animation-delay: 160ms;
}
.settings-stack > section:nth-child(6) {
  animation-delay: 200ms;
}

@keyframes settings-card-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-stack > section {
    animation: none;
  }
}
</style>
