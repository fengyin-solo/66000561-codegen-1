export interface TaskNode { id: string; name: string; deps: string[]; x: number; y: number; status: string; startTime?: number; endTime?: number; retries: number }
export interface DAGWorkflow { id: number; name: string; nodes: TaskNode[]; edges: [string,string][] }
export interface ExecutionLog { taskId: string; status: string; timestamp: number; message: string }
export interface CircuitBreaker { taskId: string; failureCount: number; state: string; cooldownUntil: number }
export interface ExecutionInfo { runId?: number; runStatus?: string; workflow: DAGWorkflow; logs: ExecutionLog[]; circuitBreakers: CircuitBreaker[]; completed: boolean }

export interface StageNodeMetric {
  nodeId: string
  nodeName: string
  stage: string
  rows: number
  durationMs: number
  retries: number
}
export interface StageMetric {
  stage: string
  name: string
  executed: boolean
  rows?: number
  durationMs?: number
  retries?: number
  nodes?: StageNodeMetric[]
}
export interface RunSummary {
  id: number
  workflowId: number
  workflowName: string
  workers: number
  strategy: string
  status: string
  startedAt: number
  endedAt: number | null
  qualityDefects: number
  extractRows?: number
  totalDurationMs?: number
  totalRetries?: number
}
export interface RunDetail extends RunSummary {
  stages: StageMetric[]
}
