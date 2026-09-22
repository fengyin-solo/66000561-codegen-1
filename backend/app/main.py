import asyncio, time, random, json, threading, os, sqlite3
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="DAG Workflow Engine")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ACTIVE_CLIENTS = []
WORKFLOW_ID = 0

# Main thread event loop, captured at startup so worker threads can push WS updates.
MAIN_LOOP: asyncio.AbstractEventLoop | None = None
# run_id -> threading.Event (set when an execution is interrupted by the user)
CANCEL_EVENTS: dict[int, threading.Event] = {}

# ---------------------------------------------------------------------------
# Persistence: one row per execution + per-node quality metrics.
# Node rows are written the moment a node finishes, so an interrupted run still
# exposes the detail of everything that completed before the interruption.
# ---------------------------------------------------------------------------
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "pipeline.db")
_db_lock = threading.RLock()


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = _connect()
    try:
        with _db_lock, conn:
            yield conn
    finally:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = _connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id INTEGER,
            workflow_name TEXT,
            workers INTEGER,
            strategy TEXT,
            status TEXT,
            started_at REAL,
            ended_at REAL,
            quality_defects INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS node_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER,
            node_id TEXT,
            node_name TEXT,
            stage TEXT,
            rows_processed INTEGER,
            duration_ms INTEGER,
            retries INTEGER,
            end_time REAL
        );
        CREATE INDEX IF NOT EXISTS idx_node_run ON node_metrics(run_id);
        CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
        """
    )
    conn.commit()
    conn.close()


init_db()


@app.on_event("startup")
def _capture_loop():
    global MAIN_LOOP
    MAIN_LOOP = asyncio.get_event_loop()


# The eight quality stages surfaced by the overview, and how node rows are
# combined when a stage contains more than one node (clean_a/clean_b and
# transform/enrich).
STAGES = [
    {"id": "extract", "name": "提取", "rowsMode": "single", "nodes": ["extract"]},
    {"id": "validate", "name": "校验", "rowsMode": "single", "nodes": ["validate"]},
    {"id": "clean", "name": "清洗", "rowsMode": "sum", "nodes": ["clean_a", "clean_b"]},
    {"id": "transform", "name": "转换", "rowsMode": "max", "nodes": ["transform", "enrich"]},
    {"id": "aggregate", "name": "聚合", "rowsMode": "single", "nodes": ["aggregate"]},
    {"id": "quality", "name": "质检", "rowsMode": "single", "nodes": ["quality"]},
    {"id": "export_db", "name": "入库", "rowsMode": "single", "nodes": ["export_db"]},
    {"id": "report", "name": "报表生成", "rowsMode": "single", "nodes": ["export_report"]},
]
NODE_STAGE = {nid: s["id"] for s in STAGES for nid in s["nodes"]}
STAGE_ROWS_MODE = {s["id"]: s["rowsMode"] for s in STAGES}


def _create_run(workflow_id: int, workflow_name: str, workers: int, strategy: str) -> int:
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO runs (workflow_id, workflow_name, workers, strategy, status, started_at) "
            "VALUES (?, ?, ?, ?, 'RUNNING', ?)",
            (workflow_id, workflow_name, workers, strategy, time.time()),
        )
        return cur.lastrowid


def _insert_node_metric(run_id, node, stage, rows, duration_ms, retries, end_time):
    with db() as conn:
        conn.execute(
            "INSERT INTO node_metrics (run_id, node_id, node_name, stage, rows_processed, duration_ms, retries, end_time) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, node["id"], node["name"], stage, rows, duration_ms, retries, end_time),
        )


def _finish_run(run_id, status, quality_defects=0):
    with db() as conn:
        conn.execute(
            "UPDATE runs SET status = ?, ended_at = ?, quality_defects = ? WHERE id = ?",
            (status, time.time(), quality_defects, run_id),
        )


def _run_summary_row(r, extra=None):
    summary = {
        "id": r["id"],
        "workflowId": r["workflow_id"],
        "workflowName": r["workflow_name"],
        "workers": r["workers"],
        "strategy": r["strategy"],
        "status": r["status"],
        "startedAt": r["started_at"],
        "endedAt": r["ended_at"],
        "qualityDefects": r["quality_defects"],
    }
    if extra is not None:
        summary.update(extra)
    return summary


_SUMMARY_STATS_SQL = """
    SELECT nm.run_id AS run_id,
           SUM(CASE WHEN nm.stage = 'extract' THEN nm.rows_processed ELSE 0 END) AS extract_rows,
           SUM(nm.duration_ms) AS total_duration_ms,
           SUM(nm.retries) AS total_retries
    FROM node_metrics nm
    WHERE nm.run_id IN ({placeholders})
    GROUP BY nm.run_id
