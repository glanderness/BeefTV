// 助手面板里所有用户可见文案的唯一来源：机器可读原因、操作名和改动摘要都在这里
// 翻译成用户语。组件只负责排版，不自己拼文案，避免同一种状态在两处写出两句话。
import type { AgentLifecycleEvent, AgentToolCall, AssistantGenerationProposal, AssistantTurnChange, AssistantUndoFailure } from "@/services/api/agent-assistant";

export type AssistantStatusAction = "model-settings" | "retry";

export type AssistantStatusNotice = {
    text: string;
    actionLabel?: string;
    action?: AssistantStatusAction;
    /** 正在启动时要更频繁地复查状态，其余情况按常规节奏。 */
    starting?: boolean;
};

/** 兜底文案：原因缺失或后端给了我们还不认识的值时用这一句。 */
export const ASSISTANT_UNAVAILABLE_FALLBACK = "助手暂时用不了，请稍后再试";

export function assistantStatusNotice(reason: string | undefined): AssistantStatusNotice {
    switch (reason) {
        case "model_not_configured":
        case "model_protocol_unsupported":
            return { text: "还没有可用的助手模型", actionLabel: "去模型配置", action: "model-settings" };
        case "credential_missing":
            return { text: "BeefAPI 还没连接好", actionLabel: "去连接", action: "model-settings" };
        case "host_starting":
            return { text: "助手正在启动…", starting: true };
        case "host_start_failed":
        case "host_unreachable":
            return { text: "助手没有启动成功", actionLabel: "重试", action: "retry" };
        default:
            return { text: ASSISTANT_UNAVAILABLE_FALLBACK, actionLabel: "重试", action: "retry" };
    }
}

/** 工具名是内部标识，用户只该看到「做了什么」。 */
export function assistantActionLabel(tool: string | undefined): string {
    const name = (tool || "").trim();
    if (name.startsWith("asset.")) return "读取素材";
    switch (name) {
        case "canvas.nodes.create":
            return "新建节点";
        case "canvas.node.update":
            return "修改节点";
        case "canvas.edge.create":
            return "连线";
        case "canvas.get":
        case "canvas.search":
            return "读取画布";
        case "canvas.generation.propose":
            return "准备生成";
        default:
            return "改动画布";
    }
}

/** 失败的那一步用一句话说清楚是哪件事没成。 */
export function assistantFailedActionText(call: AgentToolCall): string {
    return `${assistantActionLabel(call.tool)}没有成功`;
}

/**
 * 这一轮改了什么：只数真实落地的对象，不复述用户的选择数量。
 * 没有任何改动时返回 null，卡片整块不出现。
 */
export function assistantChangeSummary(change: AssistantTurnChange | null | undefined): string | null {
    if (!change) return null;
    const parts: string[] = [];
    const created = change.createdNodeIds?.length ?? 0;
    const updated = change.updatedNodeIds?.length ?? 0;
    const edges = change.createdEdgeIds?.length ?? 0;
    if (created > 0) parts.push(`新建 ${created} 个节点`);
    if (updated > 0) parts.push(`修改 ${updated} 个节点`);
    if (edges > 0) parts.push(`连了 ${edges} 条线`);
    if (!parts.length) return null;
    return parts.join("，");
}

/** 改动卡片要定位的对象：新建的和被改过的都算。 */
export function assistantChangedNodeIds(change: AssistantTurnChange | null | undefined): string[] {
    if (!change) return [];
    const ids = new Set<string>();
    for (const id of change.createdNodeIds || []) ids.add(id);
    for (const id of change.updatedNodeIds || []) ids.add(id);
    return [...ids];
}

export function assistantUndoFailureText(failure: AssistantUndoFailure): string {
    switch (failure) {
        case "canvas_changed":
            return "这之后画布又改过，不能直接撤销";
        case "already_undone":
            return "这一轮已经撤销过了";
        case "no_change":
            return "这一轮没有改动画布";
        default:
            return "撤销没有成功，请再试一次";
    }
}

/** 提议可能来自自建渠道，不能把所有费用都归到 BeefAPI。 */
export function assistantProposalText(proposal: AssistantGenerationProposal): string {
    const count = proposal.nodeIds?.length ?? 0;
    const target = proposal.kind === "video" ? "视频" : "图片";
    return `生成 ${count} ${target === "视频" ? "段视频" : "张参考图片"} · ${proposal.model}\n确认后开始，按所选渠道计费。`;
}

