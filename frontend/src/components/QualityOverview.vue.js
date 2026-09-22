/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts';
import { useDAGStore } from '../store/dag';
const store = useDAGStore();
const run = computed(() => store.selectedRun);
const prev = computed(() => store.previousRun);
const trendRef = ref();
let chart = null;
let pollTimer = null;
const DIFF_THRESHOLD = 0.3;
function statusLabel(s) {
    return { RUNNING: '运行中', SUCCESS: '成功', FAILED: '失败', INTERRUPTED: '已打断' }[s] ?? s;
}
function statusTag(s) {
    return { RUNNING: 'primary', SUCCESS: 'success', FAILED: 'danger', INTERRUPTED: 'warning' }[s] ?? 'info';
}
function fmtNum(v) { return (v ?? 0).toLocaleString('zh-CN'); }
function fmtDuration(ms) {
    if (ms == null)
        return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} 毫秒`;
}
function fmtClock(ts) {
    const d = new Date(ts * 1000);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function fmtDateTime(ts) { return fmtClock(ts); }
function pctChange(cur, prevVal) {
    if (cur == null || prevVal == null || !Number.isFinite(cur) || !Number.isFinite(prevVal))
        return null;
    if (prevVal === 0)
        return cur === 0 ? 0 : 1; // 0 → 非0 视为 100% 增长
    return (cur - prevVal) / prevVal;
}
function diffText(cur, prevVal) {
    const p = pctChange(cur, prevVal);
    if (p == null || prevVal == null)
        return prevVal == null ? '（无历史）' : '';
    if (p === 0)
        return '持平';
    return `${p > 0 ? '+' : ''}${(p * 100).toFixed(0)}%`;
}
function diffClass(cur, prevVal, threshold = true) {
    const p = pctChange(cur, prevVal);
    if (p == null || p === 0 || prevVal == null)
        return 'neutral';
    return threshold && Math.abs(p) < DIFF_THRESHOLD ? 'neutral' : p > 0 ? 'up' : 'down';
}
function prevStage(row) {
    return prev.value?.stages.find(s => s.stage === row.stage);
}
function prevStageVal(row, key) {
    const ps = prevStage(row);
    if (!ps || !ps.executed)
        return undefined;
    return ps[key];
}
function isBig(row, key) {
    const p = pctChange(row[key], prevStageVal(row, key));
    return p != null && Math.abs(p) >= DIFF_THRESHOLD;
}
const METRIC_LABELS = { rows: '处理条数', durationMs: '处理时长', retries: '重试次数' };
const bigChanges = computed(() => {
    if (!run.value || !prev.value)
        return [];
    const out = [];
    for (const s of run.value.stages) {
        if (!s.executed)
            continue;
        const ps = prev.value.stages.find(x => x.stage === s.stage);
        if (!ps || !ps.executed)
            continue;
        ['rows', 'durationMs', 'retries'].forEach(key => {
            const p = pctChange(s[key], ps[key]);
            if (p != null && Math.abs(p) >= DIFF_THRESHOLD) {
                out.push({ stage: s.stage, name: s.name, metric: key, metricLabel: METRIC_LABELS[key], pct: p });
            }
        });
    }
    return out;
});
const interruptedExpanded = computed(() => (run.value?.stages ?? []).filter(s => s.executed && s.nodes && s.nodes.length > 1).map(s => s.stage));
function onSelect(id) {
    store.setSelectedRunId(id);
    store.fetchSelectedRun();
}
function renderTrend() {
    if (!trendRef.value)
        return;
    if (!chart)
        chart = echarts.init(trendRef.value, undefined, { renderer: 'canvas' });
    const list = [...store.runs].sort((a, b) => a.id - b.id);
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
    });
    // 抽屉开合动画期间容器宽度可能尚未稳定
    window.setTimeout(() => chart?.resize(), 300);
}
async function openRefresh() {
    await store.fetchRuns();
    // 首次打开且未选择过：默认最近一次，并持久化
    if (store.selectedRunId == null && store.runs.length) {
        store.setSelectedRunId(store.runs[0].id);
    }
    await store.fetchSelectedRun();
}
function syncPoll() {
    if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
    if (store.overviewOpen && run.value?.status === 'RUNNING') {
        pollTimer = window.setInterval(async () => {
            await store.refreshOverview();
        }, 2500);
    }
}
watch(() => store.overviewOpen, (open) => {
    if (open) {
        nextTick(openRefresh);
    }
    syncPoll();
});
watch(() => run.value?.status, syncPoll);
watch(() => store.runs, () => nextTick(renderTrend), { deep: false });
onMounted(() => {
    if (store.overviewOpen)
        nextTick(openRefresh);
    syncPoll();
    window.addEventListener('resize', resizeChart);
});
onBeforeUnmount(() => {
    if (pollTimer)
        window.clearInterval(pollTimer);
    window.removeEventListener('resize', resizeChart);
    chart?.dispose();
});
function resizeChart() { chart?.resize(); }
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['defect']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['change-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['change-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-main']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-main']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-diff']} */ ;
/** @type {__VLS_StyleScopedClasses['up']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-diff']} */ ;
/** @type {__VLS_StyleScopedClasses['down']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-diff']} */ ;
/** @type {__VLS_StyleScopedClasses['node-detail']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.ElDrawer;
/** @type {[typeof __VLS_components.ElDrawer, typeof __VLS_components.elDrawer, typeof __VLS_components.ElDrawer, typeof __VLS_components.elDrawer, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ 'onUpdate:modelValue': {} },
    modelValue: (__VLS_ctx.store.overviewOpen),
    title: "📊 每次执行质量概览",
    direction: "rtl",
    size: "62%",
    ...{ class: "quality-drawer" },
}));
const __VLS_2 = __VLS_1({
    ...{ 'onUpdate:modelValue': {} },
    modelValue: (__VLS_ctx.store.overviewOpen),
    title: "📊 每次执行质量概览",
    direction: "rtl",
    size: "62%",
    ...{ class: "quality-drawer" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_4;
let __VLS_5;
let __VLS_6;
const __VLS_7 = {
    'onUpdate:modelValue': (...[$event]) => {
        __VLS_ctx.store.setOverviewOpen($event);
    }
};
var __VLS_8 = {};
__VLS_3.slots.default;
{
    const { header: __VLS_thisSlot } = __VLS_3.slots;
    const [{ titleId, titleClass }] = __VLS_getSlotParams(__VLS_thisSlot);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        id: (titleId),
        ...{ class: (titleClass) },
        ...{ class: "drawer-title" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "toolbar" },
});
const __VLS_9 = {}.ElSelect;
/** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
// @ts-ignore
const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
    ...{ 'onUpdate:modelValue': {} },
    modelValue: (__VLS_ctx.store.selectedRunId ?? undefined),
    size: "small",
    ...{ style: {} },
    placeholder: "选择执行",
}));
const __VLS_11 = __VLS_10({
    ...{ 'onUpdate:modelValue': {} },
    modelValue: (__VLS_ctx.store.selectedRunId ?? undefined),
    size: "small",
    ...{ style: {} },
    placeholder: "选择执行",
}, ...__VLS_functionalComponentArgsRest(__VLS_10));
let __VLS_13;
let __VLS_14;
let __VLS_15;
const __VLS_16 = {
    'onUpdate:modelValue': (__VLS_ctx.onSelect)
};
__VLS_12.slots.default;
for (const [r] of __VLS_getVForSourceType((__VLS_ctx.store.runs))) {
    const __VLS_17 = {}.ElOption;
    /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
    // @ts-ignore
    const __VLS_18 = __VLS_asFunctionalComponent(__VLS_17, new __VLS_17({
        key: (r.id),
        value: (r.id),
        label: (`#${r.id} · ${__VLS_ctx.statusLabel(r.status)} · ${__VLS_ctx.fmtClock(r.startedAt)}`),
    }));
    const __VLS_19 = __VLS_18({
        key: (r.id),
        value: (r.id),
        label: (`#${r.id} · ${__VLS_ctx.statusLabel(r.status)} · ${__VLS_ctx.fmtClock(r.startedAt)}`),
    }, ...__VLS_functionalComponentArgsRest(__VLS_18));
    __VLS_20.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "opt-id" },
    });
    (r.id);
    const __VLS_21 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_22 = __VLS_asFunctionalComponent(__VLS_21, new __VLS_21({
        size: "small",
        type: (__VLS_ctx.statusTag(r.status)),
        effect: "dark",
        disableTransitions: true,
    }));
    const __VLS_23 = __VLS_22({
        size: "small",
        type: (__VLS_ctx.statusTag(r.status)),
        effect: "dark",
        disableTransitions: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_22));
    __VLS_24.slots.default;
    (__VLS_ctx.statusLabel(r.status));
    var __VLS_24;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "opt-time" },
    });
    (__VLS_ctx.fmtClock(r.startedAt));
    var __VLS_20;
}
var __VLS_12;
const __VLS_25 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_26 = __VLS_asFunctionalComponent(__VLS_25, new __VLS_25({
    ...{ 'onClick': {} },
    size: "small",
    loading: (__VLS_ctx.store.overviewLoading),
}));
const __VLS_27 = __VLS_26({
    ...{ 'onClick': {} },
    size: "small",
    loading: (__VLS_ctx.store.overviewLoading),
}, ...__VLS_functionalComponentArgsRest(__VLS_26));
let __VLS_29;
let __VLS_30;
let __VLS_31;
const __VLS_32 = {
    onClick: (...[$event]) => {
        __VLS_ctx.store.refreshOverview();
    }
};
__VLS_28.slots.default;
var __VLS_28;
if (__VLS_ctx.run && __VLS_ctx.run.status === 'RUNNING') {
    const __VLS_33 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_34 = __VLS_asFunctionalComponent(__VLS_33, new __VLS_33({
        ...{ 'onClick': {} },
        size: "small",
        type: "warning",
        loading: (__VLS_ctx.store.cancelling),
    }));
    const __VLS_35 = __VLS_34({
        ...{ 'onClick': {} },
        size: "small",
        type: "warning",
        loading: (__VLS_ctx.store.cancelling),
    }, ...__VLS_functionalComponentArgsRest(__VLS_34));
    let __VLS_37;
    let __VLS_38;
    let __VLS_39;
    const __VLS_40 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.run && __VLS_ctx.run.status === 'RUNNING'))
                return;
            __VLS_ctx.store.cancelSelectedRun();
        }
    };
    __VLS_36.slots.default;
    var __VLS_36;
}
if (!__VLS_ctx.store.runs.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-state" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-icon" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-title" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "empty-desc" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.br)({});
}
else if (__VLS_ctx.run) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "run-header" },
    });
    const __VLS_41 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_42 = __VLS_asFunctionalComponent(__VLS_41, new __VLS_41({
        type: (__VLS_ctx.statusTag(__VLS_ctx.run.status)),
        effect: "dark",
        size: "large",
    }));
    const __VLS_43 = __VLS_42({
        type: (__VLS_ctx.statusTag(__VLS_ctx.run.status)),
        effect: "dark",
        size: "large",
    }, ...__VLS_functionalComponentArgsRest(__VLS_42));
    __VLS_44.slots.default;
    (__VLS_ctx.statusLabel(__VLS_ctx.run.status));
    var __VLS_44;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "run-time" },
    });
    (__VLS_ctx.fmtDateTime(__VLS_ctx.run.startedAt));
    if (__VLS_ctx.run.endedAt) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-time" },
        });
        (__VLS_ctx.fmtDateTime(__VLS_ctx.run.endedAt));
    }
    if (__VLS_ctx.run.totalDurationMs != null) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "run-time" },
        });
        (__VLS_ctx.fmtDuration(__VLS_ctx.run.totalDurationMs));
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "run-time" },
    });
    (__VLS_ctx.run.strategy);
    (__VLS_ctx.run.workers);
    if (__VLS_ctx.run.status === 'INTERRUPTED') {
        const __VLS_45 = {}.ElAlert;
        /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
        // @ts-ignore
        const __VLS_46 = __VLS_asFunctionalComponent(__VLS_45, new __VLS_45({
            type: "warning",
            closable: (false),
            showIcon: true,
            title: "本次执行中途被打断，以下仅展示已完成环节的明细；未执行环节以「—」标注。",
            ...{ class: "interrupt-alert" },
        }));
        const __VLS_47 = __VLS_46({
            type: "warning",
            closable: (false),
            showIcon: true,
            title: "本次执行中途被打断，以下仅展示已完成环节的明细；未执行环节以「—」标注。",
            ...{ class: "interrupt-alert" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_46));
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-grid" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-value" },
    });
    (__VLS_ctx.fmtNum(__VLS_ctx.run.extractRows));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-value" },
    });
    (__VLS_ctx.fmtDuration(__VLS_ctx.run.totalDurationMs));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-card" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-value" },
        ...{ class: ({ warn: (__VLS_ctx.run.totalRetries ?? 0) > 0 }) },
    });
    (__VLS_ctx.run.totalRetries ?? 0);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-card defect" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "stat-value" },
    });
    (__VLS_ctx.fmtNum(__VLS_ctx.run.qualityDefects));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "stat-unit" },
    });
    if (__VLS_ctx.prev) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "stat-sub" },
        });
        (__VLS_ctx.fmtNum(__VLS_ctx.prev.qualityDefects));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: (__VLS_ctx.diffClass(__VLS_ctx.run.qualityDefects, __VLS_ctx.prev.qualityDefects, false)) },
        });
        (__VLS_ctx.diffText(__VLS_ctx.run.qualityDefects, __VLS_ctx.prev.qualityDefects));
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "stat-sub" },
        });
    }
    if (__VLS_ctx.bigChanges.length) {
        const __VLS_49 = {}.ElAlert;
        /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
        // @ts-ignore
        const __VLS_50 = __VLS_asFunctionalComponent(__VLS_49, new __VLS_49({
            type: "error",
            closable: (false),
            showIcon: true,
            ...{ class: "change-alert" },
        }));
        const __VLS_51 = __VLS_50({
            type: "error",
            closable: (false),
            showIcon: true,
            ...{ class: "change-alert" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_50));
        __VLS_52.slots.default;
        {
            const { title: __VLS_thisSlot } = __VLS_52.slots;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "prev-ref" },
            });
            (__VLS_ctx.prev.id);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "change-list" },
        });
        for (const [c] of __VLS_getVForSourceType((__VLS_ctx.bigChanges))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                key: (c.stage + c.metric),
                ...{ class: "change-chip" },
            });
            (c.name);
            (c.metricLabel);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: (c.pct >= 0 ? 'up' : 'down') },
            });
            (c.pct >= 0 ? '▲' : '▼');
            (Math.abs(c.pct * 100).toFixed(0));
        }
        var __VLS_52;
    }
    else if (__VLS_ctx.prev) {
        const __VLS_53 = {}.ElAlert;
        /** @type {[typeof __VLS_components.ElAlert, typeof __VLS_components.elAlert, ]} */ ;
        // @ts-ignore
        const __VLS_54 = __VLS_asFunctionalComponent(__VLS_53, new __VLS_53({
            type: "success",
            closable: (false),
            showIcon: true,
            title: (`与上一次执行 #${__VLS_ctx.prev.id} 相比，各环节处理条数与时长均无显著波动（±30% 以内）。`),
            ...{ class: "change-alert" },
        }));
        const __VLS_55 = __VLS_54({
            type: "success",
            closable: (false),
            showIcon: true,
            title: (`与上一次执行 #${__VLS_ctx.prev.id} 相比，各环节处理条数与时长均无显著波动（±30% 以内）。`),
            ...{ class: "change-alert" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_54));
    }
    const __VLS_57 = {}.ElTable;
    /** @type {[typeof __VLS_components.ElTable, typeof __VLS_components.elTable, typeof __VLS_components.ElTable, typeof __VLS_components.elTable, ]} */ ;
    // @ts-ignore
    const __VLS_58 = __VLS_asFunctionalComponent(__VLS_57, new __VLS_57({
        data: (__VLS_ctx.run.stages),
        size: "small",
        ...{ class: "stage-table" },
        rowKey: "stage",
        expandRowKeys: (__VLS_ctx.run.status === 'INTERRUPTED' ? __VLS_ctx.interruptedExpanded : []),
    }));
    const __VLS_59 = __VLS_58({
        data: (__VLS_ctx.run.stages),
        size: "small",
        ...{ class: "stage-table" },
        rowKey: "stage",
        expandRowKeys: (__VLS_ctx.run.status === 'INTERRUPTED' ? __VLS_ctx.interruptedExpanded : []),
    }, ...__VLS_functionalComponentArgsRest(__VLS_58));
    __VLS_60.slots.default;
    const __VLS_61 = {}.ElTableColumn;
    /** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
    // @ts-ignore
    const __VLS_62 = __VLS_asFunctionalComponent(__VLS_61, new __VLS_61({
        type: "expand",
    }));
    const __VLS_63 = __VLS_62({
        type: "expand",
    }, ...__VLS_functionalComponentArgsRest(__VLS_62));
    __VLS_64.slots.default;
    {
        const { default: __VLS_thisSlot } = __VLS_64.slots;
        const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
        if (row.executed && row.nodes && row.nodes.length > 1) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "node-detail" },
            });
            for (const [m] of __VLS_getVForSourceType((row.nodes))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    key: (m.nodeId),
                    ...{ class: "node-row" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "node-name" },
                });
                (m.nodeName);
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (__VLS_ctx.fmtNum(m.rows));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (__VLS_ctx.fmtDuration(m.durationMs));
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (m.retries);
            }
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "node-detail single" },
            });
        }
    }
    var __VLS_64;
    const __VLS_65 = {}.ElTableColumn;
    /** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
    // @ts-ignore
    const __VLS_66 = __VLS_asFunctionalComponent(__VLS_65, new __VLS_65({
        prop: "name",
        label: "环节",
        width: "110",
    }));
    const __VLS_67 = __VLS_66({
        prop: "name",
        label: "环节",
        width: "110",
    }, ...__VLS_functionalComponentArgsRest(__VLS_66));
    __VLS_68.slots.default;
    {
        const { default: __VLS_thisSlot } = __VLS_68.slots;
        const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "stage-name" },
        });
        (row.name);
        if (row.nodes && row.nodes.length > 1) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "branch-hint" },
            });
            (row.nodes.length);
        }
    }
    var __VLS_68;
    const __VLS_69 = {}.ElTableColumn;
    /** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
    // @ts-ignore
    const __VLS_70 = __VLS_asFunctionalComponent(__VLS_69, new __VLS_69({
        label: "状态",
        width: "90",
    }));
    const __VLS_71 = __VLS_70({
        label: "状态",
        width: "90",
    }, ...__VLS_functionalComponentArgsRest(__VLS_70));
    __VLS_72.slots.default;
    {
        const { default: __VLS_thisSlot } = __VLS_72.slots;
        const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
        if (row.executed) {
            const __VLS_73 = {}.ElTag;
            /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
            // @ts-ignore
            const __VLS_74 = __VLS_asFunctionalComponent(__VLS_73, new __VLS_73({
                type: "success",
                size: "small",
                effect: "plain",
            }));
            const __VLS_75 = __VLS_74({
                type: "success",
                size: "small",
                effect: "plain",
            }, ...__VLS_functionalComponentArgsRest(__VLS_74));
            __VLS_76.slots.default;
            var __VLS_76;
        }
        else {
            const __VLS_77 = {}.ElTag;
            /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
            // @ts-ignore
            const __VLS_78 = __VLS_asFunctionalComponent(__VLS_77, new __VLS_77({
                type: "info",
                size: "small",
                effect: "plain",
            }));
            const __VLS_79 = __VLS_78({
                type: "info",
                size: "small",
                effect: "plain",
            }, ...__VLS_functionalComponentArgsRest(__VLS_78));
            __VLS_80.slots.default;
            var __VLS_80;
        }
    }
    var __VLS_72;
    const __VLS_81 = {}.ElTableColumn;
    /** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
    // @ts-ignore
    const __VLS_82 = __VLS_asFunctionalComponent(__VLS_81, new __VLS_81({
        label: "处理条数",
        minWidth: "180",
    }));
    const __VLS_83 = __VLS_82({
        label: "处理条数",
        minWidth: "180",
    }, ...__VLS_functionalComponentArgsRest(__VLS_82));
    __VLS_84.slots.default;
    {
        const { default: __VLS_thisSlot } = __VLS_84.slots;
        const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
        if (row.executed) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "metric-main" },
                ...{ class: ({ big: __VLS_ctx.isBig(row, 'rows') }) },
            });
            (__VLS_ctx.fmtNum(row.rows));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "metric-diff" },
                ...{ class: (__VLS_ctx.diffClass(row.rows, __VLS_ctx.prevStageVal(row, 'rows'), true)) },
            });
            (__VLS_ctx.diffText(row.rows, __VLS_ctx.prevStageVal(row, 'rows')));
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dash" },
            });
        }
    }
    var __VLS_84;
    const __VLS_85 = {}.ElTableColumn;
    /** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
    // @ts-ignore
    const __VLS_86 = __VLS_asFunctionalComponent(__VLS_85, new __VLS_85({
        label: "处理时长",
        minWidth: "170",
    }));
    const __VLS_87 = __VLS_86({
        label: "处理时长",
        minWidth: "170",
    }, ...__VLS_functionalComponentArgsRest(__VLS_86));
    __VLS_88.slots.default;
    {
        const { default: __VLS_thisSlot } = __VLS_88.slots;
        const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
        if (row.executed) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "metric-main" },
                ...{ class: ({ big: __VLS_ctx.isBig(row, 'durationMs') }) },
            });
            (__VLS_ctx.fmtDuration(row.durationMs));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "metric-diff" },
                ...{ class: (__VLS_ctx.diffClass(row.durationMs, __VLS_ctx.prevStageVal(row, 'durationMs'), true)) },
            });
            (__VLS_ctx.diffText(row.durationMs, __VLS_ctx.prevStageVal(row, 'durationMs')));
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dash" },
            });
        }
    }
    var __VLS_88;
    const __VLS_89 = {}.ElTableColumn;
    /** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
    // @ts-ignore
    const __VLS_90 = __VLS_asFunctionalComponent(__VLS_89, new __VLS_89({
        label: "重试次数",
        minWidth: "130",
    }));
    const __VLS_91 = __VLS_90({
        label: "重试次数",
        minWidth: "130",
    }, ...__VLS_functionalComponentArgsRest(__VLS_90));
    __VLS_92.slots.default;
    {
        const { default: __VLS_thisSlot } = __VLS_92.slots;
        const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
        if (row.executed) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "metric-main" },
                ...{ class: ({ warn: row.retries > 0, big: __VLS_ctx.isBig(row, 'retries') }) },
            });
            (row.retries);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "metric-diff" },
                ...{ class: (__VLS_ctx.diffClass(row.retries, __VLS_ctx.prevStageVal(row, 'retries'), false)) },
            });
            (__VLS_ctx.diffText(row.retries, __VLS_ctx.prevStageVal(row, 'retries')));
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "dash" },
            });
        }
    }
    var __VLS_92;
    var __VLS_60;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({
        ...{ class: "trend-title" },
    });
    (__VLS_ctx.store.runs.length);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ref: "trendRef",
        ...{ class: "trend-chart" },
    });
    /** @type {typeof __VLS_ctx.trendRef} */ ;
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['quality-drawer']} */ ;
/** @type {__VLS_StyleScopedClasses['drawer-title']} */ ;
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['opt-id']} */ ;
/** @type {__VLS_StyleScopedClasses['opt-time']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-state']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-title']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-desc']} */ ;
/** @type {__VLS_StyleScopedClasses['run-header']} */ ;
/** @type {__VLS_StyleScopedClasses['run-time']} */ ;
/** @type {__VLS_StyleScopedClasses['run-time']} */ ;
/** @type {__VLS_StyleScopedClasses['run-time']} */ ;
/** @type {__VLS_StyleScopedClasses['run-time']} */ ;
/** @type {__VLS_StyleScopedClasses['interrupt-alert']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-grid']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['defect']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-value']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-unit']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-sub']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-sub']} */ ;
/** @type {__VLS_StyleScopedClasses['change-alert']} */ ;
/** @type {__VLS_StyleScopedClasses['prev-ref']} */ ;
/** @type {__VLS_StyleScopedClasses['change-list']} */ ;
/** @type {__VLS_StyleScopedClasses['change-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['change-alert']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-table']} */ ;
/** @type {__VLS_StyleScopedClasses['node-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['node-row']} */ ;
/** @type {__VLS_StyleScopedClasses['node-name']} */ ;
/** @type {__VLS_StyleScopedClasses['node-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['single']} */ ;
/** @type {__VLS_StyleScopedClasses['stage-name']} */ ;
/** @type {__VLS_StyleScopedClasses['branch-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-main']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-diff']} */ ;
/** @type {__VLS_StyleScopedClasses['dash']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-main']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-diff']} */ ;
/** @type {__VLS_StyleScopedClasses['dash']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-main']} */ ;
/** @type {__VLS_StyleScopedClasses['metric-diff']} */ ;
/** @type {__VLS_StyleScopedClasses['dash']} */ ;
/** @type {__VLS_StyleScopedClasses['trend-title']} */ ;
/** @type {__VLS_StyleScopedClasses['trend-chart']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            store: store,
            run: run,
            prev: prev,
            trendRef: trendRef,
            statusLabel: statusLabel,
            statusTag: statusTag,
            fmtNum: fmtNum,
            fmtDuration: fmtDuration,
            fmtClock: fmtClock,
            fmtDateTime: fmtDateTime,
            diffText: diffText,
            diffClass: diffClass,
            prevStageVal: prevStageVal,
            isBig: isBig,
            bigChanges: bigChanges,
            interruptedExpanded: interruptedExpanded,
            onSelect: onSelect,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
