import { useEffect, useMemo, useState } from "react";
import { AppModal } from "@/components/ui/product/app-modal";
import { imageQualityLabel } from "@/components/image-settings-panel";
import { X } from "lucide-react";
import { getNodeLabel } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasImageHistoryItem, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { configuredModelDisplayName } from "@/lib/model-selection";
import { formatImageRatio, formatMimeShort } from "@/lib/image-display-format";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { ASSET_CATEGORY_OPTIONS, type AssetCategory } from "@/lib/asset-category";
import { resolveActiveCanvasImageHistoryItem } from "@/lib/canvas/canvas-image-history";
import { canvasNodeAssetCategory } from "@/lib/canvas/canvas-node-asset";
import { formatBytes, formatDuration, getDataUrlByteSize } from "@/lib/image-utils";
import { GenerationFailureNotice } from "@/components/generation/generation-failure-notice";
import { explainGenerationError } from "@/lib/generation-error";
import { canvasNodeDiagnosticContext } from "@/services/diagnostics/canvas-media-diagnostics";
import { readNodeLiveTaskTelemetry } from "@/stores/use-generation-task-telemetry";

import "./canvas-node-info-modal.css";

export function CanvasNodeInfoModal({
    node,
    open,
    onClose,
    onMetadataChange,
    readOnly = false,
    onUnauthorized,
}: {
    node: CanvasNodeData | null;
    open: boolean;
    onClose: () => void;
    onMetadataChange?: (nodeId: string, metadata: Partial<CanvasNodeMetadata>) => void;
    readOnly?: boolean;
    onUnauthorized?: () => void;
}) {
    const activeTheme = useActiveTheme();
    const config = useConfigStore((state) => state.config);
    const [assetTags, setAssetTags] = useState<string[]>([]);
    const [assetTagInput, setAssetTagInput] = useState("");
    const [assetCategory, setAssetCategory] = useState<AssetCategory>("other");
    const batchCount = node?.type === CanvasNodeType.Image ? node.metadata?.batchChildIds?.length || 0 : 0;
    const activeImageHistoryItem = useMemo(() => resolveActiveCanvasImageHistoryItem(node), [node]);
    const displayPrompt = activeImageHistoryItem?.prompt ?? node?.metadata?.prompt;
    const generationRows = useMemo(() => (node ? nodeGenerationRows(node, config, activeImageHistoryItem) : []), [activeImageHistoryItem, config, node]);
    useEffect(() => {
        setAssetTags(node?.metadata?.assetTags || []);
        setAssetTagInput("");
        setAssetCategory(node ? canvasNodeAssetCategory(node) : "other");
    }, [node?.id, node?.metadata?.assetCategory, node?.metadata?.assetTags]);

    const saveAssetCategory = (category: AssetCategory) => {
        if (readOnly) {
            onUnauthorized?.();
            return;
        }
        if (!node || node.type !== CanvasNodeType.Image) return;
        setAssetCategory(category);
        onMetadataChange?.(node.id, { assetCategory: category });
    };

    const saveAssetTags = (nextTags: string[]) => {
        if (readOnly) {
            onUnauthorized?.();
            return;
        }
        if (!node || node.type !== CanvasNodeType.Image) return;
        const tags = Array.from(new Set(nextTags.map((item) => item.trim()).filter(Boolean)));
        setAssetTags(tags);
        onMetadataChange?.(node.id, { assetTags: tags });
    };

    const addAssetTag = () => {
        const tags = assetTagInput
            .split(/\n|,|，/)
            .map((item) => item.trim())
            .filter(Boolean);
        if (!tags.length) return;
        saveAssetTags([...assetTags, ...tags]);
        setAssetTagInput("");
    };

    const removeAssetTag = (tag: string) => {
        saveAssetTags(assetTags.filter((item) => item !== tag));
    };

    if (!node) return null;

    const metadata = node.metadata;
    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const width = activeImageHistoryItem?.naturalWidth ?? metadata?.naturalWidth;
    const height = activeImageHistoryItem?.naturalHeight ?? metadata?.naturalHeight;
    const bytes = isImage || isVideo ? activeImageHistoryItem?.bytes || metadata?.bytes || (metadata?.content?.startsWith("data:") ? getDataUrlByteSize(metadata.content) : 0) : 0;
    const format = isImage
        ? formatMimeShort(activeImageHistoryItem?.mimeType ?? metadata?.mimeType, activeImageHistoryItem?.content ?? metadata?.content)
        : isVideo ? metadata?.mimeType?.match(/^video\/(?:x-)?([\w-]+)/i)?.[1]?.toUpperCase() || formatMimeShort(undefined, metadata?.content) : "";
    const status = metadata?.status || "idle";
    const rows = [
        ...((isImage || isVideo) && width && height ? [{ label: isImage ? "原图尺寸" : "视频尺寸", value: `${width} × ${height} px` }] : []),
        ...(bytes || format ? [{ label: "文件", value: [formatBytes(bytes), format].filter(Boolean).join(" · ") }] : []),
        ...(isVideo && metadata?.durationMs && Number.isFinite(metadata.durationMs) ? [{ label: "视频时长", value: formatDuration(metadata.durationMs) }] : []),
        ...(batchCount > 1 ? [{ label: "图片组", value: `${batchCount} 张` }] : []),
        ...generationRows,
    ];
    const title = (
        <div className="inspector-title">
            <span>节点信息</span>
            <span className="inspector-name">{node.title || getNodeLabel(node.type)}</span>
            <span className="inspector-status" data-status={status}>{statusLabels[status]}</span>
        </div>
    );

    return (
        <AppModal flush className={`canvas-node-info-modal ${activeTheme === "light" ? "is-light" : "is-dark"}`} title={title} open={open} footer={null} onCancel={onClose} width="min(640px, calc(100vw - 24px))">
            <div className="inspector-body thin-scrollbar" data-canvas-wheel-scroll>
                {rows.length > 0 && (
                    <section>
                        <h3>{isImage ? "图片信息" : isVideo ? "视频信息" : "生成信息"}</h3>
                        <dl className="inspector-facts">
                            {rows.map(({ label, value }) => <InfoRow key={label} label={label} value={value} />)}
                        </dl>
                    </section>
                )}
                {displayPrompt && (
                    <section>
                        <h3>提示词</h3>
                        <p className="inspector-text">{displayPrompt}</p>
                    </section>
                )}
                {node.type === CanvasNodeType.Skill && metadata?.skillSnapshot && (
                    <section>
                        <h3>技能模板</h3>
                        <p className="inspector-text">{metadata.skillSnapshot.template}</p>
                        {metadata.skillSnapshot.outputContract && <>
                            <h3>输出约束</h3>
                            <p className="inspector-text">{metadata.skillSnapshot.outputContract}</p>
                        </>}
                    </section>
                )}
                {isImage && (
                    <section>
                        <h3>项目资产</h3>
                        <div className="inspector-field">
                            <span>分类</span>
                            <div className="canvas-node-inspector-options" role="group" aria-label="项目资产分类">
                                {ASSET_CATEGORY_OPTIONS.map(({ value, label }) => (
                                    <button key={value} type="button" disabled={readOnly} aria-pressed={assetCategory === value} onClick={() => saveAssetCategory(value)}>{label}</button>
                                ))}
                            </div>
                        </div>
                        <div className="inspector-field">
                            <span>标签</span>
                            <div className="inspector-tag-field">
                                {!readOnly && (
                                    <form className="canvas-node-inspector-tag-editor" onSubmit={(event) => { event.preventDefault(); addAssetTag(); }}>
                                        <input aria-label="资产标签" value={assetTagInput} onChange={(event) => setAssetTagInput(event.target.value)} placeholder="输入标签，按回车添加" />
                                        <button type="submit" disabled={!assetTagInput.trim()}>添加</button>
                                    </form>
                                )}
                                {assetTags.length > 0 && (
                                    <ul className="inspector-tags">{assetTags.map((tag) => (
                                        <li key={tag}>{tag}{!readOnly && <button type="button" aria-label={`移除标签 ${tag}`} onClick={() => removeAssetTag(tag)}><X size={12} /></button>}</li>
                                    ))}</ul>
                                )}
                                {readOnly && <p className="canvas-node-inspector-notice">分享画布为只读，标签无法编辑。</p>}
                            </div>
                        </div>
                    </section>
                )}
                {node.metadata?.errorDetails ? (
                    <section className="canvas-node-inspector-error">
                        <GenerationFailureNotice
                            explanation={explainGenerationError(
                                { code: node.metadata.generationErrorCode || node.metadata.taskErrorCode, message: node.metadata.errorDetails },
                                { taskId: node.metadata.taskId, model: node.metadata.model, createdAt: node.metadata.taskCreatedAt, stage: node.metadata.taskStage },
                            )}
                            context={{ ...canvasNodeDiagnosticContext(node), model: node.metadata.model, createdAt: node.metadata.taskCreatedAt, stage: node.metadata.taskStage, providerRequestId: node.metadata.taskProviderRequestId, failureDiagnostics: node.metadata.taskFailureDiagnostics, errorSummary: node.metadata.generationErrorSummary, providerCode: node.metadata.generationProviderCode, completedAt: node.metadata.taskCompletedAt, updatedAt: node.metadata.taskUpdatedAt }}
                        />
                    </section>
                ) : null}
                <details key={node.id} className="inspector-details">
                    <summary>画布信息</summary>
                    <dl className="inspector-facts">
                        <InfoRow label="节点类型" value={getNodeLabel(node.type)} />
                        <InfoRow label="节点尺寸" value={`${Math.round(node.width)} × ${Math.round(node.height)}`} />
                        <InfoRow label="画布位置" value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                        <InfoRow label="节点 ID" value={node.id} />
                    </dl>
                </details>
            </div>
        </AppModal>
    );
}

