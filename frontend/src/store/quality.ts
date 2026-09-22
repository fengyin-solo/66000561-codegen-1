import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'
import type { RunSummary, RunDetail, ExecutionInfo, RunStatus, StageSummary, QualitySummary } from '@/types'

const SELECT_KEY = 'qa.selectedRunId'
const DRAWER_KEY = 'qa.drawerOpen'

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

export const useQualityStore = defineStore('quality', () => {
  const runs = ref<RunSummary[]>([])          // 最近若干次执行，新的在前
  const selectedId = ref<number | null>(null)
  const currentDetail = ref<RunDetail | null>(null)
  const detailForId = ref<number | null>(null)
  const liveRunId = ref<number | null>(null) // 正在推送的实时执行
  const wsConnected = ref(false)
  const drawerOpen = ref(localStorage.getItem(DRAWER_KEY) === '1')

  let ws: WebSocket | null = null
  const loading = ref(false)

  const selected = computed<RunSummary | null>(() =>
    runs.value.find(r => r.id === selectedId.value) ?? null)

  /** 后端 WS 推送（与原有 store 各自独立连接，互不影响） */
  function connectWS() {
    if (ws) return
    ws = new WebSocket(wsUrl())
    ws.onopen = () => { wsConnected.value = true }
    ws.onclose = () => { wsConnected.value = false; ws = null }
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data) as ExecutionInfo
        if (d.runId == null) return
        liveRunId.value = d.status === 'RUNNING' ? d.runId : null
        const summary: RunSummary = {
          id: d.runId,
          status: (d.status || 'RUNNING') as RunStatus,
          workers: d.workers ?? 0,
          strategy: d.strategy || 'fifo',
          startedAt: d.startedAt || 0,
          endedAt: d.endedAt ?? null,
          stages: d.stages || [],
          quality: d.quality || { nodeId: 'quality', status: 'PENDING', checked: null, issues: 0 },
          totalRecords: (d.stages || []).reduce((a, s) => a + (s.records || 0), 0),
          totalDurationMs: (d.stages || []).reduce((a, s) => a + s.durationMs, 0),
          totalRetries: (d.stages || []).reduce((a, s) => a + s.retries, 0),
          totalNodes: d.workflow?.nodes.length || 0,
          completedNodes: d.workflow?.nodes.filter(n => n.status === 'SUCCESS').length || 0,
        }
        upsert(summary)
        // 若当前正在看这次执行，同步节点级明细（中断时能看到已完成部分）
        if (selectedId.value === d.runId) {
          currentDetail.value = {
            ...summary,
            nodes: d.workflow?.nodes || [],
            edges: d.workflow?.edges || [],
            logs: d.logs || [],
            circuitBreakers: d.circuitBreakers || [],
          }
          detailForId.value = d.runId
        }
      } catch { /* ignore malformed frames */ }
    }
  }

  function disconnectWS() {
    ws?.close()
    ws = null
  }

  function upsert(r: RunSummary) {
    const i = runs.value.findIndex(x => x.id === r.id)
    if (i >= 0) runs.value[i] = r
    else runs.value.unshift(r)
    runs.value.sort((a, b) => b.startedAt - a.startedAt)
  }

  async function refreshRuns(): Promise<void> {
    loading.value = true
    try {
      const { data } = await axios.get<RunSummary[]>('/api/runs?limit=20')
      runs.value = data
      if (selectedId.value == null && data.length) select(data[0].id)
      else if (selectedId.value != null && !data.some(r => r.id === selectedId.value)) {
        // 服务重启后 localStorage 里的执行已不存在
        currentDetail.value = null
        detailForId.value = null
        selectedId.value = data.length ? data[0].id : null
      }
    } finally {
      loading.value = false
    }
  }

  async function select(id: number | null): Promise<void> {
    selectedId.value = id
    if (id == null) {
      localStorage.removeItem(SELECT_KEY)
      currentDetail.value = null
      detailForId.value = null
      return
    }
    localStorage.setItem(SELECT_KEY, String(id))
    const live = id === liveRunId.value
    if (!live) {
      try {
        const { data } = await axios.get<RunDetail>(`/api/runs/${id}`)
        currentDetail.value = data
        detailForId.value = id
      } catch {
        currentDetail.value = null
        detailForId.value = null
      }
    }
  }

  async function stop(id: number): Promise<void> {
    await axios.post(`/api/runs/${id}/stop`)
  }

  function setDrawer(open: boolean) {
    drawerOpen.value = open
    localStorage.setItem(DRAWER_KEY, open ? '1' : '0')
  }

  /** 首次进入：恢复上次选中的那次执行（关闭页面再打开仍停在该处） */
  async function init() {
    connectWS()
    await refreshRuns()
    const saved = Number(localStorage.getItem(SELECT_KEY))
    if (saved && runs.value.some(r => r.id === saved)) {
      await select(saved)
    } else if (runs.value.length) {
      await select(runs.value[0].id)
    }
  }

  return {
    runs, selectedId, selected, currentDetail, detailForId,
    liveRunId, wsConnected, drawerOpen, loading,
    connectWS, disconnectWS, refreshRuns, select, stop, setDrawer, init,
  }
})

// 供组件复用的类型
export type { StageSummary, QualitySummary }
