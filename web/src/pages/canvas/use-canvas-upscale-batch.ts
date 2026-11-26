import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { channelHasGenerationCredential, isBuiltinBeefTVChannel, useConfigStore } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import { createDefaultUpscaleSettings, deriveUpscaleBatchState, getUpscaleInputNodes, getUpscaleOutputPosition, upscaleParamsForNode, upscaleSourceKey, isUpscaleItemSettled, type CanvasUpscaleBatchItem, type CanvasUpscaleQuote } from "@/lib/canvas/canvas-upscale";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { canCanvasNodeAcceptGenerationTask } from "@/lib/canvas/canvas-generation-task-identity";
import { isRegenerateAllowed, submissionUnknownTaskOutcome } from "@/lib/task-outcome";
import { mediaResultMetadata } from "@/lib/canvas/canvas-node-semantics";
import { createUpscaleTask, estimateUpscale } from "@/services/api/media-upscale";
import { findGenerationTaskByOperation, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { syncLocalCanvasSnapshot } from "@/services/local-workspace-sync";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasPageUiStoreHook } from "@/stores/canvas/use-canvas-page-ui-store";

type Dependencies = {
    pageUi: CanvasPageUiStoreHook;
    nodes?: CanvasNodeData[];
    projectId: string; nodesRef: { current: CanvasNodeData[] }; connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>; setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    observeTask: (task: GenerationTask, nodeId: string) => void;
    bindTask?: (task: GenerationTask, nodeId: string) => void;
};

