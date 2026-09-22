import { defineStore } from 'pinia';
import { ref } from 'vue';
import axios from 'axios';
const SELECTED_RUN_KEY = 'dag.quality.selectedRunId';
const DRAWER_OPEN_KEY = 'dag.quality.drawerOpen';
export const useDAGStore = defineStore('dag', () => {
    const loading = ref(false);
    const workflow = ref(null);
    const execution = ref(null);
    const wsConnected = ref(false);
    const workers = ref(3);
    const strategy = ref('fifo');
    // ---- 质量概览视图状态（与实时执行视图互不影响）----
    const runs = ref([]);
    const selectedRunId = ref(localStorage.getItem(SELECTED_RUN_KEY) ? Number(localStorage.getItem(SELECTED_RUN_KEY)) : null);
    const selectedRun = ref(null);
    const previousRun = ref(null);
    const overviewOpen = ref(localStorage.getItem(DRAWER_OPEN_KEY) === '1');
    const overviewLoading = ref(false);
    const cancelling = ref(false);
    function setOverviewOpen(open) {
        overviewOpen.value = open;
        localStorage.setItem(DRAWER_OPEN_KEY, open ? '1' : '0');
    }
    function setSelectedRunId(id) {
        selectedRunId.value = id;
        localStorage.setItem(SELECTED_RUN_KEY, String(id));
    }
    async function fetchRuns() {
        const { data } = await axios.get('/api/runs', { params: { limit: 12 } });
        runs.value = data;
        // 已选中的执行被清理掉时，回退到最近一次
        if (selectedRunId.value != null && !data.some(r => r.id === selectedRunId.value)) {
            if (data.length)
                setSelectedRunId(data[0].id);
            else {
                selectedRunId.value = null;
                localStorage.removeItem(SELECTED_RUN_KEY);
            }
        }
        return data;
    }
    async function fetchSelectedRun() {
        if (selectedRunId.value == null) {
            selectedRun.value = null;
            previousRun.value = null;
            return;
        }
        const id = selectedRunId.value;
        overviewLoading.value = true;
        try {
            const { data } = await axios.get(`/api/runs/${id}`);
            selectedRun.value = data;
            // 相邻上一次执行（按 id 相邻，即更早的最近一次），用于环比
            const prevId = data.id - 1;
            if (prevId > 0) {
                try {
                    const prev = await axios.get(`/api/runs/${prevId}`);
                    previousRun.value = prev.data;
                }
                catch {
                    previousRun.value = null;
                }
            }
            else {
                previousRun.value = null;
            }
        }
        catch (e) {
            if (e?.response?.status === 404)
                selectedRun.value = null;
        }
        finally {
            overviewLoading.value = false;
        }
    }
    async function refreshOverview() {
        await fetchRuns();
        await fetchSelectedRun();
    }
    async function cancelSelectedRun() {
        if (selectedRunId.value == null)
            return;
        cancelling.value = true;
        try {
            await axios.post(`/api/runs/${selectedRunId.value}/cancel`);
            await refreshOverview();
        }
        finally {
            cancelling.value = false;
        }
    }
    let ws = null;
    function connectWS() {
        ws = new WebSocket(`ws://${location.hostname}:8000/ws`);
        ws.onopen = () => { wsConnected.value = true; };
        ws.onmessage = (e) => {
            try {
                const d = JSON.parse(e.data);
                execution.value = d;
            }
            catch { }
        };
    }
    async function createWorkflow(name) {
        loading.value = true;
        try {
            const { data } = await axios.post('/api/workflow', { name });
            workflow.value = data;
        }
        finally {
            loading.value = false;
        }
    }
    async function run() {
        if (!workflow.value)
            return;
        loading.value = true;
        try {
            const { data } = await axios.post('/api/run', { workflowId: workflow.value.id, workers: workers.value, strategy: strategy.value });
            execution.value = data;
            // 新执行产生后，概览下次打开/刷新即可看到；不改写用户已选中的执行
            if (overviewOpen.value)
                await refreshOverview();
        }
        finally {
            loading.value = false;
        }
    }
    function disconnectWS() { ws?.close(); ws = null; }
    return {
        loading, workflow, execution, wsConnected, workers, strategy, connectWS, createWorkflow, run, disconnectWS,
        runs, selectedRunId, selectedRun, previousRun, overviewOpen, overviewLoading, cancelling,
        setOverviewOpen, setSelectedRunId, fetchRuns, fetchSelectedRun, refreshOverview, cancelSelectedRun
    };
});
