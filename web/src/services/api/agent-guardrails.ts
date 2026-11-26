import { http } from "@/services/api/request";

export type ExternalGuardrailMode = "allow" | "propose_only";

export type ExternalAgentGuardrails = {
    mode: ExternalGuardrailMode;
    maxPerCallCny: number;
    dailyBudgetCny: number;
    todaySpentCny: number;
};

export type ExternalAgentGuardrailsInput = {
    mode: ExternalGuardrailMode;
    maxPerCallCny: number;
    dailyBudgetCny: number;
};

export async function getExternalAgentGuardrails(signal?: AbortSignal) {
    return http.get<ExternalAgentGuardrails>("/agent-clients/guardrails", { signal });
}

export async function updateExternalAgentGuardrails(input: ExternalAgentGuardrailsInput) {
    return http.put<ExternalAgentGuardrails>("/agent-clients/guardrails", input);
}
