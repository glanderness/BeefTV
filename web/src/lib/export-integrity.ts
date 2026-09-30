export type MissingExportFile = {
    owner: string;
    reference: string;
};

/** Incomplete archives cannot safely serve as a backup. Keep every missing reference. */
export class ExportIntegrityError extends Error {
    readonly missingFiles: MissingExportFile[];

    constructor(missingFiles: MissingExportFile[]) {
        const unique = [...new Map(missingFiles.map((item) => [JSON.stringify([item.owner, item.reference]), item])).values()]
            .sort((a, b) => a.owner.localeCompare(b.owner) || a.reference.localeCompare(b.reference));
        super(`导出未完成：缺少 ${unique.length} 个文件，未生成不完整的备份。请找回以下文件后重试：\n${unique.map((item) => `${item.owner}：${item.reference}`).join("\n")}`);
        this.name = "ExportIntegrityError";
        this.missingFiles = unique;
    }
}
