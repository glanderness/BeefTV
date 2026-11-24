import { isLocalRuntimeMode } from "@/lib/runtime-mode";
import {
    debugIdLine,
    extractProviderFields,
    isNetworkText,
    joinSentences,
    sanitizeDebugId,
    type CategoryCopy,
    type GenerationErrorCategory,
} from "./generation-error-classifiers";

export type ReferenceStorageClassified = {
    category: GenerationErrorCategory;
    reason?: string;
    action?: string;
    providerCode?: string;
    requestId?: string;
    taskId?: string;
    fromCode?: boolean;
    uncertain?: boolean;
    retryable: boolean;
};

export const REFERENCE_PREPARATION_COPY: Record<string, CategoryCopy> = {
    image_reference_upload_failed: { reason: "参考图片上传失败，本次尚未开始生成", action: "请稍后重试" },
    reference_media_upload_failed: { reason: "参考素材上传失败，本次尚未开始生成", action: "请检查对象存储配置和公开读取权限后重试" },
    reference_preupload_failed: { reason: "参考素材上传失败，本次尚未开始生成", action: "请检查网络或稍后重试" },
};

export const SAFE_STORAGE_REJECTION_CODES = [
    "AccessDenied",
    "SignatureDoesNotMatch",
    "InvalidAccessKeyId",
    "NoSuchBucket",
    "InvalidBucketName",
    "RequestTimeTooSkewed",
    "AuthorizationHeaderMalformed",
    "PermanentRedirect",
] as const;

const SAFE_STORAGE_REJECTION_CODE_PATTERN = new RegExp(`\\b(${SAFE_STORAGE_REJECTION_CODES.join("|")})\\b`, "i");
const SAFE_STORAGE_REJECTION_REASON_PATTERN = /^.+?（HTTP ([345]\d{2})(?:，([A-Za-z]+))?），本次尚未开始生成$/;

// Mirrors backend/internal/referencestorage.SafeStorageRejectionCopy so persisted
// pre-submission storage failures keep consistent manual/automatic retry semantics.
export function safeStorageRejectionCopy(statusCode: string, code: string): CategoryCopy {
    switch (code) {
        case "AccessDenied":
            return {
                reason: `对象存储拒绝上传（HTTP ${statusCode}，AccessDenied），本次尚未开始生成`,
                action: "请检查存储桶访问权限（推荐公有读私有写）以及子账号/CAM 是否具备写入与删除权限",
            };
        case "SignatureDoesNotMatch":
            return {
                reason: `对象存储签名校验失败（HTTP ${statusCode}，SignatureDoesNotMatch），本次尚未开始生成`,
                action: "请检查 Secret Access Key、区域代码（如 ap-guangzhou / auto）及本机系统时间后重试",
            };
        case "InvalidAccessKeyId":
            return {
                reason: `对象存储密钥无效（HTTP ${statusCode}，InvalidAccessKeyId），本次尚未开始生成`,
                action: "请检查 Access Key ID（腾讯云 COS 为 SecretId）后重试",
            };
        case "NoSuchBucket":
        case "InvalidBucketName":
            return {
                reason: `找不到指定的对象存储桶（HTTP ${statusCode}，${code}），本次尚未开始生成`,
                action: "请检查存储桶名称（腾讯云 COS 须含 -APPID 后缀）与区域端点是否一致后重试",
            };
        case "RequestTimeTooSkewed":
            return {
                reason: `对象存储拒绝上传（HTTP ${statusCode}，RequestTimeTooSkewed），本次尚未开始生成`,
                action: "请校准本机系统时间后重试",
            };
        case "AuthorizationHeaderMalformed":
        case "PermanentRedirect":
            return {
                reason: `对象存储区域或端点不匹配（HTTP ${statusCode}，${code}），本次尚未开始生成`,
                action: "请核对 S3 端点与区域代码是否一致后重试",
            };
        default:
            if (statusCode === "403") {
                return {
                    reason: "对象存储拒绝上传（HTTP 403），本次尚未开始生成",
                    action: "请检查访问密钥、存储桶名称（腾讯云 COS 须含 -APPID）、区域及存储桶/子账号写入权限",
                };
            }
            return {
                reason: `对象存储拒绝上传（HTTP ${statusCode}），本次尚未开始生成`,
                action: "请检查对象存储端点、区域、访问密钥与存储桶权限后重试",
            };
    }
}

