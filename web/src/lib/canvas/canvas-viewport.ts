import type { CanvasNodeData, Position, ViewportTransform } from "@/types/canvas";

export type CanvasBounds = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};

export type CanvasViewportSize = {
    width: number;
    height: number;
};

export function getCanvasNodesBounds(nodes: CanvasNodeData[]): CanvasBounds | null {
    if (!nodes.length) return null;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    nodes.forEach((node) => {
        left = Math.min(left, node.position.x);
        top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width);
        bottom = Math.max(bottom, node.position.y + node.height);
    });

    return { left, top, right, bottom };
}

export function viewportForBounds(bounds: CanvasBounds, viewportSize: CanvasViewportSize, options: { padding?: number; minScale?: number; maxScale?: number } = {}): ViewportTransform {
    const padding = options.padding ?? 96;
    const minScale = options.minScale ?? 0.05;
    const maxScale = options.maxScale ?? 1;
    const boundsWidth = Math.max(1, bounds.right - bounds.left);
    const boundsHeight = Math.max(1, bounds.bottom - bounds.top);
    const availableWidth = Math.max(1, viewportSize.width - padding * 2);
    const availableHeight = Math.max(1, viewportSize.height - padding * 2);
    const k = Math.min(maxScale, Math.max(minScale, Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight)));
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;

    return {
        x: viewportSize.width / 2 - centerX * k,
        y: viewportSize.height / 2 - centerY * k,
        k,
    };
}

export function viewportAtScale(viewport: ViewportTransform, viewportSize: CanvasViewportSize, scale: number): ViewportTransform {
    const k = Math.min(8, Math.max(0.05, scale));
    const centerWorldX = (viewportSize.width / 2 - viewport.x) / viewport.k;
    const centerWorldY = (viewportSize.height / 2 - viewport.y) / viewport.k;
    return {
        x: viewportSize.width / 2 - centerWorldX * k,
        y: viewportSize.height / 2 - centerWorldY * k,
        k,
    };
}

export function interpolateViewport(from: ViewportTransform, to: ViewportTransform, progress: number): ViewportTransform {
    const t = 1 - Math.pow(1 - Math.min(1, Math.max(0, progress)), 3);
    return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        k: from.k + (to.k - from.k) * t,
    };
}

export const CANVAS_MAIN_DOCK_CLEARANCE = 80;

function constrainNodePanelPosition(left: number, top: number, viewportSize: { width: number; height: number }, panelWidth: number, panelHeight: number, preferredTop: number, keepBelowNode = false, avoidBottomDock = false) {
    const gap = 16;
    // Keep the compact composer below the node on short viewports; LibTV
    // reserves only a small gap above the bottom controls.
    const bottomReserve = avoidBottomDock ? CANVAS_MAIN_DOCK_CLEARANCE : 16;
    const maxLeft = Math.max(gap, viewportSize.width - panelWidth - gap);
    const maxTop = Math.max(gap, viewportSize.height - panelHeight - bottomReserve);
    return {
        left: Math.min(Math.max(left, gap), maxLeft),
        top: keepBelowNode
            ? (avoidBottomDock ? Math.min(top, maxTop) : top)
            : Math.min(Math.max(top > maxTop ? preferredTop - panelHeight - gap : top, gap), maxTop),
    };
}

export function getAttachedNodePanelPosition(nodeElement: HTMLElement, container: HTMLElement, panelWidth: number, panelHeight: number, keepBelowNode = false, avoidBottomDock = false) {
    const gap = 16;
    const nodeRect = nodeElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const viewportSize = { width: container.clientWidth, height: container.clientHeight };
    const left = nodeRect.left - containerRect.left + nodeRect.width / 2 - panelWidth / 2;
    const preferredTop = nodeRect.top - containerRect.top;
    const top = nodeRect.bottom - containerRect.top + gap;
    return {
        ...constrainNodePanelPosition(left, top, viewportSize, panelWidth, panelHeight, preferredTop, keepBelowNode, avoidBottomDock),
        placement: "below" as const,
    };
}

export function getNodePanelPosition(node: CanvasNodeData, viewport: ViewportTransform, viewportSize: { width: number; height: number }, panelWidth: number, panelHeight: number, dragOffset?: Position | null, keepBelowNode = false, avoidBottomDock = false) {
    const gap = 16;
    const offsetX = dragOffset?.x || 0;
    const offsetY = dragOffset?.y || 0;
    const nodeCenterX = viewport.x + (node.position.x + offsetX + node.width / 2) * viewport.k;
    const nodeTop = viewport.y + (node.position.y + offsetY) * viewport.k;
    const nodeBottom = viewport.y + (node.position.y + offsetY + node.height) * viewport.k;
    return {
        ...constrainNodePanelPosition(nodeCenterX - panelWidth / 2, nodeBottom + gap, viewportSize, panelWidth, panelHeight, nodeTop, keepBelowNode, avoidBottomDock),
        placement: "below" as const,
    };
}
