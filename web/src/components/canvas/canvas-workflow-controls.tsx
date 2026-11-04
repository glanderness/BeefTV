import { Button, Popover } from "antd";
import { Settings2, SlidersHorizontal } from "lucide-react";
import { WorkflowParameterControls } from "./canvas-config-node-panel";
import { workflowFieldKey, workflowFieldRole, workflowParameterFields, workflowVideoFieldsFromJson } from "@/lib/model-capabilities";
import { workflowMediaSlotIndex, workflowSlotReference } from "@/lib/canvas/canvas-workflow-inputs";
import { workflowVideoControlFields, workflowVideoControlSummary } from "@/lib/workflow-video-controls";
import { type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export function CanvasWorkflowControls({ node, config, theme, references, onConfigChange }: {
    node: CanvasNodeData; config: AiConfig; theme: CanvasTheme; references: CanvasResourceReference[];
    onConfigChange: (id: string, patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const selected = config.runningHub.workflows.find((item) => item.workflowId === node.metadata?.runningHubWorkflowId && (item.kind === "app" ? "app" : "workflow") === (node.metadata?.runningHubWorkflowKind || "workflow"));
    const fields = selected?.fields?.length ? selected.fields : workflowVideoFieldsFromJson(selected?.workflowJson);
    const controls = workflowVideoControlFields(fields, selected?.videoControls);
    const mappedKeys = new Set(controls.map(workflowFieldKey));
    const remaining = workflowParameterFields(fields).filter((field) => !mappedKeys.has(workflowFieldKey(field)));
    const common = remaining.filter((field) => workflowFieldRole(field) === "business");
    const advanced = remaining.filter((field) => workflowFieldRole(field) !== "business");
    const media = (selected?.fields || []).filter((field) => field.enabled !== false && ["referenceImage", "referenceVideo", "referenceAudio", "mask"].includes(field.source || ""));
    const summary = workflowVideoControlSummary(fields, selected?.videoControls, node.metadata?.workflowParameters || {});
    const surface = { background: theme.node.panel, color: theme.node.text };
    return <div className="flex min-w-0 items-center gap-1" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
        {controls.length ? <Popover trigger="click" placement="topRight" content={<div className="max-h-80 w-80 overflow-y-auto" style={surface} data-canvas-no-zoom data-canvas-wheel-scroll><WorkflowParameterControls fields={controls} node={node} theme={theme} onConfigChange={onConfigChange} /></div>}>
            <Button size="small" type="text" className="canvas-generation-settings-trigger canvas-node-composer-settings-trigger [&_.lucide]:!size-3" style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} aria-label={`高级设置：${summary}`} title={`视频设置 · ${summary}`}><span className="truncate">{summary || "视频设置"}</span></Button>
        </Popover> : null}
        <Popover trigger="click" placement="topRight" content={<div className="max-h-[min(460px,65vh)] w-[min(360px,80vw)] space-y-2 overflow-y-auto text-xs" style={surface} data-canvas-no-zoom data-canvas-wheel-scroll>
            <div className="truncate font-medium">{selected?.title || selected?.workflowId || "请选择工作流"}</div>
            {common.length ? <WorkflowParameterControls fields={common} node={node} theme={theme} onConfigChange={onConfigChange} /> : null}
            {advanced.length ? <WorkflowParameterControls fields={advanced} node={node} theme={theme} onConfigChange={onConfigChange} defaultExpanded={false} /> : null}
            {media.length ? <details className="rounded-lg p-2" style={{ background: theme.node.fill }}><summary className="cursor-pointer">素材槽位 · {media.filter((field) => workflowSlotReference(field, references)).length}/{media.length}</summary><div className="mt-2 space-y-2">
                {media.map((field) => {
                    const reference = workflowSlotReference(field, references);
                    return <div key={workflowFieldKey(field)} className="flex justify-between gap-2" style={{ color: reference || !field.required ? theme.node.muted : theme.accent.danger }}><span>{field.label || field.fieldName} · 槽位 {workflowMediaSlotIndex(field) + 1}{field.required ? "（必填）" : ""}</span><span className="max-w-36 truncate" title={reference?.title}>{reference?.title || (field.source === "mask" ? "需要蒙版输入" : field.required ? "待连接素材" : "使用工作流默认值")}</span></div>;
                })}
            </div></details> : null}
            {!remaining.length && !media.length ? <p style={{ color: theme.node.muted }}>没有额外参数</p> : null}
        </div>}><Button size="small" type="text" icon={<SlidersHorizontal className="size-3" />} style={{ color: theme.node.muted }} aria-label="工作流参数">参数</Button></Popover>
    </div>;
}
