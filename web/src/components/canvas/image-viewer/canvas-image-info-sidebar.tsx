import { imageQualityLabel } from "@/components/image-settings-panel";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { formatImageRatio, formatMimeShort } from "@/lib/image-display-format";
import { formatBytes } from "@/lib/image-utils";
import { configuredModelDisplayName } from "@/lib/model-selection";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasImageHistoryItem, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

import { CanvasMediaInfoSidebar, formatDateTimeExact } from "./canvas-media-info-sidebar";

export type SupplementedMediaMetrics = {
    width?: number;
    height?: number;
    bytes?: number;
    mimeType?: string;
};

type CanvasImageInfoSidebarProps = {
    node?: CanvasNodeData | null;
    item: CanvasImageHistoryItem;
    comparePartner?: CanvasImageHistoryItem | null;
    inspectTarget: "A" | "B";
    onInspectTargetChange?: (target: "A" | "B") => void;
    inCompareMode: boolean;
    supplemented?: SupplementedMediaMetrics;
    config: AiConfig;
    theme: CanvasTheme;
    readOnly?: boolean;
    onApplyParameters?: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onOpenNodeInfo?: (nodeId: string) => void;
};

export function CanvasImageInfoSidebar({
    node,
    item,
    comparePartner,
    inspectTarget,
    onInspectTargetChange,
    inCompareMode,
    supplemented,
    config,
    theme,
    readOnly = false,
    onApplyParameters,
    onOpenNodeInfo,
}: CanvasImageInfoSidebarProps) {
    const railBg = theme.node.panel;
    const insetBg = theme.timeline.trackFill;
    const secondaryInk = theme.node.label;

    const width = item.naturalWidth || supplemented?.width || 0;
    const height = item.naturalHeight || supplemented?.height || 0;
    const bytes = item.bytes || supplemented?.bytes || 0;
    const mimeShort = formatMimeShort(item.mimeType || supplemented?.mimeType, item.content);
    const modelText = item.model ? configuredModelDisplayName(config, item.model) : "本地图片 / 未记录";
    const ratioText = formatImageRatio(item.size, width, height);
    const qualityText = item.quality ? imageQualityLabel(item.quality) : "";
    const pixelText = width > 0 && height > 0 ? `${Math.round(width)} × ${Math.round(height)} px` : "读取中";
    const sizeText = bytes > 0 ? `${formatBytes(bytes)}${mimeShort ? ` · ${mimeShort}` : ""}` : mimeShort || "未记录";
    const createdText = formatDateTimeExact(item.createdAt);
    const promptText = item.prompt?.trim() || "";

    const currentComposerPrompt = (node?.metadata?.composerContent ?? node?.metadata?.prompt ?? "").trim();
    const canRestoreToComposer = Boolean(
        !readOnly
        && node
        && onApplyParameters
        && (promptText || item.model || item.size || item.quality)
        && (
            (promptText && promptText !== currentComposerPrompt)
            || (item.model && item.model !== node.metadata?.model)
            || (item.size && item.size !== node.metadata?.size)
            || (item.quality && item.quality !== node.metadata?.quality)
        ),
    );

    const diffFromPartner = (key: "model" | "size" | "quality" | "prompt") =>
        Boolean(inCompareMode && comparePartner && (item[key] || "") !== (comparePartner[key] || ""));

    const specRows: Array<{ label: string; value: string; changed?: boolean }> = [
        { label: "模型", value: modelText, changed: diffFromPartner("model") },
        { label: "比例", value: ratioText, changed: diffFromPartner("size") },
        ...(qualityText ? [{ label: "分辨率", value: qualityText, changed: diffFromPartner("quality") }] : []),
        { label: "像素尺寸", value: pixelText },
        { label: "文件大小", value: sizeText },
        { label: "生成时间", value: createdText },
    ];

    return (
        <CanvasMediaInfoSidebar
            kind="图片"
            testIdPrefix="canvas-image"
            theme={theme}
            prompt={promptText}
            promptChanged={diffFromPartner("prompt")}
            rows={specRows}
            onRestore={canRestoreToComposer && node && onApplyParameters ? () => onApplyParameters(node.id, {
                ...(promptText ? { composerContent: promptText } : {}),
                ...(item.model ? { model: item.model } : {}),
                ...(item.size ? { size: item.size } : {}),
                ...(item.quality ? { quality: item.quality } : {}),
            }) : undefined}
            onOpenNodeInfo={node && onOpenNodeInfo ? () => onOpenNodeInfo(node.id) : undefined}
            nodeInfoLabel={readOnly ? "查看节点信息" : "节点信息与资产标签"}
            headerAction={
                inCompareMode && comparePartner && onInspectTargetChange ? (
                    <div
                        role="group"
                        aria-label="切换查看对比图参数"
                        className="inline-flex h-7 items-center rounded-[var(--r-md)] p-0.5"
                        style={{ background: insetBg }}
                    >
                        {(["A", "B"] as const).map((side) => {
                            const active = inspectTarget === side;
                            return (
                                <button
                                    key={side}
                                    type="button"
                                    aria-pressed={active}
                                    className="h-6 rounded-[var(--r-sm)] px-2.5 transition-colors"
                                    style={{
                                        background: active ? railBg : "transparent",
                                        color: active ? theme.node.text : secondaryInk,
                                        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.12)" : undefined,
                                    }}
                                    onClick={() => onInspectTargetChange(side)}
                                >
                                    图 {side}
                                </button>
                            );
                        })}
                    </div>
                ) : null
            }
        />
    );
}
