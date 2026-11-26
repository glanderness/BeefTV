import { useContext, useId, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Select } from "antd";
import { ArrowUp, LoaderCircle, WandSparkles } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { createDefaultUpscaleSettings, deriveUpscaleBatchState, upscaleParamsForNode, upscaleSourceKey } from "@/lib/canvas/canvas-upscale";
import { canRecoverUpscaleNode } from "@/lib/canvas/canvas-ai-upscale-task";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { channelHasGenerationCredential, isBuiltinBeefTVChannel, useEffectiveConfig } from "@/stores/use-config-store";
import { ApiError, getTransportFailureKind } from "@/services/api/request";
import { estimateUpscale, getUpscaleCapabilities } from "@/services/api/media-upscale";
import { useCanvasNodeActions } from "../canvas-node-action-context";
import { CanvasNodeGraphContext, useUpstreamNodes } from "../canvas-node-graph-context";

const resolutions = [
    { label: "720P", value: 720 },
    { label: "1080P", value: 1080 },
    { label: "2K", value: 1440 },
    { label: "4K", value: 2160 },
];
const videoPreset = "tencent-video-enhance-seedance2";
const imagePreset = "topaz-standard-v2";
const mayRetry = (failures: number, error: Error) =>
    failures < 1 && error instanceof ApiError && (error.retryable || Boolean(getTransportFailureKind(error)));

