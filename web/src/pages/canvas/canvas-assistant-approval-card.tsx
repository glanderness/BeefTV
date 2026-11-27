import { Button } from "antd";
import { useState } from "react";

import type {
    AssistantPendingApproval,
    AssistantProductionMandate,
    CreateAssistantMandateInput,
} from "@/services/api/agent-assistant";

const KIND_LABELS: Record<string, string> = {
    image: "图片生成",
    video: "视频生成",
    audio: "配音/音频",
    media_review: "媒体审片",
    media_transcribe: "云端转写",
};

export function formatMandateCny(amount: number): string {
    if (!Number.isFinite(amount) || amount <= 0) return "¥0";
    if (amount >= 100 && Math.abs(amount - Math.round(amount)) < 0.005) {
        return `¥${Math.round(amount)}`;
    }
    if (Math.abs(amount - Math.round(amount)) < 0.005) {
        return `¥${Math.round(amount)}`;
    }
    return `¥${amount.toFixed(2)}`;
}

function resolveSuggestedCap(suggestedCapCny?: number): number {
    if (typeof suggestedCapCny === "number" && Number.isFinite(suggestedCapCny) && suggestedCapCny > 0) {
        return Math.ceil(suggestedCapCny);
    }
    return 20;
}

function buildCapOptions(suggested: number): number[] {
    const merged = new Set<number>([suggested, 20, 50, 100]);
    return [...merged].filter((n) => n > 0).sort((a, b) => a - b).slice(0, 4);
}

type ApprovalCardProps = {
    approval: AssistantPendingApproval;
    busy?: boolean;
    disabled?: boolean;
    feedback?: string;
    onApproveOnce: (proposalId: string) => void;
    onApproveMandate: (proposalId: string, mandate: CreateAssistantMandateInput) => void;
    onReject: (proposalId: string) => void;
};

export function CanvasAssistantApprovalCard({
    approval,
    busy = false,
    disabled = false,
    feedback,
    onApproveOnce,
    onApproveMandate,
    onReject,
}: ApprovalCardProps) {
    const initialCap = resolveSuggestedCap(approval.suggestedCapCny);
    const [selectedCap, setSelectedCap] = useState<number>(initialCap);
    const [allowUnquoted, setAllowUnquoted] = useState(false);
    const capOptions = buildCapOptions(initialCap);

    const hasQuotedAmount = typeof approval.estimatedCny === "number" && Number.isFinite(approval.estimatedCny) && approval.estimatedCny > 0;
    const unquotedCount = typeof approval.unquotedCount === "number" && approval.unquotedCount > 0 ? approval.unquotedCount : 0;
    const optedInUnquotedLimit = Math.max(4, unquotedCount);
    const badgeText = hasQuotedAmount
        ? `约 ${formatMandateCny(approval.estimatedCny!)}${unquotedCount > 0 ? ` + ${unquotedCount} 项无报价` : ""}`
        : unquotedCount > 0
            ? `${unquotedCount} 项无报价`
            : null;
    const kindLabels = (approval.kinds || (approval.kind ? [approval.kind] : []))
        .map((k) => KIND_LABELS[k] || k)
        .filter(Boolean);
    const summaryLine = approval.summary?.trim() || approval.message?.trim() || "助手请求执行一项付费操作，请确认是否放行。";

    const handleApproveMandate = () => {
        onApproveMandate(approval.proposalId, {
            maxAmountCny: selectedCap,
            maxUnquotedCount: allowUnquoted ? optedInUnquotedLimit : 0,
        });
    };

    return (
        <div className="canvas-assistant-card" role="region" aria-label="待批准付费操作">
            <div className="canvas-assistant-proposal-head">
                <span className="canvas-assistant-proposal-status-row">
                    <span className="canvas-assistant-status-dot" data-tone="pending" aria-hidden="true" />
                    <span>待批准 · 付费操作</span>
                </span>
                {badgeText ? <span className="canvas-assistant-status-pill">{badgeText}</span> : null}
            </div>
            <div className="canvas-assistant-proposal-lines">
                <div>{summaryLine}</div>
                {kindLabels.length > 0 ? (
                    <div className="canvas-assistant-meta">涉及能力：{kindLabels.join(" · ")}</div>
                ) : null}
            </div>
            <div className="canvas-assistant-mandate-caps" role="group" aria-label="预算包上限">
                <span className="canvas-assistant-meta">预算上限：</span>
                {capOptions.map((cap) => (
                    <button
                        key={cap}
                        type="button"
                        className="canvas-assistant-cap-chip"
                        data-active={selectedCap === cap ? "true" : undefined}
                        aria-pressed={selectedCap === cap}
                        disabled={busy || disabled}
                        onClick={() => setSelectedCap(cap)}
                    >
                        {formatMandateCny(cap)}
                    </button>
                ))}
            </div>
            <label className="canvas-assistant-meta inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={allowUnquoted}
                    disabled={busy || disabled}
                    onChange={(event) => setAllowUnquoted(event.target.checked)}
                />
                <span>{`同时允许无报价/自带 Key 调用（限 ${optedInUnquotedLimit} 次，独立于 ¥ 上限计数）`}</span>
            </label>
            {feedback ? (
                <span className="canvas-assistant-meta canvas-assistant-failed" role="status">
                    {feedback}
                </span>
            ) : null}
            <div className="canvas-assistant-card-actions">
                <Button
                    size="small"
                    type="primary"
                    autoInsertSpace={false}
                    loading={busy}
                    disabled={disabled}
                    onClick={() => onApproveOnce(approval.proposalId)}
                >
                    批准本次
                </Button>
                <Button
                    size="small"
                    autoInsertSpace={false}
                    loading={busy}
                    disabled={disabled || (unquotedCount > 0 && !allowUnquoted)}
                    onClick={handleApproveMandate}
                >
                    {`批准本片预算包（上限 ${formatMandateCny(selectedCap)}）`}
                </Button>
                <Button
                    size="small"
                    autoInsertSpace={false}
                    disabled={busy || disabled}
                    onClick={() => onReject(approval.proposalId)}
                >
                    拒绝
                </Button>
            </div>
        </div>
    );
}

type MandateBarProps = {
    mandate: AssistantProductionMandate | null | undefined;
    busy?: boolean;
    readOnly?: boolean;
    onRevoke: () => void;
};

export function CanvasAssistantMandateBar({ mandate, busy = false, readOnly = false, onRevoke }: MandateBarProps) {
    if (!mandate || mandate.status !== "active") return null;
    const unquotedNote = mandate.maxUnquotedCount > 0
        ? ` · 无报价余 ${mandate.remainingUnquoted}/${mandate.maxUnquotedCount} 次`
        : "";
    return (
        <div className="canvas-assistant-mandate-bar" role="status" aria-label="当前制作预算包">
            <div className="canvas-assistant-mandate-info">
                <span className="canvas-assistant-proposal-status-row">
                    <span className="canvas-assistant-status-dot" data-tone="active" aria-hidden="true" />
                    <span>本片预算包生效中</span>
                </span>
                <span className="canvas-assistant-meta">
                    {`剩余 ${formatMandateCny(mandate.remainingCny)} / 上限 ${formatMandateCny(mandate.maxAmountCny)}（已用 ${formatMandateCny(mandate.spentAmountCny)}，预留 ${formatMandateCny(mandate.reservedAmountCny)}${unquotedNote}）`}
                </span>
            </div>
            {!readOnly ? (
                <Button size="small" loading={busy} onClick={onRevoke}>
                    撤销预算包
                </Button>
            ) : null}
        </div>
    );
}
