import asyncio, time, random, json, threading
from collections import defaultdict, deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="DAG Workflow Engine")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ACTIVE_CLIENTS = []
WORKFLOW_ID = 0
MAIN_LOOP = None

# ---------------------------------------------------------------------------
# 每次执行的质量概览数据
# ---------------------------------------------------------------------------
# DAG 节点 -> 八个数据流水线环节的映射（notify 不属于数据处理环节，不纳入汇总）
STAGE_DEFS = [
    ("extract",   "提取",     ["extract"]),
    ("validate",  "校验",     ["validate"]),
    ("clean",     "清洗",     ["clean_a", "clean_b"]),
    ("transform", "转换",     ["transform", "enrich"]),
    ("aggregate", "聚合",     ["aggregate"]),
    ("quality",   "质检",     ["quality"]),
    ("load",      "入库",     ["export_db"]),
    ("report",    "报表生成", ["export_report"]),
]
NODE_STAGE = {nid: sid for sid, _name, nids in STAGE_DEFS for nid in nids}

RUNS = deque(maxlen=100)       # 最近若干次执行（新的在尾部）
RUN_MAP = {}
RUN_SEQ = 0

class WorkflowCreate(BaseModel):
    name: str = "data-pipeline"

class RunRequest(BaseModel):
    workflowId: int
    workers: int = 3
    strategy: str = "fifo"


def generate_dag_workflow(name: str):
    """Create a realistic DAG pipeline"""
    nodes = [
        {"id": "extract", "name": "数据提取", "deps": [], "duration": 2.0},
        {"id": "validate", "name": "数据校验", "deps": ["extract"], "duration": 1.5},
        {"id": "clean_a", "name": "清洗分支A", "deps": ["validate"], "duration": 1.8},
        {"id": "clean_b", "name": "清洗分支B", "deps": ["validate"], "duration": 1.2},
        {"id": "transform", "name": "数据转换", "deps": ["clean_a"], "duration": 3.0},
        {"id": "enrich", "name": "数据增强", "deps": ["clean_a", "clean_b"], "duration": 2.0},
        {"id": "aggregate", "name": "聚合计算", "deps": ["transform", "enrich"], "duration": 2.5},
        {"id": "quality", "name": "质量检查", "deps": ["aggregate"], "duration": 1.0},
        {"id": "export_db", "name": "入库", "deps": ["quality"], "duration": 1.8},
        {"id": "export_report", "name": "报表生成", "deps": ["quality"], "duration": 2.2},
        {"id": "notify", "name": "通知", "deps": ["export_db", "export_report"], "duration": 0.5},
    ]
    positions = [
        (0, 0), (0, 1), (-1, 2), (1, 2), (-1, 3),
        (0.5, 3), (-0.3, 4), (-0.3, 5), (-1, 6), (0.5, 6), (-0.3, 7)
    ]
    for i, n in enumerate(nodes):
        n["x"] = positions[i][0] * 2.5 + 2.5
        n["y"] = positions[i][1] * 0.9
        n["status"] = "PENDING"
        n["retries"] = 0
        n["startTime"] = None
        n["endTime"] = None
        n["records"] = None          # 该节点处理条数
        n["qualityIssues"] = None    # 仅质检节点：检出的异常条数

    edges = []
    for n in nodes:
        for d in n["deps"]:
            edges.append([d, n["id"]])

    return {"nodes": nodes, "edges": edges,
            "durations": {n["id"]: n["duration"] for n in nodes}}


@app.on_event("startup")
def _capture_loop():
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_event_loop()


def broadcast(payload):
    """线程安全地向所有 WS 客户端推送（工作线程 -> 主事件循环）"""
    loop = MAIN_LOOP
    if loop is None:
        return
    msg = json.dumps(payload)
    for ws in list(ACTIVE_CLIENTS):
        try:
            asyncio.run_coroutine_threadsafe(ws.send_text(msg), loop)
        except Exception:
            pass


