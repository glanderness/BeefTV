// 第七轮探针新逻辑的功能核对（bun 直跑，不需要浏览器、不启动客户端）。
//
// 覆盖 #101 第六轮复核指出的两处记录缺陷：
//   1. move 首末必须按每个 pointerId 手势归属（第六轮用一个全局计数器 + 取模采样）；
//   2. 「完整 down/up 区间内的 rAF 回调」必须与「计数有增量的标记帧」分开（第六轮混用）。
// 同时确认 __perfLogConnectStart / __perfLogDropTarget 的记录形状与文档指纹字段。
//
// 用法（从仓库根）：
//   bun docs/performance/2026-10-28-canvas-interaction/round7/probe-gesture-check.ts


type Listener = (event: any) => void;
const listeners = new Map<string, Listener[]>();
const buttons: any[] = [];
const dumps: any[] = [];
const reports: string[] = [];
let rafCallback: ((now: number) => void) | null = null;
let now = 1000;

const fakeElement = (tag: string) => {
    const element: any = {
        tagName: tag,
        style: { cssText: "" },
        dataset: {},
        children: [],
        textContent: "",
        attributes: {} as Record<string, string>,
        setAttribute(key: string, value: string) {
            this.attributes[key] = value;
        },
        getAttribute(key: string) {
            return this.attributes[key] ?? null;
        },
        append(child: any) {
            this.children.push(child);
        },
        getBoundingClientRect() {
            return { left: 100, top: 200, width: 300, height: 200 };
        },
    };
    if (tag === "button") buttons.push(element);
    return element;
};

(globalThis as any).window = globalThis;
(globalThis as any).performance = { timeOrigin: 1700000000000, now: () => now };
(globalThis as any).requestAnimationFrame = (callback: (value: number) => void) => {
    rafCallback = callback;
    return 1;
};
(globalThis as any).setTimeout = () => 0;
(globalThis as any).fetch = (url: string, init?: any) => {
    if (init?.method === "POST") dumps.push(JSON.parse(init.body));
    else reports.push(String(url));
    return Promise.resolve({});
};
(globalThis as any).document = {
    title: "",
    visibilityState: "visible",
    body: fakeElement("body"),
    createElement: fakeElement,
    hasFocus: () => true,
    querySelectorAll: () => [],
    querySelector: () => null,
};
(globalThis as any).screen = { width: 1440, height: 960, availWidth: 1440, availHeight: 960 };
(globalThis as any).window.screen = (globalThis as any).screen;
(globalThis as any).innerWidth = 1440;
(globalThis as any).innerHeight = 960;
(globalThis as any).devicePixelRatio = 1;
(globalThis as any).screenX = 0;
(globalThis as any).screenY = 0;
(globalThis as any).outerWidth = 1440;
(globalThis as any).outerHeight = 992;
(globalThis as any).addEventListener = (type: string, listener: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
};

// 探针自装：import 即把 window.__perf / __perfLogDropTarget / __perfLogConnectStart 装好。
await import("./perf-probe-round7.ts");

const dispatch = (type: string, event: any) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
};
const tick = (delta: number) => {
    now += delta;
    const callback = rafCallback;
    rafCallback = null;
    callback?.(now);
};
const clickButton = (label: string) => {
    const button = buttons.find((item) => item.getAttribute("aria-label") === label);
    if (!button) throw new Error(`找不到按钮 ${label}`);
    button.onclick({ stopPropagation() {} });
};
const node = (id: string) => ({ closest: (selector: string) => (selector === "[data-node-id]" ? { dataset: { nodeId: id } } : null) });

// 起手：真实开始入口先记一条。
clickButton("perf-rec-start");
(globalThis as any).__perfLogConnectStart({
    entry: "ordinary",
    pointerId: 7,
    nodeId: "perf-node-19",
    handleType: "source",
    handleId: "",
    anchorRatio: null,
    rail: "right",
    railRect: { left: 500, top: 300, width: 8, height: 8 },
    clientX: 1098,
    clientY: 447,
    projectId: "perf300",
    nodeCount: 300,
    connectionCount: 150,
});

// 手势 A：pointerId=7，3 条 move；中间夹两帧。
dispatch("pointerdown", { pointerId: 7, clientX: 1098, clientY: 447, button: 0, buttons: 1, target: node("perf-node-19") });
tick(16);
dispatch("pointermove", { pointerId: 7, clientX: 1100, clientY: 447, buttons: 1, target: node("perf-node-19") });
tick(16);
dispatch("pointermove", { pointerId: 7, clientX: 1130, clientY: 447, buttons: 1, target: node("perf-node-19") });
dispatch("pointermove", { pointerId: 7, clientX: 1170, clientY: 447, buttons: 1, target: node("perf-node-20") });
tick(16);
(globalThis as any).__perf.dropTargetCalls += 1;
dispatch("pointerup", { pointerId: 7, clientX: 1170, clientY: 447, button: 0, buttons: 0, target: node("perf-node-20") });
tick(16);

