import type { CostEstimate, CostSummary } from "./cost-estimate";

/** 后端给出的不可用原因（穷举，见契约 A1）；未知值一律走兜底文案。 */
export type AssistantUnavailableReason =
    | "model_not_configured"
    | "credential_missing"
    | "model_protocol_unsupported"
    | "host_starting"
    | "host_busy"
    | "host_start_failed"
    | "host_unreachable";

export type AssistantModelInfo = {
    id: string;
    channelId: string;
    channelName: string;
};

export type AssistantPermissionMode = "read-only" | "canvas" | "full-access";

export function assistantPermissionMode(value: unknown): AssistantPermissionMode {
    return value === "read-only" || value === "full-access" ? value : "canvas";
}

export type AssistantThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export function assistantThinkingLevel(value: unknown): AssistantThinkingLevel {
    return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high"
        ? value
        : "low";
}

export type AssistantContextUsage = {
    estimatedTokens: number;
    contextWindow: number;
    percent: number | null;
    totalInput: number;
    totalOutput: number;
    cacheRead: number;
    cacheWrite: number;
};

export type AgentHostStatus = {
    available: boolean;
    reason?: string;
    model?: AssistantModelInfo;
    url?: string;
    health?: { raw?: string };
};

/**
 * 模型思考过程的一个可读片段。
 *
 * 宿主只投影可读纯文本：签名、加密占位、工具参数和上游原始报文都不在这里。
 * 一个回合的思考会被模型拆成多段（中间夹工具调用），`status` 表示这一段是否还在生成。
 */
export type AssistantReasoningSegment = {
    id: string;
    text: string;
    status: "streaming" | "done";
};

export type AgentToolCall = {
    toolCallId?: string;
    tool: string;
    args?: Record<string, unknown>;
    isError?: boolean;
    error?: string;
    replayed?: boolean;
    /** Whitelisted successful media result, not model prose or tool arguments. */
    mediaFacts?: AssistantMediaFacts;
    mediaEvidence?: AssistantMediaFacts[];
};

export type AssistantMediaFacts = {
    source: { resourceId: string; version: string; startMs: number; endMs: number; nodeId?: string };
    mode: "frames" | "video" | "audio" | "check";
    durationMs: number;
    hasAudio: boolean;
    silenceIntervals?: { startMs: number; endMs: number }[];
    meanDb?: number;
    peakDb?: number;
};

/** 一个回合真正落到画布上的改动；没写任何东西时后端给 null。 */
export type AssistantTurnChange = {
    revisionBefore: number;
    revisionAfter: number;
    createdNodeIds: string[];
    updatedNodeIds: string[];
    createdEdgeIds: string[];
    timelineUpdated?: boolean;
    deletedNodeIds?: string[];
    deletedEdgeIds?: string[];
    documentUpdated?: boolean;
    canvasChanges?: AssistantCanvasChange[];
};

export type AssistantCanvasChange = Omit<AssistantTurnChange, "canvasChanges"> & { canvasId: string; operationIds: string[] };

export type GenerationOrderTargetView = {
    nodeId: string;
    title: string;
    kind: "image" | "video" | "audio";
    model?: string;
    modelKey: string;
    pricing?: unknown;
    estimate?: CostEstimate;
    prompt: string;
    parameters: Record<string, string>;
    metadata?: Record<string, unknown>;
    referenceNodeIds: string[];
};

export type GenerationOrder = {
    orderId: string;
    proposalId: string;
    canvasId: string;
    canvasRevision: number;
    modelConfigRevision: number;
    callerKind: "manual" | "assistant" | "external";
    callerClient?: string;
    approvalMode: "ask" | "caller" | "auto";
    status: "pending" | "approved" | "submitted" | "rejected";
    approvedBy?: string;
    approvedAt?: string;
    kind: "image" | "video" | "audio" | "mixed";
    model: string;
    modelKey: string;
    pricing?: unknown;
    note?: string;
    nodeIds: string[];
    productionNodeIds?: string[];
    targetViews?: GenerationOrderTargetView[];
    sourceTurnId?: string;
    sessionId?: string;
    estimatedCny?: number;
    taskIds?: string[];
    regenerate?: boolean;
    continuationId?: string;
    createdAt: string;
    updatedAt: string;
};

