import { Button, ConfigProvider, Form, Input, Select } from "antd";
import { Plus, X } from "lucide-react";
import { WorkspaceForm } from "../../src/components/ui/product/workspace-form";
import { getWorkspaceAntThemeConfig } from "../../src/lib/app-theme";

export type ControlsExampleState = "default" | "disabled" | "loading" | "error";

/** Reusable, backend-free specimen. Interactions use the same production controls. */
export function WorkspaceControlsStates({ state = "default" }: { state?: ControlsExampleState }) {
    const busy = state === "loading";
    const disabled = state === "disabled" || busy;
    return <ConfigProvider theme={getWorkspaceAntThemeConfig()}><WorkspaceForm name={`controls-${state}`} disabled={disabled} aria-busy={busy}>
        <Form.Item name="name" label="名称" validateStatus={state === "error" ? "error" : undefined} help={state === "error" ? "请填写技能名称" : undefined} rules={[{ required: true, message: "请填写技能名称" }]}>
            <Input placeholder="为技能起一个清晰的名称" allowClear />
        </Form.Item>
        <Form.Item name="description" label="简介"><Input.TextArea rows={2} placeholder="说明输入、输出和使用场景" /></Form.Item>
        <Form.Item name="category" label="分类"><Select placeholder="选择分类" allowClear options={[{ value: "creative", label: "创意设计" }, { value: "writing", label: "长名称示例：中文 English 123 混排" }, { value: "unavailable", label: "暂不可用", disabled: true }]} /></Form.Item>
        <div className="workspace-control-group">
            <Button type="primary" htmlType="submit" loading={busy} disabled={disabled} aria-busy={busy}>保存修改</Button>
            <Button>取消</Button>
            <Button type="text" size="small" icon={<Plus className="size-4" />}>添加媒体</Button>
            <Button type="text" size="small" icon={<X className="size-4" />} aria-label="关闭示例" />
            <Button danger>删除</Button>
        </div>
    </WorkspaceForm></ConfigProvider>;
}
