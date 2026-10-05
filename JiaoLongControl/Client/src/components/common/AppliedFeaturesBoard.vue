<script setup lang="ts">
/**
 * 已应用功能看板（概览页下半页）。
 *
 * 纯渲染：所有状态判定都在 domain/appliedFeatures.ts 的纯函数里（无 DOM 可测），
 * 本组件只按注册表遍历 —— 注册表加一行，这里就多一行，不做任何功能清单硬编码。
 *
 * 两栏语义（v4 第一性原则 1）：
 *   意图 = config.yaml 里的字段路径与值        （用户想让它生效）
 *   实测 = 桥接 getter 的回读值                （硬件里到底是什么）
 * 两者不一致 → 「配置开着·硬件没写进去」；读不到 → 「不可回读 / 读取失败」，绝不回退 0/false。
 */
import { computed, onMounted } from 'vue'
import { Message } from '@arco-design/web-vue'
import CompositeSteps from '@/components/common/CompositeSteps.vue'
import { useAppliedFeatures } from '@/composables/useAppliedFeatures'
import {
  CONCLUSION_LABELS,
  groupFeatures,
  type AppliedFeature,
  type FeatureVerdict,
} from '@/domain/appliedFeatures'

interface BoardRow {
  item: AppliedFeature
  verdict: FeatureVerdict
}

const board = useAppliedFeatures()

const groups = computed(() =>
  groupFeatures().map((group) => ({
    id: group.id,
    label: group.label,
    rows: board.rows.value.filter((row) => row.item.group === group.id),
  })),
)

const restoreLabel = computed(() =>
  board.restorePlan.value.length > 0
    ? `全部还原（${board.restorePlan.value.length} 项）`
    : '全部还原（无可还原项）',
)

/**
 * 「全部还原」的覆盖范围：必须逐类说清（覆盖哪些、不覆盖哪些、各为什么），
 * 不许只报一个数字 —— 只报数字时「漏了正生效的项」与「收进了别人写的项」都看不出来。
 */
const restoreTitle = computed(() => {
  const s = board.scope.value
  const parts = [
    `本次覆盖 ${s.covered.length} 项：${s.covered.length > 0 ? s.covered.join('、') : '无'}`,
  ]
  if (s.notWrittenByUs.length > 0) {
    parts.push(
      `不覆盖 ${s.notWrittenByUs.length} 项（非本软件下发，不该替别的工具清掉）：${s.notWrittenByUs.join('、')}`,
    )
  }
  if (s.notActive.length > 0) {
    parts.push(`不覆盖 ${s.notActive.length} 项（当前未生效）：${s.notActive.join('、')}`)
  }
  if (s.notRead.length > 0) {
    parts.push(`不覆盖 ${s.notRead.length} 项（本次没读出生效值）：${s.notRead.join('、')}`)
  }
  if (s.noRemovalPath.length > 0) {
    parts.push(
      `另有 ${s.noRemovalPath.length} 项本行不提供「移除」（不可回读 / 永久不可逆 / 无还原值），逐行标了原因`,
    )
  }
  return parts.join('｜')
})

onMounted(() => {
  void board.refresh()
})

async function onRemove(row: BoardRow) {
  const confirmed = await board.removeOne(row.item)
  const entry = board.removalLog.value.find((e) => e.id === row.item.id)
  const text = entry?.message ?? '移除已执行'
  if (!confirmed) Message.error(`${row.item.name}：${text}`)
  else if (entry?.ok) Message.success(`${row.item.name}：${text}`)
  else Message.warning(`${row.item.name}：${text}`)
}

async function onRestoreAll() {
  const result = await board.restoreAll()
  if (result.total === 0) {
    Message.info('当前没有可还原的项')
    return
  }
  const parts = [`已确认还原 ${result.confirmed} 项`]
  if (result.unconfirmed > 0) parts.push(`仅命令确认 ${result.unconfirmed} 项（未确认已恢复）`)
  if (result.failed > 0) parts.push(`未确认 ${result.failed} 项`)
  const text = parts.join(' · ')
  if (result.failed > 0) Message.error(text)
  else if (result.unconfirmed > 0) Message.warning(text)
  else Message.success(text)
}
</script>

