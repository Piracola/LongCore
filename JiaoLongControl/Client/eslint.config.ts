import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'bin/**', '../../bin/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      // 浏览器 + WebView2 环境 (console/window 等)
      globals: { ...globals.browser, console: 'readonly' },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        // Vue SFC 的 <script> 由 typescript-eslint 解析
        parser: tseslint.parser,
      },
    },
  },
  {
    // scripts/ 下的 QA 工具: 本体跑在 Node, 但 page.evaluate() 回调在浏览器上下文执行,
    // 因此 window/document/localStorage 与 Node 的 console 都要声明 (原先只覆盖 ts/vue 导致 no-undef)
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    rules: {
      // 显式 any 已全部清除, 禁止再引入
      '@typescript-eslint/no-explicit-any': 'error',
      // 单字组件名是既有命名习惯 (CPU/GPU/Fan/Main)
      'vue/multi-word-component-names': 'off',
    },
  },
  // 格式规则交由 Prettier 统一处理, 必须放在最后
  eslintConfigPrettier,
)
