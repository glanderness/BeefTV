// Provider-neutral resource references. Inline bytes stay in backend resources.
export type GenerationOutput = {
    id: string;
    outputIndex: number;
    mediaType: "image" | "video" | "audio" | "file";
    sourceNodeId?: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    resourceId?: string;
    assetId?: string;
    mimeType?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export function primaryGenerationOutput(outputs: GenerationOutput[], mode: string, selectedId?: string) {
    return outputs.find((item) => item.id === selectedId && item.mediaType === mode)
        || outputs.find((item) => item.mediaType === mode);
}
