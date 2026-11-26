import { Button, Select, Tooltip } from "antd";
import { ArrowUp, Minimize2, Square, X, Paperclip, Sparkles } from "lucide-react";
import { useRef, useState } from "react";

import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssistantContextUsage, AssistantPermissionMode, AssistantThinkingLevel } from "@/services/api/agent-assistant";
import { CanvasAssistantModelPicker } from "./canvas-assistant-model-picker";

const LINE_HEIGHT = 21;
const MIN_LINES = 3;
const MAX_LINES = 8;

function formatUsageCount(count: number): string {
    if (!Number.isFinite(count) || count <= 0) return "0";
    if (count >= 1000) return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k`;
    return String(Math.round(count));
}

function formatContextTooltip(usage: AssistantContextUsage): string {
    const parts: string[] = [];
    if (usage.contextWindow > 0) {
        parts.push(`当前上下文约 ${formatUsageCount(usage.estimatedTokens)} / ${formatUsageCount(usage.contextWindow)}`);
    } else {
        parts.push(`当前上下文约 ${formatUsageCount(usage.estimatedTokens)}`);
    }
    if (usage.cacheRead > 0) {
        parts.push(`本会话已复用缓存 ${formatUsageCount(usage.cacheRead)}`);
    }
    return parts.join(" · ");
}

type Props = {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    streaming: boolean;
    disabled: boolean;
    disabledReason?: string;
    references: CanvasResourceReference[];
    selectedCount: number;
    selectionAttached: boolean;
    onDetachSelection: () => void;
    modelBusy?: boolean;
    canSupplement?: boolean;
    supplementBusy?: boolean;
    hasAttachments?: boolean;
    inputBusy?: boolean;
    onFiles?: (files: File[]) => void;
    onOpenSkills?: () => void;
    onOpenReferences?: () => void;
    inputContent?: React.ReactNode;
    permissionMode?: AssistantPermissionMode;
    permissionLocked?: boolean;
    onPermissionChange?: (mode: AssistantPermissionMode) => void;
    thinkingLevel?: AssistantThinkingLevel;
    onThinkingLevelChange?: (level: AssistantThinkingLevel) => void;
    contextUsage?: AssistantContextUsage | null;
    canCompact?: boolean;
    compacting?: boolean;
    compactNotice?: string | null;
    onCompact?: () => void;
};

export function CanvasAssistantComposer({
    value,
    onChange,
    onSend,
    onStop,
    streaming,
    disabled,
    disabledReason,
    references,
    selectedCount,
    selectionAttached,
    onDetachSelection,
    modelBusy,
    canSupplement,
    supplementBusy,
    hasAttachments,
    inputBusy,
    onFiles,
    onOpenSkills,
    onOpenReferences,
    inputContent,
    permissionMode = "canvas",
    permissionLocked,
    onPermissionChange,
    thinkingLevel = "low",
    onThinkingLevelChange,
    contextUsage,
    canCompact,
    compacting,
    compactNotice,
    onCompact,
}: Props) {
    const [contentHeight, setContentHeight] = useState(LINE_HEIGHT);
    const fileInput = useRef<HTMLInputElement>(null);
    const height = Math.min(MAX_LINES * LINE_HEIGHT, Math.max(MIN_LINES * LINE_HEIGHT, contentHeight));
    const canSend = !disabled && !compacting && (!streaming || canSupplement) && !supplementBusy && !inputBusy && (Boolean(value.trim()) || Boolean(hasAttachments));
    const showContext = Boolean(contextUsage && (contextUsage.estimatedTokens > 0 || canCompact));
    const contextLabel = contextUsage
        ? (typeof contextUsage.percent === "number" ? `上下文 ${contextUsage.percent}%` : `上下文 ${formatUsageCount(contextUsage.estimatedTokens)}`)
        : "";
    const thinkingOptions = [
        { value: "off" as const, label: "关闭思考", title: "直接回答，不展开思考过程" },
        ...(thinkingLevel === "minimal" ? [{ value: "minimal" as const, label: "极简思考", title: "仅做简短思考" }] : []),
        { value: "low" as const, label: "轻量思考", title: "默认强度，兼顾速度与规划质量" },
        { value: "medium" as const, label: "标准思考", title: "适合分镜拆解和多步修改" },
        { value: "high" as const, label: "深度思考", title: "适合复杂整片策划与排查" },
    ];

    return (
        <footer className="canvas-assistant-composer" onDragOver={event => { if (onFiles && !disabled && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
            onDrop={event => { if (onFiles && !disabled && event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); onFiles([...event.dataTransfer.files]); } }}
            onPasteCapture={event => { const files = [...event.clipboardData.files]; if (onFiles && !disabled && files.length) { event.preventDefault(); event.stopPropagation(); onFiles(files); const text = event.clipboardData.getData("text/plain"); if (text) onChange(value + text); } }}>
            <input ref={fileInput} type="file" multiple hidden aria-label="添加文件或素材" onChange={event => { onFiles?.([...event.target.files || []]); event.target.value = ""; }} />
            {!streaming && selectionAttached && selectedCount > 0 ? <div className="canvas-assistant-chips">
                    <span className="canvas-assistant-chip">
                        已选 {selectedCount} 个节点
                        <button type="button" aria-label="这条消息不带已选节点" onClick={onDetachSelection}>
                            <X className="size-3" />
                        </button>
                    </span>
            </div> : null}

            {inputContent}

            <div className="canvas-assistant-input" style={{ height: height + 14 }}>
                <CanvasResourceMentionTextarea
                    value={value}
                    references={references}
                    onChange={onChange}
                    onSubmit={() => { if (canSend) onSend(); }}
                    includeAssetLibrary
                    containerClassName="h-full min-h-0"
                    className="thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-3 py-1.5 text-[var(--fs-caption)] leading-[21px] !shadow-none !outline-none !ring-0 focus:!shadow-none focus:!outline-none focus:!ring-0 placeholder:text-[var(--muted-foreground)]"
                    onContentSizeChange={setContentHeight}
                    disabled={disabled}
                    placeholder={streaming ? "补充这次创作的要求" : "描述你的想法，或用 @ 引用素材"}
                    aria-label="给助手的消息"
                />
            </div>

            {disabled && disabledReason ? <span className="canvas-assistant-meta">{disabledReason}</span> : null}
            {compactNotice ? <span className="canvas-assistant-meta" role="status">{compactNotice}</span> : null}

            <div className="canvas-assistant-composer-tools">
                {onFiles ? <Tooltip title="添加文件或素材"><Button type="text" size="small" aria-label="添加文件或素材" disabled={disabled || inputBusy} icon={<Paperclip size={15} />} onClick={() => fileInput.current?.click()} /></Tooltip> : null}
                {onOpenSkills ? <Tooltip title="选择技能"><Button type="text" size="small" aria-label="选择技能" disabled={disabled} icon={<Sparkles size={15} />} onClick={onOpenSkills} /></Tooltip> : null}
                {onOpenReferences ? <Button type="text" size="small" disabled={disabled} onClick={onOpenReferences}>画布素材</Button> : null}
                {showContext || (canCompact && onCompact) ? (
                    <div className="canvas-assistant-context">
                        {showContext && contextUsage ? (
                            <Tooltip title={formatContextTooltip(contextUsage)}>
                                <span className={`canvas-assistant-context-usage${(contextUsage.percent ?? 0) >= 80 ? " canvas-assistant-context-usage-high" : ""}`}>
                                    {contextLabel}
                                </span>
                            </Tooltip>
                        ) : null}
                        {canCompact && onCompact ? (
                            <Tooltip title="压缩较早对话上下文，释放更多空间">
                                <Button
                                    type="text"
                                    size="small"
                                    aria-label="压缩上下文"
                                    loading={compacting}
                                    disabled={disabled || streaming || permissionLocked || compacting}
                                    icon={<Minimize2 size={14} />}
                                    onClick={onCompact}
                                />
                            </Tooltip>
                        ) : null}
                    </div>
                ) : null}
            </div>
            <div className="canvas-assistant-composer-footer">
                <div className="canvas-assistant-composer-settings">
                <CanvasAssistantModelPicker busy={disabled || streaming || Boolean(modelBusy)} />
                {onThinkingLevelChange ? <Tooltip title={permissionLocked ? "处理中暂不可切换思考深度" : "调节当前对话的思考深度"}>
                    <Select className="canvas-assistant-thinking" size="small" variant="borderless" aria-label="思考深度" value={thinkingLevel} disabled={disabled || permissionLocked}
                        placement="topRight" popupMatchSelectWidth={false} onChange={onThinkingLevelChange} options={thinkingOptions} />
                </Tooltip> : null}
                {onPermissionChange ? <Tooltip title={permissionLocked ? "本轮权限已固定，结束后可更改" : "选择助手可访问和修改的范围"}>
                    <Select className="canvas-assistant-permission" size="small" variant="borderless" aria-label="助手权限" value={permissionMode} disabled={disabled || permissionLocked}
                        placement="topRight" popupMatchSelectWidth={false} onChange={onPermissionChange} options={[
                            { value: "read-only", label: "只读", title: "查看和分析，不修改内容" },
                            { value: "canvas", label: "当前画布", title: "查看素材并修改当前画布" },
                            { value: "full-access", label: "完全访问", title: "查看素材，可修改所有画布" },
                        ]} />
                </Tooltip> : null}
                </div>
                <div className="canvas-assistant-composer-actions">
                {streaming ? (
                    <>
                        <Button size="small" disabled={!canSend} loading={supplementBusy} onClick={onSend}>补充</Button>
                        <Button size="small" icon={<Square className="size-3" />} onClick={onStop}>停止</Button>
                    </>
                ) : (
                    <Tooltip title="Enter 发送 · Shift + Enter 换行" placement="topRight">
                        <Button className="canvas-assistant-send" shape="circle" type="primary" aria-label="发送" disabled={!canSend} icon={<ArrowUp className="size-4" />} onClick={onSend} />
                    </Tooltip>
                )}
                </div>
            </div>
        </footer>
    );
}
