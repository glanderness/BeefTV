// 仅用于本地测量构建的探针（第六轮），不参与产品逻辑。第六轮时整份复制为
// web/src/perf-probe.ts；第五轮的版本见 native-probe.patch。
//
// 第六轮相对第五轮只加导出，不改第五轮已有的口径：
//   1. 逐帧原始数组（帧间隔、每帧落点/重建增量、每帧的墙上时间）——第五轮只发了汇总，
//      事后无法复算 FPS/p95，也无法把拖线帧与空闲帧分开（#101 复核）。
//   2. 每次落点调用的实际目标（nodeId / handleId / 耗时）。
//   3. 每次真实输入的起止（pointerdown/pointerup/wheel/keydown/keyup，含坐标与命中的节点）。
//   4. 录制起止的墙上时间，用来和隔离客户端的访问日志对齐。
//   5. 每次录制的 `runId`、单调递增的 `startSeq`、单调时间基与每次 start 的独立记录。
//      第五轮 `perf-after-grouped1000-r2.ndjson` 里出现连续两条 start（14:23:19、14:23:24）
//      后 14:23:29 才 stop，只有「窗口不完整」是确定的：接收端只记请求，HTTP 重传本身不会
//      触发前端 reset，重传与真实二次点击必须区分开。所以第六轮把每一次 start 单独落一条
//      （带 runId / startSeq / 单调时间），再配合真实输入起止与逐帧数组判断是不是真的重启过。
// 汇总行仍然照发（GET /perf），完整导出走 POST /perf（数组塞不进 query string）。
//
// 需要在两处调用点各加一行（与第五轮插桩同一位置，见 round6-prep.md）：
//   在算出 target 之后：`(window as any).__perfLogDropTarget?.(target, performance.now() - begin)`
type PerfCounters = {
    page: number;
    node: number;
    indexBuilds: number;
    indexBuildMs: number;
    indexQueries: number;
    indexQueryMs: number;
    indexCandidates: number;
    dropTargetCalls: number;
    dropTargetMs: number;
    progressLookups: number;
    progressMs: number;
};

type DropTargetRecord = { t: number; nodeId: string; handleId: string; ms: number };
type InputRecord = { t: number; type: string; x: number; y: number; nodeId: string; key?: string; button?: number };

const perf: PerfCounters = {
    page: 0,
    node: 0,
    indexBuilds: 0,
    indexBuildMs: 0,
    indexQueries: 0,
    indexQueryMs: 0,
    indexCandidates: 0,
    dropTargetCalls: 0,
    dropTargetMs: 0,
    progressLookups: 0,
    progressMs: 0,
};

(window as any).__perf = perf;

// 结果回传：WKWebView 里写不了文件，无障碍树也读不回一长串数字，所以同时用回环端口的
// 接收脚本落盘（docs/performance/2026-10-28-canvas-interaction/perf-sink.py）。
const SINK = "http://127.0.0.1:8799/perf";
const epochNow = () => performance.timeOrigin + performance.now();

function report(kind: string, text: string) {
    document.title = `perf-${kind} ${text}`;
    try {
        void fetch(`${SINK}?kind=${encodeURIComponent(kind)}&d=${encodeURIComponent(text)}`, { mode: "no-cors", keepalive: true });
    } catch {
        /* 接收端没起也不影响测量 */
    }
}

// 完整导出走 POST：逐帧数组几千项，query string 放不下。text/plain 是 no-cors 下的
// 简单请求，不触发预检；接收端不看 Content-Type，只解析 body。
function reportDump(payload: unknown) {
    try {
        void fetch(SINK, {
            method: "POST",
            mode: "no-cors",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify(payload),
        });
    } catch {
        /* 接收端没起也不影响测量 */
    }
}

