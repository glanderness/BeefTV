import { Button, Dropdown, Tooltip } from "antd";
import { History, MessageSquarePlus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AppDrawer } from "@/components/ui/product/app-drawer";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssistantGenerationProposal } from "@/services/api/agent-assistant";
import { ASSISTANT_STARTER_PROMPTS, assistantStatusNotice, assistantVisibleReply } from "./canvas-assistant-copy";
import { CanvasAssistantComposer } from "./canvas-assistant-composer";
import { CanvasAssistantReply, CanvasAssistantTurnView, CanvasAssistantUserMessage } from "./canvas-assistant-turn";
import { ASSISTANT_MAX_WIDTH, ASSISTANT_MIN_WIDTH, type CanvasAssistantController } from "./use-canvas-assistant";
import "./canvas-assistant-sidebar.css";

type Props = {
    assistant: CanvasAssistantController;
    canvasTitle: string;
    dockable: boolean;
    readOnly: boolean;
    selectedNodeIds: string[];
    references: CanvasResourceReference[];
    onLocateNodes: (nodeIds: string[]) => void;
    onRunProposal: (proposal: AssistantGenerationProposal) => void;
    onOpenModelSettings: () => void;
};

export function CanvasAssistantSidebar(props: Props) {
    const { assistant, canvasTitle, dockable, readOnly, selectedNodeIds, references, onLocateNodes, onRunProposal, onOpenModelSettings } = props;
    const [draft, setDraft] = useState("");
    const [selectionAttached, setSelectionAttached] = useState(true);
    const logRef = useRef<HTMLDivElement | null>(null);
    const sidebarRef = useRef<HTMLDivElement | null>(null);

    // 新的一条选择又可以被带上：用户移除只对当前这条消息生效。
    useEffect(() => {
        setSelectionAttached(true);
    }, [selectedNodeIds.join(",")]);

    const turnCount = assistant.turns.length;
    useLayoutEffect(() => {
        const node = logRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [turnCount, assistant.streamed, assistant.pendingUserText]);

    const notice = assistant.status && !assistant.status.available ? assistantStatusNotice(assistant.status.reason) : null;
    const available = Boolean(assistant.status?.available);
    const composerDisabled = readOnly || !available || assistant.streaming;
    const composerReason = readOnly ? "这个画布是只读的，不能让助手改动。" : undefined;
    const attachedIds = selectionAttached ? selectedNodeIds : [];

    const send = useCallback(() => {
        const text = draft;
        setDraft("");
        void assistant.send(text, attachedIds);
    }, [assistant, attachedIds, draft]);

    const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = sidebarRef.current?.getBoundingClientRect().width ?? assistant.width;
        const move = (moveEvent: PointerEvent) => assistant.setWidth(startWidth + (startX - moveEvent.clientX));
        const done = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", done);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", done);
    }, [assistant]);

    const sessionItems = assistant.sessions.length
        ? assistant.sessions.map((session) => ({
              key: session.sessionId,
              label: session.title || "还没有内容的对话",
              onClick: () => void assistant.activateSession(session.sessionId),
          }))
        : [{ key: "empty", label: "还没有别的对话", disabled: true }];

    const content = (
        <div className="canvas-assistant-panel" data-canvas-no-zoom>
            <header className="canvas-assistant-header">
                <h2 title={`助手 · ${canvasTitle}`}>助手 · {canvasTitle}</h2>
                <Tooltip title="新对话">
                    <Button type="text" size="small" aria-label="新对话" disabled={assistant.streaming} icon={<MessageSquarePlus className="size-4" />} onClick={() => void assistant.startNewSession()} />
                </Tooltip>
                <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: sessionItems, selectedKeys: assistant.sessionId ? [assistant.sessionId] : [] }}>
                    <Button type="text" size="small" aria-label="历史对话" icon={<History className="size-4" />} />
                </Dropdown>
                <Tooltip title="关闭助手">
                    <Button type="text" size="small" aria-label="关闭助手" icon={<X className="size-4" />} onClick={() => assistant.setOpen(false)} />
                </Tooltip>
            </header>

            {notice ? (
                <div className="canvas-assistant-notice" role="status">
                    <span>{notice.text}</span>
                    {notice.action === "model-settings" ? (
                        <Button size="small" onClick={onOpenModelSettings}>{notice.actionLabel}</Button>
                    ) : notice.action === "retry" ? (
                        <Button size="small" loading={assistant.statusBusy} onClick={() => void assistant.restartHost()}>{notice.actionLabel}</Button>
                    ) : null}
                </div>
            ) : null}

            <div ref={logRef} className="canvas-assistant-log">
                {turnCount === 0 && !assistant.pendingUserText ? (
                    <div className="canvas-assistant-empty">
                        <p>说一句你想要的结果，助手会直接在这张画布上动手。</p>
                        {ASSISTANT_STARTER_PROMPTS.map((prompt) => (
                            <button key={prompt} type="button" className="canvas-assistant-starter" onClick={() => setDraft(prompt)}>
                                {prompt}
                            </button>
                        ))}
                    </div>
                ) : null}

                {assistant.turns.map((turn) => (
                    <CanvasAssistantTurnView
                        key={turn.turnId}
                        turn={turn}
                        status={assistant.turnStatus[turn.turnId]}
                        handledProposals={assistant.handledProposals}
                        onLocate={onLocateNodes}
                        onUndo={(turnId) => void assistant.undoTurn(turnId)}
                        onRunProposal={onRunProposal}
                        onDismissProposal={assistant.markProposalDismissed}
                    />
                ))}

                {assistant.pendingUserText ? (
                    <div className="canvas-assistant-turn">
                        <CanvasAssistantUserMessage text={assistant.pendingUserText} selectedCount={assistant.pendingSelectedNodeIds.length} />
                        {assistantVisibleReply(assistant.streamed || "") ? <CanvasAssistantReply text={assistant.streamed} /> : assistant.streaming ? <p className="canvas-assistant-meta">助手正在处理…</p> : null}
                    </div>
                ) : null}

                {assistant.error ? (
                    <div className="canvas-assistant-card">
                        <span className="canvas-assistant-failed">{assistant.error}</span>
                        <div className="canvas-assistant-card-actions">
                            {assistant.canRetry ? <Button size="small" onClick={assistant.retryLast}>重试</Button> : null}
                            <Button size="small" type="text" onClick={assistant.dismissError}>知道了</Button>
                        </div>
                    </div>
                ) : null}
            </div>

            <CanvasAssistantComposer
                value={draft}
                onChange={setDraft}
                onSend={send}
                onStop={() => void assistant.stop()}
                streaming={assistant.streaming}
                disabled={composerDisabled}
                disabledReason={composerReason}
                references={references}
                selectedCount={selectedNodeIds.length}
                selectionAttached={selectionAttached}
                onDetachSelection={() => setSelectionAttached(false)}
                modelName={assistant.status?.model?.id}
            />
        </div>
    );

    if (!dockable) {
        return (
            <AppDrawer
                flush
                open={assistant.open}
                placement="right"
                title={null}
                closable={false}
                onClose={() => assistant.setOpen(false)}
                size="min(380px, 92vw)"
                aria-label="助手"
            >
                {content}
            </AppDrawer>
        );
    }

    return (
        <aside ref={sidebarRef} className="canvas-assistant-sidebar" aria-label="助手" style={{ width: assistant.width, flexBasis: assistant.width }}>
            <button
                type="button"
                className="canvas-assistant-resize"
                aria-label="调整助手宽度"
                onPointerDown={startResize}
                onKeyDown={(event) => {
                    if (event.key === "ArrowLeft") assistant.setWidth(Math.min(ASSISTANT_MAX_WIDTH, assistant.width + 16));
                    if (event.key === "ArrowRight") assistant.setWidth(Math.max(ASSISTANT_MIN_WIDTH, assistant.width - 16));
                }}
            />
            {content}
        </aside>
    );
}