export const ASSISTANT_STARTER_PROMPTS = [
    "把剧本拆成分镜草案",
    "给选中的镜头补充景别和情绪",
    "整理画布并按顺序连线",
    "检查哪些镜头还缺参考图",
];

/** 官方压缩/重试进度：只说现在在做什么，不提内部事件名。 */
export function assistantLifecycleText(event: Pick<AgentLifecycleEvent, "phase"> | string | null | undefined): string | null {
    const phase = typeof event === "string" ? event : event?.phase;
    switch (phase) {
        case "compaction":
            return "正在整理对话内容，方便继续。";
        case "retry":
            return "模型暂时没响应，正在再试一次。";
        default:
            return null;
    }
}

const REASONING_TAG_PREFIXES = ["</thinking>", "<thinking>", "</think>", "<think>"];

function stripDanglingReasoningTag(text: string) {
    const start = text.lastIndexOf("<");
    return start >= 0 && REASONING_TAG_PREFIXES.some((tag) => tag.startsWith(text.slice(start).toLowerCase()))
        ? text.slice(0, start) : text;
}

/**
 * 官方会话把推理放在独立的 thinking 块里，不进入回复。
 * 有的模型仍把 <thinking> 或 <think> 直接写进正文；那是草稿，不是给用户的话。
 * 代码示例里的同名标记保留。未闭合的思考区块隐藏到正文末尾，不猜测答案起点。
 */
export function assistantVisibleReply(text: string): string {
    const tokens = /`+|~{3,}|<\/?(?:think|thinking)>/gi;
    const reasoning: string[] = [];
    let output = "";
    let index = 0;
    for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
        if (!reasoning.length) output += text.slice(index, token.index);
        const marker = token[0];
        index = tokens.lastIndex;
        if (marker[0] === "`" || marker[0] === "~") {
            const delimiters = new RegExp(`${marker[0]}+`, "g");
            delimiters.lastIndex = index;
            let end = delimiters.exec(text);
            while (end && (marker.length >= 3 ? end[0].length < marker.length : end[0].length !== marker.length)) {
                end = delimiters.exec(text);
            }
            index = end ? delimiters.lastIndex : text.length;
            if (!reasoning.length) output += text.slice(token.index, index);
            tokens.lastIndex = index;
        } else if (marker[1] !== "/") {
            reasoning.push(marker.slice(1, -1).toLowerCase());
        } else if (reasoning.at(-1) === marker.slice(2, -1).toLowerCase()) {
            reasoning.pop();
        }
    }
    if (!reasoning.length) output += stripDanglingReasoningTag(text.slice(index));
    return output.trim();
}

/** 同一件事的身份：修改看节点，连线看两端，新建看有没有再次成功；读操作失败不影响画布，不单独提示。 */
function assistantActionTarget(call: AgentToolCall): string | null {
    const args = call.args || {};
    switch (call.tool) {
        case "canvas.node.update":
            return `update:${String(args.nodeId ?? "")}`;
        case "canvas.edge.create":
            return `edge:${String(args.fromNodeId ?? "")}>${String(args.toNodeId ?? "")}`;
        case "canvas.nodes.create":
            // 模型重试新建时常会调整标题或数量：之后任何一次新建成功都算这一步已完成。
            return "create";
        case "canvas.generation.propose":
            return `propose:${Array.isArray(args.nodeIds) ? args.nodeIds.join("|") : ""}`;
        default:
            return null;
    }
}

/**
 * 这一轮里最后仍没做成的事：失败后又重试成功的步骤不再提示，
 * 同类失败合并成一句，避免把助手的中间重试当成错误摆给用户。
 */
export function assistantUnresolvedFailures(calls: AgentToolCall[] | undefined): string[] {
    const list = calls || [];
    const counts = new Map<string, number>();
    list.forEach((call, index) => {
        if (!call.isError) return;
        const target = assistantActionTarget(call);
        if (!target) return;
        const resolved = list.slice(index + 1).some((later) => !later.isError && later.tool === call.tool && assistantActionTarget(later) === target);
        if (resolved) return;
        const label = assistantActionLabel(call.tool);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    });
    return [...counts.entries()].map(([label, count]) => (count > 1 ? `${label}没有成功（${count} 处）` : `${label}没有成功`));
}
