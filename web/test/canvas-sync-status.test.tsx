import { describe, expect, test } from "bun:test";
import { canvasSyncStatusView } from "@/pages/canvas/canvas-sync-status";

describe("本地画布保存状态", () => {
    test("排队和提交中都显示正在保存，不提前说已保存", () => {
        for (const phase of ["pending", "saving", "uploading"] as const) {
            expect(canvasSyncStatusView({ phase })).toEqual({ label: "正在保存", tone: "saving", detail: "正在保存到本机。" });
        }
    });

    test("服务端接受后才显示已保存在本地", () => {
        expect(canvasSyncStatusView({ phase: "done", message: "画布已保存" })).toEqual({ label: "已保存在本地", tone: "saved", detail: "画布已保存在本机。" });
        expect(canvasSyncStatusView(undefined).label).toBe("已保存在本地");
    });

    test("保存失败时说明修改还在本机，并给出重试", () => {
        expect(canvasSyncStatusView({ phase: "error", message: "保存没有完成，修改仍保留在本机。" })).toEqual({
            label: "保存失败",
            tone: "failed",
            detail: "保存没有完成，修改仍保留在本机。",
            action: "retry-save",
        });
    });

    test("历史 conflict phase 不会锁定界面，回退显示已保存在本地", () => {
        expect(canvasSyncStatusView({ phase: "conflict", message: "旧状态" })).toEqual({
            label: "已保存在本地",
            tone: "saved",
            detail: "画布已保存在本机。",
        });
    });
});