def build_stages(run, now):
    """按八个环节汇总节点明细：处理条数 / 处理时长 / 重试次数 / 状态"""
    node_map = run["nodeMap"]
    stages = []
    for sid, name, nids in STAGE_DEFS:
        ns = [node_map[i] for i in nids]
        states = {n["status"] for n in ns}
        if states == {"SUCCESS"}:
            status = "SUCCESS"
        elif "RUNNING" in states:
            status = "RUNNING"
        elif "INTERRUPTED" in states:
            status = "INTERRUPTED"
        elif "SUCCESS" in states:
            status = "PARTIAL"
        else:
            status = "PENDING"

        recs = [n["records"] for n in ns if n.get("records") is not None]
        duration_ms = 0
        for n in ns:
            if n["startTime"]:
                end = n["endTime"]
                if end is None and n["status"] == "RUNNING":
                    end = now
                if end is not None:
                    duration_ms += int((end - n["startTime"]) * 1000)

        stages.append({
            "id": sid,
            "name": name,
            "nodeIds": nids,
            "status": status,
            "records": sum(recs) if recs else None,
            "durationMs": duration_ms,
            "retries": sum(n["retries"] for n in ns),
        })
    return stages


def build_quality(run):
    q = run["nodeMap"]["quality"]
    return {
        "nodeId": "quality",
        "status": q["status"],
        "checked": q["records"],
        "issues": q["qualityIssues"] or 0,
    }


def run_summary(run):
    stages = run.get("stages") or []
    nodes = run["nodes"]
    return {
        "id": run["id"],
        "status": run["status"],
        "workers": run["workers"],
        "strategy": run["strategy"],
        "startedAt": run["startedAt"],
        "endedAt": run["endedAt"],
        "stages": stages,
        "quality": run.get("quality") or {"nodeId": "quality", "status": "PENDING",
                                          "checked": None, "issues": 0},
        "totalRecords": sum(s["records"] or 0 for s in stages),
        "totalDurationMs": sum(s["durationMs"] for s in stages),
        "totalRetries": sum(s["retries"] for s in stages),
        "totalNodes": len(nodes),
        "completedNodes": sum(1 for n in nodes if n["status"] == "SUCCESS"),
    }


def run_detail(run):
    detail = run_summary(run)
    detail.update({
        "nodes": run["nodes"],
        "edges": run["edges"],
        "logs": run["logs"],
        "circuitBreakers": [{"taskId": k, **v} for k, v in run["cbState"].items()],
    })
    return detail


def ws_payload(run, completed_flag):
    return {
        # 兼容原有实时明细 / 画布节点的字段
        "workflow": {"id": run["workflowId"], "name": "workflow",
                     "nodes": run["nodes"], "edges": run["edges"]},
        "logs": run["logs"][-30:],
        "circuitBreakers": [{"taskId": k, **v} for k, v in run["cbState"].items()],
        "completed": completed_flag,
        # 每次执行质量概览字段
        "runId": run["id"],
        "status": run["status"],
        "workers": run["workers"],
        "strategy": run["strategy"],
        "startedAt": run["startedAt"],
        "endedAt": run["endedAt"],
        "stages": run["stages"],
        "quality": run["quality"],
    }


@app.post("/api/workflow")
def create_workflow(req: WorkflowCreate):
    global WORKFLOW_ID
    WORKFLOW_ID += 1
    dag = generate_dag_workflow(req.name)
    return {"id": WORKFLOW_ID, "name": req.name, "nodes": dag["nodes"], "edges": dag["edges"],
            "_durations": dag["durations"]}


