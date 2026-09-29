import { Alert, App, Button, Form, Input, Segmented, Select, Switch } from "antd";
import { nanoid } from "nanoid";
import { useState } from "react";

import { WorkflowGraphEditor } from "@/components/workflow-graph-editor";
import { comfyUIWorkflowClassTypes, comfyUIWorkflowFields, inferComfyUIPromptField, inferComfyUIReferenceImageFields, type ComfyUIWorkflowJson } from "@/lib/comfyui-workflow";
import { fetchComfyUIObjectInfo } from "@/services/api/comfyui";
import { useConfigStore, type ComfyUIConfig, type ComfyUIWorkflow, type WorkflowFieldMapping } from "@/stores/use-config-store";

const fallbackBaseUrl = "http://127.0.0.1:8188";

/**
 * 原生 ComfyUI 的配置入口。
 *
 * 与 RunningHub 不同，这里不需要 API Key：ComfyUI 是自托管服务，
 * 配置重点是把 API 格式工作流的节点字段映射到画布参数。
 */
export function ComfyUISettingsPane() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const comfyui = config.comfyui;

    const [jsonText, setJsonText] = useState("");
    const [title, setTitle] = useState("");
    const [draftJson, setDraftJson] = useState<ComfyUIWorkflowJson | null>(null);
    const [draftFields, setDraftFields] = useState<WorkflowFieldMapping[]>([]);
    const [parsing, setParsing] = useState(false);

    const patch = (values: Partial<ComfyUIConfig>) => updateConfig("comfyui", { ...comfyui, ...values });
    const baseUrl = comfyui.baseUrl.trim() || fallbackBaseUrl;

    const parseWorkflow = async () => {
        const parsed = parseJsonObject(jsonText);
        if (!parsed) {
            message.error("工作流 JSON 解析失败，请粘贴 ComfyUI 导出的 API 格式工作流");
            return;
        }
        const classTypes = comfyUIWorkflowClassTypes(parsed);
        if (classTypes.length === 0) {
            message.error("未在工作流里识别到节点，请确认导出的是 API 格式");
            return;
        }
        setParsing(true);
        try {
            // 节点定义只用于补全枚举与数值范围；上游不可达时仍保留工作流自身的字段，
            // 用户可以手动填写，因此这里降级为提示而不是中断。
            const objectInfo = await fetchComfyUIObjectInfo(baseUrl, classTypes).catch((error: unknown) => {
                message.warning(`读取 ComfyUI 节点定义失败，已跳过枚举补全：${errorText(error)}`);
                return undefined;
            });
            // 先识别参考图槽位，再推断提示词槽位：LoadImage 与文本节点互不重叠，
            // 但顺序固定后行为更可预期。
            const fields = inferComfyUIPromptField(inferComfyUIReferenceImageFields(comfyUIWorkflowFields(parsed, objectInfo)));
            setDraftJson(parsed);
            setDraftFields(fields);
            message.success(`已解析 ${classTypes.length} 类节点，生成 ${fields.length} 个可配置字段`);
        } finally {
            setParsing(false);
        }
    };

    const saveWorkflow = () => {
        if (!draftJson) {
            message.warning("请先解析工作流 JSON");
            return;
        }
        const workflowTitle = title.trim() || `ComfyUI 工作流 ${comfyui.workflows.length + 1}`;
        const entry: ComfyUIWorkflow = {
            workflowId: nanoid(),
            title: workflowTitle,
            capability: comfyui.capability,
            workflowJson: draftJson,
            fields: draftFields,
        };
        patch({ workflows: [...comfyui.workflows, entry], workflowId: entry.workflowId });
        message.success(`已保存「${workflowTitle}」`);
    };

    const loadWorkflow = (workflowId: string) => {
        patch({ workflowId });
        const entry = comfyui.workflows.find((item) => item.workflowId === workflowId);
        if (!entry) return;
        setTitle(entry.title || "");
        setJsonText(entry.workflowJson ? JSON.stringify(entry.workflowJson, null, 2) : "");
        setDraftJson(entry.workflowJson || null);
        setDraftFields(entry.fields || []);
    };

    const removeWorkflow = (workflowId: string) => {
        const remaining = comfyui.workflows.filter((item) => item.workflowId !== workflowId);
        patch({ workflows: remaining, workflowId: comfyui.workflowId === workflowId ? remaining[0]?.workflowId || "" : comfyui.workflowId });
    };

    return (
        <div className="settings-pane space-y-4">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>ComfyUI 工作流</h2>
                    <p>连接本地或可信网络内的原生 ComfyUI，用 API 格式工作流生成图片与视频。</p>
                </div>
            </div>

            <Form layout="vertical">
                <div className="grid gap-3 lg:grid-cols-12">
                    <Form.Item className="lg:col-span-2" label="启用">
                        <Switch checked={comfyui.enabled} onChange={(enabled) => patch({ enabled })} />
                    </Form.Item>
                    <Form.Item className="lg:col-span-7" label="ComfyUI 地址">
                        <Input
                            value={comfyui.baseUrl}
                            placeholder={fallbackBaseUrl}
                            onChange={(event) => patch({ baseUrl: event.target.value })}
                            onBlur={() => patch({ baseUrl: (comfyui.baseUrl.trim() || fallbackBaseUrl).replace(/\/+$/, "") })}
                        />
                    </Form.Item>
                    <Form.Item className="lg:col-span-3" label="用途">
                        <Segmented
                            value={comfyui.capability}
                            onChange={(value) => patch({ capability: value === "video" ? "video" : "image" })}
                            options={[
                                { label: "图片", value: "image" },
                                { label: "视频", value: "video" },
                            ]}
                        />
                    </Form.Item>
                </div>
            </Form>

            <Alert
                type="info"
                showIcon
                message="本机地址需要显式放行"
                description="后端默认拒绝本机与私网上游。请用 CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1 启动后端；该白名单只按主机名匹配，端口不参与判断。"
            />

            <Form layout="vertical">
                <Form.Item
                    label="API 格式工作流 JSON"
                    extra="在 ComfyUI 里使用「导出（API 格式）」得到，粘贴后点击解析补全字段。"
                >
                    <Input.TextArea
                        rows={8}
                        value={jsonText}
                        spellCheck={false}
                        placeholder='{"3": {"class_type": "KSampler", "inputs": {"seed": 0}}}'
                        onChange={(event) => setJsonText(event.target.value)}
                    />
                </Form.Item>
                <Button onClick={parseWorkflow} loading={parsing}>
                    解析并补全字段
                </Button>
            </Form>

            {draftJson ? (
                <div className="settings-section space-y-3">
                    <Form layout="vertical">
                        <Form.Item label="工作流名称" extra="用于在画布工作流节点上区分不同工作流。">
                            <Input value={title} placeholder="例如：Flux 文生图" onChange={(event) => setTitle(event.target.value)} />
                        </Form.Item>
                    </Form>
                    <WorkflowGraphEditor
                        workflowJson={draftJson}
                        fields={draftFields}
                        onChange={setDraftFields}
                        emptyDescription="尚未解析出工作流字段"
                    />
                    <Button type="primary" onClick={saveWorkflow}>
                        保存到我的工作流
                    </Button>
                </div>
            ) : null}

            <Form layout="vertical">
                <Form.Item label="已保存条目" extra="选中后，画布工作流节点会使用该工作流的字段映射。">
                    <Select
                        value={comfyui.workflowId || undefined}
                        placeholder="尚未保存工作流"
                        allowClear
                        options={comfyui.workflows.map((item) => ({
                            label: `${item.title || item.workflowId}（${item.capability === "video" ? "视频" : "图片"}）`,
                            value: item.workflowId,
                        }))}
                        onChange={(value) => (value ? loadWorkflow(value) : patch({ workflowId: "" }))}
                    />
                </Form.Item>
                {comfyui.workflowId ? (
                    <Button danger onClick={() => removeWorkflow(comfyui.workflowId)}>
                        删除当前条目
                    </Button>
                ) : null}
            </Form>
        </div>
    );
}

function parseJsonObject(value: string): ComfyUIWorkflowJson | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as ComfyUIWorkflowJson;
    } catch {
        return null;
    }
}

function errorText(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
