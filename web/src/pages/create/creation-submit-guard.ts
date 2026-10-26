import { videoDurationAllowed, type VideoCapabilityConfig } from "@/lib/model-capabilities";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { ReferenceImage } from "@/types/image";
import { assertVideoCapability, outputDurationNotice } from "@/services/api/video-validation";
import type { CreationMode } from "./creation-assets";

export type VideoSubmitReferences = {
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
};

// 提交前的本地核对只对视频生效：文本和图片的附件上限由各自的面板处理，
// 用视频合同去核对它们会拿 9 张图的上限误拦 Seedream 允许的 14 张，
// 也会把文本模式残留的时长当成错误。素材库里只有 resource: 标识、浏览器
// 还没读到时长的音频/视频交给后端补查，不能在这里判成「时长无法读取」。
export function videoSubmitNotice(
    mode: CreationMode,
    profile: VideoCapabilityConfig,
    seconds: string,
    references: VideoSubmitReferences,
): string {
    if (mode !== "video") return "";
    if (!videoDurationAllowed(profile, Number(seconds))) return outputDurationNotice(profile, seconds);
    try {
        assertVideoCapability(profile, references.referenceImages, references.referenceVideos, references.referenceAudios, seconds, { deferResourceMetadataToBackend: true });
    } catch (error) {
        return error instanceof Error ? error.message : "参考内容不符合当前模型要求，请调整后再提交";
    }
    return "";
}