<template>
  <section class="board-panel">
    <header class="board-head">
      <div class="head-main">
        <h2>已应用功能</h2>
        <p>
          注册表 {{ board.summary.value.total }} 项 · 意图 = config.yaml 字段，实测 = 桥接回读值；
          不一致即「配置开着、硬件没写进去」。读不到一律显示「不可回读 / 读取失败」，不回退
          0/false。
        </p>
        <p class="scope" data-testid="restore-scope">{{ restoreTitle }}</p>
      </div>
      <div class="head-chips">
        <span class="chip mismatch">不一致 {{ board.summary.value.mismatch }}</span>
        <span class="chip read-failed">读取失败 {{ board.summary.value.readFailed }}</span>
        <span class="chip unreadable">不可回读 {{ board.summary.value.unreadable }}</span>
        <span class="chip no-write-path">无下发路径 {{ board.summary.value.noWritePath }}</span>
      </div>
      <div class="head-actions">
        <button
          type="button"
          class="btn-refresh"
          :disabled="board.loading.value || board.removing.value"
          @click="board.refresh()"
        >
          {{ board.loading.value ? '读取中…' : '重新读取' }}
        </button>
        <button
          type="button"
          class="btn-restore"
          :disabled="board.removing.value || board.restorePlan.value.length === 0"
          :title="restoreTitle"
          :aria-label="restoreTitle"
          @click="onRestoreAll"
        >
          {{ board.removing.value ? '正在还原…' : restoreLabel }}
        </button>
      </div>
    </header>

    <div class="board-scroll">
      <table class="board-table">
        <thead>
          <tr>
            <th class="col-name">功能</th>
            <th class="col-intent">意图（config.yaml）</th>
            <th class="col-observed">实测（桥接回读）</th>
            <th class="col-status">状态</th>
            <th class="col-conclusion">必要性</th>
            <th class="col-action">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in groups" :key="group.id">
            <tr class="group-row">
              <td :colspan="6">
                {{ group.label }}
                <span class="group-count">{{ group.rows.length }} 项</span>
              </td>
            </tr>
            <tr
              v-for="row in group.rows"
              :key="row.item.id"
              data-testid="applied-feature-row"
              :class="['feature-row', row.verdict.status]"
            >
              <td class="col-name">
                <span class="name">{{ row.item.name }}</span>
                <span
                  class="level"
                  :title="`可逆级别 ${row.item.reversibility}（operations.ts:21-29）`"
                >
                  {{ row.item.reversibility.toUpperCase() }} 级
                </span>
              </td>
              <td class="col-intent">
                <code>{{ row.verdict.intentText }}</code>
              </td>
              <td class="col-observed">
                <code>{{ row.verdict.observedText }}</code>
                <span
                  v-if="row.verdict.inferred"
                  class="inferred"
                  title="EC 无对应 getter：这是推断口径"
                >
                  推断
                </span>
              </td>
              <td class="col-status">
                <span class="status" :class="row.verdict.status">{{
                  row.verdict.statusLabel
                }}</span>
                <span v-if="row.verdict.detail" class="detail">{{ row.verdict.detail }}</span>
              </td>
              <td class="col-conclusion">
                <span class="conclusion" :class="row.item.conclusion">
                  {{ CONCLUSION_LABELS[row.item.conclusion] }}
                </span>
                <span class="reason">{{ row.item.conclusionReason }}</span>
              </td>
              <td class="col-action">
                <button
                  v-if="row.verdict.canRemove"
                  type="button"
                  class="btn-remove"
                  :disabled="board.removing.value"
                  :title="
                    row.item.removalConfirm === 'command-only'
                      ? '仅命令确认，未确认已恢复（该项没有能证明「已还原」的回读判据）'
                      : '写后独立重读，确认已不再生效'
                  "
                  @click="onRemove(row)"
                >
                  移除
                </button>
                <span v-else class="no-remove" :title="row.verdict.blockedReason ?? ''">
                  无法还原 · {{ row.verdict.blockedReason }}
                </span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div v-if="board.removalLog.value.length" class="board-result">
      <p class="result-title">最近移除结果</p>
      <ul>
        <li v-for="entry in board.removalLog.value" :key="entry.id" :class="{ ok: entry.ok }">
          <span class="t">{{ entry.name }}</span>
          <span class="m">{{ entry.message }}</span>
        </li>
      </ul>
    </div>

    <CompositeSteps
      v-if="board.composite.state.value.steps.length"
      :steps="board.composite.state.value.steps"
      :partial="board.composite.state.value.partialApplied"
      :message="board.composite.state.value.message"
    />
  </section>
