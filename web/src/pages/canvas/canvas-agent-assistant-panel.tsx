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

type Props = {
    canvasId: string;
    selectedCount: number;
    selectedTitles?: string[];
};

// 画布内创作助手侧栏：可收起、显示当前画布与选中对象、流式展示工具进度与错误。
// 会话按画布归属（切画布即切换上下文），收起不取消正在进行的回合。
export function CanvasAgentAssistantPanel({ canvasId, selectedCount, selectedTitles = [] }: Props) {
    const [collapsed, setCollapsed] = useState(false);
    const [status, setStatus] = useState<AgentHostStatus | null>(null);
    const [messages, setMessages] = useState<PanelMessage[]>([]);
    const [toolCalls, setToolCalls] = useState<AgentToolCall[]>([]);
    const [draft, setDraft] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const logRef = useRef<HTMLDivElement | null>(null);
    // 会话记录按画布分开保存：切画布不会把 A 的回复画到 B 上。
    const historyRef = useRef<Map<string, { messages: PanelMessage[]; toolCalls: AgentToolCall[] }>>(new Map());

    useEffect(() => {
        let cancelled = false;
        getAgentHostStatus()
            .then((value) => { if (!cancelled) setStatus(value); })
            .catch(() => { if (!cancelled) setStatus({ available: false, reason: "status_unavailable" }); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const saved = historyRef.current.get(canvasId);
        setMessages(saved?.messages ?? []);
        setToolCalls(saved?.toolCalls ?? []);
        setError(null);
    }, [canvasId]);

    useEffect(() => {
        historyRef.current.set(canvasId, { messages, toolCalls });
    }, [canvasId, messages, toolCalls]);

    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [messages, toolCalls]);

    const append = useCallback((target: string, entry: PanelMessage) => {
        if (target !== canvasId) {
            // 异步回复归属发送时的画布：不画到当前画布上。
            const saved = historyRef.current.get(target) ?? { messages: [], toolCalls: [] };
            saved.messages = [...saved.messages, entry];
            historyRef.current.set(target, saved);
            return;
        }
        setMessages((prev) => [...prev, entry]);
    }, [canvasId]);

    const send = useCallback(async () => {
        const message = draft.trim();
        if (!message || streaming) return;
        if (!status?.available) {
            setError("内置助手宿主未就绪：请由产品启动链启动 agent-host（普通开发机未安装 Node 时不可用）");
            return;
        }
        setDraft("");
        setError(null);
        const targetCanvas = canvasId;
        append(targetCanvas, { id: `${Date.now()}-user`, role: "user", text: message });
        setStreaming(true);
        const controller = new AbortController();
        abortRef.current = controller;
        let streamed = "";
        try {
            await streamAgentChat(targetCanvas, message, {
                onDelta: (delta) => {
                    streamed += delta;
                    if (targetCanvas !== canvasId) return;
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === "assistant" && last.id.endsWith("-stream")) {
                            return [...prev.slice(0, -1), { ...last, text: streamed }];
                        }
                        return [...prev, { id: `${Date.now()}-stream`, role: "assistant", text: streamed }];
                    });
                },
                onToolCall: (call) => { if (targetCanvas === canvasId) setToolCalls((prev) => [...prev, call]); },
                onTurnEnd: (end) => {
                    if (end.error) setError(end.error);
                    if (targetCanvas === canvasId) {
                        setMessages((prev) => {
                            const trimmed = prev.filter((item) => !item.id.endsWith("-stream"));
                            return [...trimmed, { id: `${Date.now()}-assistant`, role: "assistant", text: end.reply || streamed || "(无回复)" }];
                        });
                        setToolCalls((prev) => [...prev, ...end.toolCalls]);
                    }
                },
            }, controller.signal);
        } catch (streamError) {
            const text = streamError instanceof Error ? streamError.message : String(streamError);
            setError(text);
            append(targetCanvas, { id: `${Date.now()}-notice`, role: "notice", text });
        } finally {
            setStreaming(false);
            abortRef.current = null;
        }
    }, [append, canvasId, draft, status, streaming]);

    const stop = useCallback(async () => {
        abortRef.current?.abort();
        try { await cancelAgentChat(canvasId); } catch (cancelError) {
            setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
        }
    }, [canvasId]);

    if (collapsed) {
        return (
            <Tooltip title="展开创作助手">
                <Button
                    size="small"
                    shape="circle"
                    className="pointer-events-auto"
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
            className="pointer-events-auto flex h-[420px] w-[330px] flex-col overflow-hidden rounded-lg border border-white/10 bg-zinc-900/95 text-zinc-100 shadow-xl backdrop-blur"
        >
            <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Bot className="size-4 shrink-0 text-emerald-400" />
                    <div className="min-w-0">
                        <div className="truncate text-xs font-semibold">创作助手</div>
                        <div className="truncate text-[10px] text-zinc-400">
                            画布 {canvasId.slice(0, 12)}…
                        </div>
                    </div>
                </div>
                <button type="button" className="rounded p-1 hover:bg-white/10" onClick={() => setCollapsed(true)} aria-label="收起创作助手">
                    <ChevronRight className="size-4" />
                </button>
            </header>

            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] text-zinc-400">
                {selectedCount > 0
                    ? `已选 ${selectedCount} 个对象${selectedTitles.length > 0 ? `：${selectedTitles.slice(0, 3).join("、")}` : ""}（将作为固定上下文）`
                    : "未选中对象：默认作用于当前画布"}
                {status && !status.available ? <span className="ml-1 text-amber-400">· 宿主未就绪（{status.reason}）</span> : null}
            </div>

            <div ref={logRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-xs">
                {messages.length === 0 ? <p className="text-zinc-500">描述你的创作需求，例如“给这部短剧建三镜头草案并连成链”。</p> : null}
                {messages.map((item) => (
                    <div
                        key={item.id}
                        className={
                            item.role === "user"
                                ? "ml-6 rounded bg-emerald-900/40 px-2 py-1.5"
                                : item.role === "notice"
                                    ? "rounded bg-amber-900/30 px-2 py-1.5 text-amber-200"
                                    : "mr-6 whitespace-pre-wrap rounded bg-white/5 px-2 py-1.5"
                        }
                    >
                        {item.text}
                    </div>
                ))}
                {toolCalls.length > 0 ? (
                    <div className="space-y-1">
                        {toolCalls.map((call, index) => (
                            <div key={`${call.tool}-${index}`} className={`rounded border-l-2 px-2 py-1 text-[10px] ${call.isError ? "border-red-500 text-red-300" : "border-emerald-500 text-zinc-400"}`}>
                                {call.isError ? "✗" : "✓"} {call.tool}
                                {call.replayed ? " · 幂等回放" : ""}
                                {call.error ? ` · ${call.error}` : ""}
                            </div>
                        ))}
                    </div>
                ) : null}
                {error ? <div className="rounded bg-red-900/30 px-2 py-1.5 text-red-200">{error}</div> : null}
            </div>

            <footer className="border-t border-white/10 p-2">
                <textarea
                    className="h-16 w-full resize-none rounded border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:border-emerald-500"
                    placeholder="用自然语言描述创作需求…"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
                    }}
                />
                <div className="mt-1 flex items-center justify-between">
                    <span className="text-[10px] text-zinc-500">⌘/Ctrl + Enter 发送</span>
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
