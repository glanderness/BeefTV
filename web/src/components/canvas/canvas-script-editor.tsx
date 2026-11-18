import { App, Button, Input, InputNumber, Modal, Segmented, Select, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ChevronDown, ChevronUp, Copy, Film, Image as ImageIcon, Link2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { StoryboardAssetsCell } from "@/components/canvas/storyboard-assets-cell";
import { CheckboxGroup } from "@/components/ui/base/checkbox";
import { createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { applyAssetsToStoryboardRows, collectSelectedBindableAssetNodes } from "@/lib/canvas/canvas-storyboard-assets";
import { resolveStoryboardVisibleColumns } from "@/lib/canvas/canvas-storyboard-columns";
import type { CanvasNodeData, StoryboardColumn, StoryboardRow, StoryboardVideoInputMode } from "@/types/canvas";

const EMPTY_STORYBOARD_ROWS: StoryboardRow[] = [];

const columnOptions: Array<{ label: string; value: StoryboardColumn }> = [
    { label: "序号", value: "shotNumber" },
    { label: "时长", value: "durationSeconds" },
    { label: "画面描述", value: "plotDescription" },
    { label: "台词/旁白", value: "dialogue" },
    { label: "镜头意图", value: "narrativeIntent" },
    { label: "观众视点", value: "viewerPOV" },
    { label: "表演调度", value: "performanceBlocking" },
    { label: "景别", value: "shotSize" },
    { label: "情绪", value: "emotion" },
    { label: "光影氛围", value: "lightingAndAtmosphere" },
    { label: "音效", value: "audioEffects" },
    { label: "镜头设计", value: "camera" },
    { label: "运镜", value: "motion" },
    { label: "时间节拍", value: "timeBeats" },
    { label: "图片提示词", value: "imageGenerationPrompt" },
    { label: "视频提示词", value: "videoMotionPrompt" },
    { label: "关联资产", value: "assets" },
    { label: "连续性出口", value: "continuityOut" },
    { label: "负面要求", value: "negativePrompt" },
];

export function resolveStoryboardGenerationRowIds(filteredRows: StoryboardRow[], selectedIds: string[]): string[] {
    if (selectedIds.length > 0) return selectedIds;
    return filteredRows.map((row) => row.id);
}

export function storyboardEditorImageButtonLabel(
    videoInputMode: StoryboardVideoInputMode,
    selectedCount: number,
    filteredCount: number,
): string {
    const noun = videoInputMode === "keyframe" ? "首帧" : "分镜图";
    if (selectedCount > 0) return `生成${noun} (${selectedCount})`;
    if (filteredCount > 0) return `生成全部${noun} (${filteredCount})`;
    return `生成${noun}`;
}

export function storyboardEditorVideoButtonLabel(
    videoInputMode: StoryboardVideoInputMode,
    selectedCount: number,
    filteredCount: number,
): string {
    if (videoInputMode === "keyframe") {
        if (selectedCount > 0) return `确认首帧并生成 (${selectedCount})`;
        if (filteredCount > 0) return `确认首帧并生成全部 (${filteredCount})`;
        return "确认首帧并生成";
    }
    if (selectedCount > 0) return `生成视频 (${selectedCount})`;
    if (filteredCount > 0) return `生成全部视频 (${filteredCount})`;
    return "生成视频";
}

export function CanvasScriptEditor({
    node,
    nodes,
    selectedCanvasNodeIds,
    readOnly = false,
    open,
    onClose,
    onUpdateRows,
    onVisibleColumnsChange,
    onGenerateImages,
    onGenerateVideos,
    onVideoInputModeChange,
}: {
    node: CanvasNodeData | null;
    nodes: CanvasNodeData[];
    selectedCanvasNodeIds?: Iterable<string>;
    readOnly?: boolean;
    open: boolean;
    onClose: () => void;
    onUpdateRows: (rows: StoryboardRow[]) => void;
    onVisibleColumnsChange: (columns: StoryboardColumn[]) => void;
    onGenerateImages: (rowIds: string[]) => void;
    onGenerateVideos: (rowIds: string[]) => void;
    onVideoInputModeChange: (mode: StoryboardVideoInputMode) => void;
}) {
    const { message } = App.useApp();
    const [query, setQuery] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const rows = node?.metadata?.storyboard?.rows || EMPTY_STORYBOARD_ROWS;
    const visibleColumns = resolveStoryboardVisibleColumns(node?.metadata?.storyboard?.visibleColumns, rows, node?.metadata?.storyboardVisibleColumnsCustomized);
    const videoInputMode = node?.metadata?.storyboardVideoInputMode || "direct";
    const nodeById = useMemo(() => new Map(nodes.map((item) => [item.id, item])), [nodes]);
    const selectedBindableNodes = useMemo(
        () => collectSelectedBindableAssetNodes(nodes, selectedCanvasNodeIds),
        [nodes, selectedCanvasNodeIds],
    );
    const filteredRows = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return keyword
            ? rows.filter((row) =>
                  [row.plotDescription, row.dialogue, row.camera, row.motion, row.timeBeats, row.imageGenerationPrompt, row.videoMotionPrompt, row.negativePrompt, ...(row.assetBindings || []).map((binding) => nodeById.get(binding.nodeId)?.title || "")].some((value) =>
                      String(value || "")
                          .toLowerCase()
                          .includes(keyword),
                  ),
              )
            : rows;
    }, [nodeById, query, rows]);
    useEffect(() => {
        setSelectedIds((current) => {
            const next = current.filter((id) => rows.some((row) => row.id === id));
            return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
        });
    }, [rows]);
    const targetRowIds = useMemo(
        () => resolveStoryboardGenerationRowIds(filteredRows, selectedIds),
        [filteredRows, selectedIds],
    );
    const updateRow = (rowId: string, patch: Partial<StoryboardRow>) => onUpdateRows(rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
    const moveRow = (rowId: string, direction: -1 | 1) => {
        const index = rows.findIndex((row) => row.id === rowId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) return;
        const next = [...rows];
        [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
        onUpdateRows(next.map((row, rowIndex) => ({ ...row, shotNumber: rowIndex + 1 })));
    };
    const duplicateRow = (row: StoryboardRow) => {
        const index = rows.findIndex((item) => item.id === row.id);
        const next = [...rows];
        next.splice(index + 1, 0, { ...row, id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, imageNodeId: undefined, videoNodeId: undefined, status: "idle" });
        onUpdateRows(next.map((item, rowIndex) => ({ ...item, shotNumber: rowIndex + 1 })));
    };
    const removeRow = (rowId: string) => onUpdateRows(rows.filter((row) => row.id !== rowId).map((row, index) => ({ ...row, shotNumber: index + 1 })));
    const bindSelectedAssetsToTargetRows = () => {
        if (!selectedBindableNodes.length || !targetRowIds.length) return;
        const result = applyAssetsToStoryboardRows(rows, targetRowIds, selectedBindableNodes);
        onUpdateRows(result.rows);
        if (result.updatedShotNumbers.length === 1) {
            message?.success?.(`已将 ${selectedBindableNodes.length} 个素材关联到第 ${result.updatedShotNumbers[0]} 镜`);
        } else if (result.updatedShotNumbers.length > 1) {
            message?.success?.(`已将 ${selectedBindableNodes.length} 个素材关联到 ${result.updatedShotNumbers.length} 个镜头`);
        }
    };

    const columns: ColumnsType<StoryboardRow> = columnOptions
        .filter((option) => visibleColumns.includes(option.value))
        .map((option) => ({
            title: option.label,
            dataIndex: option.value,
            key: option.value,
            width: option.value === "shotNumber" ? 72 : option.value === "durationSeconds" ? 100 : option.value === "assets" ? 240 : option.value === "plotDescription" || option.value === "dialogue" || option.value === "timeBeats" || option.value.endsWith("Prompt") ? 260 : 170,
            fixed: option.value === "shotNumber" ? ("left" as const) : undefined,
            render: (_: unknown, row: StoryboardRow) =>
                option.value === "shotNumber" ? (
                    <span className="font-semibold tabular-nums">{row.shotNumber}</span>
                ) : option.value === "durationSeconds" ? (
                    <InputNumber className="w-full" min={1} max={60} disabled={readOnly} value={row.durationSeconds} suffix="s" onChange={(value) => updateRow(row.id, { durationSeconds: Number(value) || 1 })} />
                ) : option.value === "assets" ? (
                    <StoryboardAssetsCell
                        bindings={row.assetBindings || []}
                        nodes={nodes}
                        selectedCanvasNodeIds={selectedCanvasNodeIds}
                        onChange={readOnly ? undefined : (assetBindings) => updateRow(row.id, { assetBindings })}
                    />
                ) : option.value === "shotSize" ? (
                    <Select
                        className="w-full"
                        disabled={readOnly}
                        value={row.shotSize || undefined}
                        placeholder="选择景别"
                        options={["特写", "近景", "中景", "全景", "远景"].map((value) => ({ value, label: value }))}
                        onChange={(shotSize) => updateRow(row.id, { shotSize })}
                    />
                ) : (
                    <Input.TextArea
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        readOnly={readOnly}
                        value={String(row[option.value] || "")}
                        placeholder={`填写${option.label}`}
                        onChange={(event) => updateRow(row.id, { [option.value]: event.target.value } as Partial<StoryboardRow>)}
                    />
                ),
        }));
    columns.push({
        title: "操作",
        key: "actions",
        dataIndex: "shotNumber",
        width: 150,
        fixed: "right" as const,
        render: (_: unknown, row: StoryboardRow) => (
            <div className="flex gap-1">
                <SmallButton title="上移" disabled={readOnly} onClick={() => moveRow(row.id, -1)}>
                    <ChevronUp className="size-3.5" />
                </SmallButton>
                <SmallButton title="下移" disabled={readOnly} onClick={() => moveRow(row.id, 1)}>
                    <ChevronDown className="size-3.5" />
                </SmallButton>
                <SmallButton title="复制" disabled={readOnly} onClick={() => duplicateRow(row)}>
                    <Copy className="size-3.5" />
                </SmallButton>
                <SmallButton title="删除" disabled={readOnly} onClick={() => removeRow(row.id)}>
                    <Trash2 className="size-3.5" />
                </SmallButton>
            </div>
        ),
    });

    return (
        <Modal title={node?.title || "分镜脚本"} open={open} onCancel={onClose} footer={null} width="min(1480px, calc(100vw - 40px))" centered destroyOnHidden>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <Input.Search className="w-72" allowClear placeholder="筛选画面、台词或提示词" value={query} onChange={(event) => setQuery(event.target.value)} />
                <CheckboxGroup className="script-column-picker" options={columnOptions} value={visibleColumns} onChange={(values) => onVisibleColumnsChange(values)} />
                <span className="min-w-0 flex-1" />
                {!readOnly && selectedBindableNodes.length > 0 && targetRowIds.length > 0 ? (
                    <Button icon={<Link2 className="size-4" />} onClick={bindSelectedAssetsToTargetRows}>
                        关联已选素材 ({selectedBindableNodes.length})
                    </Button>
                ) : null}
                <Button icon={<Plus className="size-4" />} disabled={readOnly} onClick={() => onUpdateRows([...rows, createStoryboardRow(rows.length + 1)])}>
                    新增镜头
                </Button>
                <Button icon={<ImageIcon className="size-4" />} disabled={readOnly || !targetRowIds.length} onClick={() => onGenerateImages(targetRowIds)}>
                    {storyboardEditorImageButtonLabel(videoInputMode, selectedIds.length, filteredRows.length)}
                </Button>
                <Segmented<StoryboardVideoInputMode>
                    disabled={readOnly}
                    value={videoInputMode}
                    options={[
                        { value: "direct", label: "直接生成" },
                        { value: "keyframe", label: "先做首帧" },
                    ]}
                    onChange={onVideoInputModeChange}
                />
                <Button type="primary" icon={<Film className="size-4" />} disabled={readOnly || !targetRowIds.length} onClick={() => onGenerateVideos(targetRowIds)}>
                    {storyboardEditorVideoButtonLabel(videoInputMode, selectedIds.length, filteredRows.length)}
                </Button>
            </div>
            <Table<StoryboardRow>
                rowKey="id"
                size="small"
                bordered
                sticky
                pagination={false}
                scroll={{ x: Math.max(900, columns.length * 180), y: "calc(78vh - 170px)" }}
                dataSource={filteredRows}
                columns={columns}
                rowSelection={readOnly ? undefined : { selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys.map(String)) }}
            />
        </Modal>
    );
}

function SmallButton({ title, children, onClick, disabled }: { title: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className="grid size-7 shrink-0 place-items-center rounded opacity-65 transition enabled:hover:bg-black/5 enabled:hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-25 dark:enabled:hover:bg-white/10"
            title={title}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            {children}
        </button>
    );
}