const statusLabels = { idle: "就绪", success: "已完成", loading: "处理中", error: "失败" };

function InfoRow({ label, value }: { label: string; value: string }) {
    return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function nodeGenerationRows(node: CanvasNodeData, config: AiConfig, activeImageItem?: CanvasImageHistoryItem | null) {
    const metadata = node.metadata;
    if (!metadata) return [] as Array<{ label: string; value: string }>;
    const rows: Array<{ label: string; value: string }> = [];
    const add = (label: string, value: unknown) => {
        if (value === undefined || value === null || value === "") return;
        rows.push({ label, value: String(value) });
    };
    const addTime = (label: string, value?: string) => {
        if (!value) return;
        const timestamp = Date.parse(value);
        add(label, Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value);
    };
    const addDuration = (value?: number) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        const totalSeconds = Math.max(0, Math.round(value / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        add("耗时", minutes ? `${minutes}分 ${seconds}秒` : `${seconds}秒`);
    };

    const model = activeImageItem?.model ?? metadata.model;
    const size = activeImageItem?.size ?? metadata.size;
    add("模型", model && configuredModelDisplayName(config, model));
    if (node.type === CanvasNodeType.Image && size && (activeImageItem?.naturalWidth || metadata.naturalWidth)) {
        add("宽高比", formatImageRatio(size, activeImageItem?.naturalWidth ?? metadata.naturalWidth, activeImageItem?.naturalHeight ?? metadata.naturalHeight));
    } else {
        add("生成尺寸", size);
    }
    const quality = activeImageItem?.quality ?? (metadata.vquality || metadata.quality);
    if (node.type === CanvasNodeType.Image && quality && !/^\d+k$/i.test(quality)) {
        add("质量", quality === "standard" ? "标准" : imageQualityLabel(quality));
    } else {
        add("分辨率", quality);
    }
    add("秒数", metadata.seconds ? `${metadata.seconds} 秒` : undefined);
    add("生成声音", metadata.generateAudio === undefined ? undefined : metadata.generateAudio === "true" ? "开启" : "关闭");
    add("水印", metadata.watermark === undefined ? undefined : metadata.watermark === "true" ? "开启" : "关闭");
    if (metadata.references?.length) {
        const referenceNames = metadata.references
            .slice(0, 3)
            .map((reference) => reference.split("/").pop() || reference)
            .join("、");
        add("引用素材", `${metadata.references.length} 个${referenceNames ? `（${referenceNames}${metadata.references.length > 3 ? "…" : ""}）` : ""}`);
    }
    const liveTelemetry = readNodeLiveTaskTelemetry(metadata);
    addTime("创建时间", metadata.taskCreatedAt);
    addTime("开始时间", metadata.taskStartedAt || liveTelemetry?.startedAt);
    addTime("完成时间", activeImageItem?.createdAt ?? metadata.taskCompletedAt);
    addDuration(metadata.taskDurationMs ?? liveTelemetry?.durationMs);
    return rows;
}
