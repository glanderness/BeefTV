import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import { createClientId } from "@/lib/client-id";
import { captureUserScope, assertUserScope, userScopeMatches } from "@/lib/user-scope-guard";
import { runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { uploadResourceFile, resourceStorageKey } from "@/services/api/resources";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { estimateUpscale, runUpscaleTask, upscaleModel, type UpscaleMode, type UpscaleSource, type UpscaleParams } from "@/services/api/media-upscale";
import type { GenerationTask } from "@/services/api/task-center";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { generationErrorMessage } from "@/lib/generation-error";
import { isGenerationCanceled } from "@/lib/canvas/canvas-project-generation";
import { createUpscaleResultNodes, type QuotedUpscaleSource, type UpscaleQuote } from "@/lib/canvas/canvas-upscale";

type Options = {
    projectId: string;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    bindGenerationTask: (nodeId: string, task: GenerationTask) => void;
    applyGenerationTaskResult: (nodeId: string, task: GenerationTask) => Promise<void>;
    startGenerationRequest: (target: string, origin: string, runningId?: string) => AbortController;
    finishGenerationRequest: (target: string, controller: AbortController) => void;
};

function fingerprint(node: CanvasNodeData) {
    return JSON.stringify([node.type, node.metadata?.content, node.metadata?.storageKey, node.metadata?.bytes]);
}

export function useCanvasUpscale({ projectId, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, bindGenerationTask, applyGenerationTaskResult, startGenerationRequest, finishGenerationRequest }: Options) {
    const config = useEffectiveConfig();
    const epoch = useRef(0);
    const controllers = useRef(new Set<AbortController>());
    const submitted = useRef(new Set<string>());
    useEffect(
        () => () => {
            epoch.current++;
            for (const controller of controllers.current) controller.abort();
            controllers.current.clear();
        },
        [projectId],
    );

    const estimate = useCallback(
        async (ids: string[], params: UpscaleParams, signal?: AbortSignal): Promise<UpscaleQuote> => {
            const scope = captureUserScope();
            const session = epoch.current;
            const assertCurrent = () => {
                assertUserScope(scope);
                if (signal?.aborted || session !== epoch.current) throw new DOMException("操作已结束", "AbortError");
            };
            const sources: QuotedUpscaleSource[] = [];
            for (const id of ids) {
                assertCurrent();
                const node = nodesRef.current.find((item) => item.id === id);
                if (!node?.metadata?.content || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video)) throw new Error("请选择有内容的图片或视频");
                const original = fingerprint(node);
                const mode = node.type === CanvasNodeType.Image ? "image" : "video";
                const media = {
                    id: node.id,
                    name: node.title,
                    dataUrl: node.metadata.content,
                    url: node.metadata.content,
                    storageKey: node.metadata.storageKey,
                    type: node.metadata.mimeType || (mode === "image" ? "image/png" : "video/mp4"),
                    mimeType: node.metadata.mimeType,
                    width: node.metadata.naturalWidth,
                    height: node.metadata.naturalHeight,
                    bytes: node.metadata.bytes,
                    durationMs: node.metadata.durationMs,
                };
                let storageKey = media.storageKey;
                if (!storageKey?.startsWith("resource:")) {
                    let blob = storageKey ? await (mode === "image" ? getImageBlob(storageKey) : getMediaBlob(storageKey)) : null;
                    if (!blob) {
                        const resolved = await (mode === "image" ? resolveImageUrl(storageKey, media.url) : resolveMediaUrl(storageKey, media.url));
                        const response = await fetch(resolved, { signal, credentials: "omit" });
                        if (!response.ok) throw new Error("素材无法读取，请重新导入");
                        blob = await response.blob();
                    }
                    assertCurrent();
                    const resource = await uploadResourceFile(blob, mode, { fileName: node.title });
                    storageKey = resourceStorageKey(resource.id);
                }
                assertCurrent();
                const current = nodesRef.current.find((item) => item.id === id);
                if (!current || fingerprint(current) !== original) throw new Error("素材已变化，请重新获取费用");
                const source: UpscaleSource = { id, name: node.title, storageKey, mimeType: media.mimeType, type: media.type, bytes: media.bytes, width: media.width, height: media.height, durationMs: media.durationMs };
                const linked = await ensureCanvasNodeAsset({
                    canvasId: projectId,
                    domainProjectId: useCanvasStore.getState().openProject(projectId)?.projectId,
                    node: { ...current, metadata: { ...current.metadata, storageKey: source.storageKey } },
                    source: "canvas-manual",
                    signal,
                    expectedScope: scope,
                });
                assertCurrent();
                if (!linked.confirmed) throw new Error("素材尚未保存完成，请稍后重试");
                const latest = nodesRef.current.find((item) => item.id === id);
                if (!latest || fingerprint(latest) !== original) throw new Error("素材已变化，请重新获取费用");
                const patch = (item: CanvasNodeData) => (item.id === id ? { ...item, metadata: { ...item.metadata, storageKey: source.storageKey, assetId: linked.assetId } } : item);
                nodesRef.current = nodesRef.current.map(patch);
                setNodes((items) => items.map(patch));
                const expected = fingerprint(patch(current));
                const quote = await estimateUpscale(mode, source, params, signal);
                assertCurrent();
                if (quote.model !== upscaleModel(mode, params.variant) || quote.currency !== "CNY" || !Number.isFinite(quote.reservation) || quote.reservation <= 0 || quote.generation_submitted !== false) throw new Error("费用预估未能确认，请重试");
                sources.push({ nodeId: id, fingerprint: expected, mode, source, reservation: quote.reservation });
            }
            if (!sources.length) throw new Error("请选择图片或视频");
            return { id: createClientId(), projectId, epoch: session, scope, params: { ...params }, sources, reservation: sources.reduce((sum, item) => sum + item.reservation, 0) };
        },
        [projectId, nodesRef, setNodes],
    );

    const start = useCallback(
        async (quote: UpscaleQuote) => {
            assertUserScope(quote.scope);
            if (quote.projectId !== projectId || quote.epoch !== epoch.current) throw new Error("画布已切换，请重新获取费用");
            if (submitted.current.has(quote.id)) return;
            const origins = quote.sources.map((item) => {
                const node = nodesRef.current.find((node) => node.id === item.nodeId);
                if (!node || fingerprint(node) !== item.fingerprint) throw new Error("素材已变化，请重新获取费用");
                return node;
            });
            submitted.current.add(quote.id);
            const targets = createUpscaleResultNodes(origins, nodesRef.current, quote.params.factor);
            const nextNodes = [...nodesRef.current, ...targets];
            const nextConnections = [...connectionsRef.current, ...targets.map((node, index) => ({ id: nanoid(), fromNodeId: origins[index].id, toNodeId: node.id }))];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            useCanvasStore.getState().updateProject(projectId, { nodes: nextNodes, connections: nextConnections });
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set(targets.map((node) => node.id)));
            await Promise.allSettled(
                targets.map(async (target, index) => {
                    const item = quote.sources[index];
                    const controller = startGenerationRequest(target.id, item.nodeId, target.id);
                    controllers.current.add(controller);
                    try {
                        await runCanvasGenerationTaskToConsumer(
                            { projectId, nodeId: target.id, mode: item.mode, prompt: "AI 超分", config, signal: controller.signal, expectedScope: quote.scope, clientOperationId: createClientId() },
                            {
                                onSubmission: (metadata) => {
                                    const patch = (node: CanvasNodeData) => (node.id === target.id ? { ...node, metadata: { ...node.metadata, ...metadata } } : node);
                                    nodesRef.current = nodesRef.current.map(patch);
                                    setNodes((nodes) => nodes.map(patch));
                                },
                                bindTask: (task) => bindGenerationTask(target.id, task),
                                consumeTask: (task) => applyGenerationTaskResult(target.id, task),
                                isCurrent: () => quote.epoch === epoch.current && userScopeMatches(quote.scope),
                                runTask: (options) =>
                                    runUpscaleTask({
                                        projectId,
                                        nodeId: target.id,
                                        mode: item.mode,
                                        source: item.source,
                                        params: quote.params,
                                        signal: controller.signal,
                                        expectedScope: quote.scope,
                                        clientOperationId: options.clientOperationId!,
                                        onTaskCreated: options.onTaskCreated,
                                    }),
                            },
                        );
                    } catch (error) {
                        if (!isGenerationCanceled(error) && quote.epoch === epoch.current && userScopeMatches(quote.scope))
                            setNodes((nodes) => nodes.map((node) => (node.id === target.id ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: generationErrorMessage(error) } } : node)));
                    } finally {
                        controllers.current.delete(controller);
                        finishGenerationRequest(target.id, controller);
                    }
                }),
            );
        },
        [projectId, nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, startGenerationRequest, finishGenerationRequest, config, bindGenerationTask, applyGenerationTaskResult],
    );
    return { estimateUpscale: estimate, startUpscale: start };
}
