<template>
  <el-drawer
    :model-value="store.overviewOpen"
    @update:model-value="store.setOverviewOpen($event)"
    title="📊 每次执行质量概览"
    direction="rtl"
    size="62%"
    class="quality-drawer"
  >
    <template #header="{ titleId, titleClass }">
      <div :id="titleId" :class="titleClass" class="drawer-title">📊 每次执行质量概览</div>
    </template>

    <!-- 顶部：执行切换 -->
    <div class="toolbar">
      <el-select
        :model-value="store.selectedRunId ?? undefined"
        @update:model-value="onSelect"
        size="small"
        style="width: 320px"
        placeholder="选择执行"
      >
        <el-option
          v-for="r in store.runs"
          :key="r.id"
          :value="r.id"
          :label="`#${r.id} · ${statusLabel(r.status)} · ${fmtClock(r.startedAt)}`"
        >
          <span class="opt-id">#{{ r.id }}</span>
          <el-tag size="small" :type="statusTag(r.status)" effect="dark" disable-transitions>
            {{ statusLabel(r.status) }}
          </el-tag>
          <span class="opt-time">{{ fmtClock(r.startedAt) }}</span>
        </el-option>
      </el-select>
      <el-button size="small" :loading="store.overviewLoading" @click="store.refreshOverview()">🔄 刷新</el-button>
      <el-button
        v-if="run && run.status === 'RUNNING'"
        size="small"
        type="warning"
        :loading="store.cancelling"
        @click="store.cancelSelectedRun()"
      >⏹ 打断本次执行</el-button>
    </div>

    <!-- 空态 -->
    <div v-if="!store.runs.length" class="empty-state">
      <div class="empty-icon">🗂️</div>
      <div class="empty-title">还没有执行记录</div>
      <div class="empty-desc">创建 DAG 并点击「执行」后，这里会按环节汇总每次执行的处理条数、处理时长与重试次数；<br/>质检检出的异常条数、相邻执行的环比波动与历史趋势也会在这里呈现。</div>
    </div>

    <template v-else-if="run">
      <!-- 执行摘要 -->
      <div class="run-header">
        <el-tag :type="statusTag(run.status)" effect="dark" size="large">{{ statusLabel(run.status) }}</el-tag>
        <span class="run-time">开始 {{ fmtDateTime(run.startedAt) }}</span>
        <span v-if="run.endedAt" class="run-time">结束 {{ fmtDateTime(run.endedAt) }}</span>
        <span v-if="run.totalDurationMs != null" class="run-time">总处理时长 {{ fmtDuration(run.totalDurationMs) }}</span>
        <span class="run-time">策略 {{ run.strategy }} · {{ run.workers }} Workers</span>
      </div>

      <el-alert
        v-if="run.status === 'INTERRUPTED'"
        type="warning"
        :closable="false"
        show-icon
        title="本次执行中途被打断，以下仅展示已完成环节的明细；未执行环节以「—」标注。"
        class="interrupt-alert"
      />

      <!-- 指标卡片：质检异常单独突出 -->
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">提取条数</div>
          <div class="stat-value">{{ fmtNum(run.extractRows) }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">总处理时长</div>
          <div class="stat-value">{{ fmtDuration(run.totalDurationMs) }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">总重试次数</div>
          <div class="stat-value" :class="{ warn: (run.totalRetries ?? 0) > 0 }">{{ run.totalRetries ?? 0 }}</div>
        </div>
        <div class="stat-card defect">
          <div class="stat-label">质检检出异常</div>
          <div class="stat-value">{{ fmtNum(run.qualityDefects) }} <span class="stat-unit">条</span></div>
          <div v-if="prev" class="stat-sub">
            上次 {{ fmtNum(prev.qualityDefects) }} 条
            <span :class="diffClass(run.qualityDefects, prev.qualityDefects, false)">
              {{ diffText(run.qualityDefects, prev.qualityDefects) }}
            </span>
          </div>
          <div v-else class="stat-sub">暂无相邻执行可对比</div>
        </div>
      </div>

      <!-- 环比波动提示 -->
      <el-alert
        v-if="bigChanges.length"
        type="error"
        :closable="false"
        show-icon
        class="change-alert"
      >
        <template #title>
          与上一次执行<span class="prev-ref">#{{ prev!.id }}</span>相比，以下环节差异较大（阈值 ±30%）：
        </template>
        <div class="change-list">
          <span v-for="c in bigChanges" :key="c.stage + c.metric" class="change-chip">
            {{ c.name }} · {{ c.metricLabel }}
            <span :class="c.pct >= 0 ? 'up' : 'down'">{{ c.pct >= 0 ? '▲' : '▼' }}{{ Math.abs(c.pct * 100).toFixed(0) }}%</span>
          </span>
        </div>
      </el-alert>
      <el-alert
        v-else-if="prev"
        type="success"
        :closable="false"
        show-icon
        :title="`与上一次执行 #${prev.id} 相比，各环节处理条数与时长均无显著波动（±30% 以内）。`"
        class="change-alert"
      />

      <!-- 分环节列表 -->
      <el-table :data="run.stages" size="small" class="stage-table" row-key="stage" :expand-row-keys="run.status === 'INTERRUPTED' ? interruptedExpanded : []">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div v-if="row.executed && row.nodes && row.nodes.length > 1" class="node-detail">
              <div v-for="m in row.nodes" :key="m.nodeId" class="node-row">
                <span class="node-name">{{ m.nodeName }}</span>
                <span>处理 {{ fmtNum(m.rows) }} 条</span>
                <span>耗时 {{ fmtDuration(m.durationMs) }}</span>
                <span>重试 {{ m.retries }} 次</span>
              </div>
            </div>
            <div v-else class="node-detail single">该环节仅包含单个节点。</div>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="环节" width="110">
          <template #default="{ row }">
            <span class="stage-name">{{ row.name }}</span>
            <span v-if="row.nodes && row.nodes.length > 1" class="branch-hint">（{{ row.nodes.length }} 个分支）</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.executed" type="success" size="small" effect="plain">已完成</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">— 未执行</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="处理条数" min-width="180">
          <template #default="{ row }">
            <template v-if="row.executed">
              <span class="metric-main" :class="{ big: isBig(row, 'rows') }">{{ fmtNum(row.rows) }}</span>
              <span class="metric-diff" :class="diffClass(row.rows, prevStageVal(row, 'rows'), true)">
                {{ diffText(row.rows, prevStageVal(row, 'rows')) }}
              </span>
            </template>
            <span v-else class="dash">—</span>
          </template>
        </el-table-column>
        <el-table-column label="处理时长" min-width="170">
          <template #default="{ row }">
            <template v-if="row.executed">
              <span class="metric-main" :class="{ big: isBig(row, 'durationMs') }">{{ fmtDuration(row.durationMs) }}</span>
              <span class="metric-diff" :class="diffClass(row.durationMs, prevStageVal(row, 'durationMs'), true)">
                {{ diffText(row.durationMs, prevStageVal(row, 'durationMs')) }}
              </span>
            </template>
            <span v-else class="dash">—</span>
          </template>
        </el-table-column>
        <el-table-column label="重试次数" min-width="130">
          <template #default="{ row }">
            <template v-if="row.executed">
              <span class="metric-main" :class="{ warn: row.retries > 0, big: isBig(row, 'retries') }">{{ row.retries }}</span>
              <span class="metric-diff" :class="diffClass(row.retries, prevStageVal(row, 'retries'), false)">
                {{ diffText(row.retries, prevStageVal(row, 'retries')) }}
              </span>
            </template>
            <span v-else class="dash">—</span>
          </template>
        </el-table-column>
      </el-table>

      <!-- 历史趋势 -->
      <h4 class="trend-title">历史趋势（最近 {{ store.runs.length }} 次执行）</h4>
      <div ref="trendRef" class="trend-chart"></div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { useDAGStore } from '../store/dag'
import type { StageMetric } from '../types'

const store = useDAGStore()
const run = computed(() => store.selectedRun)
const prev = computed(() => store.previousRun)
const trendRef = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let pollTimer: number | null = null

const DIFF_THRESHOLD = 0.3

function statusLabel(s: string) {
  return { RUNNING: '运行中', SUCCESS: '成功', FAILED: '失败', INTERRUPTED: '已打断' }[s] ?? s
}
function statusTag(s: string): any {
  return { RUNNING: 'primary', SUCCESS: 'success', FAILED: 'danger', INTERRUPTED: 'warning' }[s] ?? 'info'
}
function fmtNum(v?: number | null) { return (v ?? 0).toLocaleString('zh-CN') }
function fmtDuration(ms?: number | null) {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} 毫秒`
}
function fmtClock(ts: number) {
  const d = new Date(ts * 1000)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
function fmtDateTime(ts: number) { return fmtClock(ts) }

function pctChange(cur?: number, prevVal?: number | null): number | null {
  if (cur == null || prevVal == null || !Number.isFinite(cur) || !Number.isFinite(prevVal)) return null
  if (prevVal === 0) return cur === 0 ? 0 : 1 // 0 → 非0 视为 100% 增长
  return (cur - prevVal) / prevVal
}
function diffText(cur?: number, prevVal?: number | null) {
  const p = pctChange(cur, prevVal)
  if (p == null || prevVal == null) return prevVal == null ? '（无历史）' : ''
  if (p === 0) return '持平'
  return `${p > 0 ? '+' : ''}${(p * 100).toFixed(0)}%`
}
function diffClass(cur?: number, prevVal?: number | null, threshold = true) {
  const p = pctChange(cur, prevVal)
  if (p == null || p === 0 || prevVal == null) return 'neutral'
  return threshold && Math.abs(p) < DIFF_THRESHOLD ? 'neutral' : p > 0 ? 'up' : 'down'
}

function prevStage(row: StageMetric): StageMetric | undefined {
  return prev.value?.stages.find(s => s.stage === row.stage)
}
function prevStageVal(row: StageMetric, key: 'rows' | 'durationMs' | 'retries'): number | undefined {
  const ps = prevStage(row)
  if (!ps || !ps.executed) return undefined
  return ps[key]
}
function isBig(row: StageMetric, key: 'rows' | 'durationMs' | 'retries') {
  const p = pctChange(row[key], prevStageVal(row, key))
  return p != null && Math.abs(p) >= DIFF_THRESHOLD
}

const METRIC_LABELS = { rows: '处理条数', durationMs: '处理时长', retries: '重试次数' } as const
const bigChanges = computed(() => {
  if (!run.value || !prev.value) return []
  const out: { stage: string; name: string; metric: keyof typeof METRIC_LABELS; metricLabel: string; pct: number }[] = []
  for (const s of run.value.stages) {
    if (!s.executed) continue
    const ps = prev.value.stages.find(x => x.stage === s.stage)
    if (!ps || !ps.executed) continue
    ;(['rows', 'durationMs', 'retries'] as const).forEach(key => {
      const p = pctChange(s[key], ps[key])
      if (p != null && Math.abs(p) >= DIFF_THRESHOLD) {
        out.push({ stage: s.stage, name: s.name, metric: key, metricLabel: METRIC_LABELS[key], pct: p })
      }
    })
  }
  return out
})

const interruptedExpanded = computed(() => (run.value?.stages ?? []).filter(s => s.executed && s.nodes && s.nodes.length > 1).map(s => s.stage))

function onSelect(id: number) {
  store.setSelectedRunId(id)
  store.fetchSelectedRun()
}

function renderTrend() {
  if (!trendRef.value) return
  if (!chart) chart = echarts.init(trendRef.value, undefined, { renderer: 'canvas' })
  const list = [...store.runs].sort((a, b) => a.id - b.id)
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 64, right: 56, top: 36, bottom: 28 },
    tooltip: { trigger: 'axis', backgroundColor: '#1a1a2e', borderColor: '#2a2a4a', textStyle: { color: '#e0e0e0' } },
    legend: { data: ['提取条数', '质检异常'], textStyle: { color: '#aaa', fontSize: 11 }, top: 4 },
    xAxis: {
      type: 'category',
      data: list.map(r => `#${r.id}`),
      axisLine: { lineStyle: { color: '#2a2a4a' } },
      axisLabel: { color: '#888' }
    },
    yAxis: [
      { type: 'value', name: '条数', nameTextStyle: { color: '#888' }, axisLabel: { color: '#888' }, splitLine: { lineStyle: { color: '#222244' } } },
      { type: 'value', name: '异常', nameTextStyle: { color: '#f87171' }, axisLabel: { color: '#888' }, splitLine: { show: false } }
    ],
    series: [
      {
        name: '提取条数', type: 'line', smooth: true, data: list.map(r => r.extractRows ?? 0),
        lineStyle: { color: '#bb86fc' }, itemStyle: { color: '#bb86fc' }, areaStyle: { color: 'rgba(187,134,252,0.12)' }
      },
      {
        name: '质检异常', type: 'bar', yAxisIndex: 1, data: list.map(r => r.qualityDefects ?? 0),
        itemStyle: { color: 'rgba(248,113,113,0.75)' }, barMaxWidth: 22
      }
    ]
  })
  // 抽屉开合动画期间容器宽度可能尚未稳定
  window.setTimeout(() => chart?.resize(), 300)
}

