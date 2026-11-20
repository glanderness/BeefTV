import { CanvasNodeType, type CanvasNodeData, type StoryboardAssetBinding, type StoryboardAssetRole, type StoryboardRow } from "@/types/canvas";

export type StoryboardAssetCatalogItem = {
    id: string;
    title: string;
    type: "image" | "video" | "audio" | "character";
    category?: string;
    tags: string[];
    prompt: string;
    characterAssetId?: string;
    characterVersionId?: string;
};

export type StoryboardAssetBadgeLabel = "角色" | "场景" | "图片" | "视频" | "音频";

export const STORYBOARD_ASSET_ROLE_LABELS: Record<StoryboardAssetRole, string> = {
    character: "角色",
    environment: "场景",
    prop: "道具",
    wardrobe: "服装",
    weapon: "武器",
    style: "风格",
    motion: "动态",
    audio: "音频",
};

export const STORYBOARD_ASSET_ROLE_OPTIONS: ReadonlyArray<{ value: StoryboardAssetRole; label: string }> = [
    { value: "character", label: "角色" },
    { value: "environment", label: "场景" },
    { value: "prop", label: "道具" },
    { value: "wardrobe", label: "服装" },
    { value: "style", label: "风格" },
    { value: "motion", label: "动态" },
    { value: "audio", label: "音频" },
];

const OUTPUT_WORKFLOW_KINDS = new Set(["shot", "action_board", "final"]);
const STORYBOARD_ASSET_ROLES = new Set<StoryboardAssetRole>(["character", "environment", "wardrobe", "prop", "weapon", "style", "motion", "audio"]);

export function buildStoryboardAssetCatalog(nodes: CanvasNodeData[]): StoryboardAssetCatalogItem[] {
    return nodes.flatMap((node): StoryboardAssetCatalogItem[] => {
        const type = storyboardAssetType(node);
        if (!type || OUTPUT_WORKFLOW_KINDS.has(node.metadata?.workflowKind || "")) return [];
        if (!node.metadata?.content && !node.metadata?.storageKey && !node.metadata?.assetId && type !== "character") return [];
        const prompt = compactStoryboardAssetText(node.metadata?.prompt || node.metadata?.workflowDescription || node.metadata?.characterPrompt || "");
        return [{
            id: node.id,
            title: compactStoryboardAssetText(node.title, 120) || "未命名资产",
            type,
            category: node.metadata?.assetCategory,
            tags: Array.from(new Set((node.metadata?.assetTags || []).map((tag) => compactStoryboardAssetText(tag, 64)).filter(Boolean))).slice(0, 12),
            prompt,
            characterAssetId: node.metadata?.characterAssetId,
            characterVersionId: node.metadata?.characterVersionId,
        }];
    }).slice(0, 60);
}

export function defaultStoryboardRolePriority(role: StoryboardAssetRole): number {
    if (role === "character") return 100;
    if (role === "environment") return 90;
    if (role === "prop" || role === "weapon" || role === "wardrobe") return 80;
    if (role === "motion" || role === "audio") return 70;
    return 60;
}

export function storyboardAssetRoleForNode(node: CanvasNodeData): StoryboardAssetRole | null {
    if (node.metadata?.workflowKind === "character" || node.metadata?.assetCategory === "character") return "character";
    if (node.type === CanvasNodeType.Audio) return "audio";
    if (node.type === CanvasNodeType.Video) return "motion";
    if (node.metadata?.workflowKind === "styleboard") return "style";
    const category = node.metadata?.assetCategory;
    if (category === "environment" || category === "prop") return category;
    if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing) return "environment";
    return null;
}

export function storyboardAssetNodeBadge(node: CanvasNodeData): StoryboardAssetBadgeLabel {
    if (node.metadata?.workflowKind === "character" || node.metadata?.assetCategory === "character") return "角色";
    if (node.type === CanvasNodeType.Audio) return "音频";
    if (node.type === CanvasNodeType.Video) return "视频";
    if (node.metadata?.assetCategory === "environment") return "场景";
    return "图片";
}

export function isBindableStoryboardAssetNode(node: CanvasNodeData, options?: { allowGeneratedOutputs?: boolean }): boolean {
    const isPreviewAsset =
        node.type === CanvasNodeType.Image
        || node.type === CanvasNodeType.Drawing
        || node.type === CanvasNodeType.Video
        || node.type === CanvasNodeType.Audio
        || node.metadata?.workflowKind === "character";
    if (!isPreviewAsset) return false;
    if (!options?.allowGeneratedOutputs && OUTPUT_WORKFLOW_KINDS.has(node.metadata?.workflowKind || "")) {
        return false;
    }
    if (
        node.metadata?.generationMode
        && node.metadata?.workflowKind !== "character"
        && !node.metadata?.content
        && !node.metadata?.storageKey
        && !node.metadata?.assetId
        && !node.metadata?.drawingPreviewUrl
    ) {
        return false;
    }
    return true;
}

export function collectBindableStoryboardAssetNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    return nodes.filter((node) => isBindableStoryboardAssetNode(node));
}

