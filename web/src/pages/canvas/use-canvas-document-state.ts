import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { stampCanvasNodeChanges } from "@/lib/canvas/canvas-node-timestamps";
import { bringCanvasNodeToFront, type CanvasNodeStackOrder } from "@/lib/canvas/canvas-node-stack-order";
import { refreshLocalCanvasProjectIfChanged } from "@/services/local-workspace-repository";
import { notifyExternalCanvasEvent, subscribeCanvasEventsStream } from "@/services/canvas-external-writes";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import { canvasDocumentBase, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { persistCanvasNodeFailure } from "@/lib/canvas/canvas-node-failure-state";
import { useCanvasNodeContent } from "./use-canvas-node-content";
import { subscribeWorkspaceResume } from "@/lib/workspace-resume";

function captureFailures(next: CanvasNodeData[], previous?: CanvasNodeData[]) {
    if (next === previous) return next;
    let changed = false;
    const sameOrder = previous?.length === next.length && previous.every((node, index) => node.id === next[index].id);
    const result = next.map((node, index) => {
        if (sameOrder && node.metadata === previous![index].metadata) return node;
        const captured = persistCanvasNodeFailure(node);
        if (captured !== node) changed = true;
        return captured;
    });
    return changed ? result : next;
}

export function useCanvasNodeState() {
    const [nodes, setCommittedNodes] = useState<CanvasNodeData[]>([]);
    const nodesRef = useRef(nodes);
    const setNodesState = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>((value) => {
        setCommittedNodes(current => {
            const candidate = typeof value === "function" ? value(current) : value;
            const next = captureFailures(candidate, current);
            nodesRef.current = next;
            return next;
        });
    }, []);
    const setNodes = useCallback<Dispatch<SetStateAction<CanvasNodeData[]>>>((value) => {
        if (typeof value === "function") {
            setCommittedNodes(current => {
                const next = captureFailures(stampCanvasNodeChanges(current, value(current)), current);
                nodesRef.current = next;
                return next;
            });
        } else {
            // Synchronous producers can already have advanced nodesRef. Capture
            // derived failure fields independently of timestamp identity checks.
            const next = captureFailures(stampCanvasNodeChanges(nodesRef.current, value));
            nodesRef.current = next;
            setCommittedNodes(next);
        }
    }, []);
    const adoptNodes = useCallback((value: CanvasNodeData[]) => {
        const next = stampCanvasNodeChanges(nodesRef.current, value);
        nodesRef.current = next;
        setCommittedNodes(next);
    }, []);
    useLayoutEffect(() => { nodesRef.current = nodes; }, [nodes]);
    return { nodes, nodesRef, setNodes, setNodesState, adoptNodes };
}

export function useCanvasDocumentState(projectId: string) {
    const { nodes, nodesRef, setNodes, setNodesState, adoptNodes } = useCanvasNodeState();
    const content = useCanvasNodeContent({ canvasId: projectId, nodesRef, setNodesState });
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const connectionsRef = useRef(connections);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const chatSessionsRef = useRef(chatSessions);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const activeChatIdRef = useRef(activeChatId);
    const [nodeStackOrder, setNodeStackOrder] = useState<CanvasNodeStackOrder>([]);
    const bringNodeToFront = useCallback((nodeId: string) => {
        setNodeStackOrder(current => bringCanvasNodeToFront(current, nodeId));
    }, []);
    useLayoutEffect(() => {
        connectionsRef.current = connections;
        chatSessionsRef.current = chatSessions;
        activeChatIdRef.current = activeChatId;
    }, [connections, chatSessions, activeChatId]);
    useEffect(() => { setNodeStackOrder([]); }, [projectId]);
    useEffect(() => {
        const ids = new Set(nodes.map(node => node.id));
        setNodeStackOrder(current => {
            const next = current.filter(id => ids.has(id));
            return next.length === current.length ? current : next;
        });
    }, [nodes]);
    useEffect(() => {
        if (!projectId || !isLocalWorkspaceMode()) return;
        let disposed = false;
        let sseConnected = false;
        let debounceTimer: number | null = null;
        let pollTimer: number | null = null;

        const appliedRevision = () => {
            const baseRev = canvasDocumentBase(projectId)?.revision ?? 0;
            const storeRev = useCanvasStore.getState().projects.find((item) => item.id === projectId)?.revision ?? 0;
            return Math.max(baseRev, storeRev);
        };

        const sync = () => {
            if (!disposed) void refreshLocalCanvasProjectIfChanged(projectId);
        };

        const scheduleFallbackPoll = () => {
            if (pollTimer !== null) {
                window.clearTimeout(pollTimer);
                pollTimer = null;
            }
            if (disposed || (typeof document !== "undefined" && document.hidden)) return;
            // Healthy SSE carries instant revision notifications; fall back to a
            // light 30s safety-net check (8s while SSE is disconnected).
            const intervalMs = sseConnected ? 30_000 : 8_000;
            pollTimer = window.setTimeout(() => {
                pollTimer = null;
                if (!disposed && (typeof document === "undefined" || !document.hidden)) {
                    sync();
                    scheduleFallbackPoll();
                }
            }, intervalMs);
        };

        const handleVisibilityChange = () => {
            if (typeof document !== "undefined" && document.hidden) {
                if (pollTimer !== null) {
                    window.clearTimeout(pollTimer);
                    pollTimer = null;
                }
                return;
            }
            if (pollTimer === null) {
                scheduleFallbackPoll();
            }
        };
        const unsubscribeResume = subscribeWorkspaceResume(() => {
            sync();
            scheduleFallbackPoll();
        });

        const unsubscribeStream = subscribeCanvasEventsStream(
            projectId,
            (incomingRevision) => {
                if (disposed) return;
                if (incomingRevision !== undefined && incomingRevision <= appliedRevision()) {
                    return;
                }
                if (debounceTimer !== null) window.clearTimeout(debounceTimer);
                debounceTimer = window.setTimeout(() => {
                    debounceTimer = null;
                    sync();
                    if (!disposed) notifyExternalCanvasEvent(projectId);
                }, 150);
            },
            {
                onConnectionChange(connected) {
                    if (sseConnected === connected) return;
                    sseConnected = connected;
                    scheduleFallbackPoll();
                },
            },
        );

        scheduleFallbackPoll();
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", handleVisibilityChange);
        }

        return () => {
            disposed = true;
            if (debounceTimer !== null) window.clearTimeout(debounceTimer);
            if (pollTimer !== null) window.clearTimeout(pollTimer);
            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", handleVisibilityChange);
            }
            unsubscribeResume();
            unsubscribeStream();
        };
    }, [projectId]);
    return { nodes, nodesRef, setNodes, setNodesState, adoptNodes, connections, connectionsRef, setConnections, chatSessions, chatSessionsRef, setChatSessions, activeChatId, activeChatIdRef, setActiveChatId, nodeStackOrder, bringNodeToFront, ...content };
}