</template>

<style scoped lang="scss">
.board-panel {
  background: var(--bg-panel);
  border: 1px solid var(--hair);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex-shrink: 0;
}

.board-head {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--hair);
}

.head-main {
  min-width: 0;

  h2 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  p {
    margin: 4px 0 0;
    font-size: 10px;
    color: var(--weak);
    line-height: 1.5;
  }
}

.head-chips {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}

.chip {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--weak);
  background: var(--bg-inset);
  border: 1px solid var(--hair);

  &.mismatch {
    color: var(--temp-hot);
    border-color: color-mix(in srgb, var(--temp-hot) 40%, transparent);
  }

  &.read-failed {
    color: var(--temp-critical);
    border-color: color-mix(in srgb, var(--temp-critical) 40%, transparent);
  }
}

.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.btn-refresh,
.btn-restore {
  height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--hair-strong);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);

  &:hover:not(:disabled) {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.04);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.btn-restore:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

.board-scroll {
  max-height: 420px;
  overflow: auto;
}

.board-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-panel);
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--weak);
    padding: 6px 10px;
    border-bottom: 1px solid var(--hair);
  }

  td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--hair);
    vertical-align: top;
    font-size: 11px;
    color: var(--muted);
  }

  code {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink);
    word-break: break-all;
  }
}

.col-name {
  width: 21%;
}

.col-intent {
  width: 19%;
}

.col-observed {
  width: 21%;
}

.col-status {
  width: 13%;
}

.col-conclusion {
  width: 16%;
}

.col-action {
  width: 10%;
}

.group-row td {
  background: var(--bg-inset);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
  padding: 5px 10px;

  .group-count {
    margin-left: 8px;
    color: var(--weak);
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
  }
}

.feature-row {
  &.mismatch td {
    background: color-mix(in srgb, var(--temp-hot) 6%, transparent);
  }

  &.read-failed td {
    background: color-mix(in srgb, var(--temp-critical) 6%, transparent);
  }
}

.name {
  color: var(--ink);
  display: block;
}

.level {
  display: inline-block;
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--weak);
  border: 1px solid var(--hair);
  border-radius: 3px;
  padding: 0 4px;
}

.inferred {
  display: inline-block;
  margin-left: 6px;
  font-size: 9px;
  color: var(--temp-warm);
  border: 1px solid color-mix(in srgb, var(--temp-warm) 40%, transparent);
  border-radius: 3px;
  padding: 0 4px;
}

.status {
  display: block;
  font-size: 11px;

  &.match {
    color: var(--temp-cool);
  }

  &.mismatch {
    color: var(--temp-hot);
    font-weight: 600;
  }

  &.hardware-only {
    color: var(--temp-warm);
  }

  &.read-failed {
    color: var(--temp-critical);
    font-weight: 600;
  }

  &.unreadable,
  &.no-write-path {
    color: var(--weak);
  }
}

.detail {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  color: var(--weak);
  line-height: 1.4;
}

.conclusion {
  font-size: 10px;

  &.keep {
    color: var(--weak);
  }

  &.review {
    color: var(--temp-warm);
  }

  &.cut {
    color: var(--temp-critical);
  }
}

.reason {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  color: var(--weak);
  line-height: 1.4;
}

.btn-remove {
  height: 24px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hair-strong);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--temp-critical);
    border-color: color-mix(in srgb, var(--temp-critical) 45%, transparent);
    background: color-mix(in srgb, var(--temp-critical) 10%, transparent);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.no-remove {
  display: block;
  font-size: 10px;
  color: var(--weak);
  line-height: 1.4;
}

.board-result {
  border-top: 1px solid var(--hair);
  padding: 8px 14px 10px;

  .result-title {
    margin: 0 0 4px;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--weak);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 96px;
    overflow-y: auto;
  }

  li {
    display: flex;
    gap: 10px;
    font-size: 11px;
    padding: 2px 0;

    .t {
      color: var(--ink);
      flex-shrink: 0;
    }

    .m {
      color: var(--temp-critical);
    }

    &.ok .m {
      color: var(--temp-cool);
    }
  }
}

[data-theme='light'] .btn-refresh:hover:not(:disabled) {
  background: rgba(13, 14, 21, 0.04);
}
</style>