export function useCanvasUpscaleBatch({pageUi,  projectId, nodes, nodesRef, connectionsRef, setNodes, setConnections, observeTask, bindTask }: Dependencies) {
    const locks = useRef(new Set<string>());
    const mounted = useRef(true);
    const lifetime = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; lifetime.current += 1; };
    }, []);
    const liveProject = useRef(projectId); liveProject.current = projectId;
    const startUpscaleBatch = useCallback(async (processor: CanvasNodeData, quotes?: CanvasUpscaleQuote[]) => {
        if (locks.current.has(processor.id)) return;
        locks.current.add(processor.id);
        const capturedLifetime = lifetime.current;
        let expectedBatchId = nodesRef.current.find(n => n.id === processor.id)?.metadata?.upscaleBatch?.id;
        const assertCurrent = () => {
            if (!mounted.current || lifetime.current !== capturedLifetime) throw new Error("画布已关闭，停止提交超分任务");
            if (liveProject.current !== projectId) throw new Error("画布已切换，停止提交超分任务");
            const live = nodesRef.current.find(n => n.id === processor.id);
            if (!live) throw new Error("超分节点已删除，停止提交任务");
            if (live.metadata?.upscaleBatch?.id !== expectedBatchId) throw new Error("超分批次已更换，停止提交旧批次");
        };
        const patch = (transform: (nodes: CanvasNodeData[]) => CanvasNodeData[]) => {
            assertCurrent();
            nodesRef.current = transform(nodesRef.current); setNodes(nodesRef.current);
            useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
        };
        // Store persistence emits ordinary canvas deltas; never race task.bind with a full snapshot sync.
        const save = async () => { assertCurrent(); await flushCanvasStorePersistence(); assertCurrent(); };
        const validateQuotedItems = (items: CanvasUpscaleBatchItem[]) => {
            const waiting = items.filter(item => item.status === "waiting");
            if (!waiting.length) throw new Error(items.find(item => item.error)?.error || "没有可提交的素材");
            if (!waiting.every(item => Number.isFinite(item.reservation) && item.reservation! > 0)) throw new Error("超分费用尚未确认，请重新获取");
        };
        const reviewQuote = async (source: CanvasNodeData, settings: ReturnType<typeof createDefaultUpscaleSettings>, savedParams?: CanvasUpscaleQuote["params"]) => {
            const reviewed = quotes?.find(quote => quote.sourceId === source.id && quote.sourceKey === upscaleSourceKey(source));
            if (!reviewed) throw new Error("请先获取完整的超分费用");
            const params = savedParams ?? upscaleParamsForNode(settings, source, reviewed.params.resourceId);
            if (JSON.stringify(params) !== JSON.stringify(reviewed.params)) throw new Error("超分参数已变更，请重新估价");
            const quote = await estimateUpscale(params);
            assertCurrent();
            if (quote.reservation !== reviewed.reservation) throw new Error("超分费用已变更，请重新估价后再提交");
            return { params, reservation: quote.reservation };
        };
        try {
            const current = nodesRef.current.find(n => n.id === processor.id);
            if (!current) throw new Error("超分节点已删除");
            let batch = current.metadata?.upscaleBatch;
            let rejectedRetryBlocked = false;
            // Only retry proven pre-admission failures once every paid sibling
            // is terminal and delivered. This checkpoint cannot race an active bind.
            if (batch?.items.some(i => i.status === "rejected" && !i.detachedResult) && batch.items.every(i => {
                if (i.status === "rejected") return !i.taskId;
                return isUpscaleItemSettled(i, nodesRef.current.find(n => n.id === i.outputNodeId)?.metadata);
            })) {
                const defaults = createDefaultUpscaleSettings();
                const settings = structuredClone({ ...defaults, ...current.metadata?.upscale, ...processor.metadata?.upscale,
                    image: { ...defaults.image, ...current.metadata?.upscale?.image, ...processor.metadata?.upscale?.image },
                    video: { ...defaults.video, ...current.metadata?.upscale?.video, ...processor.metadata?.upscale?.video },
                });
                const retried = structuredClone(batch);
                let foundReceipt = false;
                for (const item of retried.items.filter(i => i.status === "rejected" && !i.detachedResult)) {
                    const task = await findGenerationTaskByOperation(item.clientOperationId, projectId);
                    assertCurrent();
                    if (task) {
                        item.status = "accepted"; item.taskId = task.id; foundReceipt = true;
                        bindTask?.(task, item.outputNodeId); observeTask(task, item.outputNodeId);
                        continue;
                    }
                    const source = nodesRef.current.find(n => n.id === item.sourceNodeId);
                    if (!source) throw new Error("找不到原素材，无法重试");
                    const quote = await reviewQuote(source, settings, item.params);
                    Object.assign(item, quote, { status: "waiting", error: undefined, quotedAt: Date.now() });
                }
                // An unexpected receipt restores observation first; defer retries
                // until the next explicit click so no checkpoint races its bind.
                if (!foundReceipt) {
                    validateQuotedItems(retried.items);
                    batch = retried;
                    patch(nodes => nodes.map(n => {
                        if (n.id === current.id) return { ...n, metadata: { ...n.metadata, upscaleBatch: retried } };
                        const item = retried.items.find(i => i.outputNodeId === n.id && i.status === "waiting");
                        return item ? { ...n, metadata: { ...n.metadata, status: "loading", taskType: `canvas_${item.mediaType}`, generationSubmissionState: undefined, errorDetails: undefined, processingLabel: "等待超分提交", workflowOperation: { id: `${item.mediaType}.ai-upscale`, version: 1, config: { ...item.params }, inputs: [{ nodeId: item.sourceNodeId, port: item.mediaType }, { nodeId: current.id, port: "processor" }] } } } : n;
                    }));
                    await save();
                    await syncLocalCanvasSnapshot(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
                    assertCurrent();
                } else {
                    const reconciled = { ...batch, items: batch.items.map(i => {
                        const restored = retried.items.find(r => r.outputNodeId === i.outputNodeId && r.status === "accepted" && r.taskId);
                        return restored ?? i;
                    }) };
                    patch(nodes => nodes.map(n => n.id === current.id ? { ...n, metadata: { ...n.metadata, upscaleBatch: reconciled } } : n));
                    await save();
                    return;
                }
            } else if (batch?.items.some(i => i.status === "rejected" && !i.detachedResult)) {
                rejectedRetryBlocked = true;
            }
            if (!batch || deriveUpscaleBatchState(batch, nodesRef.current).canStartNewBatch) {
                if (!useConfigStore.getState().config.channels.some(channel => channel.enabled !== false && isBuiltinBeefTVChannel(channel) && channelHasGenerationCredential(channel))) throw new Error("暂无可用超分模型，请连接 BeefTV 内置的官方算力");
                const inputs = structuredClone(getUpscaleInputNodes(processor.id, nodesRef.current, connectionsRef.current));
                if (!inputs.length) throw new Error("请连接可读取的图片或视频");
                const defaults = createDefaultUpscaleSettings();
                const stored = current.metadata?.upscale;
                const passed = processor.metadata?.upscale;
                const settings = structuredClone({ ...defaults, ...stored, ...passed,
                    image: { ...defaults.image, ...stored?.image, ...passed?.image },
                    video: { ...defaults.video, ...stored?.video, ...passed?.video },
                });
                if (!settings.channelId) throw new Error("请选择超分渠道");
                if (quotes?.length !== inputs.length) throw new Error("素材列表已变更，请重新估价");
                const priced = await Promise.all(inputs.map(source => reviewQuote(source, settings)));
                const liveInputs = getUpscaleInputNodes(processor.id, nodesRef.current, connectionsRef.current);
                if (liveInputs.length !== inputs.length || liveInputs.some(live => !quotes.some(quote => quote.sourceKey === upscaleSourceKey(live)))) {
                    throw new Error("素材列表已变更，请重新估价");
                }
                const items: CanvasUpscaleBatchItem[] = inputs.map((source, index) => ({
                    sourceNodeId: source.id, sourceTitle: source.title || "素材", mediaType: source.type === CanvasNodeType.Video ? "video" : "image",
                    outputNodeId: nanoid(), clientOperationId: nanoid(), status: "waiting", ...priced[index], quotedAt: Date.now(),
                }));
                batch = { id: nanoid(), createdAt: Date.now(), items };
                const outputs: CanvasNodeData[] = [];
                const downstreamIds = new Set(connectionsRef.current.filter(c => c.fromNodeId === current.id).map(c => c.toNodeId));
                const reusable = nodesRef.current.filter(n => downstreamIds.has(n.id) && (n.type === CanvasNodeType.Image || n.type === CanvasNodeType.Video) && !n.metadata?.content && !n.metadata?.storageKey && !n.metadata?.taskId && !n.metadata?.taskClientOperationId && !n.metadata?.generationSubmissionState);
                for (const item of items) {
                    const source = inputs.find(n => n.id === item.sourceNodeId)!;
                    const emptyIndex = reusable.findIndex(n => n.type === source.type);
                    const empty = emptyIndex >= 0 ? reusable.splice(emptyIndex, 1)[0] : undefined;
                    if (empty) item.outputNodeId = empty.id;
                    const size = empty?.metadata?.manualSize ? { width: empty.width, height: empty.height } : fitNodeSize(source.metadata?.naturalWidth || source.width, source.metadata?.naturalHeight || source.height);
                    outputs.push({ ...empty, id: item.outputNodeId, type: source.type, title: `${item.sourceTitle} · AI超分`, position: empty?.position ?? getUpscaleOutputPosition(current, 0, [...nodesRef.current, ...outputs], size), ...size,
                        metadata: { ...empty?.metadata, ...mediaResultMetadata("derived", { status: item.status === "rejected" ? "error" : "loading", taskType: `canvas_${item.mediaType}`, generationSubmissionState: item.status === "rejected" ? "rejected" : undefined, errorDetails: item.error, processingLabel: "等待超分提交", generatedFromNodeId: source.id, generatedFromProcessingNodeId: current.id, generationMode: item.mediaType, taskClientOperationId: item.clientOperationId,
                            workflowOperation: { id: `${item.mediaType}.ai-upscale`, version: 1, config: { ...item.params }, inputs: [{ nodeId: source.id, port: item.mediaType }, { nodeId: current.id, port: "processor" }] } }) } });
                }
                const frozen = batch;
                connectionsRef.current = [...connectionsRef.current, ...items.filter(i => !downstreamIds.has(i.outputNodeId)).map(i => ({ id: nanoid(), fromNodeId: current.id, toNodeId: i.outputNodeId }))];
                setConnections(connectionsRef.current);
                patch(nodes => [...nodes.filter(n => !outputs.some(o => o.id === n.id)).map(n => n.id === current.id ? { ...n, metadata: { ...n.metadata, upscaleBatch: frozen } } : n), ...outputs]);
                expectedBatchId = frozen.id;
                await save();
                pageUi.getState().setSelectedNodeIds(new Set(items.map(i => i.outputNodeId)));
            }
            // Retry a failed initial save only after verifying that no operation
            // has been admitted. Once any receipt exists, task.bind owns results.
            if (batch.items.every(i => i.status === "waiting" || i.status === "rejected")) {
                const receipts = await Promise.all(batch.items.filter(i => i.status === "waiting").map(i => findGenerationTaskByOperation(i.clientOperationId, projectId)));
                assertCurrent();
                if (receipts.every(task => !task)) {
                    await syncLocalCanvasSnapshot(projectId, { nodes: nodesRef.current, connections: connectionsRef.current });
                    assertCurrent();
                }
            }
            const batchId = batch.id;
            const update = (item: CanvasUpscaleBatchItem, values: Partial<CanvasUpscaleBatchItem>) => {
                Object.assign(item, values);
                patch(nodes => nodes.map(n => n.id === processor.id && n.metadata?.upscaleBatch?.id === batchId ? { ...n, metadata: { ...n.metadata, upscaleBatch: { ...n.metadata.upscaleBatch, items: n.metadata.upscaleBatch.items.map(i => i.outputNodeId === item.outputNodeId ? { ...i, ...values } : i) } } } : n));
            };
            for (const original of batch.items) {
                if (original.detachedResult) continue;
                const item = { ...original };
                assertCurrent();
                if (!nodesRef.current.some(n => n.id === item.outputNodeId)) continue;
                if (item.status === "rejected") continue;
                if (item.status !== "waiting") {
                    try {
                        const rawTask = item.taskId ? await queryGenerationTask(item.taskId) : await findGenerationTaskByOperation(item.clientOperationId, projectId);
                        assertCurrent();
                        if (rawTask) {
                            const task = rawTask.clientOperationId ? rawTask : { ...rawTask, clientOperationId: item.clientOperationId };
                            update(item, { status: "accepted", taskId: task.id, error: undefined });
                            const liveOut = nodesRef.current.find(n => n.id === item.outputNodeId);
                            if (canCanvasNodeAcceptGenerationTask(liveOut, task)) {
                                bindTask?.(task, item.outputNodeId);
                                observeTask(task, item.outputNodeId);
                            }
                        }
                    } catch { /* Unknown receipts remain blocked; never infer permission to resubmit. */ }
                    assertCurrent();
                    continue;
                }
                // A durable backend batch can still say waiting after a lost receipt. Always
                // reconcile the same operation before dispatching a waiting item.
                let existing: GenerationTask | undefined;
                try {
                    existing = await findGenerationTaskByOperation(item.clientOperationId, projectId);
                    assertCurrent();
                } catch (cause) {
                    assertCurrent();
                    update(item, { status: "waiting", error: cause instanceof Error ? cause.message : "原任务查询失败，尚未提交，可继续查询原操作" });
                    continue;
                }
                if (existing) {
                    const task = existing.clientOperationId ? existing : { ...existing, clientOperationId: item.clientOperationId };
                    update(item, { status: "accepted", taskId: task.id, error: undefined });
                    const liveOut = nodesRef.current.find(n => n.id === item.outputNodeId);
                    if (canCanvasNodeAcceptGenerationTask(liveOut, task)) {
                        bindTask?.(task, item.outputNodeId);
                        observeTask(task, item.outputNodeId);
                    }
                    continue;
                }
                if (!item.params) { update(item, { status: "rejected", error: "缺少已冻结的提交参数，请重新配置新批次" }); continue; }
                if (!item.quotedAt || Date.now() - item.quotedAt > 60_000) {
                    update(item, { status: "rejected", error: "费用预估已过期，请重新获取报价" });
                    await save();
                    continue;
                }
                if (!useConfigStore.getState().config.channels.some(channel => channel.enabled !== false && isBuiltinBeefTVChannel(channel) && channelHasGenerationCredential(channel))) {
                    update(item, { status: "rejected", error: "暂无可用超分模型，请连接 BeefTV 内置的官方算力" });
                    await save();
                    continue;
                }
                update(item, { status: "submitting" });
                patch(nodes => nodes.map(n => n.id === item.outputNodeId && canCanvasNodeAcceptGenerationTask(n, { id: item.clientOperationId, clientOperationId: item.clientOperationId }) ? { ...n, metadata: { ...n.metadata, generationSubmissionState: "submitting" } } : n));
                // Persist the intent before POST. A crash from this point is uncertain, never waiting.
                await save();
                if (!canCanvasNodeAcceptGenerationTask(nodesRef.current.find(n => n.id === item.outputNodeId), { id: item.clientOperationId, clientOperationId: item.clientOperationId })) continue;
                try {
                    const created = await createUpscaleTask({ ...item.params, clientOperationId: item.clientOperationId, projectId, nodeId: item.outputNodeId });
                    const task = created.clientOperationId ? created : { ...created, clientOperationId: item.clientOperationId };
                    assertCurrent(); update(item, { status: "accepted", taskId: task.id, error: undefined });
                    if (canCanvasNodeAcceptGenerationTask(nodesRef.current.find(n => n.id === item.outputNodeId), task)) {
                        patch(nodes => nodes.map(n => n.id === item.outputNodeId && canCanvasNodeAcceptGenerationTask(n, task) ? { ...n, metadata: { ...n.metadata, taskId: task.id, taskStatus: task.status, generationSubmissionState: "accepted" } } : n));
                        bindTask?.(task, item.outputNodeId); observeTask(task, item.outputNodeId);
                    }
                } catch (cause) {
                    assertCurrent(); update(item, { status: "unknown", error: cause instanceof Error ? cause.message : "提交回执待确认" });
                    patch(nodes => nodes.map(n => n.id === item.outputNodeId && canCanvasNodeAcceptGenerationTask(n, { id: item.clientOperationId, clientOperationId: item.clientOperationId }) ? { ...n, metadata: { ...n.metadata, taskOutcome: submissionUnknownTaskOutcome(), errorDetails: "提交状态待确认，请查询原任务，暂勿重复提交" } } : n));
                }
                await save();
            }
            if (rejectedRetryBlocked) throw new Error("等待其他项完成后重试未提交项");
        } finally { locks.current.delete(processor.id); }
    }, [pageUi, projectId, nodesRef, connectionsRef, setNodes, setConnections, observeTask, bindTask]);
    const needsDetachedPolling = Boolean(nodes?.some(node => node.metadata?.upscaleBatch?.items.some(item =>
        !item.detachedResult && !nodes.some(output => output.id === item.outputNodeId),
    )));
    useEffect(() => {
        if (!needsDetachedPolling) return;
        const controller = new AbortController();
        const { signal } = controller;
        let polling = false;
        const poll = async () => {
            if (polling) return;
            polling = true;
            try {
                const live = nodesRef.current;
                const nodeIds = new Set(live.map(node => node.id));
                await Promise.all(live.flatMap(processor => {
                    const batch = processor.metadata?.upscaleBatch;
                    if (!batch || locks.current.has(processor.id)) return [];
                    return batch.items.filter(item => !item.detachedResult && !nodeIds.has(item.outputNodeId)).map(async item => {
                        try {
                            const task = item.taskId ? await queryGenerationTask(item.taskId, { signal })
                                : await findGenerationTaskByOperation(item.clientOperationId, projectId, signal);
                            if (signal.aborted || liveProject.current !== projectId || locks.current.has(processor.id)) return;
                            const current = nodesRef.current;
                            if (current.some(node => node.id === item.outputNodeId)) return;
                            const activeBatch = current.find(node => node.id === processor.id)?.metadata?.upscaleBatch;
                            const latest = activeBatch?.items.find(entry => entry.clientOperationId === item.clientOperationId);
                            if (activeBatch?.id !== batch.id || !latest || latest.detachedResult || latest.status !== item.status || latest.taskId !== item.taskId) return;
                            let detachedResult: CanvasUpscaleBatchItem["detachedResult"];
                            if (task?.status === "succeeded") detachedResult = "succeeded";
                            else if ((task?.status === "failed" || task?.status === "cancelled") && task.outcome?.phase !== "retrievable") {
                                detachedResult = isRegenerateAllowed(task.outcome) ? "restartable" : "failed";
                            } else if (!task && (item.status === "waiting" || item.status === "rejected")) detachedResult = "skipped";
                            if (!detachedResult && (!task || task.id === item.taskId)) return;
                            const nextBatch = { ...activeBatch, items: activeBatch.items.map(entry => entry === latest
                                ? { ...entry, ...(task ? { taskId: task.id, status: "accepted" as const } : {}), detachedResult } : entry) };
                            const updated = current.map(node => node.id === processor.id
                                ? { ...node, metadata: { ...node.metadata, upscaleBatch: nextBatch } } : node);
                            nodesRef.current = updated;
                            setNodes(updated);
                            useCanvasStore.getState().updateProject(projectId, { nodes: updated, connections: connectionsRef.current });
                        } catch { /* Keep the original operation pending until it can be queried again. */ }
                    });
                }));
            } finally { polling = false; }
        };
        void poll();
        const timer = setInterval(() => void poll(), 3000);
        return () => { clearInterval(timer); controller.abort(); };
    }, [needsDetachedPolling, projectId, nodesRef, connectionsRef, setNodes]);
    return { startUpscaleBatch, resumeUpscaleBatch: startUpscaleBatch };
}
