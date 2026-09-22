<template>
  <el-drawer
    :model-value="store.drawerOpen"
    title="📊 每次执行质量概览"
    direction="rtl"
    size="72%"
    :with-header="false"
    append-to-body
    @update:model-value="store.setDrawer($event)"
  >
    <div class="qa-root">
      <header class="qa-header">
        <div class="qa-title">
          <h3>📊 每次执行质量概览</h3>
          <el-tag v-if="store.wsConnected" type="success" size="small" effect="dark">实时已连接</el-tag>
          <el-tag v-else type="info" size="small" effect="dark">实时未连接</el-tag>
        </div>
        <div class="qa-tools">
          <el-select
            :model-value="store.selectedId"
            size="small"
            style="width:280px"
            placeholder="选择执行"
            @update:model-value="store.select($event)"
          >
            <el-option v-for="r in store.runs" :key="r.id" :value="r.id" :label="runLabel(r)" />
          </el-select>
          <el-button size="small" :loading="store.loading" @click="store.refreshRuns()">刷新</el-button>
          <el-button
            v-if="cur?.status === 'RUNNING'"
            size="small" type="danger" plain
            @click="onStop"
          >■ 中断本次执行</el-button>
        </div>
      </header>

      <!-- 空态：还没有执行记录 -->
      <div v-if="!store.runs.length" class="qa-empty">
        <el-empty description="还没有执行记录">
          <p class="empty-hint">在页面顶部点击「▶ 执行」发起一次数据流水线运行，</p>
          <p class="empty-hint">提取 / 校验 / 清洗 / 转换 / 聚合 / 质检 / 入库 / 报表生成各环节的质量概览将在这里汇总。</p>
        </el-empty>
      </div>

      <template v-else-if="cur">
        <!-- 中断提示 -->
        <el-alert
          v-if="cur.status === 'INTERRUPTED'"
          type="warning" show-icon :closable="false" class="qa-banner"
          title="本次执行在中途被中断"
          description="下表按环节列出中断前已完成 / 进行中的处理明细，未执行的环节标记为「未执行」；可在上方切换到其他次执行对比。"
        />
        <el-alert
          v-else-if="cur.status === 'RUNNING'"
          type="info" show-icon :closable="false" class="qa-banner"
          title="本次执行进行中"
          description="概览随执行实时更新；若此时被中断，已完成环节的明细会保留。"
        />

        <!-- 顶部汇总卡片 -->
        <div class="qa-cards">
          <div class="qa-card"><span class="c-label">执行编号</span><span class="c-value">#{{ cur.id }}</span><span class="c-sub">{{ fmtTime(cur.startedAt) }}</span></div>
          <div class="qa-card"><span class="c-label">各环节处理条数合计</span><span class="c-value">{{ fmtNum(cur.totalRecords) }}</span><span class="c-sub">8 个环节累加</span></div>
          <div class="qa-card"><span class="c-label">各环节处理时长合计</span><span class="c-value">{{ fmtDur(cur.totalDurationMs) }}</span><span class="c-sub">节点实际耗时累加</span></div>
          <div class="qa-card"><span class="c-label">重试合计</span><span class="c-value">{{ cur.totalRetries }}</span><span class="c-sub">次</span></div>
          <div class="qa-card"><span class="c-label">节点完成</span><span class="c-value">{{ cur.completedNodes }}/{{ cur.totalNodes }}</span><span class="c-sub">{{ statusText(cur.status) }}</span></div>
        </div>

        <!-- 质检异常单独呈现 -->
        <section class="qa-section">
          <h4>🚨 质检检出异常（单独统计）</h4>
          <div class="quality-box">
            <div class="q-main">
              <div class="q-num" :class="{ spike: issueSpike }">{{ fmtNum(cur.quality.issues) }}</div>
              <div class="q-desc">
                异常条数
                <span v-if="cur.quality.checked != null">/ 已检 {{ fmtNum(cur.quality.checked) }} 条，异常率 {{ pct(cur.quality.issues, cur.quality.checked) }}</span>
                <span v-else>（质检环节尚未执行）</span>
              </div>
              <div class="q-cmp">
                <span>较上一次：</span>
                <DeltaTag :d="issuesDelta" />
                <span class="hist">历史均值 {{ histIssuesAvg != null ? fmtNum(histIssuesAvg) : '—' }} 条</span>
              </div>
            </div>
            <div class="q-trend">
              <div class="trend-title">最近 {{ issueTrend.length }} 次执行 · 质检异常条数趋势</div>
              <div class="trend-bars">
                <div v-for="t in issueTrend" :key="t.id" class="t-col" :class="{ active: t.id === cur.id, spike: t.issues >= issueSpikeThreshold }">
                  <div class="t-bar" :style="{ height: barH(t.issues) + '%' }" :title="`#${t.id} ${fmtNum(t.issues)} 条`"></div>
                  <div class="t-label">#{{ t.id }}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 各环节明细表 -->
        <section class="qa-section">
          <h4>
            各环节处理明细
            <span class="h-hint">第二行为「较上一次执行」变化，灰色小字为历史均值；同一环节相邻两次差得多的单元格会高亮警示（点击行展开节点明细）</span>
          </h4>
          <table class="stage-table">
            <thead>
              <tr>
                <th class="col-stage">环节</th>
                <th class="col-status">状态</th>
                <th>处理条数</th>
                <th>处理时长</th>
                <th>重试次数</th>
                <th class="col-node">环节内节点</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in stageRows" :key="row.id">
                <tr :class="'st-' + row.status.toLowerCase()" @click="toggle(row.id)">
                  <td class="col-stage">
                    <span class="caret">{{ expanded[row.id] ? '▾' : '▸' }}</span>
                    <span class="stage-name">{{ row.name }}</span>
                  </td>
                  <td class="col-status"><el-tag :type="statusTag(row.status)" size="small" effect="dark">{{ stageStatusText(row.status) }}</el-tag></td>
                  <td>
                    <template v-if="row.records != null">
                      <div class="m-val" :class="bigClass(row.recordsBig, row.recordsDelta)">{{ fmtNum(row.records) }}</div>
                      <DeltaTag :d="row.recordsDelta" />
                      <div class="hist">历史均值 {{ row.histRecords != null ? fmtNum(row.histRecords) : '—' }}</div>
                    </template>
                    <span v-else class="m-na">—</span>
                  </td>
                  <td>
                    <template v-if="row.durationMs > 0">
                      <div class="m-val" :class="bigClass(row.durationBig, row.durationDelta)">{{ fmtDur(row.durationMs) }}</div>
                      <DeltaTag :d="row.durationDelta" />
                      <div class="hist">历史均值 {{ row.histDuration != null ? fmtDur(row.histDuration) : '—' }}</div>
                    </template>
                    <span v-else class="m-na">—</span>
                  </td>
                  <td>
                    <div class="m-val" :class="bigClass(row.retriesBig, row.retriesDelta)">{{ row.retries }}</div>
                    <DeltaTag :d="row.retriesDelta" />
                    <div class="hist">历史均值 {{ row.histRetries != null ? fmtNum(row.histRetries, 1) : '—' }}</div>
                  </td>
                  <td class="col-node"><span class="node-chips">{{ row.nodeIds.join(' / ') }}</span></td>
                </tr>
                <tr v-show="expanded[row.id]" class="detail-row">
                  <td colspan="6">
                    <table class="node-table" v-if="detailNodes(row.nodeIds).length">
                      <thead>
                        <tr><th>节点</th><th>状态</th><th>处理条数</th><th>处理时长</th><th>重试</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="n in detailNodes(row.nodeIds)" :key="n.id" :class="'nst-' + n.status.toLowerCase()">
                          <td>{{ n.name }} <span class="n-id">{{ n.id }}</span></td>
                          <td>{{ nodeStatusText(n.status) }}</td>
                          <td>{{ n.records != null ? fmtNum(n.records) : '—' }}</td>
                          <td>{{ n.startTime && n.endTime ? fmtDur((n.endTime - n.startTime) * 1000) : '—' }}</td>
                          <td>{{ n.retries }}</td>
                        </tr>
                      </tbody>
                    </table>
                    <div v-else class="detail-empty">该环节尚未产出节点明细</div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div class="table-foot">
            对比规则：与相邻的上一次执行相比，处理条数 / 处理时长波动 ≥ 50%，或重试次数明显增加（≥2 次）时高亮警示；
            历史均值取本页所列早于当前执行的所有执行，运行中执行的变化量按最新快照实时计算。
          </div>
        </section>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, h, reactive, type FunctionalComponent } from 'vue'
