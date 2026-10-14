import { expect, test } from "bun:test";

import { generationErrorMessage, generationFailureMetadata } from "../src/lib/generation-error";
import { ApiError } from "@/services/api/request";

test("local desktop admission failure is distinguished from upstream model permission", () => {
    const message = generationErrorMessage(new ApiError("任务只能由当前桌面界面创建", { status: 403, reason: "desktop_ui_required" }));
    expect(message).toContain("桌面界面的身份校验失败");
    expect(message).toContain("任务尚未提交");
    expect(message).not.toContain("更换模型");
    expect(generationErrorMessage(new ApiError("forbidden", { status: 403, reason: "forbidden" }))).toContain("该模型的权限");
});

test("local generation errors do not expose hosted object-storage wording", () => {
    expect(generationErrorMessage("OSS 上传失败：对象存储不可用")).toBe("本地参考素材保存失败，请检查本地资源目录后重试");
    expect(generationErrorMessage("参考图片上传失败")).toBe("本地参考素材保存失败，请检查本地资源目录后重试");
});

test("HTTP 402 explains the upstream billing cause and exposes a stable canvas error code", () => {
    const raw = "模型服务请求失败（HTTP 402）";
    expect(generationErrorMessage(raw)).toContain("计费或额度");
    expect(generationErrorMessage(raw)).not.toContain("余额不足");
    expect(generationFailureMetadata(raw, "prompt")).toEqual({
        errorDetails: generationErrorMessage(raw),
        generationErrorCode: "quota_unknown",
        generationErrorSummary: raw,
    });
});

test("HTTP 402 keeps the classified upstream cause without exposing its raw body", () => {
    expect(generationErrorMessage({ status: 402, data: { error: { message: "subscription required api_key=PRIVATE" } } })).toContain("计费或额度");
    expect(generationErrorMessage({ status: 402, data: { error: { message: "subscription required api_key=PRIVATE" } } })).not.toContain("PRIVATE");
});
