import type { ModelCapabilityConfig } from "@/lib/model-capabilities";
import type { ModelProtocol } from "@/lib/model-protocols";
import { http } from "@/services/api/request";
import type { WorkspaceCapabilityContract } from "@/services/workspace-mode";
import type { AiConfig } from "@/stores/use-config-store";
import type { FeatureAvailability, LocalUser, RuntimeLimits } from "@/stores/use-user-store";

export type ModelCapabilityDraftInput = {
    capability?: string;
    category?: string;
    type?: string;
    protocol?: ModelProtocol | string;
    interfaceType?: ModelProtocol | string;
    model: string;
    baseUrl?: string;
    channelId?: string;
    videoCapabilitiesVersion?: string;
    capabilityConfig?: ModelCapabilityConfig;
};

export function normalizeModelCapabilityDraft(draft: ModelCapabilityDraftInput) {
    return http.post<ModelCapabilityConfig & { capabilityConfig?: ModelCapabilityConfig }>("/workspace/model-config/capability", draft);
}

export type LocalWorkspace = {
    id: string;
    name: string;
    owner: "local";
    storage: "sqlite";
};

export type WorkspaceBootstrapPayload = {
    contractVersion: number;
    profile: "local";
    capabilities: WorkspaceCapabilityContract["capabilities"];
    user: LocalUser;
    workspace: LocalWorkspace;
    storageMode: "local";
    runtimeLimits?: RuntimeLimits;
    features?: FeatureAvailability;
};

export const WORKSPACE_BOOTSTRAP_TIMEOUT_MS = 15_000;

export function getWorkspaceBootstrap() {
    return http.get<WorkspaceBootstrapPayload>("/workspace/bootstrap", { timeout: WORKSPACE_BOOTSTRAP_TIMEOUT_MS });
}

export function getLocalModelConfig() {
	return http.get<LocalModelConfigPayload>("/workspace/model-config", { timeout: WORKSPACE_BOOTSTRAP_TIMEOUT_MS });
}

export type LocalModelConfigPayload = {
	config: AiConfig;
	revision: number;
	health: "ready" | "default" | "migrated" | "recovered";
	source: "builtin+local";
};

export function saveLocalModelConfig(config: AiConfig, expectedRevision: number) {
	return http.put<{ saved: boolean; revision: number }>("/workspace/model-config", { config, expectedRevision });
}
