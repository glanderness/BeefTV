import { expect, test } from "bun:test";

import { generationErrorMessage, generationFailureMetadata, PROVIDER_PAYMENT_REQUIRED_ERROR_CODE } from "../src/lib/generation-error";

test("local generation errors do not expose hosted object-storage wording", () => {
    expect(generationErrorMessage("OSS 上传失败：对象存储不可用")).toBe("本地参考素材保存失败，请检查本地资源目录后重试。");
    expect(generationErrorMessage("参考图片上传失败")).toBe("本地参考素材保存失败，请检查本地资源目录后重试。");
});

test("HTTP 402 explains the upstream billing cause and exposes a stable canvas error code", () => {
    const raw = "模型服务请求失败（HTTP 402）";
    expect(generationErrorMessage(raw)).toContain("余额");
    expect(generationErrorMessage(raw)).toContain("订阅");
    expect(generationFailureMetadata(raw, "prompt")).toEqual({
        errorDetails: generationErrorMessage(raw),
        generationErrorCode: PROVIDER_PAYMENT_REQUIRED_ERROR_CODE,
    });
});

test("HTTP 402 keeps the classified upstream cause without exposing its raw body", () => {
    expect(generationErrorMessage("上游模型服务返回 HTTP 402：当前账户的订阅或模型权限不足，请检查模型套餐、计费状态和账号权限")).toBe(
        "上游模型服务返回 HTTP 402：当前账户的订阅或模型权限不足，请检查模型套餐、计费状态和账号权限。",
    );
});