/** 付费生成提议（生成单）：后端只登记，不生成、不扣费，批准后统一按生成单执行。 */
export type AssistantGenerationProposal = {
    proposalId: string;
    orderId?: string;
    kind: "image" | "video" | "audio" | "mixed";
    nodeIds: string[];
    model: string;
    modelKey: string;
    pricing?: unknown;
    /** 后端按价格目录算出的合计，nodeIds 这一批的费用。 */
    estimate?: CostSummary;
    approvalMode?: "ask" | "caller" | "auto";
    status?: "pending" | "approved" | "submitted" | "rejected";
    note?: string;
    regenerate?: boolean;
    targets?: GenerationOrderTargetView[];
    order?: GenerationOrder;
    production?: { targets: { nodeId: string; title: string; kind: "image" | "video" | "audio"; modelKey: string; prompt: string; parameters: Record<string, string>; metadata?: Record<string, unknown>; referenceNodeIds: string[]; estimate?: CostEstimate }[]; estimate?: CostSummary };
    source?: { canvasId: string; canvasRevision: number; modelConfigRevision: number };
};

export type AssistantScriptOutputFile = {
    path: string;
    size: number;
    resourceId?: string;
    mimeType?: string;
};

export type AssistantScriptRunResult = {
    exitCode: number;
    timedOut: boolean;
    cancelled: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    outputFiles?: AssistantScriptOutputFile[];
};

export type AssistantScriptProposal = {
    proposalId: string;
    turnId: string;
    canvasId: string;
    sessionId?: string;
    skillId: string;
    skillName: string;
    versionId: string;
    version: string;
    contentHash: string;
    scriptPath: string;
    interpreter: "python3" | "bash" | "node";
    args: string[];
    stdinPreview?: string;
    hasStdin?: boolean;
    timeoutSec: number;
    useWorkspaceOutputDir?: boolean;
    note?: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";
    result?: AssistantScriptRunResult;
};

export function normalizeAssistantProposal(proposal: AssistantGenerationProposal): AssistantGenerationProposal {
    const normalizeTarget = <T extends { parameters?: Record<string, string> | null; referenceNodeIds?: string[] | null }>(target: T): T => ({
        ...target,
        parameters: target.parameters && typeof target.parameters === "object" ? target.parameters : {},
        referenceNodeIds: Array.isArray(target.referenceNodeIds) ? target.referenceNodeIds : [],
    });
    return {
        ...proposal,
        nodeIds: Array.isArray(proposal.nodeIds) ? proposal.nodeIds : [],
        ...(proposal.targets !== undefined
            ? { targets: Array.isArray(proposal.targets) ? proposal.targets.map(normalizeTarget) : [] }
            : {}),
        ...(proposal.production
            ? {
                production: {
                    ...proposal.production,
                    targets: Array.isArray(proposal.production.targets) ? proposal.production.targets.map(normalizeTarget) : [],
                },
            }
            : {}),
    };
}

export type AssistantPlan = {
    goal: string;
    items: { id: string; title: string; status: "todo" | "doing" | "done" | "needs_user" | "blocked"; note?: string }[];
    done: number;
    total: number;
    updatedAt: string;
};

export type AgentLifecycleEvent = {
    type: "lifecycle";
    phase: "compaction" | "compaction_end" | "retry" | "retry_end" | "tool" | "tool_end" | "business";
    stage?: "processing" | "downloading" | "saving" | "saved" | "binding" | "rendering" | "exporting" | "checking" | "observation_unavailable";
    saved?: number;
    total?: number;
    toolName?: string;
    reason?: string;
    aborted?: boolean;
    willRetry?: boolean;
    attempt?: number;
    maxAttempts?: number;
    success?: boolean;
};

export type StreamHandlers = {
    onSession?: (sessionId: string) => void;
    onDelta?: (delta: string) => void;
    onText?: (text: string) => void;
    /** 整段替换本回合的思考片段；宿主每次给的都是当前完整状态。 */
    onReasoning?: (segments: AssistantReasoningSegment[]) => void;
    onPlan?: (plan: AssistantPlan | null) => void;
    onTurnEnd?: (end: AgentTurnEnd) => void;
    onLifecycle?: (event: AgentLifecycleEvent) => void;
};