export function UpscaleNodePanel({ node, theme, readOnly = false }: { node: CanvasNodeData; theme: CanvasTheme; readOnly?: boolean }) {
    const actions = useCanvasNodeActions();
    const { getNode } = useContext(CanvasNodeGraphContext);
    const videoResolutionId = useId();
    const imageSizeId = useId();
    const upstream = useUpstreamNodes(node.id);
    const inputs = [...new Map(upstream.filter(item =>
        (item.type === CanvasNodeType.Image || item.type === CanvasNodeType.Video) &&
        item.metadata?.status !== "loading" && Boolean(item.metadata?.storageKey || item.metadata?.content),
    ).map(item => [item.id, item])).values()];
    const images = inputs.filter(item => item.type === CanvasNodeType.Image);
    const videos = inputs.filter(item => item.type === CanvasNodeType.Video);
    const config = useEffectiveConfig();
    const connected = config.channels.some(channel => channel.enabled !== false && isBuiltinBeefTVChannel(channel) && channelHasGenerationCredential(channel));
    const capabilities = useQuery({
        queryKey: ["media-upscale", "capabilities"],
        queryFn: ({ signal }) => getUpscaleCapabilities(signal),
        enabled: connected && !readOnly,
        retry: mayRetry,
    });
    const imageMode = capabilities.data?.modes.find(mode => mode.mediaType === "image" && mode.mode === "precision" &&
        (mode.models.includes(imagePreset) || mode.models.includes("Standard V2")))
        ?? capabilities.data?.modes.find(mode => mode.mediaType === "image" && mode.mode === "precision" && mode.models.length > 0)
        ?? capabilities.data?.modes.find(mode => mode.mediaType === "image" && mode.models.length > 0);
    const videoMode = capabilities.data?.modes.find(mode => mode.mediaType === "video" && mode.mode === "generative" && mode.models.includes(videoPreset))
        ?? capabilities.data?.modes.find(mode => mode.mediaType === "video" && mode.modelOptions?.some(opt => opt.billingMode === "mps_video_seconds"))
        ?? capabilities.data?.modes.find(mode => mode.mediaType === "video" && mode.mode === "generative" && mode.models.length > 0)
        ?? capabilities.data?.modes.find(mode => mode.mediaType === "video" && mode.models.length > 0);
    const resolvedImageModel = imageMode?.models.includes(imagePreset) ? imagePreset
        : imageMode?.models.includes("Standard V2") ? "Standard V2"
        : imageMode?.modelOptions?.[0]?.id || imageMode?.models[0] || "Standard V2";
    const resolvedVideoModelOption = videoMode?.modelOptions?.find(opt => opt.id === videoPreset)
        ?? videoMode?.modelOptions?.find(opt => opt.billingMode === "mps_video_seconds")
        ?? videoMode?.modelOptions?.[0];
    const resolvedVideoModel = videoMode?.models.includes(videoPreset) ? videoPreset
        : resolvedVideoModelOption?.id || videoMode?.models[0] || videoPreset;
    const videoSupportsTargetShortEdge = resolvedVideoModelOption?.billingMode === "mps_video_seconds";
    const saved = node.metadata?.upscale || createDefaultUpscaleSettings();
    const defaultTarget = videos.length ? Math.max(720, ...videos.map(video => {
        const width = video.metadata?.naturalWidth || 0;
        const height = video.metadata?.naturalHeight || 0;
        if (!width || !height) return 1080;
        const desired = Math.round(Math.min(width, height) * saved.scale);
        return resolutions.find(item => item.value >= desired)?.value ?? 2160;
    })) : undefined;
    const settings = {
        ...saved,
        channelId: "beeftv",
        videoTargetShortEdge: videoSupportsTargetShortEdge ? (saved.videoTargetShortEdge ?? defaultTarget) : undefined,
        video: { mode: videoMode?.mode ?? ("generative" as const), model: resolvedVideoModel },
        image: {
            mode: imageMode?.mode ?? ("precision" as const),
            model: resolvedImageModel,
            outputFormat: imageMode?.outputFormats.includes("png") ? "png" : (imageMode?.outputFormats[0] || "png"),
        },
    };
    const patch = (change: Partial<typeof settings>) => actions.updateMetadata?.(node.id, { upscale: { ...settings, ...change } });
    const modelAvailable = (!videos.length || videoMode) && (!images.length || imageMode);
    const batch = node.metadata?.upscaleBatch;
    const outputs = (batch?.items || []).flatMap(item => {
        const output = getNode?.(item.outputNodeId);
        return output ? [output] : [];
    });
    const batchState = deriveUpscaleBatchState(batch, outputs);
    const resuming = !batchState.canStartNewBatch;
    const rejected = batch?.items.filter(item => item.status === "rejected" && !item.taskId && !item.detachedResult) ?? [];
    const canRetryBatch = !batchState.running && rejected.length > 0;
    const quoteInputs = canRetryBatch
        ? rejected.map(item => ({ source: getNode?.(item.sourceNodeId), savedParams: item.params }))
        : inputs.map(source => ({ source, savedParams: undefined }));
    const prepareResource = actions.prepareUpscaleResource;
    const quote = useQuery({
        queryKey: ["media-upscale", "quote", settings, quoteInputs.map(({ source, savedParams }) => [source && upscaleSourceKey(source), savedParams])],
        queryFn: async ({ signal }) => Promise.all(quoteInputs.map(async ({ source, savedParams }) => {
            if (!source) throw new Error("找不到原素材，无法估价");
            if (!prepareResource) throw new Error("暂时无法准备超分素材");
            const params = savedParams ?? upscaleParamsForNode(settings, source, await prepareResource(source));
            signal.throwIfAborted();
            const estimate = await estimateUpscale(params, signal);
            return { sourceId: source.id, sourceKey: upscaleSourceKey(source), params, reservation: estimate.reservation };
        })),
        enabled: !readOnly && connected && Boolean(prepareResource) && quoteInputs.length > 0
            && (canRetryBatch || (!resuming && Boolean(modelAvailable))),
        retry: false,
        staleTime: 30_000,
    });
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const recoverable = outputs.filter(canRecoverUpscaleNode);
    const run = async (recover = false) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setNotice("");
        try {
            if (recover) {
                for (const output of recoverable) await actions.recoverUpscaleResult?.(output);
            } else {
                if (!resuming) patch({});
                await actions.startUpscaleBatch?.({ ...node, metadata: { ...node.metadata, upscale: settings } }, quote.data);
            }
        } catch (cause) {
            setNotice(cause instanceof Error ? cause.message : "处理失败，请查看原任务状态");
            if (!resuming || canRetryBatch) void quote.refetch();
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    const imageSize = images.length === 1 ? images[0].metadata : undefined;
    const imageScales = (imageMode?.scales || [1, 2, 3, 4]).map(value => {
        if (!imageSize?.naturalWidth || !imageSize.naturalHeight) {
            return { value, label: ["原始尺寸", "高清", "超清", "最大尺寸"][value - 1] };
        }
        const width = imageSize.naturalWidth * value;
        const height = imageSize.naturalHeight * value;
        const longEdge = Math.max(width, height);
        return {
            value,
            label: longEdge < 1024 ? `${longEdge} px` : `${Number((longEdge / 1024).toFixed(2))}K`,
            title: `${width} × ${height}`,
        };
    });
    const actionLabel = !resuming ? (batchState.total ? "开始新批次" : "开始批量超分")
        : batchState.running ? "继续 / 查询批次" : canRetryBatch ? "重试未提交项" : "查询原批次";
    const reservation = quote.data?.reduce((sum, item) => sum + item.reservation, 0);
    const modelError = capabilities.isError || Boolean(capabilities.data && !modelAvailable);
    const status = (!connected && !readOnly ? "请连接 BeefTV 官方算力" : "")
        || (!inputs.length ? "从左侧连接图片或视频" : "")
        || (resuming && !canRetryBatch ? `已完成 ${batchState.succeeded}/${batchState.total}${batchState.failed ? ` · ${batchState.failed} 项失败` : ""}` : "")
        || (modelError ? "暂时无法加载超分模型" : "")
        || (capabilities.isFetching ? "正在加载超分模型…" : "")
        || (quote.isFetching ? "正在估价…" : "")
        || (quote.error?.message ?? "")
        || (reservation !== undefined ? `预计先扣 ¥${reservation.toFixed(2)}` : "提交前获取费用");
    const submitDisabled = busy || !actions.startUpscaleBatch
        || ((!resuming || canRetryBatch) && (!connected || !quote.data?.length || quote.isFetching || quote.isError))
        || (!resuming && (!inputs.length || !modelAvailable));
    const showVideo = videos.length > 0;
    const statusIsError = notice || quote.isError || modelError;
    return (
        <section aria-label="画质提升参数"
            className="canvas-node-composer canvas-node-composer--libtv canvas-node-composer-type flex flex-col gap-2.5"
            style={{ background: theme.node.panel, color: theme.node.text, boxShadow: theme.node.shadow,
                "--canvas-composer-surface": theme.node.panel, "--canvas-composer-control-surface": theme.toolbar.itemHover } as CSSProperties}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
                <span style={{ color: theme.node.muted }}>模型</span>
                <div className="flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium" style={{ background: theme.toolbar.itemHover }}>
                    <WandSparkles aria-hidden className="size-3.5 shrink-0" />
                    <span>BeefTV超分模型</span>
                </div>
                {showVideo && videoSupportsTargetShortEdge ? <>
                    <label htmlFor={videoResolutionId} style={{ color: theme.node.muted }}>分辨率</label>
                    <Select id={videoResolutionId} aria-label="输出清晰度" size="small"
                        disabled={readOnly || busy || resuming}
                        options={resolutions.map((resolution, index) => ({ ...resolution, disabled: videos.some(video => {
                            const short = Math.min(video.metadata?.naturalWidth || 0, video.metadata?.naturalHeight || 0);
                            return short > 0 && (short > resolution.value || short * 4 <= (resolutions[index - 1]?.value ?? 0));
                        }) }))}
                        value={settings.videoTargetShortEdge} onChange={videoTargetShortEdge => patch({ videoTargetShortEdge })} />
                </> : null}
                {images.length ? <>
                    <label htmlFor={imageSizeId} style={{ color: theme.node.muted }}>图片尺寸</label>
                    <Select id={imageSizeId} aria-label="图片输出尺寸" size="small" value={settings.scale}
                        options={imageScales} disabled={readOnly || busy || resuming} onChange={scale => patch({ scale })} />
                </> : null}
            </div>
            <footer className="flex min-w-0 items-center justify-end gap-2">
                <span role={statusIsError ? "alert" : "status"} className="min-w-0 flex-1 break-words tabular-nums" style={{ color: theme.node.muted }}>{notice ? `${notice} · ${status}` : status}</span>
                {!readOnly && modelError && connected ? <Button size="small" onClick={() => void capabilities.refetch()}>重试加载模型</Button> : null}
                {!readOnly && quote.isError ? <Button size="small" onClick={() => void quote.refetch()}>重新估价</Button> : null}
                {!readOnly && recoverable.length ? <Button size="small" disabled={busy} onClick={() => void run(true)}>取回结果</Button> : null}
                {!readOnly ? <Button type="text" className="canvas-node-composer-submit canvas-node-composer-submit-canvas"
                    aria-label={actionLabel} title={actionLabel} disabled={submitDisabled} aria-busy={busy || undefined}
                    style={{ "--canvas-composer-submit-action": submitDisabled ? theme.toolbar.itemHover : theme.node.activeStroke,
                        "--canvas-composer-submit-action-fg": submitDisabled ? theme.node.faint : theme.canvas.background } as CSSProperties}
                    onClick={() => void run()}>
                    <span className="canvas-node-composer-submit-action" aria-hidden>
                        {busy ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <ArrowUp className="size-3.5" strokeWidth={2.4} />}
                    </span>
                </Button> : null}
            </footer>
        </section>
    );
}
