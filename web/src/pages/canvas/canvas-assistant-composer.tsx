import { Button, Popover, Select, Tooltip } from "antd";
import { ArrowUp, Check, ImagePlus, Minimize2, Paperclip, Sparkles, Square, X, Zap } from "lucide-react";
import { useRef, useState } from "react";

import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssistantContextUsage, AssistantPermissionMode, AssistantThinkingLevel } from "@/services/api/agent-assistant";
import { CanvasAssistantModelPicker } from "./canvas-assistant-model-picker";
import "./canvas-assistant-composer.css";

const LINE_HEIGHT = 21;
const MIN_LINES = 2;
const MAX_LINES = 7;

const AUTO_CONFIRM_OPTIONS = [
    { value: 0, label: "手动确认", desc: "每次点击确认" },
    { value: 2, label: "免确认 ¥2", desc: "单会话 ¥2 内" },
    { value: 5, label: "免确认 ¥5", desc: "单会话 ¥5 内" },
    { value: 10, label: "免确认 ¥10", desc: "单会话 ¥10 内" },
    { value: 20, label: "免确认 ¥20", desc: "单会话 ¥20 内" },
] as const;

const THINKING_SHORT_LABEL: Record<AssistantThinkingLevel, string> = {
    off: "关闭",
    minimal: "极简",
    low: "轻量",
    medium: "标准",
    high: "深度",
};

const PERMISSION_SHORT_LABEL: Record<AssistantPermissionMode, string> = {
    "read-only": "只读",
    canvas: "画布",
    "full-access": "全部",
};

const PASSIVE_TOOLTIP_STYLES = {
    root: { pointerEvents: "none" as const },
    container: { pointerEvents: "none" as const },
};

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