async function openRefresh() {
  await store.fetchRuns()
  // 首次打开且未选择过：默认最近一次，并持久化
  if (store.selectedRunId == null && store.runs.length) {
    store.setSelectedRunId(store.runs[0].id)
  }
  await store.fetchSelectedRun()
}

function syncPoll() {
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null }
  if (store.overviewOpen && run.value?.status === 'RUNNING') {
    pollTimer = window.setInterval(async () => {
      await store.refreshOverview()
    }, 2500)
  }
}

watch(() => store.overviewOpen, (open) => {
  if (open) { nextTick(openRefresh) }
  syncPoll()
})
watch(() => run.value?.status, syncPoll)
watch(() => store.runs, () => nextTick(renderTrend), { deep: false })

onMounted(() => {
  if (store.overviewOpen) nextTick(openRefresh)
  syncPoll()
  window.addEventListener('resize', resizeChart)
})
onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer)
  window.removeEventListener('resize', resizeChart)
  chart?.dispose()
})
function resizeChart() { chart?.resize() }
</script>

<style scoped>
.drawer-title { color: #bb86fc; font-size: 15px; font-weight: 700; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.opt-id { font-weight: 700; margin-right: 8px; color: #e0e0e0; }
.opt-time { color: #888; font-size: 11px; margin-left: 8px; }

.empty-state { text-align: center; padding: 80px 30px; color: #666; }
.empty-icon { font-size: 48px; margin-bottom: 14px; }
.empty-title { font-size: 16px; color: #aaa; margin-bottom: 8px; }
.empty-desc { font-size: 12px; line-height: 1.9; }

.run-header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; }
.run-time { color: #999; font-size: 12px; }
.interrupt-alert { margin-bottom: 12px; }

.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
.stat-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 12px 14px; }
.stat-card.defect { border-color: #f8717155; background: linear-gradient(135deg, #2a1420, #1a1a2e); }
.stat-label { font-size: 11px; color: #888; margin-bottom: 6px; }
.stat-value { font-size: 22px; font-weight: 700; color: #e0e0e0; }
.stat-value.warn { color: #fbbf24; }
.stat-unit { font-size: 12px; font-weight: 400; color: #f87171; }
.stat-card.defect .stat-value { color: #f87171; }
.stat-sub { font-size: 11px; color: #777; margin-top: 4px; }

.change-alert { margin-bottom: 12px; }
.change-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.change-chip { background: #0f0f23; border: 1px solid #3a2a3a; border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #ccc; }
.change-chip .up { color: #f87171; font-weight: 700; margin-left: 4px; }
.change-chip .down { color: #34d399; font-weight: 700; margin-left: 4px; }
.prev-ref { font-weight: 700; color: #fbbf24; margin: 0 2px; }

.stage-table { margin-bottom: 18px; }
.stage-name { font-weight: 600; color: #e0e0e0; }
.branch-hint { color: #777; font-size: 11px; }
.metric-main { font-family: monospace; }
.metric-main.big { color: #f87171; font-weight: 700; }
.metric-main.warn { color: #fbbf24; }
.metric-diff { margin-left: 8px; font-size: 11px; }
.metric-diff.up { color: #f87171; }
.metric-diff.down { color: #34d399; }
.metric-diff.neutral { color: #666; }
.dash { color: #4a5568; }
.node-detail { padding: 6px 16px; background: #0f0f23; }
.node-detail.single { color: #555; font-size: 11px; }
.node-row { display: flex; gap: 18px; font-size: 11px; color: #aaa; padding: 2px 0; font-family: monospace; }
.node-name { color: #ccc; min-width: 110px; }

.trend-title { color: #bb86fc; font-size: 12px; margin-bottom: 6px; }
.trend-chart { width: 100%; height: 220px; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; }
</style>

<style>
/* Drawer is teleported to <body>, so non-scoped overrides are needed */
.quality-drawer.el-drawer { background: #14142b; }
.quality-drawer .el-drawer__header { margin-bottom: 12px; color: #bb86fc; border-bottom: 1px solid #2a2a4a; padding: 16px 20px; }
.quality-drawer .el-drawer__body { padding: 0 20px 20px; }
.quality-drawer .el-table { background: transparent; color: #e0e0e0; --el-table-bg-color: transparent; --el-table-tr-bg-color: transparent; --el-table-header-bg-color: #1a1a2e; --el-table-border-color: #2a2a4a; --el-table-header-text-color: #bb86fc; --el-table-row-hover-bg-color: #1f1f3a; --el-table-expanded-cell-bg-color: #0f0f23; }
.quality-drawer .el-table__expanded-cell { padding: 6px 12px !important; }
.quality-drawer .el-alert { border-radius: 6px; }
</style>