export function collectSelectedBindableAssetNodes(nodes: CanvasNodeData[], selectedNodeIds?: Iterable<string>): CanvasNodeData[] {
    if (!selectedNodeIds) return [];
    const selectedSet = selectedNodeIds instanceof Set ? selectedNodeIds : new Set(selectedNodeIds);
    if (selectedSet.size === 0) return [];
    return nodes.filter((node) => selectedSet.has(node.id) && isBindableStoryboardAssetNode(node, { allowGeneratedOutputs: true }));
}

export function mergeStoryboardAssetBindings(
    existing: StoryboardAssetBinding[] | undefined,
    candidateNodes: CanvasNodeData[],
    roleOverride?: StoryboardAssetRole,
): StoryboardAssetBinding[] {
    const seen = new Set<string>();
    const next: StoryboardAssetBinding[] = [];
    for (const binding of existing || []) {
        const nodeId = String(binding?.nodeId || "").trim();
        if (!nodeId || seen.has(nodeId) || !STORYBOARD_ASSET_ROLES.has(binding.role)) continue;
        seen.add(nodeId);
        next.push({
            nodeId,
            role: binding.role,
            priority: Math.max(0, Math.min(100, Math.round(Number(binding.priority) || defaultStoryboardRolePriority(binding.role)))),
        });
    }
    for (const node of candidateNodes) {
        const nodeId = String(node?.id || "").trim();
        if (!nodeId || seen.has(nodeId)) continue;
        const role = roleOverride ?? storyboardAssetRoleForNode(node);
        if (!role || !STORYBOARD_ASSET_ROLES.has(role)) continue;
        seen.add(nodeId);
        next.push({
            nodeId,
            role,
            priority: defaultStoryboardRolePriority(role),
        });
    }
    return next;
}

export function toggleStoryboardAssetBinding(existing: StoryboardAssetBinding[] | undefined, node: CanvasNodeData): StoryboardAssetBinding[] {
    const current = existing || [];
    if (current.some((binding) => binding.nodeId === node.id)) {
        return removeStoryboardAssetBinding(current, node.id);
    }
    return mergeStoryboardAssetBindings(current, [node]);
}

export function updateStoryboardAssetBindingRole(
    existing: StoryboardAssetBinding[] | undefined,
    nodeId: string,
    role: StoryboardAssetRole,
): StoryboardAssetBinding[] {
    if (!STORYBOARD_ASSET_ROLES.has(role)) return existing || [];
    return (existing || []).map((binding) =>
        binding.nodeId === nodeId
            ? { ...binding, role, priority: defaultStoryboardRolePriority(role) }
            : binding,
    );
}

export function removeStoryboardAssetBinding(existing: StoryboardAssetBinding[] | undefined, nodeId: string): StoryboardAssetBinding[] {
    return (existing || []).filter((binding) => binding.nodeId !== nodeId);
}

export function applyAssetsToStoryboardRows(
    rows: StoryboardRow[],
    targetRowIds: Iterable<string>,
    candidateNodes: CanvasNodeData[],
): { rows: StoryboardRow[]; updatedShotNumbers: number[] } {
    const targetSet = targetRowIds instanceof Set ? targetRowIds : new Set(targetRowIds);
    if (targetSet.size === 0 || candidateNodes.length === 0) {
        return { rows, updatedShotNumbers: [] };
    }
    const updatedShotNumbers: number[] = [];
    const nextRows = rows.map((row) => {
        if (!targetSet.has(row.id)) return row;
        updatedShotNumbers.push(row.shotNumber);
        return {
            ...row,
            assetBindings: mergeStoryboardAssetBindings(row.assetBindings, candidateNodes),
        };
    });
    return { rows: nextRows, updatedShotNumbers };
}

export function normalizeStoryboardAssetBindings(bindings: StoryboardAssetBinding[] | undefined, nodes?: CanvasNodeData[]) {
    const nodeIds = nodes ? new Set(nodes.map((node) => node.id)) : null;
    const seen = new Set<string>();
    return (bindings || []).flatMap((binding): StoryboardAssetBinding[] => {
        const nodeId = String(binding?.nodeId || "").trim();
        if (!nodeId || seen.has(nodeId) || !STORYBOARD_ASSET_ROLES.has(binding.role) || (nodeIds && !nodeIds.has(nodeId))) return [];
        seen.add(nodeId);
        return [{ nodeId, role: binding.role, priority: Math.max(0, Math.min(100, Math.round(Number(binding.priority) || 0))) }];
    }).sort((left, right) => right.priority - left.priority);
}

function storyboardAssetType(node: CanvasNodeData): StoryboardAssetCatalogItem["type"] | null {
    if (node.metadata?.workflowKind === "character" && node.metadata.characterAssetId && node.metadata.characterVersionId) return "character";
    if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Drawing) return "image";
    if (node.type === CanvasNodeType.Video) return "video";
    if (node.type === CanvasNodeType.Audio) return "audio";
    return null;
}

function compactStoryboardAssetText(value: string, limit = 600) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}