import { useQualityStore } from '../store/quality'
import type { RunSummary, StageSummary, StageStatus, TaskNode } from '@/types'

const store = useQualityStore()

const expanded = reactive<Record<string, boolean>>({})
function toggle(id: string) { expanded[id] = !expanded[id] }

const cur = computed<RunSummary | null>(() => store.selected)
const runIndex = computed(() => cur.value ? store.runs.findIndex(r => r.id === cur.value!.id) : -1)
const prevRun = computed<RunSummary | null>(() => {
  const i = runIndex.value
  return i >= 0 && i + 1 < store.runs.length ? store.runs[i + 1] : null
})
const olderRuns = computed<RunSummary[]>(() => {
  const i = runIndex.value
  return i >= 0 ? store.runs.slice(i + 1) : []
})

interface Delta { text: string; tone: 'up' | 'down' | 'flat' | 'none'; big: boolean; pct: number | null }

function deltaOf(curV: number | null | undefined, prevV: number | null | undefined,
                 opts: { asPct?: boolean; bigPct?: number } = {}): Delta {
  if (curV == null || prevV == null) return { text: '上次无数据', tone: 'none', big: false, pct: null }
  const diff = curV - prevV
  if (diff === 0) return { text: '持平', tone: 'flat', big: false, pct: 0 }
  const pctVal = prevV === 0 ? Infinity : (diff / prevV) * 100
  const big = opts.bigPct != null && Math.abs(pctVal) >= opts.bigPct
  const text = opts.asPct === false
    ? (diff > 0 ? '▲ +' : '▼ ') + diff + ' 次'
    : (pctVal === Infinity ? '▲ ∞%' : (diff > 0 ? '▲ +' : '▼ ') + Math.abs(pctVal).toFixed(0) + '%')
  return { text, tone: diff > 0 ? 'up' : 'down', big, pct: pctVal === Infinity ? null : pctVal }
}

