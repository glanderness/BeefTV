import { expect, test } from "bun:test";

import { explainGenerationError, generationErrorMessage, generationFailureMetadata } from "../src/lib/generation-error";

test("local runtime reports local resource directory errors only for actual local storage failures", () => {
    for (const localFailure of [
        "create local resource directory: permission denied",
        "参考图片上传失败：write local resource: input/output error",
        "保存文件到本地资源目录失败",
        "图片保存未完成，请检查本机存储空间",
    ]) {
        const explained = explainGenerationError(localFailure);
        expect(explained.category).toBe("input_inaccessible");
        expect(explained.message).toBe("本地参考素材保存失败，请检查本地资源目录后重试");
    }

    const diskFull = explainGenerationError("write local resource: no space left on device");
    expect(diskFull.category).toBe("local_disk_full");
});

test("local runtime preserves remote upload, object storage, and HTTP 403 causes instead of blaming local directory", () => {
    expect(generationErrorMessage("参考图片上传失败")).toBe("参考素材上传失败，请检查网络连接或对象存储配置后重试");
    expect(generationErrorMessage("参考媒体上传失败：failed to fetch")).toBe("参考素材上传失败，请检查网络连接或对象存储配置后重试");
    expect(generationErrorMessage("OSS 上传失败：对象存储不可用")).toBe("参考素材上传到对象存储失败，请检查网络连接或对象存储配置后重试");
    expect(generationErrorMessage("七牛云上传失败")).toBe("参考素材上传到对象存储失败，请检查网络连接或对象存储配置后重试");
    expect(generationErrorMessage("腾讯云 COS 上传失败：i/o timeout")).toBe("参考素材上传失败，请检查网络连接或对象存储配置后重试");
    expect(generationErrorMessage("S3 upload failed: connection reset")).toBe("参考素材上传失败，请检查网络连接或对象存储配置后重试");

    for (const denied of [
        "对象存储拒绝上传（HTTP 403），请检查区域、密钥和存储桶权限",
        "参考图片上传失败：HTTP 403 SignatureDoesNotMatch",
        "OSS 上传失败：AccessDenied",
    ]) {
        const msg = generationErrorMessage(denied);
        expect(msg).toBe("参考素材上传被拒绝（HTTP 403），请检查对象存储密钥和存储桶权限后重试");
        expect(msg).not.toContain("本地参考素材保存失败");
    }

    expect(generationErrorMessage("素材已上传，但公网地址不可读取（HTTP 403），请检查公开读取设置")).toBe(
        "参考素材已上传，但公网地址无法读取，请检查对象存储公开读取权限后重试",
    );
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