export function matchOwnedStorageRejectionCopy(reason: string, action: string): CategoryCopy | undefined {
    const match = reason.trim().match(SAFE_STORAGE_REJECTION_REASON_PATTERN);
    if (!match) return undefined;
    const statusCode = match[1];
    const code = match[2] || "";
    const expected = safeStorageRejectionCopy(statusCode, code);
    if (reason.trim() === expected.reason && action.trim() === expected.action) {
        return expected;
    }
    return undefined;
}

export function persistedReferencePreparation(raw: string): ReferenceStorageClassified | undefined {
    const text = raw.trim();
    const debug = text.match(/。排查编号：([^。]+)。?$/)?.[1] || "";
    const requestId = sanitizeDebugId(debug.match(/(?:^| · )请求 ([A-Za-z0-9._:-]{6,127})$/)?.[1]);
    const taskId = sanitizeDebugId(debug.match(/^任务 ([A-Za-z0-9._:-]{6,127})(?: · |$)/)?.[1]);
    for (const [providerCode, copy] of Object.entries(REFERENCE_PREPARATION_COPY)) {
        const message = joinSentences(copy.reason, copy.action, debugIdLine(taskId, requestId));
        if (text === message || text === message.replace(/。$/, "")) {
            return { category: "provider_unavailable", ...copy, providerCode, requestId, taskId, fromCode: true, retryable: false };
        }
    }
    const debugMatch = text.match(/。排查编号：([^。]+)。?$/);
    const body = (debugMatch ? text.slice(0, debugMatch.index) : text).replace(/。$/, "").trim();
    const sep = body.indexOf("。");
    if (sep > 0) {
        const reason = body.slice(0, sep).trim();
        const action = body.slice(sep + 1).trim();
        const owned = matchOwnedStorageRejectionCopy(reason, action);
        if (owned) {
            const message = joinSentences(owned.reason, owned.action, debugIdLine(taskId, requestId));
            if (text === message || text === message.replace(/。$/, "")) {
                return { category: "provider_unavailable", ...owned, providerCode: "reference_media_upload_failed", requestId, taskId, fromCode: true, retryable: false };
            }
        }
    }
    return undefined;
}

export function confirmedReferencePreparation(classified: Pick<ReferenceStorageClassified, "uncertain" | "category" | "providerCode" | "reason" | "action">) {
    if (classified.uncertain || classified.category !== "provider_unavailable") return false;
    const copy = REFERENCE_PREPARATION_COPY[classified.providerCode || ""];
    if (copy && classified.reason === copy.reason && classified.action === copy.action) return true;
    return classified.providerCode === "reference_media_upload_failed" && Boolean(matchOwnedStorageRejectionCopy(classified.reason || "", classified.action || ""));
}

const LOCAL_DISK_FULL_STORAGE_SIGNAL = /(?:no space left on device|not enough space on the disk|disk full|database or disk is full|本地磁盘空间不足)/i;
const LOCAL_RESOURCE_WRITE_FAILURE = /(?:(?:create|set|write|sync|close|publish|resolve)\s+local\s+resource|local\s+resource\s+(?:body|path|parent|root|store|object\s+key)|本地参考素材保存失败|本地资源目录(?:不可用|无法(?:访问|写入|读取|创建)|写入失败|保存失败|权限)|(?:保存|写入)(?:文件|参考素材|参考图片|参考媒体)?到本地资源目录(?:失败)?|写入桌面资源目录失败|(?:图片|媒体)保存未完成[，,]?\s*请检查本机存储空间)/i;
const REMOTE_OBJECT_STORAGE_SIGNAL = /(?:(?:OSS|COS|S3|R2)\s*上传失败|\b(?:OSS|COS|S3|R2)\s+upload\s+failed\b|对象存储|腾讯云\s*COS|阿里云\s*OSS|七牛云)/i;
const REMOTE_REFERENCE_UPLOAD_SIGNAL = /(?:参考(?:图片|图|媒体|视频|音频|素材)(?:\s*\d+\s*)?(?:预)?上传(?:文件)?失败|素材已上传[，,]?\s*但公网地址(?:无法访问|不可读取)|公网地址未返回上传的素材)/i;
const POST_UPLOAD_PUBLIC_READ_SIGNAL = /(?:素材已上传[，,]?\s*但公网地址(?:无法访问|不可读取)|公网地址(?:无法访问|不可读取)|公网地址未返回上传的素材)/;

