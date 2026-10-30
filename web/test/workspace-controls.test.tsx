import { expect, test } from "bun:test";
import { Button, Form, Input, Select } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceForm } from "../src/components/ui/product/workspace-form";
import { getWorkspaceAntThemeConfig } from "../src/lib/app-theme";
import { WorkspaceControlsStates } from "./fixtures/workspace-controls-states";

test("workspace form preserves field binding, disabled context and accessible validation", () => {
    const html = renderToStaticMarkup(<WorkspaceForm name="control-check" disabled>
        <Form.Item name="name" label="名称" validateStatus="error" help="请填写技能名称"><Input /></Form.Item>
        <Form.Item name="category" label="分类"><Select options={[{ value: "creative", label: "创意设计" }]} /></Form.Item>
        <Button htmlType="submit">保存</Button>
    </WorkspaceForm>);
    expect(html).toContain("workspace-controls-form");
    expect(html).toContain('for="control-check_name"');
    expect(html).toContain('aria-describedby="control-check_name_help"');
    expect(html).toContain("ant-input-status-error");
    expect(html).toContain("ant-select-disabled");
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled/);
});

test("shared workspace geometry retains the approved AntD dimensions", () => {
    const theme = getWorkspaceAntThemeConfig();
    expect([theme.token?.controlHeightSM, theme.token?.controlHeight, theme.token?.controlHeightLG]).toEqual([30, 38, 44]);
    expect([theme.components?.Button?.borderRadiusSM, theme.components?.Button?.borderRadius, theme.components?.Button?.borderRadiusLG]).toEqual([8, 12, 14]);
    expect(theme.components?.Button?.paddingInline).toBe(14);
    expect(theme.components?.Input?.paddingInline).toBe(12);
    expect(theme.components?.Button?.defaultBorderColor).toBe("transparent");
});

test("state examples retain loading, disabled and error semantics without a backend", () => {
    const loading = renderToStaticMarkup(<WorkspaceControlsStates state="loading" />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("ant-btn-loading");
    expect(loading).toContain("ant-select-disabled");
    expect(renderToStaticMarkup(<WorkspaceControlsStates state="error" />)).toContain("ant-input-status-error");
    const normal = renderToStaticMarkup(<WorkspaceControlsStates />);
    expect(normal).toContain('aria-label="关闭示例"');
    expect(normal).toContain('type="submit"');
    expect(normal).not.toContain("ant-select-disabled");
});
