export interface TaskNode { id: string; name: string; deps: string[]; x: number; y: number; status: string; startTime?: number | null; endTime?: number | null; retries: number; records?: number | null; qualityIssues?: number | null }
export interface DAGWorkflow { id: number; name: string; nodes: TaskNode[]; edges: [string,string][] }
export interface ExecutionLog { taskId: string; status: string; timestamp: number; message: string }
export interface CircuitBreaker { taskId: string; failureCount: number; state: string; cooldownUntil: number }

// ---- 每次执行质量概览 ----
export type StageStatus = 'PENDING' | 'RUNNING' | 'PARTIAL' | 'SUCCESS' | 'INTERRUPTED'
export type RunStatus = 'RUNNING' | 'SUCCESS' | 'INTERRUPTED'

export interface StageSummary {
  id: string
  name: string
  nodeIds: string[]
  status: StageStatus
  records: number | null
  durationMs: number
  retries: number
}

export interface QualitySummary {
  nodeId: string
  status: StageStatus
  checked: number | null
  issues: number
}

export interface RunSummary {
  id: number
  status: RunStatus
  workers: number
  strategy: string
  startedAt: number
  endedAt: number | null
  stages: StageSummary[]
  quality: QualitySummary
  totalRecords: number
  totalDurationMs: number
  totalRetries: number
  totalNodes: number
  completedNodes: number
}

export interface RunDetail extends RunSummary {
  nodes: TaskNode[]
  edges: [string, string][]
  logs: ExecutionLog[]
  circuitBreakers: CircuitBreaker[]
}

export interface ExecutionInfo {
  workflow: DAGWorkflow
  logs: ExecutionLog[]
  circuitBreakers: CircuitBreaker[]
  completed: boolean
  runId?: number
  status?: RunStatus
  workers?: number
  strategy?: string
  startedAt?: number
  endedAt?: number | null
  stages?: StageSummary[]
  quality?: QualitySummary
}
