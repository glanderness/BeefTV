import { mock } from "bun:test";
import { strict as assert } from "node:assert";

// 只验证「点重新生成时的付费确认」这一条：原结果已确认取不回后，这类节点再新建任务必须先弹确认框；
// 还没取过的节点交给恢复扫描自动取回，点重新生成也不新建任务。判定依据必须与自动取回一致（stage 或错误码）。
const confirmations: { onOk: () => void; afterClose: () => void }[] = [];
const infos: string[] = [];
const errors: string[] = [];

const react = await import("react");
const configStore = await import("@/stores/use-config-store");
mock.module("react", () => ({ ...react, default: react.default, useCallback: (fn: any) => fn, useRef: (value: any) => ({ current: value }) }));
mock.module("antd", () => ({ App: { useApp: () => ({ modal: { confirm: (input: any) => { confirmations.push(input); return { destroy: () => input.afterClose() }; } }, message: { error: (text: string) => errors.push(text), info: (text: string) => infos.push(text), warning() {}, success() {}, loading() { return { dismiss() {} }; } } }) } }));
// 只替换 hook 直接用的三个入口；其余导出保持真实，避免打断传递依赖（如渠道传输里的 isSystemProxyBaseUrl）。
mock.module("@/stores/use-config-store", () => ({ ...configStore, useEffectiveConfig: () => ({}), useConfigStore: (select: any) => select({ isAiConfigReady: () => true }), resolveModelRequestConfig: () => ({}) }));

const { useCanvasGenerationRetry } = await import("@/pages/canvas/use-canvas-generation-retry");

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
let nodes: any[] = [];

const settledNode = (metadata: Record<string, unknown>) => ({
    id: "image-1",
    type: "image",
    title: "image",
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata: { status: "error", taskId: "task-settled", taskStatus: "failed", prompt: "draw", ...metadata },
});

const retry = (node: any) => {
    nodes = [node];
    const hook = useCanvasGenerationRetry({
        projectId: "canvas",
        addedSkills: [],
        assets: [],
        nodesRef: { get current() { return nodes; } },
        connectionsRef: { current: [] },
        setNodes: (update: any) => { nodes = update(nodes); },
        setRunningNodeId: () => {},
        startGenerationRequest: (_id: string, _origin: string, _running?: string, controller = new AbortController()) => controller,
        finishGenerationRequest: () => {},
        bindGenerationTask: () => {},
        applyGenerationTaskResult: async () => {},
        regenerateImageBatch: async () => {},
    });
    return hook(node);
};

// 1. 原结果还没取过：交给恢复扫描自动取回，不弹确认、不新建任务。
await retry(settledNode({ taskStage: "任务失败", taskErrorCode: "submission_uncertain", generationErrorCode: "submission_uncertain", generationSubmissionState: "unknown" }));
assert.equal(confirmations.length, 0, "还没取过原结果时不能新建任务");
assert.equal(infos.length, 1, "应说明正在取回原结果");

// 2. 原结果已确认取不回、只有错误码是 submission_uncertain（stage 不是 submission_unknown）：新建任务前必须先确认。
const codeOnly = retry(settledNode({ taskStage: "任务失败", taskErrorCode: "submission_uncertain", generationErrorCode: "submission_uncertain", resourceReloadAvailable: false }));
await tick();
assert.equal(confirmations.length, 1, "取不回之后新建任务前必须弹付费确认");
confirmations[0].afterClose();
await codeOnly;
assert.equal(infos.length, 2, "取消后应说明已保留原任务记录");

// 3. stage 是 submission_unknown（错误码为空）走同一条确认路径。
const stageOnly = retry(settledNode({ taskStage: "submission_unknown", resourceReloadAvailable: false }));
await tick();
assert.equal(confirmations.length, 2, "取不回之后新建任务前必须弹付费确认");
confirmations[1].afterClose();
await stageOnly;
assert.equal(infos.length, 3);
assert.deepEqual(errors, []);

console.log("PASS: settled submission-uncertain retries always confirm before creating a task");
