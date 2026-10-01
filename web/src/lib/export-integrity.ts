export type MissingExportFile = {
    owner: string;
    reference: string;
};

/** Incomplete archives cannot safely serve as a backup. Keep every missing reference. */
export class ExportIntegrityError extends Error {
    readonly missingFiles: MissingExportFile[];

    constructor(missingFiles: MissingExportFile[]) {
        const unique = uniqueMissingExportFiles(missingFiles);
        super(`导出未完成：缺少 ${unique.length} 个文件，未生成不完整的备份。请找回以下文件后重试：\n${unique.map((item) => `${item.owner}：${item.reference}`).join("\n")}`);
        this.name = "ExportIntegrityError";
        this.missingFiles = unique;
    }
}

export function uniqueMissingExportFiles(missingFiles: MissingExportFile[]): MissingExportFile[] {
    return [...new Map(missingFiles.map((item) => [JSON.stringify([item.owner, item.reference]), item])).values()]
        .sort((a, b) => a.owner.localeCompare(b.owner) || a.reference.localeCompare(b.reference));
}

export function assertBackupHasEntries(count: number, kind: "workspace" | "assets"): void {
    if (count > 0) return;
    throw new Error(kind === "workspace" ? "工作区为空，未生成备份。" : "没有可备份的素材，未生成备份。");
}

export function assertUniqueArchiveNames(names: Iterable<string>): void {
    const seen = new Set<string>();
    for (const name of names) {
        if (seen.has(name)) throw new Error(`导出包存在重名文件，未保存：${name}`);
        seen.add(name);
    }
}

export function archiveFileExtension(mimeType: string, fallback: "png" | "bin" | "wav" | "mp3"): string {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("gltf-binary")) return "glb";
    if (mimeType.includes("gltf+json") || mimeType.includes("json")) return "gltf";
    return fallback;
}