function histAvg(runs: RunSummary[], stageId: string, key: 'records' | 'durationMs' | 'retries'): number | null {
  let sum = 0, n = 0
  for (const r of runs) {
    const s = r.stages.find(x => x.id === stageId)
    if (!s) continue
    if (key === 'records') { if (s.records != null) { sum += s.records; n++ } }
    else { if (s.status === 'SUCCESS') { sum += s[key]; n++ } }
  }
  return n ? sum / n : null
}

interface StageRow extends StageSummary {
  recordsDelta: Delta
  durationDelta: Delta
  retriesDelta: Delta
  recordsBig: boolean
  durationBig: boolean
  retriesBig: boolean
  histRecords: number | null
  histDuration: number | null
  histRetries: number | null
}

const stageRows = computed<StageRow[]>(() => {
  if (!cur.value) return []
  return cur.value.stages.map(s => {
    const p = prevRun.value?.stages.find(x => x.id === s.id) ?? null
    const recordsDelta = deltaOf(s.records, p?.records, { bigPct: 50 })
    const durationDelta = deltaOf(s.durationMs || null, p?.durationMs || null, { bigPct: 50 })
    const retriesDelta = deltaOf(s.retries, p ? p.retries : null, { asPct: false })
    const retriesBig = p != null && s.retries > 0 && (p.retries === 0 ? s.retries >= 2 : s.retries >= p.retries + 2)
    return {
      ...s,
      recordsDelta, durationDelta, retriesDelta,
      recordsBig: recordsDelta.big,
      durationBig: durationDelta.big,
      retriesBig,
      histRecords: histAvg(olderRuns.value, s.id, 'records'),
      histDuration: histAvg(olderRuns.value, s.id, 'durationMs'),
      histRetries: histAvg(olderRuns.value, s.id, 'retries'),
    }
  })
})

