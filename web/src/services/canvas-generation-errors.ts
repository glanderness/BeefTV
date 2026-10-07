export class CanvasGenerationDurableAckError extends Error {
    readonly code = "canvas_conflict";
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("生成结果已保留，画布尚未更新");
        this.name = "CanvasGenerationDurableAckError";
        this.cause = cause;
    }
}

export class CanvasGenerationTargetSaveError extends Error {
    constructor(cause?: unknown) {
        super("画布尚未保存，未开始生成。请先处理画布保存提示后重试。", { cause });
        this.name = "CanvasGenerationTargetSaveError";
    }
}
