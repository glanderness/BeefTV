import { getActiveUserScope } from "@/lib/user-scope";
import type { GenerationTaskEffectClaim, GenerationTaskEffectResult, GenerationTaskEffectStore } from "@/services/generation-task-materializer";

type ActiveEffectSlot = {
    scope: string;
    taskId: string;
    effectKey: string;
    binding: string;
    done: Promise<void>;
    finish: () => void;
};

const MAX_COMPLETED_EFFECTS = 4096;

function abortError(): DOMException {
    return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
}

function waitForSlotOrAbort(done: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return done;
    throwIfAborted(signal);
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        void done.then(
            () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

function scopedEffectKey(scope: string, effectKey: string) {
    return `${scope}\0${effectKey}`;
}

/**
 * 进程内按用户作用域串行化并去重生成任务副作用。
 * 跨刷新幂等由资产库 `generationEffectKey`、画布/对话文档与后端任务绑定持久化共同保证，
 * 无需在浏览器 IndexedDB 中维护跨标签分布式租约、心跳与轮询。
 */
export function createProviderNeutralGenerationTaskEffectStore(): GenerationTaskEffectStore {
    const completedEffects = new Map<string, GenerationTaskEffectResult>();
    const activeEffects = new Map<string, ActiveEffectSlot>();
    const ownedByBinding = new Map<string, ActiveEffectSlot>();
    let nextBindingId = 0;

    function rememberCompletedEffect(key: string, result: GenerationTaskEffectResult) {
        if (!completedEffects.has(key) && completedEffects.size >= MAX_COMPLETED_EFFECTS) {
            const oldest = completedEffects.keys().next().value;
            if (oldest !== undefined) completedEffects.delete(oldest);
        }
        completedEffects.set(key, { ...result });
    }

    function takeOwnedSlot(effectKey: string, taskId: string, binding: string): ActiveEffectSlot | undefined {
        const owned = ownedByBinding.get(binding);
        if (owned?.taskId !== taskId || owned.effectKey !== effectKey) return undefined;
        ownedByBinding.delete(binding);
        return owned;
    }

    return {
        async claim(effectKey, taskId, signal): Promise<GenerationTaskEffectClaim> {
            const scope = getActiveUserScope();
            const key = scopedEffectKey(scope, effectKey);
            while (true) {
                throwIfAborted(signal);
                const done = completedEffects.get(key);
                if (done) return { status: "completed", result: { ...done } };
                const active = activeEffects.get(key);
                if (active) {
                    await waitForSlotOrAbort(active.done, signal);
                    continue;
                }
                let finish!: () => void;
                const donePromise = new Promise<void>((resolve) => {
                    finish = resolve;
                });
                const slot: ActiveEffectSlot = {
                    scope,
                    taskId,
                    effectKey,
                    binding: `effect-${++nextBindingId}`,
                    done: donePromise,
                    finish,
                };
                activeEffects.set(key, slot);
                ownedByBinding.set(slot.binding, slot);
                return { status: "claimed", binding: slot.binding };
            }
        },
        async complete(effectKey, taskId, result, binding) {
            const owned = takeOwnedSlot(effectKey, taskId, binding);
            if (!owned) return;
            const key = scopedEffectKey(owned.scope, effectKey);
            rememberCompletedEffect(key, result);
            if (activeEffects.get(key) === owned) activeEffects.delete(key);
            owned.finish();
        },
        async release(effectKey, taskId, binding) {
            const owned = takeOwnedSlot(effectKey, taskId, binding);
            if (!owned) return;
            const key = scopedEffectKey(owned.scope, effectKey);
            if (activeEffects.get(key) === owned) activeEffects.delete(key);
            owned.finish();
        },
    };
}