const MAX_SAMPLES = 200000;
const frameIntervals: number[] = [];
const frameTimestamps: number[] = [];
const frameMonotonic: number[] = [];
const frameDropTargets: number[] = [];
const frameIndexBuilds: number[] = [];
const dropTargetLog: DropTargetRecord[] = [];
const inputLog: InputRecord[] = [];
// 每次 start 单独留痕：接收端只看到请求，重复请求既可能是重传也可能是真的又点了一次，
// 只有页面自己知道处理函数跑了几次。startLog 是判断「窗口是否被重启」的第一手证据。
const startLog: Array<{ runId: string; startSeq: number; epoch: number; monotonic: number; restartedWhileRecording: boolean }> = [];
let recording = false;
let label = "idle";
let runId = "";
let startSeq = 0;
let startedAt = 0;
let stoppedAt = 0;
let startedMonotonic = 0;
let stoppedMonotonic = 0;
let last = performance.now();
// 帧边界上的上一次总量快照。早先这里是两个「本帧计数」变量，只在初始化和清零时赋值、
// 从不随计数增加，干跑里总调用 22/67/68 而「含落点帧」一直为 0（#101 第二轮复核）。
let previousDropTargetCalls = 0;
let previousIndexBuilds = 0;
let framesWithDropTarget = 0;
let framesWithRebuild = 0;

// 落点调用的实际目标：调用点算完 target 后调用它。第六轮新增，第五轮没有这一项，
// 所以「落点调用次数」对不上是正常的——它现在能一一对上每次调用的目标。
(window as any).__perfLogDropTarget = (target: { nodeId?: string | null; handleId?: string | null } | null, ms: number) => {
    if (!recording || dropTargetLog.length >= MAX_SAMPLES) return;
    dropTargetLog.push({
        t: Math.round(epochNow() * 10) / 10,
        nodeId: String(target?.nodeId ?? ""),
        handleId: String(target?.handleId ?? ""),
        ms: Math.round(ms * 1000) / 1000,
    });
};

function nodeIdOf(element: Element | null): string {
    const host = element?.closest?.("[data-node-id]") as HTMLElement | null;
    return host?.dataset?.nodeId ?? "";
}

// 真实输入的起止：真实鼠标由 cua-driver 投递，探针只能在页面上听事件。pointermove 只记
// 每个按下手势里的第一条与最后一条（否则一次拖拽会写几千行）；wheel 每次记一条。
let gestureMoveCount = 0;
function recordInput(type: string, event: Event) {
    if (!recording || inputLog.length >= MAX_SAMPLES) return;
    const pointer = event as PointerEvent;
    const key = event as KeyboardEvent;
    const isPointer = typeof pointer.clientX === "number";
    if (type === "pointermove") {
        gestureMoveCount += 1;
        // 只留手势的首尾两条移动记录，中间的移动数量用 moveCount 体现。
        if (gestureMoveCount > 1 && gestureMoveCount % 32 !== 0) return;
    }
    inputLog.push({
        t: Math.round(epochNow() * 10) / 10,
        type,
        x: isPointer ? Math.round(pointer.clientX) : -1,
        y: isPointer ? Math.round(pointer.clientY) : -1,
        nodeId: nodeIdOf(event.target as Element | null),
        key: type.startsWith("key") ? key.key : undefined,
        button: isPointer ? pointer.button : undefined,
    });
}

for (const type of ["pointerdown", "pointerup", "pointercancel", "wheel", "keydown", "keyup"]) {
    window.addEventListener(type, (event) => recordInput(type, event), { capture: true, passive: true });
}
window.addEventListener("pointermove", (event) => recordInput("pointermove", event), { capture: true, passive: true });

function loop(now: number) {
    if (recording) {
        frameIntervals.push(now - last);
        frameTimestamps.push(Math.round(epochNow() * 10) / 10);
        frameMonotonic.push(Math.round(now * 10) / 10);
        const dropTargetDelta = perf.dropTargetCalls - previousDropTargetCalls;
        const indexBuildDelta = perf.indexBuilds - previousIndexBuilds;
        frameDropTargets.push(dropTargetDelta);
        frameIndexBuilds.push(indexBuildDelta);
        if (dropTargetDelta > 0) framesWithDropTarget += 1;
        if (indexBuildDelta > 0) framesWithRebuild += 1;
    }
    previousDropTargetCalls = perf.dropTargetCalls;
    previousIndexBuilds = perf.indexBuilds;
    last = now;
    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function quantile(sorted: number[], p: number) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}

