import { Button } from "antd";
import { Fragment } from "react";
import { ChevronRight, Film } from "lucide-react";
import { ASSISTANT_PROPOSAL_INVALIDATED_TEXT, ASSISTANT_PROPOSAL_UNDONE_TEXT, type AssistantGenerationProposal, type AssistantTurn } from "@/services/api/agent-assistant";
import type { CanvasNodeData } from "@/types/canvas";
import { modelOptionName, resolveModelChannel, useEffectiveConfig } from "@/stores/use-config-store";
import { portraitPriceLines, seedancePortraitModel } from "@/lib/seedance-portrait";
import { portraitGenerationError } from "@/lib/model-selection";
import { assistantProposalProgress, assistantProposalText } from "./canvas-assistant-copy";
import { dismissedProposalKey } from "./use-canvas-assistant";

type Props = {
    proposal: AssistantGenerationProposal;
    turn: AssistantTurn;
    placement?: "current" | "pending-history" | "history";
    handledProposals: ReadonlySet<string>;
    undone?: boolean;
    disabled?: boolean;
    running?: boolean;
    feedback?: string;
    nodes?: CanvasNodeData[];
    onRun: () => void;
    onDismiss: () => void;
    onCheckResults?: (nodeIds: string[]) => void;
};

export function CanvasAssistantProposalCard({ proposal, turn, placement = "current", handledProposals, undone, disabled, running, feedback, nodes, onRun, onDismiss, onCheckResults }: Props) {
    const config = useEffectiveConfig();
    const started = handledProposals.has(proposal.proposalId);
    const skipped = handledProposals.has(dismissedProposalKey(proposal.proposalId));
    const pending = !started && !skipped && !undone && !turn.proposalsInvalidated && !turn.cancelled;
    const actionable = pending && placement === "current";
    const title = proposal.production ? "制作方案" : "生成方案";
    const targets = proposal.production?.targets;
    const summary = targets ? [
        ["image", "张图片"], ["video", "段视频"], ["audio", "段音频"],
    ].flatMap(([kind, label]) => {
        const count = targets.filter(target => target.kind === kind).length;
        return count ? [`${count} ${label}`] : [];
    }).join(" · ") : `${proposal.nodeIds.length} 个节点`;
    const model = proposal.modelKey || proposal.model;
    const profile = proposal.kind === "video" ? resolveModelChannel(config, model).modelProfiles?.find(item => item.model === modelOptionName(model)) : undefined;
    const priceError = seedancePortraitModel(model) ? portraitGenerationError(config, model) : "";
    const progress = started && nodes ? assistantProposalProgress(proposal, nodes) : null;
    const status = undone ? "已撤销" : started ? "已确认" : skipped ? "已略过" : turn.proposalsInvalidated ? "已失效" : turn.cancelled ? "已停止" : placement === "pending-history" ? "待确认 · 见输入框上方" : placement === "history" ? "历史记录" : "等待确认";
    const inactiveNotice = started ? progress?.text || "已开始生成" : undone ? ASSISTANT_PROPOSAL_UNDONE_TEXT : skipped ? "这次没有生成" : turn.proposalsInvalidated ? ASSISTANT_PROPOSAL_INVALIDATED_TEXT : null;
    const details = <details className="canvas-assistant-proposal-details">
        <summary><ChevronRight size={12} aria-hidden />{placement === "current" ? <><span>{summary}</span><small>查看详情</small></> : "查看素材、参数与提示词"}</summary>
        <div>{proposal.note ? <p>{proposal.note}</p> : null}{targets ? <>
            <table className="canvas-assistant-targets"><caption className="sr-only">本次制作素材和参数</caption><thead><tr><th scope="col">素材</th><th scope="col">参数</th></tr></thead><tbody>{targets.map(target => {
                const labels: Record<string, string> = { size: "画幅", quality: "质量", vquality: "分辨率", seconds: "秒数", count: "数量", generateAudio: "生成声音", audioVoice: "音色", audioSpeed: "语速", audioFormat: "音频格式", audioInstructions: "朗读指令", transparentBackground: "透明背景", watermark: "水印" };
                const parameters = Object.entries(target.parameters).filter(([key]) => labels[key]);
                return <Fragment key={target.nodeId}><tr><th scope="row"><strong>{target.title}</strong><small>{target.modelKey.split("::").pop()?.split("/").pop()}</small></th><td>
                    {parameters.length ? <dl>{parameters.map(([key, value]) => <div key={key}><dt>{labels[key]}</dt><dd>{value}</dd></div>)}</dl> : <span className="canvas-assistant-meta">默认参数</span>}
                    {target.referenceNodeIds.length ? <span className="canvas-assistant-meta">{target.referenceNodeIds.length} 份参考素材</span> : null}
                </td></tr><tr className="canvas-assistant-target-prompt-row"><td colSpan={2}><details className="canvas-assistant-target-prompt"><summary>{target.kind === "audio" ? "台词" : "提示词"}</summary><p>{target.prompt}</p></details></td></tr></Fragment>;
            })}</tbody></table>
            {portraitPriceLines(profile?.videoPricing).map(line => <p key={line}>{line}</p>)}
            {actionable ? <p className="canvas-assistant-meta">确认后按此方案生成素材，并自动完成声音、字幕和剪辑。素材按所选渠道计费；失败后确认新方案重新生成也会重新计费，新增或修改生成内容时会重新确认。</p> : null}
        </> : assistantProposalText(proposal, portraitPriceLines(profile?.videoPricing), actionable)}</div>
    </details>;

    if (placement !== "current") return <details className="canvas-assistant-proposal-history">
        <summary><ChevronRight size={12} aria-hidden /><span><strong>{title}</strong><small>{summary}</small></span><small>{status}</small></summary>
        <div className="canvas-assistant-proposal-history-body"><span className="canvas-assistant-meta">{summary}</span>{proposal.note ? <p>{proposal.note}</p> : null}{details}
            {inactiveNotice ? <span className="canvas-assistant-meta">{inactiveNotice}</span> : null}
            {started && progress && onCheckResults && !undone && !proposal.production ? <Button size="small" disabled={running || !progress.ready} onClick={() => onCheckResults(progress.nodeIds)}>检查结果</Button> : null}
            {feedback ? <span className="canvas-assistant-meta">{feedback}</span> : null}
        </div>
    </details>;

    return <section className="canvas-assistant-production-action" aria-label="当前待确认方案">
        <header><Film size={15} aria-hidden /><strong>当前{title}</strong><span>{status}</span></header>
        {details}
        {actionable ? <>
            {priceError ? <span className="canvas-assistant-meta" role="status">{priceError}</span> : null}
            {feedback ? <span className="canvas-assistant-meta" role="status">{feedback}</span> : null}
            <div className="canvas-assistant-proposal-commands"><span title="未提供报价时费用未知，完整说明见方案详情">按渠道计费</span><div className="canvas-assistant-card-actions"><Button size="small" type="primary" autoInsertSpace={false} loading={running} disabled={disabled || Boolean(priceError)} onClick={onRun}>{proposal.production ? "确认并制作整片" : "生成"}</Button><Button size="small" disabled={running} onClick={onDismiss}>先不用</Button></div></div>
        </> : <>
            {inactiveNotice ? <span className="canvas-assistant-meta" role="status">{inactiveNotice}</span> : null}
            {started && progress && onCheckResults && !undone && !proposal.production ? <Button size="small" disabled={running || !progress.ready} onClick={() => onCheckResults(progress.nodeIds)}>检查结果</Button> : null}
        </>}
    </section>;
}
