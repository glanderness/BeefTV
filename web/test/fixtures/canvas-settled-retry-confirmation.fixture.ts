import { mock } from "bun:test";
import { strict as assert } from "node:assert";

// 只验证「点重新生成时的付费确认」这一条：自动取回在后端被拒绝（取不回）后，
// 这类节点再新建任务必须先弹确认框。判定依据必须与自动取回一致（stage 或错误码）。
const confirmations: { onOk: () => void; afterClose: () => void }[] = [];
const infos: string[] = [];
const errors: string[] = [];
let recoveries = 0;

const react = await import("react");
const configStore = await import("@/stores/use-config-store");
mock.module("react", () => ({ ...react, default: react.default, useCallback: (fn: any) => fn, useRef: (value: any) => ({ current: value }) }));
mock.module("antd", () => ({ App: { useApp: () => ({ modal: { confirm: (input: any) => { confirmations.push(input); return { destroy: () => input.afterClose() }; } }, message: { error: (text: string) => errors.push(text), info: (text: string) => infos.push(text), warning() {}, success() {}, loading() { return { dismiss() {} }; } } }) } }));
// 只替换 hook 直接用的三个入口；其余导出保持真实，避免打断传递依赖（如渠道传输里的 isSystemProxyBaseUrl）。
mock.module("@/stores/use-config-store", () => ({ ...configStore, useEffectiveConfig: () => ({}), useConfigStore: (select: any) => select({ isAiConfigReady: () => true }), resolveModelRequestConfig: () => ({}) }));
mock.module("@/services/canvas-task-result-recovery", () => ({
    recoverCanvasTaskResult: async () => {
        recoveries += 1;
        return undefined;
    },
    waitForRecoveryRetry: async () => {},
}));

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

// 1. 原任务已终态、错误码是 submission_uncertain（stage 不是 submission_unknown）：
//    自动取回被拒后，重新生成必须先确认，取消则不新建任务。
const codeOnly = retry(settledNode({ taskStage: "任务失败", taskErrorCode: "submission_uncertain", generationErrorCode: "submission_uncertain", generationSubmissionState: "unknown" }));
await tick();
assert.equal(confirmations.length, 1, "取不回之后新建任务前必须弹付费确认");
assert.equal(recoveries, 1, "自动取回必须先尝试一次");
confirmations[0].afterClose();
await codeOnly;
assert.equal(infos.length, 1, "取消后应说明已保留原任务记录");
assert.equal(nodes[0].metadata.generationResultUnavailableTaskId, "task-settled", "取不回要记在被拒的任务上");
assert.deepEqual(errors, []);

// 2. stage 是 submission_unknown（错误码为空）走同一条确认路径。
const stageOnly = retry(settledNode({ taskStage: "submission_unknown" }));
await tick();
assert.equal(recoveries, 2, "自动取回必须先尝试一次");
assert.equal(confirmations.length, 2, "取不回之后新建任务前必须弹付费确认");
confirmations[1].afterClose();
await stageOnly;
assert.equal(infos.length, 2);

// 3. 已经确认取不回：不再重复取回，但仍然必须先确认。
const alreadyGone = retry(settledNode({ taskStage: "submission_unknown", generationErrorCode: "submission_uncertain", generationResultUnavailableTaskId: "task-settled" }));
await tick();
assert.equal(recoveries, 2, "已确认取不回时不再重复取回");
assert.equal(confirmations.length, 3, "新建任务前仍然必须先确认");
confirmations[2].afterClose();
await alreadyGone;
assert.equal(infos.length, 3);
assert.deepEqual(errors, []);

console.log("PASS: settled submission-uncertain retries always confirm before creating a task");
