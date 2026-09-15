import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
// 注: 曾引入 assets/magic.min.css (Magic 动画包, 33.9KB), 其唯一消费点
// 是 RightSide.vue 的 .swap 关键帧, 而该关键帧因缺时长基类实际未生效。
// 过渡改用动效令牌自建, 整包已移除 (见 docs/07_UIUX设计改进计划.md P0-2)。
// 函数式 API (Message) 样式: 组件样式由 unplugin-vue-components 按需注入
import '@arco-design/web-vue/es/message/style/css.js'
import { createPinia } from 'pinia'
import router from '@/router/routes.ts'
import './assets/Global.scss'
createApp(App).use(createPinia()).use(router).mount('#app')
