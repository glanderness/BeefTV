import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, Loader2, Send, Square } from "lucide-react";
import { Button, Tooltip } from "antd";

import {
    cancelAgentChat,
    getAgentHostStatus,
    streamAgentChat,
    type AgentHostStatus,
    type AgentToolCall,
} from "@/services/api/agent-assistant";

type PanelMessage = {
    id: string;
    role: "user" | "assistant" | "notice";
    text: string;
};

type RunState = {
    messages: PanelMessage[];
    toolCalls: AgentToolCall[];
    seenToolCallIds: Set<string>;
    streaming: boolean;
    controller: AbortController | null;
};

type Props = {
    canvasId: string;
    selectedCount: number;
    selectedNodeIds?: string[];
};

const createRun = (): RunState => ({
    messages: [],
    toolCalls: [],
    seenToolCallIds: new Set(),
    streaming: false,
    controller: null,
});

// 画布内创作助手：会话与运行句柄按画布各持一份，异步结果只写回发送时的画布。
export function CanvasAgentAssistantPanel({ canvasId, selectedCount, selectedNodeIds = [] }: Props) {
    const [collapsed, setCollapsed] = useState(false);
    const [status, setStatus] = useState<AgentHostStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    // 单一事实来源：每个画布一条运行状态；UI 只是当前画布的投影。
    const runsRef = useRef<Map<string, RunState>>(new Map());
    const activeCanvasRef = useRef(canvasId);
    const [, forceRender] = useState(0);
    const logRef = useRef<HTMLDivElement | null>(null);

    const runFor = useCallback((id: string): RunState => {
        const existing = runsRef.current.get(id);
        if (existing) return existing;
        const created = createRun();
        runsRef.current.set(id, created);
        return created;
    }, []);

    const rerenderIfActive = useCallback((id: string) => {
        if (activeCanvasRef.current === id) forceRender((value) => value + 1);
    }, []);

    // 当前画布切换：只切换投影，不搬运、不清空任何画布的历史。
    useEffect(() => {
        activeCanvasRef.current = canvasId;
        setError(null);
        forceRender((value) => value + 1);
    }, [canvasId]);

    useEffect(() => {
        let cancelled = false;
        const refresh = () => {
            getAgentHostStatus()
                .then((value) => { if (!cancelled) setStatus(value); })
                .catch(() => { if (!cancelled) setStatus({ available: false, reason: "status_unavailable" }); });
        };
        refresh();
        const timer = setInterval(refresh, 15000);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    useEffect(() => {
        const node = logRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [canvasId, collapsed, status]);

    const send = useCallback(async () => {
        const message = draft.trim();
        if (!message) return;
        // 发送时冻结归属：此后即使用户切到别的画布，结果也只写回这条 run。
        const targetCanvas = activeCanvasRef.current;
        const selectedSnapshot = [...selectedNodeIds];
        const run = runFor(targetCanvas);
        if (run.streaming) return;
        if (!status?.available) {
            setError("助手尚未启动，请在设置中启动创作助手");
            return;
        }
        setDraft("");
        setError(null);
        const runId = `${targetCanvas}:${Date.now()}`;
        run.messages = [...run.messages, { id: `${runId}-user`, role: "user", text: message }];
        run.streaming = true;
        const controller = new AbortController();
        run.controller = controller;
        rerenderIfActive(targetCanvas);
        let streamed = "";
        try {
            await streamAgentChat(targetCanvas, message, {
                onDelta: (delta) => {
                    streamed += delta;
                    const current = runFor(targetCanvas);
                    const last = current.messages[current.messages.length - 1];
                    if (last && last.id === `${runId}-stream`) {
                        current.messages = [...current.messages.slice(0, -1), { ...last, text: streamed }];
                    } else {
                        current.messages = [...current.messages, { id: `${runId}-stream`, role: "assistant", text: streamed }];
                    }
                    rerenderIfActive(targetCanvas);
                },
                onToolCall: (call) => {
                    const current = runFor(targetCanvas);
                    const key = call.toolCallId || `${call.tool}:${current.toolCalls.length}`;
                    if (current.seenToolCallIds.has(key)) return;   // 同一工具调用只显示一次
                    current.seenToolCallIds.add(key);
                    current.toolCalls = [...current.toolCalls, { ...call, toolCallId: key }];
                    rerenderIfActive(targetCanvas);
                },
                onTurnEnd: (end) => {
                    const current = runFor(targetCanvas);
                    for (const call of end.toolCalls || []) {
                        const key = call.toolCallId || `${call.tool}:${current.toolCalls.length}`;
                        if (current.seenToolCallIds.has(key)) continue;
                        current.seenToolCallIds.add(key);
                        current.toolCalls = [...current.toolCalls, { ...call, toolCallId: key }];
                    }
                    current.messages = [
                        ...current.messages.filter((item) => item.id !== `${runId}-stream`),
                        { id: `${runId}-assistant`, role: "assistant", text: end.reply || streamed || "（无回复）" },
                    ];
                    rerenderIfActive(targetCanvas);
                },
            }, controller.signal, selectedSnapshot);
        } catch (streamError) {
            const text = streamError instanceof Error ? streamError.message : String(streamError);
            if (activeCanvasRef.current === targetCanvas) setError(text);
            const current = runFor(targetCanvas);
            current.messages = [...current.messages, { id: `${runId}-notice`, role: "notice", text }];
            rerenderIfActive(targetCanvas);
        } finally {
            const current = runFor(targetCanvas);
            current.streaming = false;
            current.controller = null;
            rerenderIfActive(targetCanvas);
        }
    }, [draft, rerenderIfActive, runFor, selectedNodeIds, status]);

    // 停止只作用于当前正在查看画布的那次运行，不会取消别的画布。
    const stop = useCallback(async () => {
        const target = activeCanvasRef.current;
        const run = runFor(target);
        run.controller?.abort();
        try {
            await cancelAgentChat(target);
        } catch (cancelError) {
            setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
        }
    }, [runFor]);

    const run = runsRef.current.get(canvasId) ?? createRun();
    const streaming = run.streaming;
    const toolCalls = run.toolCalls;

    if (collapsed) {
        return (
            <Tooltip title="展开创作助手">
                <Button
                    size="small"
                    shape="circle"
                    data-canvas-no-zoom
                    onClick={() => setCollapsed(false)}
                    icon={<Bot className="size-4" />}
                />
            </Tooltip>
        );
    }

    return (
        <aside
            data-canvas-no-zoom
            className="pointer-events-auto flex flex-col overflow-hidden border border-[var(--canvas-panel-border,var(--border-color))] bg-[var(--canvas-panel-bg,var(--bg-elevated))] text-[var(--text-primary)] shadow-[var(--shadow-panel)]"
            style={{ width: "var(--canvas-panel-width, 330px)", height: 420, borderRadius: "var(--panel-radius, 10px)" }}
        >
            <header className="flex items-center justify-between gap-2 border-b border-[var(--border-color)] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Bot className="size-4 shrink-0 text-[var(--accent-color,currentColor)]" />
                    <div className="min-w-0">
                        <div className="truncate text-xs font-semibold">创作助手</div>
                        <div className="truncate text-[10px] text-[var(--text-secondary)]">
                            {selectedCount > 0 ? `本次修改 ${selectedCount} 个镜头` : "作用于当前画布"}
                        </div>
                    </div>
                </div>
                <button type="button" className="rounded p-1 hover:bg-[var(--bg-hover)]" onClick={() => setCollapsed(true)} aria-label="收起创作助手">
                    <ChevronRight className="size-4" />
                </button>
            </header>

            {status && !status.available ? (
                <div className="border-b border-[var(--border-color)] px-3 py-1.5 text-[10px] text-[var(--text-secondary)]">
                    助手尚未启动，请在设置中启动创作助手
                </div>
            ) : null}

            <div ref={logRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-xs">
                {run.messages.length === 0 ? (
                    <p className="text-[var(--text-secondary)]">描述你的创作需求，例如「给这部短剧建三镜头草案并连成链」。</p>
                ) : null}
                {run.messages.map((item) => (
                    <div
                        key={item.id}
                        className={
                            item.role === "user"
                                ? "ml-6 rounded bg-[var(--bg-hover)] px-2 py-1.5"
                                : item.role === "notice"
                                    ? "rounded border border-[var(--border-color)] px-2 py-1.5 text-[var(--text-secondary)]"
                                    : "mr-6 whitespace-pre-wrap rounded bg-[var(--bg-subtle,var(--bg-hover))] px-2 py-1.5"
                        }
                    >
                        {item.text}
                    </div>
                ))}
                {toolCalls.length > 0 ? (
                    <div className="space-y-1">
                        {toolCalls.map((call) => (
                            <div key={call.toolCallId} className="rounded border-l-2 border-[var(--border-color)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
                                {call.isError ? "此操作未完成" : "此操作已完成，未重复执行"}
                                {call.error ? ` · ${call.error}` : ""}
                            </div>
                        ))}
                    </div>
                ) : null}
                {error ? <div className="rounded border border-[var(--border-color)] px-2 py-1.5 text-[var(--text-secondary)]">{error}</div> : null}
            </div>

            <footer className="border-t border-[var(--border-color)] p-2">
                <textarea
                    className="h-16 w-full resize-none rounded border border-[var(--border-color)] bg-[var(--bg-input,transparent)] px-2 py-1 text-xs outline-none focus:border-[var(--accent-color)]"
                    placeholder="用自然语言描述创作需求…"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
                    }}
                />
                <div className="mt-1 flex items-center justify-between">
                    <span className="text-[10px] text-[var(--text-secondary)]">⌘/Ctrl + Enter 发送</span>
                    <div className="flex gap-1">
                        {streaming ? (
                            <Button size="small" danger icon={<Square className="size-3" />} onClick={() => void stop()}>停止</Button>
                        ) : null}
                        <Button size="small" type="primary" loading={streaming} icon={streaming ? <Loader2 className="size-3" /> : <Send className="size-3" />} onClick={() => void send()}>
                            发送
                        </Button>
                    </div>
                </div>
            </footer>
        </aside>
    );
}