/**
 * 界面明确引用、且后端会再校验归属的额外资源。
 * 内置助手默认能读当前画布与画布关联的素材/任务；额外画布只读，素材只读。
 */
export type AgentChatReference = {
    kind: "asset" | "canvas" | "resource";
    id: string;
};

export type AssistantAttachmentPurpose = "analysis" | "reference" | "character" | "scene" | "style" | "motion" | "first-frame" | "last-frame" | "rhythm" | "sound";
export type AssistantAttachment = {
    resourceId: string;
    kind: "image" | "video" | "audio" | "file";
    name: string;
    mimeType: string;
    bytes: number;
    purpose: AssistantAttachmentPurpose;
    start?: number;
    end?: number;
    durationMs?: number;
    nodeId?: string;
    assetId?: string;
};

/** skillName/version 是后端在选定时记下的显示名；缺失表示技能已不可识别，界面不得退回显示标识。 */
export type AssistantSkillSelection = { skillId: string; versionId: string; contentHash: string; skillName?: string; version?: string };
export type AssistantSupplementInput = { message: string; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[] };

export type AgentChatRequest = {
    permissionMode?: AssistantPermissionMode;
    signal?: AbortSignal;
    selectedNodeIds?: string[];
    /** 当前消息里 @ 引用到的资源；后端逐项校验归属，任何一项非法都整轮拒绝。 */
    references?: AgentChatReference[];
    /** 只发当前会话；后端发现它已不是该画布的当前会话会整回合拒绝。 */
    sessionId?: string;
    /** 这次发送自己的标识：停止只指向它；同一标识重发不会再执行一次。 */
    requestId?: string;
    attachments?: AssistantAttachment[];
    skills?: AssistantSkillSelection[];
};

export type AgentTurnEnd = {
    /** Backend projection of the source turn's durable intent fence. */
    proposalsInvalidated?: boolean;
    type: "turn_end";
    turnId?: string;
    /** Go-confirmed generation continuation identity, never inferred from text. */
    continuationId?: string;
    /** 宿主本回合实际使用的会话；旧 JSONL 会话首次发消息会交接给新的 Durable 会话，界面据此更新。 */
    sessionId?: string;
    permissionMode?: AssistantPermissionMode;
    reply: string;
    toolCalls: AgentToolCall[];
    /** 本回合模型返回的思考片段；宿主总是写这个字段（没有可读思考时是空数组），旧记录可能没有。 */
    reasoning?: AssistantReasoningSegment[];
    change?: AssistantTurnChange | null;
    proposals?: AssistantGenerationProposal[];
    scriptProposals?: AssistantScriptProposal[];
    outputs?: AssistantTurnOutput[];
    plan?: AssistantPlan | null;
    error: string | null;
    errorReason?: string | null;
    cancelled: boolean;
    supplements?: string[];
    attachments?: AssistantAttachment[];
    skills?: AssistantSkillSelection[];
    supplementInputs?: AssistantSupplementInput[];
    persistence?: string;
    metrics?: { firstTokenMs: number | null; totalMs: number };
};

export type AssistantTurn = {
    proposalsInvalidated?: boolean;
    turnId: string;
    continuationId?: string;
    permissionMode?: AssistantPermissionMode;
    userText: string;
    selectedNodeIds: string[];
    reply: string;
    toolCalls: AgentToolCall[];
    /** 与 AgentTurnEnd.reasoning 同形；旧记录没有这个字段，没有可读思考的回合是空数组。 */
    reasoning?: AssistantReasoningSegment[];
    change: AssistantTurnChange | null;
    proposals: AssistantGenerationProposal[];
    scriptProposals?: AssistantScriptProposal[];
    outputs?: AssistantTurnOutput[];
    plan?: AssistantPlan | null;
    error: string | null;
    errorReason?: string | null;
    cancelled: boolean;
    supplements?: string[];
    attachments?: AssistantAttachment[];
    skills?: AssistantSkillSelection[];
    supplementInputs?: AssistantSupplementInput[];
    createdAt: string;
};