function ContextRing({ percent }: { percent: number }) {
    const clamped = Math.max(0, Math.min(100, percent));
    const r = 4.5;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - clamped / 100);
    return (
        <svg className="canvas-assistant-context-ring" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="6" cy="6" r={r} fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.5" />
            <circle
                cx="6"
                cy="6"
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={c}
                strokeDashoffset={offset}
                transform="rotate(-90 6 6)"
            />
        </svg>
    );
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
    skillsActive?: boolean;
    referencesActive?: boolean;
    inputContent?: React.ReactNode;
    permissionMode?: AssistantPermissionMode;
    permissionLocked?: boolean;
    onPermissionChange?: (mode: AssistantPermissionMode) => void;
    thinkingLevel?: AssistantThinkingLevel;
    onThinkingLevelChange?: (level: AssistantThinkingLevel) => void;
    autoConfirmMaxCny?: number;
    onAutoConfirmMaxCnyChange?: (limit: number) => void;
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
    skillsActive,
    referencesActive,
    inputContent,
    permissionMode = "canvas",
    permissionLocked,
    onPermissionChange,
    thinkingLevel = "low",
    onThinkingLevelChange,
    autoConfirmMaxCny = 0,
    onAutoConfirmMaxCnyChange,
    contextUsage,
    canCompact,
    compacting,
    compactNotice,
    onCompact,
}: Props) {
    const [contentHeight, setContentHeight] = useState(LINE_HEIGHT);
    const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);
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
    const autoConfirmActive = autoConfirmMaxCny > 0;
    const autoConfirmLabel = autoConfirmActive ? `免 ¥${autoConfirmMaxCny}` : "手动";

    return (
        <div className="canvas-assistant-composer-wrap">
            <footer
                className="canvas-assistant-composer"
                onDragOver={event => { if (onFiles && !disabled && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
                onDrop={event => { if (onFiles && !disabled && event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); onFiles([...event.dataTransfer.files]); } }}
                onPasteCapture={event => { const files = [...event.clipboardData.files]; if (onFiles && !disabled && files.length) { event.preventDefault(); event.stopPropagation(); onFiles(files); const text = event.clipboardData.getData("text/plain"); if (text) onChange(value + text); } }}
            >
                <input ref={fileInput} type="file" multiple hidden aria-label="添加文件或素材" onChange={event => { onFiles?.([...event.target.files || []]); event.target.value = ""; }} />
                {!streaming && selectionAttached && selectedCount > 0 ? (
                    <div className="canvas-assistant-chips">
                        <span className="canvas-assistant-chip">
                            已选 {selectedCount} 个节点
                            <button type="button" aria-label="这条消息不带已选节点" onClick={onDetachSelection}>
                                <X className="size-3" />
                            </button>
                        </span>
                    </div>
                ) : null}

                {inputContent}

                <div className="canvas-assistant-input" style={{ height: height + 10 }}>
                    <CanvasResourceMentionTextarea
                        value={value}
                        references={references}
                        onChange={onChange}
                        onSubmit={() => { if (canSend) onSend(); }}
                        includeAssetLibrary
                        containerClassName="h-full min-h-0"
                        className="thin-scrollbar h-full w-full resize-none overflow-y-auto border-none bg-transparent px-1.5 py-1 text-[var(--fs-caption)] leading-[21px] !shadow-none !outline-none !ring-0 focus:!shadow-none focus:!outline-none focus:!ring-0 placeholder:text-[var(--muted-foreground)]"
                        onContentSizeChange={setContentHeight}
                        disabled={disabled}
                        placeholder={streaming ? "补充这次创作的要求…" : "描述你的想法，或用 @ 引用素材"}
                        aria-label="给助手的消息"
                    />
                </div>

                {disabled && disabledReason ? <span className="canvas-assistant-meta">{disabledReason}</span> : null}
                {compactNotice ? <span className="canvas-assistant-meta" role="status">{compactNotice}</span> : null}

                <div className="canvas-assistant-composer-bar">
                    <div className="canvas-assistant-composer-tools">
                        {onFiles ? (
                            <Tooltip title="添加文件或素材">
                                <button
                                    type="button"
                                    className="canvas-assistant-icon-btn"
                                    aria-label="添加文件或素材"
                                    disabled={disabled || inputBusy}
                                    onClick={() => fileInput.current?.click()}
                                >
                                    <Paperclip size={15} aria-hidden="true" />
                                </button>
                            </Tooltip>
                        ) : null}
                        {onOpenReferences ? (
                            <Tooltip title="引用画布素材">
                                <button
                                    type="button"
                                    className="canvas-assistant-icon-btn"
                                    aria-label="画布素材"
                                    aria-expanded={Boolean(referencesActive)}
                                    data-active={referencesActive ? "true" : undefined}
                                    disabled={disabled}
                                    onClick={onOpenReferences}
                                >
                                    <ImagePlus size={15} aria-hidden="true" />
                                </button>
                            </Tooltip>
                        ) : null}
                        {onOpenSkills ? (
                            <Tooltip title="选择技能">
                                <button
                                    type="button"
                                    className="canvas-assistant-icon-btn"
                                    aria-label="选择技能"
                                    aria-expanded={Boolean(skillsActive)}
                                    data-active={skillsActive ? "true" : undefined}
                                    disabled={disabled}
                                    onClick={onOpenSkills}
                                >
                                    <Sparkles size={15} aria-hidden="true" />
                                </button>
                            </Tooltip>
                        ) : null}

                        {showContext || (canCompact && onCompact) ? (
                            <div className="canvas-assistant-context">
                                {showContext && contextUsage ? (
                                    <Tooltip title={formatContextTooltip(contextUsage)}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <ContextRing percent={contextUsage.percent ?? 0} />
                                            <span className={`canvas-assistant-context-usage${(contextUsage.percent ?? 0) >= 80 ? " canvas-assistant-context-usage-high" : ""}`}>
                                                {contextLabel}
                                            </span>
                                        </span>
                                    </Tooltip>
                                ) : null}
                                {canCompact && onCompact ? (
                                    <Tooltip title="压缩较早对话上下文，释放更多空间">
                                        <button
                                            type="button"
                                            className="canvas-assistant-compact-btn"
                                            aria-label="压缩上下文"
                                            disabled={disabled || streaming || permissionLocked || compacting}
                                            onClick={onCompact}
                                        >
                                            <Minimize2 size={12} aria-hidden="true" />
                                        </button>
                                    </Tooltip>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    <div className="canvas-assistant-composer-actions">
                        {streaming ? (
                            <>
                                <Button size="small" disabled={!canSend} loading={supplementBusy} onClick={onSend}>补充</Button>
                                <Tooltip title="停止当前处理">
                                    <Button size="small" shape="circle" aria-label="停止" icon={<Square className="size-3" />} onClick={onStop} />
                                </Tooltip>
                            </>
                        ) : (
                            <Tooltip title="Enter 发送 · Shift + Enter 换行" placement="topRight">
                                <Button
                                    className="canvas-assistant-send"
                                    shape="circle"
                                    type="primary"
                                    aria-label="发送"
                                    disabled={!canSend}
                                    icon={<ArrowUp className="size-4" />}
                                    onClick={onSend}
                                />
                            </Tooltip>
                        )}
                    </div>
                </div>
            </footer>

            {/* 外置单行控制轨：模型 · 思考 · 权限 · 小额免确认，零换行、不挤占输入盒 */}
            <div className="canvas-assistant-control-rail" aria-label="助手运行设置">
                <CanvasAssistantModelPicker busy={disabled || streaming || Boolean(modelBusy)} />

                {onThinkingLevelChange ? (
                    <Tooltip styles={PASSIVE_TOOLTIP_STYLES} title={permissionLocked ? "处理中暂不可切换思考深度" : "调节当前对话的思考深度"}>
                        <Select
                            className="canvas-assistant-thinking"
                            size="small"
                            variant="borderless"
                            aria-label="思考深度"
                            value={thinkingLevel}
                            disabled={disabled || permissionLocked}
                            placement="topRight"
                            popupMatchSelectWidth={false}
                            onChange={onThinkingLevelChange}
                            labelRender={({ value: current }) => THINKING_SHORT_LABEL[current as AssistantThinkingLevel] || String(current ?? "")}
                            options={thinkingOptions}
                        />
                    </Tooltip>
                ) : null}

                {onPermissionChange ? (
                    <Tooltip styles={PASSIVE_TOOLTIP_STYLES} title={permissionLocked ? "本轮权限已固定，结束后可更改" : "选择助手可访问和修改的范围"}>
                        <Select
                            className="canvas-assistant-permission"
                            size="small"
                            variant="borderless"
                            aria-label="助手权限"
                            value={permissionMode}
                            disabled={disabled || permissionLocked}
                            placement="topRight"
                            popupMatchSelectWidth={false}
                            onChange={onPermissionChange}
                            labelRender={({ value: current }) => PERMISSION_SHORT_LABEL[current as AssistantPermissionMode] || String(current ?? "")}
                            options={[
                                { value: "read-only", label: "只读", title: "查看和分析，不修改内容" },
                                { value: "canvas", label: "当前画布", title: "查看素材并修改当前画布" },
                                { value: "full-access", label: "完全访问", title: "查看素材，可修改所有画布" },
                            ]}
                        />
                    </Tooltip>
                ) : null}

                {onAutoConfirmMaxCnyChange ? (
                    <Popover
                        open={autoConfirmOpen && !disabled}
                        onOpenChange={(next) => setAutoConfirmOpen(next && !disabled)}
                        trigger="click"
                        placement="topRight"
                        content={
                            <div className="canvas-assistant-autoconfirm-menu" role="group" aria-label="小额免确认额度选项">
                                <div className="canvas-assistant-autoconfirm-menu-head">
                                    <div className="canvas-assistant-autoconfirm-menu-title">单会话小额免确认</div>
                                    <div className="canvas-assistant-autoconfirm-menu-sub">额度内已知报价自动发起，超额或原地重做仍需确认。</div>
                                </div>
                                {AUTO_CONFIRM_OPTIONS.map((opt) => {
                                    const selected = autoConfirmMaxCny === opt.value;
                                    return (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            className="canvas-assistant-autoconfirm-option"
                                            aria-pressed={selected}
                                            disabled={disabled}
                                            onClick={() => {
                                                if (disabled) return;
                                                onAutoConfirmMaxCnyChange(opt.value);
                                                setAutoConfirmOpen(false);
                                            }}
                                        >
                                            <span className="inline-flex items-center gap-1.5">
                                                <span>{opt.label}</span>
                                                <span className="canvas-assistant-autoconfirm-option-desc">{opt.desc}</span>
                                            </span>
                                            {selected ? <Check size={13} aria-hidden="true" /> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        }
                    >
                        <Tooltip styles={PASSIVE_TOOLTIP_STYLES} title={autoConfirmOpen && !disabled ? "" : "单会话小额生成免确认额度"}>
                            <button
                                type="button"
                                className="canvas-assistant-autoconfirm-btn"
                                aria-label="小额免确认额度"
                                data-active={autoConfirmActive ? "true" : undefined}
                                disabled={disabled}
                            >
                                {autoConfirmActive ? <span className="canvas-assistant-autoconfirm-dot" aria-hidden="true" /> : <Zap size={12} aria-hidden="true" />}
                                <span>{autoConfirmLabel}</span>
                            </button>
                        </Tooltip>
                    </Popover>
                ) : null}
            </div>
        </div>
    );
}
