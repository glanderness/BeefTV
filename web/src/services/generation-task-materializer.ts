import type { GenerationTask, GenerationTaskOutput } from "@/services/api/task-center";

export type GenerationTaskEffectResult = {
    materializedAssetId?: string;
};

export type GenerationTaskEffectClaim =
    | { status: "claimed"; fence: number; binding?: string }
    | { status: "busy"; retryAt?: string }
    | { status: "completed"; result: GenerationTaskEffectResult };

export type GenerationTaskEffectStore = {
    claim(effectKey: string, taskId: string, signal?: AbortSignal): Promise<GenerationTaskEffectClaim>;
    renew?(effectKey: string, taskId: string, binding?: string): Promise<{ fence: number }>;
    complete(effectKey: string, taskId: string, result: GenerationTaskEffectResult, binding?: string): Promise<void>;
    release(effectKey: string, taskId: string, binding?: string): Promise<void>;
};

export type MaterializeGenerationTaskOutput = (input: {
    task: GenerationTask;
    output: GenerationTaskOutput;
    effectKey: string;
    signal?: AbortSignal;
}) => Promise<GenerationTaskEffectResult>;

export type GenerationTaskEffectConsumer = (input: {
    task: GenerationTask;
    output?: GenerationTaskOutput;
    effectKey: string;
    signal?: AbortSignal;
}) => Promise<void>;

function abortError(): DOMException {
    return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
}

export function createIdempotentMaterializeOutput(dependencies: {
    insertOrReturnAsset(input: { task: GenerationTask; output: GenerationTaskOutput; effectKey: string; signal?: AbortSignal }): Promise<string>;
}): MaterializeGenerationTaskOutput {
    return async (input) => ({
        materializedAssetId: await dependencies.insertOrReturnAsset(input),
    });
}

export function materializeEffectKey(taskId: string, outputIndex: number): string {
    return `materialize:${taskId}:${outputIndex}`;
}

export function attachNodeEffectKey(taskId: string, nodeId: string, outputIndex: number): string {
    return `attach-node:${taskId}:${nodeId}:${outputIndex}`;
}

export function attachMessageEffectKey(taskId: string, messageId: string, outputIndex: number): string {
    return `attach-message:${taskId}:${messageId}:${outputIndex}`;
}

export function agentResumeEffectKey(taskId: string, continuationId: string): string {
    return `agent-resume:${taskId}:${continuationId}`;
}

export function createGenerationTaskMaterializer(dependencies: {
    effects: GenerationTaskEffectStore;
    materializeOutput: MaterializeGenerationTaskOutput;
}) {
    async function releaseClaim(effectKey: string, taskId: string, binding: string | undefined, original: unknown): Promise<never> {
        let failure = original;
        try {
            await dependencies.effects.release(effectKey, taskId, binding);
        } catch (error) {
            failure = error;
        }
        throw failure;
    }

    async function consumeEffect(
        effectKey: string,
        task: GenerationTask,
        consumer: GenerationTaskEffectConsumer,
        output?: GenerationTaskOutput,
        signal?: AbortSignal,
        options: { consumerResolveCommits?: boolean } = {},
    ): Promise<"applied" | "completed" | "busy"> {
        throwIfAborted(signal);
        const claim = await dependencies.effects.claim(effectKey, task.id, signal);
        if (claim.status === "completed") {
            throwIfAborted(signal);
            return "completed";
        }
        if (claim.status === "busy") {
            throwIfAborted(signal);
            return "busy";
        }
        try {
            throwIfAborted(signal);
            await consumer({ task, output, effectKey, signal });
            if (!options.consumerResolveCommits) throwIfAborted(signal);
            await dependencies.effects.complete(effectKey, task.id, {}, claim.binding);
            return "applied";
        } catch (error) {
            return releaseClaim(effectKey, task.id, claim.binding, error);
        }
    }

    function requireMaterializedOutput(task: GenerationTask, outputIndex: number): GenerationTaskOutput {
        const output = task.outputs?.find((candidate) => candidate.outputIndex === outputIndex);
        if (!output?.materializedAssetId) {
            throw new Error(`Task output ${outputIndex} is not materialized`);
        }
        return output;
    }

    return {
        async materialize(task: GenerationTask, signal?: AbortSignal): Promise<GenerationTask> {
            throwIfAborted(signal);
            if (task.status !== "succeeded" || !task.outputs?.length) return task;

            const outputs: GenerationTaskOutput[] = [];
            for (const originalOutput of task.outputs) {
                const output = { ...originalOutput };
                if (!output.materializedAssetId) {
                    const effectKey = materializeEffectKey(task.id, output.outputIndex);
                    throwIfAborted(signal);
                    const claim = await dependencies.effects.claim(effectKey, task.id, signal);
                    if (claim.status === "completed") {
                        throwIfAborted(signal);
                        output.materializedAssetId = claim.result.materializedAssetId;
                    } else if (claim.status === "claimed") {
                        try {
                            throwIfAborted(signal);
                            const result = await dependencies.materializeOutput({
                                task,
                                output,
                                effectKey,
                                signal,
                            });
                            throwIfAborted(signal);
                            await dependencies.effects.complete(effectKey, task.id, result, claim.binding);
                            output.materializedAssetId = result.materializedAssetId;
                        } catch (error) {
                            return releaseClaim(effectKey, task.id, claim.binding, error);
                        }
                    } else {
                        throwIfAborted(signal);
                    }
                }
                outputs.push(output);
            }

            return {
                ...task,
                outputs,
                resultState: outputs.every((output) => Boolean(output.materializedAssetId)) ? "READY" : "MATERIALIZING",
            };
        },

        attachNode(task: GenerationTask, nodeId: string, outputIndex: number, consumer: GenerationTaskEffectConsumer, signal?: AbortSignal) {
            const output = requireMaterializedOutput(task, outputIndex);
            return consumeEffect(attachNodeEffectKey(task.id, nodeId, outputIndex), task, consumer, output, signal);
        },

        attachMessage(task: GenerationTask, messageId: string, outputIndex: number, consumer: GenerationTaskEffectConsumer, signal?: AbortSignal) {
            const output = requireMaterializedOutput(task, outputIndex);
            return consumeEffect(attachMessageEffectKey(task.id, messageId, outputIndex), task, consumer, output, signal);
        },

        resumeAgent(task: GenerationTask, continuationId: string, consumer: GenerationTaskEffectConsumer, signal?: AbortSignal) {
            return consumeEffect(agentResumeEffectKey(task.id, continuationId), task, consumer, undefined, signal, { consumerResolveCommits: true });
        },
    };
}