// ---- 质检异常单独呈现 ----
const histIssuesAvg = computed(() => {
  const vals = olderRuns.value.filter(r => r.quality.checked != null).map(r => r.quality.issues)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
})
const issuesDelta = computed<Delta>(() => {
  if (!cur.value || !prevRun.value || prevRun.value.quality.checked == null)
    return deltaOf(cur.value?.quality.issues ?? null, null, { bigPct: 50 })
  return deltaOf(cur.value.quality.issues, prevRun.value.quality.issues, { bigPct: 50 })
})
// 异常条数超过历史均值 3 倍视为飙升（无历史时取固定阈值 100）
const issueSpikeThreshold = computed(() => histIssuesAvg.value != null && histIssuesAvg.value > 0 ? histIssuesAvg.value * 3 : 100)
const issueSpike = computed(() => !!cur.value && cur.value.quality.issues >= issueSpikeThreshold.value)

const issueTrend = computed(() =>
  [...store.runs]
    .filter(r => r.quality.checked != null)
    .reverse()
    .slice(-12)
    .map(r => ({ id: r.id, issues: r.quality.issues })))
const maxIssues = computed(() => Math.max(1, ...issueTrend.value.map(t => t.issues)))
function barH(v: number) { return Math.max(4, Math.round((v / maxIssues.value) * 100)) }

// ---- 节点级明细（中断后仍可看到已完成部分） ----
function detailNodes(nodeIds: string[]): TaskNode[] {
  const d = store.currentDetail
  if (!d || store.detailForId !== cur.value?.id) return []
  return d.nodes.filter(n => nodeIds.includes(n.id))
}

// ---- 展示辅助 ----
function fmtNum(v: number | null | undefined, digits = 0) {
  if (v == null) return '—'
  return v.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}
