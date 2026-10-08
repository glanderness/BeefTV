import { Button } from "antd";
import { Crosshair, Undo2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { agentAssistantFailureText, type AgentToolCall, type AssistantGenerationProposal, type AssistantTurn } from "@/services/api/agent-assistant";
import { ASSISTANT_UNDONE_INCOMPLETE_TEXT, assistantChangeSummary, assistantChangedNodeIds, assistantProposalText, assistantTurnCanContinue, assistantUnresolvedFailures, assistantUndoFailureText, assistantVisibleReply } from "./canvas-assistant-copy";
import { dismissedProposalKey, type AssistantTurnStatus } from "./use-canvas-assistant";
import { modelOptionName, resolveModelChannel, useEffectiveConfig } from "@/stores/use-config-store";
import { portraitPriceLines, seedancePortraitModel, seedancePortraitLabel } from "@/lib/seedance-portrait";
import { portraitGenerationError } from "@/lib/model-selection";
import { CanvasAssistantAttachments } from "./canvas-assistant-attachments";

type Props = {
    turn: AssistantTurn;
    status?: AssistantTurnStatus;
    handledProposals: Set<string>;
    proposalFeedback?: Record<string, string>;
    onLocate: (nodeIds: string[]) => void;
    onUndo: (turnId: string) => void;
    onRunProposal: (proposal: AssistantGenerationProposal) => void;
    onDismissProposal: (proposalId: string) => void;
    onContinue?: () => void;
};

/** 助手回复用 Markdown 渲染，只走 react-markdown 的安全默认值，不放开原始 HTML。 */
export function CanvasAssistantReply({ text }: { text: string }) {
    const visible = assistantVisibleReply(text);
    if (!visible) return null;
    return (
        <div className="canvas-assistant-reply">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{visible}</ReactMarkdown>
        </div>
    );
}

export function CanvasAssistantUserMessage({ text, selectedCount }: { text: string; selectedCount: number }) {
    if (!text && !selectedCount) return null;
    return (
        <div className="canvas-assistant-user">
            <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
            {selectedCount > 0 ? <span className="canvas-assistant-meta">带上了已选的 {selectedCount} 个节点</span> : null}
        </div>
    );
}

export function CanvasAssistantTurnView({ turn, status, handledProposals, proposalFeedback, onLocate, onUndo, onRunProposal, onDismissProposal, onContinue }: Props) {
    const config = useEffectiveConfig();
    const summary = assistantChangeSummary(turn.change);
    const changedNodeIds = assistantChangedNodeIds(turn.change);
    const changedCanvasCount = new Set(turn.change?.canvasChanges?.map(item => item.canvasId) || []).size;
    const failedActions = assistantUnresolvedFailures(turn.toolCalls);
    const undone = Boolean(status?.undone);
    const canContinue = Boolean(turn.error && assistantTurnCanContinue(turn.errorReason));

    return (
        <div className="canvas-assistant-turn">
            <CanvasAssistantUserMessage text={turn.userText} selectedCount={turn.selectedNodeIds?.length ?? 0} />
            <CanvasAssistantAttachments attachments={turn.attachments || []} />
            {(turn.skills || []).map(skill => <span className="canvas-assistant-chip" key={skill.skillId}>技能：{skill.skillName || skill.skillId} · {skill.version || skill.versionId}</span>)}
            {turn.supplementInputs?.length ? turn.supplementInputs.map((input, index) => <div key={`supplement:${index}`}>
                <CanvasAssistantUserMessage text={input.message} selectedCount={0} /><CanvasAssistantAttachments attachments={input.attachments || []} />
                {(input.skills || []).map(skill => <span className="canvas-assistant-chip" key={skill.skillId}>技能：{skill.skillName || skill.skillId} · {skill.version || skill.versionId}</span>)}
            </div>) : (turn.supplements || []).map((text, index) => <CanvasAssistantUserMessage key={`supplement:${index}`} text={text} selectedCount={0} />)}
            {turn.reply ? <CanvasAssistantReply text={turn.reply} /> : null}
            {turn.cancelled ? <p className="canvas-assistant-meta">这一条已经停下了。</p> : null}
            {turn.error ? (
                <div className={canContinue ? "canvas-assistant-incomplete" : "canvas-assistant-feedback"} role="status">
                    <strong>{canContinue ? "尚未完成" : "这一步没有完成"}</strong>
                    <span className={canContinue ? undefined : "canvas-assistant-failed"}>{undone ? ASSISTANT_UNDONE_INCOMPLETE_TEXT : agentAssistantFailureText(turn.errorReason ?? undefined, "这一轮没有全部完成，请核对已经落地的改动。")}</span>
                    {canContinue && onContinue && !undone ? <>
                        <Button size="small" onClick={onContinue}>继续处理</Button>
                        <span className="canvas-assistant-meta">在输入框里确认或补充要求后发送。</span>
                    </> : null}
                </div>
            ) : null}

            {failedActions.length > 0 ? (
                <div className="canvas-assistant-feedback" role="status">
                    {failedActions.map((text) => (
                        <span key={text} className="canvas-assistant-failed">
                            {text}
                        </span>
                    ))}
                </div>
            ) : null}

            {summary ? (
                <div className="canvas-assistant-change">
                    <strong>{summary}</strong>
                    {undone ? (
                        <span className="canvas-assistant-meta">{changedCanvasCount > 1 ? "已撤销这一轮全部画布改动" : "已撤销"}</span>
                    ) : (
                        <>
                            {changedCanvasCount > 1 ? <span className="canvas-assistant-meta">撤销会恢复这 {changedCanvasCount} 个画布本轮的全部改动。</span> : null}
                            <div className="canvas-assistant-card-actions">
                                {changedNodeIds.length > 0 ? (
                                    <Button type="text" size="small" icon={<Crosshair className="size-3.5" />} onClick={() => onLocate(changedNodeIds)}>
                                        在画布上查看
                                    </Button>
                                ) : null}
                                <Button type="text" size="small" icon={<Undo2 className="size-3.5" />} loading={status?.undoing} onClick={() => onUndo(turn.turnId)}>
                                    撤销这一轮
                                </Button>
                            </div>
                            {status?.undoFailure ? <span className="canvas-assistant-meta">{changedCanvasCount > 1 && status.undoFailure === "canvas_changed" ? "其中一个画布后来又改过，这一轮未撤销。" : assistantUndoFailureText(status.undoFailure)}</span> : null}
                        </>
                    )}
                </div>
            ) : null}

            {(turn.proposals || []).map((proposal) => {
                const started = handledProposals.has(proposal.proposalId);
                const skipped = handledProposals.has(dismissedProposalKey(proposal.proposalId));
                const selectedModel = proposal.modelKey || proposal.model;
                const portrait = seedancePortraitModel(selectedModel);
                const profile = seedancePortraitLabel(selectedModel) ? resolveModelChannel(config, selectedModel).modelProfiles?.find((item) => item.model === modelOptionName(selectedModel)) : undefined;
                const priceError = portrait ? portraitGenerationError(config, selectedModel) : "";
                return (
                    <div key={proposal.proposalId} className="canvas-assistant-card">
                        <span style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{assistantProposalText(proposal, portraitPriceLines(profile?.videoPricing))}</span>
                        {priceError && !started && !skipped ? <span className="canvas-assistant-meta" role="status">{priceError}</span> : null}
                        {!skipped && proposalFeedback?.[proposal.proposalId] ? <span className="canvas-assistant-meta" role="status">{proposalFeedback[proposal.proposalId]}</span> : null}
                        {started ? (
                            <span className="canvas-assistant-meta">已开始生成</span>
                        ) : skipped ? (
                            <span className="canvas-assistant-meta">这次没有生成</span>
                        ) : (
                            <div className="canvas-assistant-card-actions">
                                <Button size="small" type="primary" autoInsertSpace={false} disabled={Boolean(priceError)} onClick={() => onRunProposal(proposal)}>生成</Button>
                                <Button size="small" onClick={() => onDismissProposal(proposal.proposalId)}>先不用</Button>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
