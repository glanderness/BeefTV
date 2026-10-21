import { useEffect, useRef, useState } from "react";
import { Alert, Button, Segmented, Spin } from "antd";
import { AppModal } from "@/components/ui/product/app-modal";
import { getUpscaleCapabilities, upscaleModel, type UpscaleCapabilities, type UpscaleParams } from "@/services/api/media-upscale";
import type { UpscaleQuote } from "@/lib/canvas/canvas-upscale";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { navigateToSettings } from "@/lib/settings-navigation";

const defaults: UpscaleParams = { variant: "precision", factor: 2, outputFormat: "png" };

export function CanvasNodeAIUpscaleDialog({
    nodes,
    onClose,
    onEstimate,
    onConfirm,
}: {
    nodes: CanvasNodeData[];
    onClose: () => void;
    onEstimate: (ids: string[], params: UpscaleParams, signal: AbortSignal) => Promise<UpscaleQuote>;
    onConfirm: (quote: UpscaleQuote) => void;
}) {
    const [params, setParams] = useState(defaults);
    const [capabilities, setCapabilities] = useState<UpscaleCapabilities | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [quote, setQuote] = useState<UpscaleQuote | null>(null);
    const [estimating, setEstimating] = useState(false);
    const request = useRef<AbortController | null>(null);
    const hasImages = nodes.some((node) => node.type === CanvasNodeType.Image);
    const hasVideos = nodes.some((node) => node.type === CanvasNodeType.Video);
    const signature = nodes.map((node) => `${node.id}:${node.metadata?.content}`).join("|");
    useEffect(() => {
        const controller = new AbortController();
        void getUpscaleCapabilities(controller.signal)
            .then(setCapabilities)
            .catch((error) => {
                if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "超分服务暂时无法连接");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => {
            controller.abort();
            request.current?.abort();
        };
    }, []);
    useEffect(() => {
        setQuote(null);
        request.current?.abort();
        setEstimating(false);
    }, [params, signature]);
    const supported = capabilities && [hasImages && "image", hasVideos && "video"].filter(Boolean).every((kind) => capabilities.supported_models?.some((model) => model.id === upscaleModel(kind as "image" | "video", params.variant)));
    const estimate = async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setEstimating(true);
        setError("");
        try {
            const result = await onEstimate(
                nodes.map((node) => node.id),
                params,
                controller.signal,
            );
            if (!controller.signal.aborted) setQuote(result);
        } catch (error) {
            if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "获取费用失败，请重试");
        } finally {
            if (!controller.signal.aborted) setEstimating(false);
        }
    };
    return (
        <AppModal title="AI 超分" open centered onCancel={onClose} footer={null} width="min(560px, calc(100vw - 24px))">
            <div className="space-y-5 py-2" data-canvas-no-zoom>
                <p className="text-sm text-muted-foreground">已选择 {nodes.length} 个素材。原素材会保留，每个结果保存为新的画布节点。</p>
                {loading ? (
                    <div role="status" className="flex items-center gap-2">
                        <Spin size="small" />
                        正在连接超分服务
                    </div>
                ) : null}
                {!loading && !capabilities ? <Button onClick={() => navigateToSettings({ continueCreation: true })}>前往算力设置</Button> : null}
                <div className="space-y-2">
                    <div className="text-sm font-medium">处理方式</div>
                    <Segmented
                        block
                        value={params.variant}
                        options={[
                            { label: "保真放大", value: "precision" },
                            { label: "细节重建", value: "generative" },
                        ]}
                        onChange={(variant) => setParams({ ...params, variant: variant as UpscaleParams["variant"] })}
                    />
                    <p className="text-xs text-muted-foreground">
                        {hasImages ? (params.variant === "precision" ? "图片：Topaz Standard V2。" : "图片：Topaz Wonder 3.5，低强度重建。") : ""}
                        {hasVideos ? (params.variant === "precision" ? "视频：Topaz Proteus。" : "视频：Topaz Starlight Fast 2。") : ""}
                    </p>
                </div>
                <div className="space-y-2">
                    <div className="text-sm font-medium">放大倍数</div>
                    <Segmented block value={params.factor} options={[1, 2, 3, 4].map((value) => ({ value, label: `${value}×` }))} onChange={(factor) => setParams({ ...params, factor: Number(factor) })} />
                    <p className="text-xs text-muted-foreground">{hasVideos && params.variant === "generative" ? "保持原始比例。视频结果的分辨率可能高于所选倍数。" : "宽和高分别放大，不改变原始比例。"}</p>
                </div>
                {hasImages ? (
                    <div className="space-y-2">
                        <div className="text-sm font-medium">图片格式</div>
                        <Segmented
                            value={params.outputFormat}
                            options={[
                                { value: "png", label: "PNG" },
                                { value: "jpeg", label: "JPEG" },
                            ]}
                            onChange={(outputFormat) => setParams({ ...params, outputFormat: outputFormat as "png" | "jpeg" })}
                        />
                    </div>
                ) : null}
                {hasVideos ? <p className="text-xs text-muted-foreground">支持 5 分钟以内的 MP4、MOV。结果为 MP4，保留原音轨，不补帧。</p> : null}
                {error ? <Alert type="error" showIcon message={error} /> : null}
                {!loading && capabilities && !supported ? <Alert type="warning" showIcon message="当前服务暂不支持所选模型，请稍后再试。" /> : null}
                {quote ? (
                    <div role="status" className="rounded-lg border border-border p-3 text-sm">
                        <div className="font-medium">预计预留 ¥{quote.reservation.toFixed(2)}</div>
                        <p className="mt-1 text-xs text-muted-foreground">完成后按实际用量结算，多退少补。</p>
                    </div>
                ) : null}
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>取消</Button>
                    <Button type="primary" loading={estimating} disabled={loading || !supported} onClick={() => (quote ? onConfirm(quote) : void estimate())}>
                        {quote ? `开始超分${nodes.length > 1 ? `（${nodes.length} 个）` : ""}` : "获取费用"}
                    </Button>
                </div>
            </div>
        </AppModal>
    );
}
