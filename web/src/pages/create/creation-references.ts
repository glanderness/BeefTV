import { buildSkillMentionReferences } from "@/services/skill-runtime";
import { canvasResourceMentionToken, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { Skill } from "@/services/api/skills";
import { creationAttachmentKind, type CreationAttachment } from "./creation-assets";

export type CreationReference = CanvasResourceReference & {
    attachmentId?: string;
};

export function buildCreationMentionReferences(skills: Skill[], attachments: CreationAttachment[] = [], snapshots: CreationReference[] = []) {
    const counts = { image: 0, video: 0, audio: 0, file: 0 };
    const attachmentReferences = attachments.map((attachment) => {
        const kind = creationAttachmentKind(attachment);
        return attachmentReference(attachment, counts[kind]++);
    });
    const skillReferences = buildSkillMentionReferences(skills) as CreationReference[];
    const current = [...attachmentReferences, ...skillReferences];
    const currentIDs = new Set(current.map((reference) => reference.id));
    const restored = snapshots.filter((reference) => reference.kind === "skill" && !currentIDs.has(reference.id));
    return [...current, ...restored].map((reference) => ({ ...reference, active: true }));
}

export function selectedCreationReferences(prompt: string, references: CreationReference[]) {
    return references.filter((reference) => prompt.includes(canvasResourceMentionToken(reference)) || prompt.includes(`@${reference.label}`));
}

export function reconcileCreationAttachmentLimit(attachments: CreationAttachment[], references: CreationReference[], maxReferences: number) {
    const limit = Math.max(0, Math.floor(maxReferences));
    if (attachments.length <= limit) return { attachments, removedReferences: [] as CreationReference[] };

    const nextAttachments = attachments.slice(0, limit);
    const removedAttachmentIds = new Set(attachments.slice(limit).map((attachment) => attachment.id));
    const removedReferences = references.filter((reference) => reference.attachmentId && removedAttachmentIds.has(reference.attachmentId));
    return { attachments: nextAttachments, removedReferences };
}

export type CreationAttachmentAddPlan = {
    attachments: CreationAttachment[];
    addedCount: number;
    droppedCount: number;
    limit: number;
};

/**
 * 创作页把图片、视频、音频排进同一列参考内容，这一列的槽位数取自当前模型的参考图上限；
 * 而视频模型对参考图、参考视频、参考音频是分别计数的（例如参考图 9 张、参考视频 3 个、参考音频 3 段）。
 * 因此所有提示都要说成创作页的槽位限制，不能写成模型对全部参考素材的上限，否则会误导用户去删素材或换模型。
 */
export function referenceSlotLimitLabel(limit: number) {
    return `创作页的 ${limit} 个参考内容槽位（取自当前模型的参考图上限）`;
}

/** 点「添加参考内容」时才凑到上限的提示：说明是创作页槽位，并点出模型侧是按素材类型分别计数的。 */
export function referenceSlotLimitMessage(limit: number, mediaLimits?: { videos: number; audios: number }) {
    if (limit <= 0) return "当前模型不支持参考图输入，请切换到支持参考图输入的模型";
    const modelLimits = [`参考图 ${limit} 张`];
    if (mediaLimits?.videos && mediaLimits.videos > 0) modelLimits.push(`参考视频 ${mediaLimits.videos} 个`);
    if (mediaLimits?.audios && mediaLimits.audios > 0) modelLimits.push(`参考音频 ${mediaLimits.audios} 段`);
    return `创作页一次最多放入 ${limit} 个参考内容：槽位取自当前模型的参考图上限，模型侧是按类型分别计数的（${modelLimits.join("、")}）。可先移除部分参考内容，或切换到参考图更多的模型`;
}

/** 从素材库选入后被槽位挡住的提示：说清上限多少、进去几个、剩下几个为什么没进去。 */
export function attachmentLimitMessage(limit: number, addedCount: number, droppedCount: number) {
    const dropped = Math.max(0, droppedCount);
    if (limit <= 0) return `当前模型不支持参考图输入，已忽略 ${dropped} 个素材`;
    if (addedCount > 0) return `${referenceSlotLimitLabel(limit)}，已加入 ${addedCount} 个，另有 ${dropped} 个未加入`;
    return `${referenceSlotLimitLabel(limit)}已满，所选 ${dropped} 个素材未加入`;
}

/** 切换模型或恢复会话导致超出槽位、自动移除时的提示。 */
export function attachmentRemovalMessage(limit: number, removedCount: number) {
    if (limit <= 0) return `当前模型不支持参考图输入，已移除 ${removedCount} 个素材`;
    return `${referenceSlotLimitLabel(limit)}已满，已移除 ${removedCount} 个超出槽位的素材`;
}

/**
 * 把新选中的素材并入现有参考内容，并报告因超出创作页槽位被丢掉的个数，
 * 让界面能明确提示「还有几个没加进去」，而不是静默裁剪。
 */
export function planCreationAttachmentAdd(attachments: CreationAttachment[], incoming: CreationAttachment[], maxReferences: number): CreationAttachmentAddPlan {
    const limit = Math.max(0, Math.floor(maxReferences));
    const incomingIDs = new Set(incoming.map((attachment) => attachment.id));
    const merged = [...attachments.filter((attachment) => !incomingIDs.has(attachment.id)), ...incoming];
    const kept = merged.slice(0, limit);
    const keptIDs = new Set(kept.map((attachment) => attachment.id));
    const existingIDs = new Set(attachments.map((attachment) => attachment.id));
    const addedCount = incoming.filter((attachment) => keptIDs.has(attachment.id) && !existingIDs.has(attachment.id)).length;
    const droppedCount = incoming.filter((attachment) => !keptIDs.has(attachment.id)).length;
    return { attachments: kept, addedCount, droppedCount, limit };
}

export function removeCreationReferenceTokens(value: string, references: CreationReference[]) {
    return references.reduce((current, reference) => current.split(canvasResourceMentionToken(reference)).join("").split(`@${reference.label}`).join(""), value);
}

export function replaceCreationAttachmentReference(prompt: string, attachments: CreationAttachment[], targetAttachmentId: string, replacement: CreationAttachment) {
    const targetIndex = attachments.findIndex((attachment) => attachment.id === targetAttachmentId);
    if (targetIndex < 0) throw new Error("要替换的参考内容不存在");
    if (replacement.id === targetAttachmentId) return { prompt, attachments };

    const currentReferences = buildCreationMentionReferences([], attachments);
    const targetReference = currentReferences.find((reference) => reference.attachmentId === targetAttachmentId);
    if (!targetReference) throw new Error("要替换的提示词引用不存在");

    const remainingAttachments = attachments.filter((attachment) => attachment.id !== targetAttachmentId && attachment.id !== replacement.id);
    const insertionIndex = Math.min(targetIndex, remainingAttachments.length);
    const nextAttachments = [
        ...remainingAttachments.slice(0, insertionIndex),
        replacement,
        ...remainingAttachments.slice(insertionIndex),
    ];
    const replacementReference = buildCreationMentionReferences([], nextAttachments).find((reference) => reference.attachmentId === replacement.id);
    if (!replacementReference) throw new Error("替换后的提示词引用无效");

    const targetToken = canvasResourceMentionToken(targetReference);
    const replacementToken = canvasResourceMentionToken(replacementReference);
    const normalizedPrompt = replaceVisibleReferenceLabel(prompt, targetReference.label, replacementToken);
    return {
        prompt: normalizedPrompt.split(targetToken).join(replacementToken),
        attachments: nextAttachments,
    };
}

export function displayCreationPrompt(prompt: string, references: CreationReference[]) {
    return references.reduce((value, reference) => value.split(canvasResourceMentionToken(reference)).join(`@${reference.label}`), prompt);
}

export function expandCreationPrompt(prompt: string, references: CreationReference[], attachments: CreationAttachment[] = []) {
    const visiblePrompt = displayCreationPrompt(prompt, references).trim();
    if (!references.length) return visiblePrompt;

    const contexts: string[] = [];
    const mediaMappings: string[] = [];
    const attachmentPositions = new Map(attachments.map((attachment, index) => [attachment.id, index + 1]));
    references.forEach((reference) => {
        if (reference.attachmentId) {
            const position = attachmentPositions.get(reference.attachmentId);
            const kindLabel = reference.kind === "video" ? "视频" : reference.kind === "audio" ? "音频" : reference.kind === "text" ? "文件" : "图片";
            mediaMappings.push(`- @${reference.label}：参考${kindLabel} ${position || 1}`);
            return;
        }
    });

    if (mediaMappings.length) contexts.push(`【资源对应关系】\n${mediaMappings.join("\n")}`);
    return [...contexts, `【创作要求】\n${visiblePrompt}`].filter(Boolean).join("\n\n");
}

function attachmentReference(attachment: CreationAttachment, index: number): CreationReference {
    const kind = creationAttachmentKind(attachment);
    const label = kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "file" ? "文件" : "图片";
    return {
        id: `upload:${attachment.id}`,
        nodeId: `upload:${attachment.id}`,
        kind: kind === "file" ? "text" : kind,
        label: `${label}${index + 1}`,
        title: "当前参考内容",
        previewUrl: attachment.previewUrl || ("dataUrl" in attachment ? attachment.dataUrl : attachment.url),
        storageKey: attachment.storageKey,
        active: true,
        attachmentId: attachment.id,
        mentionToken: `@[attachment:${attachment.id}]`,
    };
}

function replaceVisibleReferenceLabel(value: string, label: string, replacementToken: string) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.replace(new RegExp(`@${escapedLabel}(?=$|\\s|[,.!?;:，。！？；：、)\\]}】）])`, "gu"), replacementToken);
}
