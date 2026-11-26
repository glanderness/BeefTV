import { http } from "@/services/api/request";

export type CreativeBibleCharacter = {
    id: string;
    name: string;
    appearance?: string;
    wardrobe?: string;
    voice?: string;
    notes?: string;
    referenceAssetId?: string;
};

export type CreativeBibleLocation = {
    id: string;
    name: string;
    description?: string;
    lighting?: string;
    notes?: string;
    referenceAssetId?: string;
};

export type CreativeBible = {
    scopeKind: "project" | "canvas";
    scopeId: string;
    title?: string;
    logline?: string;
    visualStyle?: string;
    colorPalette?: string;
    cameraRules?: string;
    taboos?: string;
    characters: CreativeBibleCharacter[];
    locations: CreativeBibleLocation[];
    revision: number;
    updatedAt?: string;
};

export type CreativeBibleResponse = {
    bible: CreativeBible;
    digest: string;
    empty: boolean;
};

export type CreativeBibleUpdateInput = {
    expectedRevision?: number;
    title?: string;
    logline?: string;
    visualStyle?: string;
    colorPalette?: string;
    cameraRules?: string;
    taboos?: string;
    characters?: CreativeBibleCharacter[];
    locations?: CreativeBibleLocation[];
};

export async function getProjectCreativeBible(projectId: string, signal?: AbortSignal) {
    return http.get<CreativeBibleResponse>(`/projects/${encodeURIComponent(projectId)}/creative-bible`, { signal });
}

export async function saveProjectCreativeBible(projectId: string, input: CreativeBibleUpdateInput) {
    return http.put<CreativeBibleResponse>(`/projects/${encodeURIComponent(projectId)}/creative-bible`, input);
}

export async function getCanvasCreativeBible(canvasId: string, signal?: AbortSignal) {
    return http.get<CreativeBibleResponse>(`/canvas-projects/${encodeURIComponent(canvasId)}/creative-bible`, { signal });
}

export async function saveCanvasCreativeBible(canvasId: string, input: CreativeBibleUpdateInput) {
    return http.put<CreativeBibleResponse>(`/canvas-projects/${encodeURIComponent(canvasId)}/creative-bible`, input);
}