/** Trusted render & deliverable receipts in creation order; task/resource access still uses owned APIs. */
export type AssistantTurnOutput = { taskId: string; kind: "video"; sourceRevision?: number }
    | { kind: "project"; resourceId: string; fileName: string; sourceRevision?: number }
    | { kind: "file"; resourceId: string; fileName: string; mimeType?: string; bytes?: number };

export type AssistantSessionForkSource = {
    sessionId: string;
    turnId: string;
    turnIndex: number;
    sourceTitle?: string;
    createdAt?: string;
};

export type AssistantSessionSummary = {
    sessionId: string;
    title: string;
    updatedAt: string;
    turnCount: number;
    forkedFrom?: AssistantSessionForkSource;
};

export type AssistantSessionList = {
    currentSessionId: string | null;
    sessions: AssistantSessionSummary[];
};

export type AssistantHistory = {
    sessionId: string;
    plan?: AssistantPlan | null;
    pausedTurnReason?: string | null;
    thinkingLevel?: AssistantThinkingLevel;
    contextUsage?: AssistantContextUsage | null;
    forkedFrom?: AssistantSessionForkSource | null;
    turns: (AssistantTurn & { undone?: boolean })[];
    active?: { turnId: string; requestId?: string; continuationId?: string; userText: string; selectedNodeIds: string[]; attachments?: AssistantAttachment[]; skills?: AssistantSkillSelection[];
        references?: AgentChatReference[]; supplements?: string[]; supplementInputs?: AssistantSupplementInput[]; permissionMode?: AssistantPermissionMode; createdAt: string; status: "running";
        /** 正在进行的回合此刻的进度（例如模型重试），只用于展示，结束后不再返回。 */
        lifecycle?: AgentLifecycleEvent | null; plan?: AssistantPlan | null; streamed?: string;
        /** 正在进行回合的思考片段，与流式推送的 reasoning_snapshot 同形。 */
        reasoning?: AssistantReasoningSegment[] } | null;
};

/** 撤销失败的机器可读原因，映射到卡片里的一句话。 */
export type AssistantUndoFailure = "canvas_changed" | "already_undone" | "no_change" | "unknown";

export type AssistantUndoResult = { ok: true; revision: number } | { ok: false; failure: AssistantUndoFailure };

/**
 * 停止的结果：stopped 正在执行，已停下；finished 已经结束；
 * pending 助手还没开始处理它，之后到达也不会执行。
 */
export type AgentCancelState = "stopped" | "finished" | "pending";

/**
 * 与后端 agent_proxy 超时预算匹配，避免默认 4s 请求超时误报「没能读取对话」：
 * - 状态查询：探测 + 宿主冷启动宽限（20s + 3s）-> 25s
 * - 会话/历史只读：宿主冷启动（20s）+ 代理读取（30s）-> 55s
 * - 会话切换/创建/删除/重启：停止延续任务（30s）+ 宿主转发（30s）-> 65s
 */
export const ASSISTANT_STATUS_TIMEOUT_MS = 25_000;
export const ASSISTANT_READ_TIMEOUT_MS = 55_000;
export const ASSISTANT_MUTATION_TIMEOUT_MS = 65_000;

/**
 * 流式结束但本次回合没有结算事件时的用户可见错误。
 *
 * 宿主对每一次对话都恰好发一条 `turn_end`；收到它才算这一回合真的结束。
 * 把「流断了」当成正常结束会让面板停在一段半截回复上，必须显式失败。
 */
export const AGENT_STREAM_INCOMPLETE_MESSAGE = "创作助手的回复没有完整结束，请再试一次";

/**
 * 服务端失败原因只用于分支，展示给用户的永远是用户语。
 * 这些 reason 由后端给出（见 handler/agent_proxy.go 与 agent_host_lifecycle.go）。
 */
