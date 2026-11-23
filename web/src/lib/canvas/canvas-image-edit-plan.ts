import { normalizeImageValue, type ImageCapabilityConfig } from "@/lib/model-capabilities";

const NATIVE_MASK_PROMPT_PREFIX = "只修改蒙版透明区域，其他区域保持不变。";

// Fixed outputs are a single provider request, not N single-image requests.
export function imageEditPlan(profile: ImageCapabilityConfig, requestedCount = 1) {
    return {
        mode: profile.references.maskSupported ? "provider-mask" as const : "local-composite" as const,
        count: Number(normalizeImageValue(profile, { count: String(requestedCount) }).count),
        outputsPerRequest: profile.fixedOutputs || 1,
    };
}

export function imageEditOutputGroups<T>(destinations: T[], outputsPerRequest: number): T[][] {
    const groups: T[][] = [];
    const size = Math.max(1, outputsPerRequest);
    for (let index = 0; index < destinations.length; index += size) groups.push(destinations.slice(index, index + size));
    return groups;
}

export function formatMaskEditPrompt(prompt: string, localComposite: boolean) {
    const stripped = prompt.startsWith(NATIVE_MASK_PROMPT_PREFIX)
        ? prompt.slice(NATIVE_MASK_PROMPT_PREFIX.length).trimStart()
        : prompt;
    return localComposite ? stripped : `${NATIVE_MASK_PROMPT_PREFIX}${stripped}`;
}