"""


def _summary_stats(run_ids):
    if not run_ids:
        return {}
    placeholders = ",".join("?" * len(run_ids))
    with db() as conn:
        rows = conn.execute(
            _SUMMARY_STATS_SQL.format(placeholders=placeholders), run_ids
        ).fetchall()
    return {r["run_id"]: r for r in rows}


def _build_run_detail(run_row):
    run_id = run_row["id"]
    stats = _summary_stats([run_id]).get(run_id)
    extra = {}
    if stats is not None:
        extra = {
            "extractRows": stats["extract_rows"] or 0,
            "totalDurationMs": stats["total_duration_ms"] or 0,
            "totalRetries": stats["total_retries"] or 0,
        }
    with db() as conn:
        node_rows = conn.execute(
            "SELECT * FROM node_metrics WHERE run_id = ? ORDER BY end_time", (run_id,)
        ).fetchall()

    metrics_by_node = {}
    for nr in node_rows:
        metrics_by_node[nr["node_id"]] = {
            "nodeId": nr["node_id"],
            "nodeName": nr["node_name"],
            "stage": nr["stage"],
            "rows": nr["rows_processed"],
            "durationMs": nr["duration_ms"],
            "retries": nr["retries"],
        }

    stages = []
    for s in STAGES:
        members = [metrics_by_node[nid] for nid in s["nodes"] if nid in metrics_by_node]
        if not members:
            stages.append({"stage": s["id"], "name": s["name"], "executed": False})
            continue
        if STAGE_ROWS_MODE[s["id"]] == "sum":
            rows = sum(m["rows"] for m in members)
        elif STAGE_ROWS_MODE[s["id"]] == "max":
            rows = max(m["rows"] for m in members)
        else:
            rows = members[0]["rows"]
        stages.append({
            "stage": s["id"],
            "name": s["name"],
            "executed": True,
            "rows": rows,
            "durationMs": sum(m["durationMs"] for m in members),
            "retries": sum(m["retries"] for m in members),
            "nodes": members,
        })

    return {**_run_summary_row(run_row, extra), "stages": stages}


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

    edges = []
    for n in nodes:
        for d in n["deps"]:
            edges.append([d, n["id"]])

    return {"nodes": [{
        "id": n["id"], "name": n["name"], "deps": n["deps"],
        "x": n["x"], "y": n["y"], "status": n["status"],
        "startTime": None, "endTime": None, "retries": n["retries"]
    } for n in nodes], "edges": edges, "durations": {n["id"]: n["duration"] for n in nodes}}


@app.post("/api/workflow")
def create_workflow(req: WorkflowCreate):
    global WORKFLOW_ID
    WORKFLOW_ID += 1
    dag = generate_dag_workflow(req.name)
    return {"id": WORKFLOW_ID, "name": req.name, "nodes": dag["nodes"], "edges": dag["edges"],
            "_durations": dag["durations"]}


@app.post("/api/run")
def run_workflow(req: RunRequest):
    dag = generate_dag_workflow("workflow")
    run_id = _create_run(req.workflowId, "workflow", req.workers, req.strategy)
    CANCEL_EVENTS[run_id] = threading.Event()
    t = threading.Thread(target=execute_workflow, args=(dag, run_id, req.workers, req.strategy), daemon=True)
    t.start()
    return {
        "runId": run_id,
        "workflow": {"id": req.workflowId, "name": "workflow", "nodes": dag["nodes"], "edges": dag["edges"]},
        "logs": [], "circuitBreakers": [], "completed": False
    }


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(run_id: int):
    ev = CANCEL_EVENTS.get(run_id)
    with db() as conn:
        row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="执行记录不存在")
    if row["status"] != "RUNNING":
        return {"id": run_id, "status": row["status"], "cancelled": False}
    if ev:
        ev.set()
    return {"id": run_id, "status": "RUNNING", "cancelled": True}


@app.get("/api/runs")
def list_runs(limit: int = 12):
    limit = max(1, min(limit, 50))
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    stats = _summary_stats([r["id"] for r in rows])
    result = []
    for r in rows:
        st = stats.get(r["id"])
        extra = {
            "extractRows": (st["extract_rows"] or 0) if st else 0,
            "totalDurationMs": (st["total_duration_ms"] or 0) if st else 0,
            "totalRetries": (st["total_retries"] or 0) if st else 0,
        }
        result.append(_run_summary_row(r, extra))
    return result


@app.get("/api/runs/{run_id}")
def get_run(run_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="执行记录不存在")
    return _build_run_detail(row)


def _simulate_rows(tid, predecessor_rows, rng):
    """Simulate how many rows a node handled, roughly following data flow."""
    if tid == "extract":
        return int(rng.uniform(90000, 120000))
    if tid == "validate":
        return int(predecessor_rows * rng.uniform(0.96, 1.0))
    if tid == "clean_a":
        return int(predecessor_rows * rng.uniform(0.55, 0.65))
    if tid == "clean_b":
        return int(predecessor_rows * rng.uniform(0.30, 0.40))
    if tid == "transform":
        return int(predecessor_rows * rng.uniform(0.95, 1.0))
    if tid == "enrich":
        return int(predecessor_rows * rng.uniform(0.97, 1.0))
    if tid == "aggregate":
        return int(predecessor_rows * rng.uniform(0.08, 0.15))
    if tid == "quality":
        return int(predecessor_rows * rng.uniform(0.98, 1.0))
    if tid == "export_db":
        return int(predecessor_rows * rng.uniform(0.98, 1.0))
    if tid == "export_report":
        return max(1, int(predecessor_rows * rng.uniform(0.003, 0.006)))
    if tid == "notify":
        return predecessor_rows
    return predecessor_rows


def execute_workflow(dag, run_id, workers, strategy):
    nodes = dag["nodes"]
    durations = dag["durations"]
    edges = dag["edges"]
    in_degree = defaultdict(int)
    adj = defaultdict(list)
    for u, v in edges:
        in_degree[v] += 1
        adj[u].append(v)

    # BFS topological sort
    ready = deque([n["id"] for n in nodes if in_degree[n["id"]] == 0])
    node_map = {n["id"]: n for n in nodes}
    logs = []
    cb_state = defaultdict(lambda: {"failureCount": 0, "state": "CLOSED", "cooldownUntil": 0})
    failure_threshold = 3
    running_tasks = {}
    completed = set()
    rng = random.Random(run_id * 1000003 + int(time.time()))
    rows_by_node = {}
    quality_defects = 0
    cancel_event = CANCEL_EVENTS.get(run_id)

    def send_update(completed_flag=False, status="RUNNING"):
        payload = {
            "runId": run_id,
            "runStatus": status,
            "workflow": {"id": 1, "name": "workflow", "nodes": nodes, "edges": edges},
            "logs": logs[-30:],
            "circuitBreakers": [{"taskId": k, **v} for k, v in cb_state.items()],
            "completed": completed_flag
        }
        for ws in ACTIVE_CLIENTS:
            try:
                asyncio.run_coroutine_threadsafe(ws.send_text(json.dumps(payload)), MAIN_LOOP)
            except Exception:
                pass
        time.sleep(0.3)

    interrupted = False
    while ready or running_tasks:
        if cancel_event is not None and cancel_event.is_set():
            interrupted = True
            break
        # Start tasks
        while ready and len(running_tasks) < workers:
            if cancel_event is not None and cancel_event.is_set():
                break
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

            # Simulate task execution (random success/failure)
            will_fail = rng.random() < 0.12  # 12% failure rate
            runtime = durations.get(tid, 1.5) * rng.uniform(0.7, 1.3)
            running_tasks[tid] = {
                "end_time": time.time() + runtime,
                "will_fail": will_fail,
                "retries": node["retries"]
            }
            logs.append({"taskId": tid, "status": "RUNNING", "timestamp": time.time(), "message": f"开始执行 {node['name']}"})

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
                    logs.append({"taskId": tid, "status": "FAILED", "timestamp": now, "message": f"重试 {node['retries']}/3"})
                    if cb["failureCount"] >= failure_threshold:
                        cb["state"] = "OPEN"
                        cb["cooldownUntil"] = now + 5
                        logs.append({"taskId": tid, "status": "CIRCUIT_OPEN", "timestamp": now, "message": f"熔断! {failure_threshold}次连续失败"})
                else:
                    node["status"] = "SUCCESS"
                    node["endTime"] = now
                    completed.add(tid)
                    cb_state[tid]["failureCount"] = 0
                    cb_state[tid]["state"] = "CLOSED"

                    # Persist per-node quality metrics as soon as the node ends,
                    # so interruptions never lose completed-stage detail.
                    pred_rows = [rows_by_node[d] for d in node["deps"] if d in rows_by_node]
                    predecessor_rows = (sum(pred_rows) if len(pred_rows) > 1 else pred_rows[0]) if pred_rows else 0
                    node_rows = _simulate_rows(tid, predecessor_rows, rng)
                    rows_by_node[tid] = node_rows
                    duration_ms = int((node["endTime"] - node["startTime"]) * 1000)
                    stage = NODE_STAGE.get(tid)
                    if stage:
                        _insert_node_metric(run_id, node, stage, node_rows, duration_ms, node["retries"], now)
                    if tid == "quality":
                        base = rows_by_node.get("aggregate", node_rows)
                        quality_defects = int(base * (rng.uniform(0.03, 0.08) if rng.random() < 0.7 else rng.uniform(0.0, 0.005)))
                        with db() as conn:
                            conn.execute("UPDATE runs SET quality_defects = ? WHERE id = ?", (quality_defects, run_id))
                        logs.append({"taskId": tid, "status": "QC", "timestamp": now, "message": f"质检检出异常 {quality_defects} 条"})

                    logs.append({"taskId": tid, "status": "SUCCESS", "timestamp": now, "message": f"完成 {node['name']}"})
                    for next_tid in adj[tid]:
                        in_degree[next_tid] -= 1
                        if in_degree[next_tid] == 0:
                            ready.append(next_tid)
                finished.append(tid)

        for tid in finished:
            del running_tasks[tid]

        # A cancel arriving while tasks are in flight: let the check above drain
        # finished tasks once more, then stop — already finished metrics are safe.
        if cancel_event is not None and cancel_event.is_set() and not finished:
            interrupted = True
            break

        send_update()
        if len(completed) == len(nodes):
            break

    if interrupted:
        for tid, info in running_tasks.items():
            node_map[tid]["status"] = "INTERRUPTED"
            node_map[tid]["endTime"] = time.time()
        for tid in list(ready):
            node_map[tid]["status"] = "INTERRUPTED"
        _finish_run(run_id, "INTERRUPTED", quality_defects)
        logs.append({"taskId": "-", "status": "INTERRUPTED", "timestamp": time.time(), "message": "执行被手动打断，已完成环节明细已保留"})
        send_update(True, "INTERRUPTED")
    else:
        _finish_run(run_id, "SUCCESS", quality_defects)
        send_update(True, "SUCCESS")
    CANCEL_EVENTS.pop(run_id, None)


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