export function resourceStorageFailureMessage(rawValue: string) {
    if (!rawValue) return "";
    const trimmed = rawValue.trim();
    const value = /^[{[]/.test(trimmed) ? extractProviderFields(trimmed).message : trimmed;
    if (!value || LOCAL_DISK_FULL_STORAGE_SIGNAL.test(value)) return "";
    if (isLocalRuntimeMode() && LOCAL_RESOURCE_WRITE_FAILURE.test(value) && !REMOTE_OBJECT_STORAGE_SIGNAL.test(value)) {
        return "本地参考素材保存失败，请检查本地资源目录后重试。";
    }
    if (/\bUserDisable\b/i.test(value)) return "对象存储账号已停用，请检查或更换对象存储配置。";
    if (REMOTE_OBJECT_STORAGE_SIGNAL.test(value) || REMOTE_REFERENCE_UPLOAD_SIGNAL.test(value)) {
        // Explicit post-upload public-read probe failure takes precedence even if
        // the public GET response also mentions AccessDenied.
        if (POST_UPLOAD_PUBLIC_READ_SIGNAL.test(value)) {
            return "参考素材已上传，但公网地址无法读取，请检查对象存储公开读取权限后重试。";
        }
        const httpStatus = value.match(/(?:HTTP\s*|status(?:\s*code)?\s*[:=]?\s*)([345]\d{2})\b/i)?.[1];
        const rawCodeMatch = value.match(SAFE_STORAGE_REJECTION_CODE_PATTERN)?.[1];
        const codeMatch = rawCodeMatch ? SAFE_STORAGE_REJECTION_CODES.find((item) => item.toLowerCase() === rawCodeMatch.toLowerCase()) : undefined;
        const isStorageUploadRejected = /(?:对象存储(?:拒绝上传|签名校验失败|密钥无效|区域或端点不匹配|请求签名失败)|找不到指定的对象存储桶|参考素材上传被拒绝)/.test(value);
        if (codeMatch || isStorageUploadRejected || /\b403\s+Forbidden\b/i.test(value) || httpStatus === "403") {
            const statusLabel = httpStatus || (codeMatch === "NoSuchBucket" ? "404" : codeMatch === "InvalidBucketName" || codeMatch === "AuthorizationHeaderMalformed" ? "400" : codeMatch === "PermanentRedirect" ? "301" : "403");
            const copy = safeStorageRejectionCopy(statusLabel, codeMatch || "");
            return `${copy.reason.replace(/，本次尚未开始生成$/, "")}，${copy.action.replace(/。$/, "")}。`;
        }
        if (/(?:尚未启用参考素材对象存储|请先启用参考素材对象存储|对象存储配置(?:损坏|无法解密|无法读取|不可用))/i.test(value)) {
            return "参考素材对象存储配置不可用，请检查存储设置后重试。";
        }
        if (REMOTE_OBJECT_STORAGE_SIGNAL.test(value) && !isNetworkText(value) && !/(?:网络|连接|超时)/i.test(value)) {
            return "参考素材上传到对象存储失败，请检查网络连接或对象存储配置后重试。";
        }
        return "参考素材上传失败，请检查网络连接或对象存储配置后重试。";
    }
    return "";
}