function stats() {
    const sorted = [...frameIntervals].sort((left, right) => left - right);
    const span = frameIntervals.reduce((sum, value) => sum + value, 0);
    const round = (value: number) => Number(value.toFixed(3));
    return [
        `场景=${label}`,
        `帧=${frameIntervals.length}`,
        `fps=${span ? ((frameIntervals.length / span) * 1000).toFixed(1) : "-"}`,
        `p50=${round(quantile(sorted, 0.5))}`,
        `p95=${round(quantile(sorted, 0.95))}`,
        `p99=${round(quantile(sorted, 0.99))}`,
        `max=${round(sorted.length ? sorted[sorted.length - 1] : 0)}`,
        `gt33=${sorted.filter((value) => value > 33.4).length}`,
        `gt50=${sorted.filter((value) => value > 50).length}`,
        `gt100=${sorted.filter((value) => value > 100).length}`,
        `含落点帧=${framesWithDropTarget}`,
        `含重建帧=${framesWithRebuild}`,
        `落点调用=${perf.dropTargetCalls}`,
        `落点总耗时=${round(perf.dropTargetMs)}`,
        `索引建立=${perf.indexBuilds}`,
        `索引建立耗时=${round(perf.indexBuildMs)}`,
        `索引查询=${perf.indexQueries}`,
        // 查询耗时只含 query；索引建立成本在 nodeIndexFor 内单独计时，合计在这里给出，
        // 不要把「建立耗时 + 查询耗时」当同一段时间重复相加。
        `索引查询耗时=${round(perf.indexQueryMs)}`,
        `索引合计耗时=${round(perf.indexBuildMs + perf.indexQueryMs)}`,
        `候选数=${perf.indexCandidates}`,
        `进度查询=${perf.progressLookups}`,
        `进度耗时=${round(perf.progressMs)}`,
        `页面渲染=${perf.page}`,
        `节点渲染=${perf.node}`,
        `挂载卡=${document.querySelectorAll("[data-node-id]").length}`,
    ].join(" ");
}

function reset() {
    frameIntervals.length = 0;
    frameTimestamps.length = 0;
    frameMonotonic.length = 0;
    frameDropTargets.length = 0;
    frameIndexBuilds.length = 0;
    dropTargetLog.length = 0;
    inputLog.length = 0;
    gestureMoveCount = 0;
    framesWithDropTarget = 0;
    framesWithRebuild = 0;
    previousDropTargetCalls = 0;
    previousIndexBuilds = 0;
    for (const key of Object.keys(perf) as Array<keyof PerfCounters>) perf[key] = 0;
}

const box = document.createElement("div");
box.setAttribute("data-canvas-no-zoom", "");
box.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:600px;font:11px/1.4 monospace;background:#000d;color:#0f0;padding:6px;border-radius:6px;pointer-events:auto";
const out = document.createElement("div");
out.setAttribute("data-perf-out", "");
out.setAttribute("aria-label", "perf idle");
out.textContent = "perf probe ready";
box.append(out);

function button(name: string, color: string, onClick: () => void) {
    const element = document.createElement("button");
    element.textContent = name;
    element.setAttribute("aria-label", name);
    element.style.cssText = `margin:4px 4px 0 0;padding:2px 6px;background:#222;color:${color};border:1px solid ${color}`;
    element.onclick = (event) => {
        event.stopPropagation();
        onClick();
    };
    box.append(element);
    return element;
}

button("perf-rec-start", "#0f0", () => {
    const restarted = recording;
    reset();
    label = "gesture";
    recording = true;
    startSeq += 1;
    startedAt = Math.round(epochNow() * 10) / 10;
    startedMonotonic = Math.round(performance.now() * 10) / 10;
    runId = `run-${startSeq}-${Math.round(startedAt)}`;
    startLog.push({ runId, startSeq, epoch: startedAt, monotonic: startedMonotonic, restartedWhileRecording: restarted });
    out.textContent = "记录中";
    out.setAttribute("aria-label", "perf recording");
    // 每条 start 都带 runId / startSeq / 单调时间，并且明确写出这一次是否打断了上一段
    // 录制。重复请求在接收端分不开，只有这里能区分「真的又点了一次」和「只是重发」。
    report("start", `recording runId=${runId} startSeq=${startSeq} restartedWhileRecording=${restarted} startedAt=${startedAt} monotonic=${startedMonotonic}`);
});