export function agentAssistantFailureText(reason: string | undefined, fallback = "创作助手暂时不可用，请稍后再试") {
    switch (reason) {
        case "skill_instruction_too_large":
            return "所选技能包超出解压上限或不可读取，请检查技能包后重试。";
        case "skill_context_budget_exceeded":
        case "skill_context_model_unavailable":
            return "当前所选技能内容超出模型单次可处理的范围，请精简技能内容或更换上下文更大的助手模型后重试。";
        case "skill_version_unavailable":
        case "skill_context_pin_unavailable":
        case "skill_package_unreadable":
        case "skill_file_unavailable":
            return "所选技能不可用或版本已变化，请在输入框移除该技能后重新添加再试。";
        case "skill_not_installed":
        case "skill_not_selected":
        case "invalid_skill_selection":
            return "所选技能未安装或已停用，请重新选择可用技能后再试。";
        case "skill_capability_unavailable":
            return "当前技能需要多模态理解等能力，请先在模型设置中配置对应模型后再试。";
        case "skill_context_unavailable":
        case "skill_context_service_unavailable":
        case "skill_scope_reset_pending":
            return "技能状态正在更新或暂时不可用，请重试或移除当前技能后再试。";
        case "script_interpreter_missing":
            return "本机缺少运行该技能脚本所需的解释器环境（如 Python 或 Bash），请安装后再试。";
        case "script_interpreter_unsupported":
        case "unsupported_script_interpreter":
            return "该技能包含暂不支持直接运行的脚本类型（目前支持 Python、Bash、Node.js）。";
        case "body_too_large":
        case "http_413":
            return "本次消息内容过大，请缩短消息或减少附件后重试。";
        case "turn_timeout":
            return "模型响应时间过长，这一轮尚未完成。已完成的改动会保留，可以继续处理。";
        case "turn_interrupted":
            return "上一轮执行中断，已经落地的改动已保留。请查看画布和改动记录后再继续。";
        case "turn_request_budget_exhausted":
        case "turn_tool_step_budget_exhausted":
            return "这一轮已达到调用上限，已停止继续执行。可以发送新消息继续，已落地的改动会保留。";
        case "request_budget_exhausted":
            return "当前配置的总调用预算已用完，请检查助手运行配置。已落地的改动会保留。";
        case "request_budget_storage_unavailable":
            return "预算记录无法读取或保存，已停止继续调用。请检查磁盘空间和数据目录权限；仍失败时，请从有效备份恢复预算记录后重启助手。";
        case "model_network_error":
            return "无法连接模型服务。若开启了系统代理，可在「通用设置 → 网络代理」切为不使用代理后重试；已完成的改动会保留。";
        case "model_error":
        case "provider_error":
            return "模型没有完成回复。已经完成的操作会保留，请检查结果后再继续。";
        case "model_request_failed":
            return "模型暂时没有完成响应。已完成的改动会保留，可以继续处理。";
        case "host_unreachable":
        case "host_unhealthy":
        case "host_token_missing":
        case "host_command_missing":
        case "host_start_failed":
            return "创作助手还没准备好，请稍后再试";
        case "unauthenticated":
        case "read_only_client":
        case "forbidden":
            return "当前页面无法使用创作助手，请重新打开画布";
        case "session_busy":
            return "上一条消息还在处理中，请等它结束";
        case "session_not_found":
            return "没找到这条对话记录，可能已经被删除";
        case "session_not_current":
            return "你已经换到别的对话了，请重新发送这条消息";
        case "session_not_running":
            return "这一轮已经结束，请查看最新结果后发送新消息";
        case "invalid_thinking_level":
            return "思考深度设置不受支持，请重新选择后再试。";
        case "compaction_failed":
            return "压缩上下文失败，当前对话内容已保留，请稍后再试。";
        case "host_timeout":
            return "助手处理耗时过长，请稍后重新读取对话查看结果。";
        default:
            return fallback;
    }
}

/** 已收到回合终态的业务失败，不等同于断流后的「执行结果未知」。 */
export class AgentTurnFailedError extends Error {
    constructor(readonly reason?: string | null) {
        super(agentAssistantFailureText(reason ?? undefined, "这一回合没有完成，请再试一次"));
        this.name = "AgentTurnFailedError";
    }
}

/** 宿主明确说明只是这条观察流断开（observer_error），回合仍由宿主持有：应改为读取结果，而不是报失败。 */
export class AgentStreamDetachedError extends Error {
    constructor(readonly reason: string) {
        super(AGENT_STREAM_INCOMPLETE_MESSAGE);
        this.name = "AgentStreamDetachedError";
    }
}

/** The chat was not sent, or Go explicitly rejected it before beginning a turn. */
export class AgentChatNotAdmittedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentChatNotAdmittedError";
    }
}