// 手势 B：pointerId=9，1 条 move（用来证明 move 是按手势分别归属，不是全局计数）。
dispatch("pointerdown", { pointerId: 9, clientX: 500, clientY: 500, button: 0, buttons: 1, target: node("perf-node-01") });
dispatch("pointermove", { pointerId: 9, clientX: 505, clientY: 500, buttons: 1, target: node("perf-node-01") });
dispatch("pointerup", { pointerId: 9, clientX: 505, clientY: 500, button: 0, buttons: 0, target: node("perf-node-01") });

// 没有按下的移动：进 hoverMoves 汇总，不进手势。
dispatch("pointermove", { pointerId: 1, clientX: 700, clientY: 700, buttons: 0, target: null });

// 一条落点记录（第七轮形状）。
(globalThis as any).__perfLogDropTarget({
    entry: "ordinary",
    clientX: 1170,
    clientY: 447,
    worldX: 980,
    worldY: 450,
    viewportX: 0,
    viewportY: 0,
    viewportK: 1,
    containerRect: { left: 100, top: 200, width: 300, height: 200 },
    target: { nodeId: "perf-node-20", handleId: null, anchorRatio: null, isNearNode: true },
    targetNodeId: "perf-node-20",
    targetHandleId: "",
    projectId: "perf300",
    nodeCount: 300,
    connectionCount: 150,
    ms: 0.4,
});

clickButton("perf-rec-stop");
const dump = dumps.at(-1);
const problems: string[] = [];
if (dump.gestures.length !== 2) problems.push(`gestures=${dump.gestures.length}，期望 2`);
const first = dump.gestures.find((item: any) => item.pointerId === 7);
const second = dump.gestures.find((item: any) => item.pointerId === 9);
if (!first || first.moveCount !== 3) problems.push(`pointerId=7 moveCount=${first?.moveCount}，期望 3`);
if (!first || first.firstMove?.x !== 1100 || first.lastMove?.x !== 1170) problems.push(`pointerId=7 首末=${first?.firstMove?.x}→${first?.lastMove?.x}，期望 1100→1170`);
if (!second || second.moveCount !== 1 || second.firstMove?.x !== 505) problems.push(`pointerId=9 首末未按手势归属`);
if (dump.hoverMoves.count !== 1) problems.push(`hoverMoves.count=${dump.hoverMoves.count}，期望 1`);
if (dump.inputs.filter((item: any) => item.type === "pointermove").length !== 0) problems.push("pointermove 不应进 inputs");
if (dump.connectStarts.length !== 1 || dump.connectStarts[0].rail !== "right") problems.push("connectStarts 形状不对");
const drop = dump.dropTargets[0];
for (const key of ["clientX", "worldX", "viewportK", "containerRect", "targetNodeId", "projectId", "nodeCount", "connectionCount", "recordMs"]) {
    if (!(key in drop)) problems.push(`落点记录缺字段 ${key}`);
}
if (drop.target.isNearNode !== true) problems.push("落点记录 target 不是完整返回值");
if (dump.summary.includes("手势内rAF=") === false) problems.push("汇总行缺手势内rAF");
// 整窗 4 帧（手势 A 的 3 次 tick + 末尾 1 次）；手势 A 的 down/up 落在 1000→1048，
// 手势 B 的 down/up 同在 1064，故 3 + 1 = 4 次 rAF 落在完整 down/up 区间内，
// 而计数标记帧只有 1 个 —— 两者必须分开（#101 第六轮复核第 4 节）。
if (dump.frames.length !== 4) problems.push(`整窗帧=${dump.frames.length}，期望 4`);
const gestureRaf = Number(/手势内rAF=(\d+)/.exec(dump.summary)?.[1] ?? -1);
if (gestureRaf !== 4) problems.push(`手势内rAF=${gestureRaf}，期望 4（与计数标记帧分开）`);
if (dump.frameDropTargets.filter((value: number) => value > 0).length !== 1) problems.push("计数标记帧应为 1");

const result = {
    probe: "perf-probe-round7.ts",
    gestures: dump.gestures.map((item: any) => ({ pointerId: item.pointerId, moveCount: item.moveCount, firstMove: item.firstMove, lastMove: item.lastMove, endType: item.endType })),
    hoverMoves: dump.hoverMoves,
    inputs: dump.inputs.map((item: any) => item.type),
    connectStarts: dump.connectStarts,
    dropTargetSample: drop,
    intervals: { 整窗帧: dump.frames.length, 手势内rAF: gestureRaf, 计数标记帧: dump.frameDropTargets.filter((value: number) => value > 0).length },
    problems,
    ok: problems.length === 0,
};
console.log(JSON.stringify(result, null, 2));
if (problems.length) process.exit(1);