@app.post("/api/run")
def run_workflow(req: RunRequest):
    global RUN_SEQ
    dag = generate_dag_workflow("workflow")
    now = time.time()
    with threading.Lock():
        RUN_SEQ += 1
        run_id = RUN_SEQ

    run = {
        "id": run_id,
        "workflowId": req.workflowId,
        "workers": req.workers,
        "strategy": req.strategy,
        "startedAt": now,
        "endedAt": None,
        "status": "RUNNING",
        "nodes": dag["nodes"],
        "edges": dag["edges"],
        "logs": [],
        "cbState": defaultdict(lambda: {"failureCount": 0, "state": "CLOSED", "cooldownUntil": 0}),
        "nodeMap": {n["id"]: n for n in dag["nodes"]},
        "stop": threading.Event(),
    }
    run["stages"] = build_stages(run, now)
    run["quality"] = build_quality(run)

    if len(RUNS) == RUNS.maxlen:
        RUN_MAP.pop(RUNS[0]["id"], None)
    RUNS.append(run)
    RUN_MAP[run_id] = run

    t = threading.Thread(target=execute_workflow,
                         args=(run, dag["durations"], req.workers), daemon=True)
    t.start()

    return {
        "workflow": {"id": req.workflowId, "name": "workflow",
                     "nodes": dag["nodes"], "edges": dag["edges"]},
        "logs": [], "circuitBreakers": [], "completed": False,
        "runId": run_id, "status": "RUNNING", "workers": req.workers,
        "strategy": req.strategy, "startedAt": now, "endedAt": None,
        "stages": run["stages"], "quality": run["quality"],
    }


@app.post("/api/runs/{run_id}/stop")
def stop_run(run_id: int):
    """中断某次执行：已完成环节保留，运行中节点标记为 INTERRUPTED"""
    run = RUN_MAP.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="执行记录不存在")
    if run["status"] == "RUNNING":
        run["stop"].set()
    return {"id": run_id, "status": run["status"]}


@app.get("/api/runs")
def list_runs(limit: int = 20):
    """最近若干次执行的概览（按时间倒序）"""
    limit = max(1, min(limit, 50))
    return [run_summary(r) for r in list(RUNS)[-limit:][::-1]]


@app.get("/api/runs/{run_id}")
def get_run(run_id: int):
    run = RUN_MAP.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="执行记录不存在")
    return run_detail(run)