button("perf-rec-stop", "#f80", () => {
    recording = false;
    stoppedAt = Math.round(epochNow() * 10) / 10;
    stoppedMonotonic = Math.round(performance.now() * 10) / 10;
    const text = stats();
    out.textContent = text;
    out.setAttribute("aria-label", `perfres ${text}`);
    (window as any).__perfLast = text;
    report("stop", `${text} runId=${runId} startSeq=${startSeq} startedAt=${startedAt} stoppedAt=${stoppedAt} monotonic=${stoppedMonotonic}`);
    // 完整导出：逐帧原始数组 + 每次落点目标 + 每次真实输入。有这一份才能事后复算
    // FPS/p95，并把拖线帧和空闲帧分开（第五轮的汇总行做不到，见 #101 复核）。
    reportDump({
        kind: "recording",
        runId,
        startSeq,
        startLog,
        label,
        timeOrigin: performance.timeOrigin,
        startedAt,
        stoppedAt,
        startedMonotonic,
        stoppedMonotonic,
        sinkReceivedAt: Math.round(Date.now()),
        frames: frameIntervals,
        frameTimestamps,
        frameMonotonic,
        frameDropTargets,
        frameIndexBuilds,
        dropTargets: dropTargetLog,
        inputs: inputLog,
        counters: { ...perf },
        mountedCards: document.querySelectorAll("[data-node-id]").length,
        summary: text,
    });
    (window as any).__perfLastDump = { runId, frames: frameIntervals.length, dropTargets: dropTargetLog.length, inputs: inputLog.length };
});

button("perf-ports", "#ff0", () => {
    // 真实鼠标要在窗口坐标里点/拖，所以把可见节点的两侧连接点中心报出来（CSS px）。
    const nodes = [...document.querySelectorAll<HTMLElement>("[data-node-id]")].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 60 && rect.height > 60 && rect.top > 60 && rect.left > 60 && rect.bottom < window.innerHeight - 60 && rect.right < window.innerWidth - 60;
    });
    const rails = (element: HTMLElement, side: string) => {
        const rail = element.querySelector<HTMLElement>(`[data-canvas-connection-rail="${side}"]`);
        if (!rail) return null;
        const rect = rail.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    };
    const first = nodes[0];
    const second = nodes.find((element) => element !== first && element.dataset.canvasNodeType === first?.dataset.canvasNodeType) || nodes[1];
    const text = [
        `视口=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`,
        `out=${first ? JSON.stringify(rails(first, "right")) : "null"}`,
        `in=${second ? JSON.stringify(rails(second, "left")) : "null"}`,
        `nodeA=${first?.dataset.nodeId ?? "null"} nodeB=${second?.dataset.nodeId ?? "null"}`,
        `卡片数=${nodes.length}`,
    ].join(" ");
    out.textContent = text;
    out.setAttribute("aria-label", `perfports ${text}`);
    report("ports", text);
});

button("perf-open", "#0ff", () => {
    location.hash = `#/canvas/${(window as any).__perfCanvasId}`;
});

button("perf-hover", "#0ff", () => {
    // 悬停用真实鼠标，这里只报出若干可见卡片中心，方便逐个移过去。
    const centers = [...document.querySelectorAll<HTMLElement>("[data-node-id]")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), id: element.dataset.nodeId };
    }).filter((center) => center.x > 80 && center.y > 80 && center.x < window.innerWidth - 80 && center.y < window.innerHeight - 80);
    const text = `卡片中心=${centers.slice(0, 8).map((center) => `${center.x},${center.y}`).join(" ")}`;
    out.textContent = text;
    out.setAttribute("aria-label", `perfcenters ${text}`);
    report("centers", text);
});

const attach = () => (document.body ? document.body.append(box) : setTimeout(attach, 50));
attach();