function fmtDur(ms: number | null | undefined) {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s >= 60) return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
  return s.toFixed(1) + 's'
}
function pct(a: number, b: number) { return b ? ((a / b) * 100).toFixed(2) + '%' : '0%' }
function fmtTime(t: number) {
  const d = new Date(t * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function statusText(s: string) { return ({ RUNNING: '运行中', SUCCESS: '成功', INTERRUPTED: '已中断' } as Record<string, string>)[s] || s }
function stageStatusText(s: StageStatus) {
  return ({ PENDING: '未执行', RUNNING: '进行中', PARTIAL: '部分完成', SUCCESS: '完成', INTERRUPTED: '已中断' } as Record<StageStatus, string>)[s]
}
function nodeStatusText(s: string) {
  if (s === 'FAILED') return '失败/重试中'
  return stageStatusText(s as StageStatus)
}
function statusTag(s: StageStatus): 'info' | 'primary' | 'warning' | 'success' | 'danger' {
  return ({ PENDING: 'info', RUNNING: 'primary', PARTIAL: 'warning', SUCCESS: 'success', INTERRUPTED: 'danger' } as Record<StageStatus, 'info' | 'primary' | 'warning' | 'success' | 'danger'>)[s]
}
function runLabel(r: RunSummary) {
  const tail = r.status === 'RUNNING' ? ' · 运行中' : r.status === 'INTERRUPTED' ? ' · 已中断' : ''
  return `#${r.id}${tail} · ${fmtTime(r.startedAt)}`
}
function bigClass(big: boolean, d: Delta) {
  return { big, up: big && d.tone === 'up', down: big && d.tone === 'down' }
}
async function onStop() {
  if (cur.value) await store.stop(cur.value.id)
}

// 变化量徽标
const DeltaTag: FunctionalComponent<{ d: Delta }> = (props) =>
  h('span', { class: ['delta', 'd-' + props.d.tone, { big: props.d.big }] }, props.d.text)
</script>

<style scoped>
.qa-root{height:100%;display:flex;flex-direction:column;color:#e0e0e0;background:#14142b;padding:14px 16px;overflow-y:auto}
.qa-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;flex-wrap:wrap}
.qa-title{display:flex;align-items:center;gap:10px}
.qa-title h3{color:#bb86fc;font-size:15px}
.qa-tools{display:flex;gap:8px;align-items:center}
.qa-empty{flex:1;display:flex;align-items:center;justify-content:center}
.empty-hint{color:#888;font-size:12px;margin-top:2px}
.qa-banner{margin-bottom:12px}
.qa-cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px}
.qa-card{background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.c-label{color:#888;font-size:11px}
.c-value{color:#fff;font-size:18px;font-weight:700}
.c-sub{color:#666;font-size:10px}
.qa-section{background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:12px;margin-bottom:14px}
.qa-section h4{color:#bb86fc;font-size:13px;margin-bottom:10px}
.h-hint{color:#666;font-size:10px;font-weight:400;margin-left:8px}
.quality-box{display:flex;gap:24px;align-items:stretch;flex-wrap:wrap}
.q-main{min-width:240px;display:flex;flex-direction:column;justify-content:center;gap:8px}
.q-num{font-size:40px;font-weight:800;color:#fbbf24;line-height:1}
.q-num.spike{color:#ef4444;text-shadow:0 0 18px #ef444455}
.q-desc{color:#aaa;font-size:12px}
.q-cmp{display:flex;align-items:center;gap:6px;font-size:11px;color:#888;flex-wrap:wrap}
.q-cmp .hist{color:#666}
.q-trend{flex:1;min-width:320px}
.trend-title{color:#888;font-size:11px;margin-bottom:8px}
.trend-bars{display:flex;align-items:flex-end;gap:6px;height:90px;padding-bottom:18px;position:relative}
.t-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative}
.t-bar{width:70%;min-height:3px;background:linear-gradient(180deg,#fbbf2488,#fbbf2433);border-radius:3px 3px 0 0}
.t-col.spike .t-bar{background:linear-gradient(180deg,#ef4444,#ef444455)}
.t-col.active .t-bar{outline:2px solid #bb86fc}
.t-label{position:absolute;bottom:0;font-size:9px;color:#666}
.stage-table{width:100%;border-collapse:collapse;font-size:12px}
.stage-table th{color:#888;font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid #2a2a4a;font-size:11px}
.stage-table td{padding:8px;border-bottom:1px solid #222244;vertical-align:top}
.stage-table tbody tr[class*='st-']{cursor:pointer}
.stage-table tbody tr[class*='st-']:not(.detail-row):hover{background:#ffffff08}
.col-stage{width:130px}.col-status{width:90px}.col-node{width:200px}
.caret{color:#666;margin-right:6px}
.stage-name{font-weight:600;color:#e0e0e0}
.node-chips{color:#777;font-size:10px;font-family:monospace}
.m-val{font-weight:700;color:#e0e0e0}
.m-val.big.up{color:#ef4444}.m-val.big.down{color:#38a169}
tr.st-running{box-shadow:inset 3px 0 0 #3182ce}
tr.st-interrupted{box-shadow:inset 3px 0 0 #ef4444}
tr.st-partial{box-shadow:inset 3px 0 0 #fbbf24}
tr.st-pending{opacity:.55}
.delta{font-size:10px;font-family:monospace}
.d-up{color:#ef444488}.d-down{color:#38a16988}.d-flat{color:#666}.d-none{color:#555}
.delta.big.d-up{color:#ef4444;font-weight:700}
.delta.big.d-down{color:#38a169;font-weight:700}
.hist{color:#555;font-size:10px;margin-top:1px}
.m-na{color:#555}
.detail-row{cursor:default!important}
.detail-row td{background:#12122a;padding:0 8px}
.node-table{width:100%;border-collapse:collapse;font-size:11px;margin:4px 0}
.node-table th{color:#777;text-align:left;padding:4px 8px;font-size:10px;border-bottom:1px solid #2a2a4a}
.node-table td{padding:4px 8px;border-bottom:1px solid #1e1e3a}
.n-id{color:#666;font-family:monospace;font-size:10px;margin-left:6px}
.nst-interrupted td:first-child{color:#ef4444}
.detail-empty{color:#555;font-size:11px;padding:8px 4px}
.table-foot{color:#666;font-size:10px;margin-top:8px;line-height:1.6}
:deep(.el-drawer__body){padding:0}
:deep(.el-drawer){background:#14142b}
</style>