def execute_workflow(run, durations, workers):
    nodes = run["nodes"]
    edges = run["edges"]
    node_map = run["nodeMap"]
    cb_state = run["cbState"]
    stop_event = run["stop"]

    in_degree = defaultdict(int)
    adj = defaultdict(list)
    for u, v in edges:
        in_degree[v] += 1
        adj[u].append(v)

    # BFS topological sort
    ready = deque([n["id"] for n in nodes if in_degree[n["id"]] == 0])
    logs = run["logs"]
    failure_threshold = 3
    running_tasks = {}
    completed = set()

    # 模拟本次执行各节点的处理条数（平时小幅波动，偶发突发，便于对比）
    base = 10000 * random.uniform(0.92, 1.08)
    if random.random() < 0.12:
        base *= random.uniform(1.6, 2.0)
    validated = base * random.uniform(0.96, 1.0)
    clean_a = validated * random.uniform(0.55, 0.62)
    clean_b = validated - clean_a
    transformed = clean_a * random.uniform(0.98, 1.02)
    enriched = (clean_a + clean_b) * random.uniform(0.98, 1.01)
    aggregated = min(transformed, enriched) * random.uniform(0.92, 1.0)
    planned_records = {
        "extract": int(base),
        "validate": int(validated),
        "clean_a": int(clean_a),
        "clean_b": int(clean_b),
        "transform": int(transformed),
        "enrich": int(enriched),
        "aggregate": int(aggregated),
        "quality": int(aggregated),
        "export_db": int(aggregated * random.uniform(0.98, 1.0)),
        "export_report": int(random.uniform(28, 36)),
    }

    def send_update(completed_flag=False):
        now = time.time()
        run["stages"] = build_stages(run, now)
        run["quality"] = build_quality(run)
        broadcast(ws_payload(run, completed_flag))

    interrupted = False
    while ready or running_tasks:
        # Start tasks
        while ready and len(running_tasks) < workers:
            tid = ready.popleft()
            node = node_map[tid]
            cb = cb_state[tid]
            if cb["state"] == "OPEN" and time.time() < cb["cooldownUntil"]:
                ready.appendleft(tid)
                continue
            if cb["state"] == "OPEN":
                cb["state"] = "HALF_OPEN"

            node["status"] = "RUNNING"
            node["startTime"] = time.time()
            if tid in planned_records:
                node["records"] = planned_records[tid]

            # Simulate task execution (random success/failure)
            will_fail = random.random() < 0.12  # 12% failure rate
            runtime = durations.get(tid, 1.5) * random.uniform(0.7, 1.3)
            running_tasks[tid] = {
                "end_time": time.time() + runtime,
                "will_fail": will_fail,
                "retries": node["retries"]
            }
            logs.append({"taskId": tid, "status": "RUNNING", "timestamp": time.time(),
                         "message": f"开始执行 {node['name']}"})

        # Check completed tasks
        now = time.time()
        finished = []
        for tid, info in running_tasks.items():
            if now >= info["end_time"]:
                node = node_map[tid]
                if info["will_fail"] and node["retries"] < 3:
                    node["retries"] += 1
                    node["status"] = "PENDING"
                    ready.appendleft(tid)
                    cb = cb_state[tid]
                    cb["failureCount"] += 1
                    logs.append({"taskId": tid, "status": "FAILED", "timestamp": now,
                                 "message": f"重试 {node['retries']}/3"})
                    if cb["failureCount"] >= failure_threshold:
                        cb["state"] = "OPEN"
                        cb["cooldownUntil"] = now + 5
                        logs.append({"taskId": tid, "status": "CIRCUIT_OPEN", "timestamp": now,
                                     "message": f"熔断! {failure_threshold}次连续失败"})
                else:
                    node["status"] = "SUCCESS"
                    node["endTime"] = now
                    completed.add(tid)
                    # 质检节点：检出异常条数（偶发异常飙升）
                    if tid == "quality" and node["records"]:
                        issues = node["records"] * random.uniform(0.002, 0.025)
                        if random.random() < 0.12:
                            issues *= random.uniform(4, 6)
                        node["qualityIssues"] = int(issues)
                    cb_state[tid]["failureCount"] = 0
                    cb_state[tid]["state"] = "CLOSED"
                    logs.append({"taskId": tid, "status": "SUCCESS", "timestamp": now,
                                 "message": f"完成 {node['name']}"})
                    for next_tid in adj[tid]:
                        in_degree[next_tid] -= 1
                        if in_degree[next_tid] == 0:
                            ready.append(next_tid)
                finished.append(tid)

        for tid in finished:
            del running_tasks[tid]

        send_update()

        # 被中断：停止调度，保留已完成 / 进行中环节的明细
        if stop_event.is_set():
            interrupted = True
            break
        if len(completed) == len(nodes):
            break

        stop_event.wait(0.3)

    # 收尾（含中途被打断的情况）
    now = time.time()
    run["endedAt"] = now
    if interrupted:
        for n in nodes:
            if n["status"] == "RUNNING":
                n["status"] = "INTERRUPTED"
                n["endTime"] = now
        run["status"] = "INTERRUPTED"
        logs.append({"taskId": "*", "status": "INTERRUPTED", "timestamp": now,
                     "message": "执行被手动中断，已完成环节的明细已保留"})
    else:
        run["status"] = "SUCCESS"
    run["stages"] = build_stages(run, now)
    run["quality"] = build_quality(run)
    broadcast(ws_payload(run, True))


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ACTIVE_CLIENTS.append(ws)
    try:
        while True:
            await ws.receive_text()
    except Exception:
        if ws in ACTIVE_CLIENTS:
            ACTIVE_CLIENTS.remove(ws)
