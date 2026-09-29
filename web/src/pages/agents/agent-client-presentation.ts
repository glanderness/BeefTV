import type { AgentClient, AgentClientKind, AgentClientMode, AgentClientSetup } from "@/services/api/agent-clients";

export const agentClientKinds: AgentClientKind[] = ["codex", "claude", "cursor", "other"];

const kindLabels: Record<AgentClientKind, string> = {
    codex: "Codex",
    claude: "Claude Code",
    cursor: "Cursor",
    other: "其他 MCP 客户端",
};

const kindSummaries: Record<AgentClientKind, string> = {
    codex: "在终端里连接 Codex。",
    claude: "在终端里连接 Claude Code。",
    cursor: "在 Cursor 的配置里连接。",
    other: "支持 MCP 的工具都能连。",
};

const modeLabels: Record<AgentClientMode, string> = {
    "read-only": "只能读取",
    "read-write": "可以修改画布",
};

const modeSummaries: Record<AgentClientMode, string> = {
    "read-only": "能看画布上的内容，不会改动。",
    "read-write": "能新建和修改画布上的内容。",
};

export function agentClientKindLabel(kind: AgentClientKind | string) {
    return kindLabels[kind as AgentClientKind] || "其他 MCP 客户端";
}

export function agentClientKindSummary(kind: AgentClientKind) {
    return kindSummaries[kind];
}

export function agentClientModeLabel(mode: AgentClientMode | string) {
    return modeLabels[mode as AgentClientMode] || modeLabels["read-only"];
}

export function agentClientModeSummary(mode: AgentClientMode) {
    return modeSummaries[mode];
}

export type AgentClientSetupBlock = {
    /** 待粘贴的整段内容；凭证只存在于这里，页面不再单独展示。 */
    text: string;
    format: "command" | "json";
    instruction: string;
};

const COMMAND_INSTRUCTION = "粘贴到终端运行。";

const configInstructions: Record<AgentClientKind, string> = {
    codex: "粘贴到你使用的工具的 MCP 配置文件里。",
    claude: "粘贴到你使用的工具的 MCP 配置文件里。",
    cursor: "粘贴到 ~/.cursor/mcp.json。",
    other: "粘贴到你使用的工具的 MCP 配置文件里。",
};

/**
 * codex / claude 给一条终端命令，cursor / other 给一段配置。
 * 后端只会给出其中一种；若与类型不一致，按实际给到的那一种展示，避免页面空白。
 */
export function agentClientSetupBlock(setup: AgentClientSetup | undefined): AgentClientSetupBlock | null {
    if (!setup) return null;
    const command = setup.command?.trim() || "";
    const json = setup.json?.trim() || "";
    const prefersCommand = setup.kind === "codex" || setup.kind === "claude";
    const text = prefersCommand ? command || json : json || command;
    if (!text) return null;
    const format: "command" | "json" = text === command ? "command" : "json";
    return { text, format, instruction: format === "command" ? COMMAND_INSTRUCTION : configInstructions[setup.kind] || configInstructions.other };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 最近使用：没用过要说没用过，不要显示一个假的时间。 */
export function agentClientLastUsedLabel(lastUsedAt: string | null | undefined, now: number = Date.now()) {
    if (!lastUsedAt) return "还没用过";
    const used = Date.parse(lastUsedAt);
    if (!Number.isFinite(used)) return "还没用过";
    const elapsed = now - used;
    if (elapsed < MINUTE) return "刚刚";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`;
    if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} 天前`;
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(used);
}

export function agentClientDisplayLabel(client: AgentClient) {
    return client.label?.trim() || agentClientKindLabel(client.kind);
}
