import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { IMAGE_PROMPT_REVERSE, VIDEO_PROMPT_REVERSE } from "@/lib/prompts";
import {
    CUSTOM_IMAGE_REVERSE_PROMPT_KEY,
    CUSTOM_VIDEO_REVERSE_PROMPT_KEY,
    getEffectiveReversePrompt,
    hasCustomReversePrompt,
    resetCustomReversePrompt,
    setCustomReversePrompt,
} from "@/lib/reverse-prompt-preference";
import {
    getTaskCompletionSoundEnabled,
    hasTaskCompletionSoundPlayed,
    onTaskCompletionSoundChange,
    playTaskCompletionChime,
    resetTaskCompletionSoundStateForTests,
    setTaskCompletionSoundEnabled,
    TASK_COMPLETION_CHIME_THROTTLE_MS,
    TASK_COMPLETION_SOUND_ENABLED_KEY,
    triggerSoundForCompletedTask,
    type MinimalAudioContext,
} from "@/lib/task-completion-sound";
import { setActiveUserScope } from "@/lib/user-scope";
import { buildReversePromptNodePair } from "@/pages/canvas/use-canvas-image-tools";
import { isConfigSection } from "@/pages/settings";
import { CanvasNodeType } from "@/types/canvas";

function createMemoryStorage(): Storage {
    const store = new Map<string, string>();
    return {
        get length() {
            return store.size;
        },
        clear() {
            store.clear();
        },
        getItem(key: string) {
            return store.get(key) ?? null;
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null;
        },
        removeItem(key: string) {
            store.delete(key);
        },
        setItem(key: string, value: string) {
            store.set(key, String(value));
        },
    };
}

describe("reverse-prompt-preference and buildReversePromptNodePair", () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;

    beforeEach(() => {
        Object.assign(globalThis, {
            window: {
                localStorage: createMemoryStorage(),
                sessionStorage: createMemoryStorage(),
                location: { protocol: "http:" },
            },
        });
        setActiveUserScope("workspace-alpha");
        resetCustomReversePrompt();
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            delete (globalThis as Record<string, unknown>).window;
        } else {
            (globalThis as Record<string, unknown>).window = originalWindow;
        }
    });

    it("falls back to builtin defaults, persists workspace-scoped custom templates, and wires canvas reverse-prompt nodes", () => {
        expect(isConfigSection("prompts")).toBe(true);
        expect(getEffectiveReversePrompt("image")).toBe(IMAGE_PROMPT_REVERSE);
        expect(getEffectiveReversePrompt("video")).toBe(VIDEO_PROMPT_REVERSE);
        expect(hasCustomReversePrompt()).toBe(false);

        const customImage = "请用英文输出高度结构化的商业摄影提示词，包含镜头焦段与布光图。";
        const customVideo = "请按秒级镜头拆解参考视频中的人物走位、运镜轨迹与环境音效。";

        setCustomReversePrompt("image", `  ${customImage}  `);
        setCustomReversePrompt("video", customVideo);

        expect(getEffectiveReversePrompt("image")).toBe(customImage);
        expect(getEffectiveReversePrompt("video")).toBe(customVideo);
        expect(hasCustomReversePrompt("image")).toBe(true);
        expect(hasCustomReversePrompt("video")).toBe(true);
        expect(window.localStorage.getItem(`${CUSTOM_IMAGE_REVERSE_PROMPT_KEY}:user:workspace-alpha`)).toBe(customImage);
        expect(window.localStorage.getItem(`${CUSTOM_VIDEO_REVERSE_PROMPT_KEY}:user:workspace-alpha`)).toBe(customVideo);

        const imageNode = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, {
            content: "data:image/png;base64,AAAA",
            status: "success",
        });
        const videoNode = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 200 }, {
            content: "/api/resources/vid-1/file",
            storageKey: "resource:vid-1",
            status: "success",
        });

        expect(buildReversePromptNodePair(imageNode).textNode.metadata?.content).toBe(customImage);
        expect(buildReversePromptNodePair(videoNode).textNode.metadata?.content).toBe(customVideo);

        // Switching workspace isolates reverse-prompt customizations.
        setActiveUserScope("workspace-beta");
        expect(getEffectiveReversePrompt("image")).toBe(IMAGE_PROMPT_REVERSE);
        expect(getEffectiveReversePrompt("video")).toBe(VIDEO_PROMPT_REVERSE);

        setActiveUserScope("workspace-alpha");
        expect(getEffectiveReversePrompt("image")).toBe(customImage);

        resetCustomReversePrompt();
        expect(hasCustomReversePrompt()).toBe(false);
        expect(buildReversePromptNodePair(imageNode).textNode.metadata?.content).toBe(IMAGE_PROMPT_REVERSE);
        expect(buildReversePromptNodePair(videoNode).textNode.metadata?.content).toBe(VIDEO_PROMPT_REVERSE);
    });
});

describe("task-completion-sound preference and Web Audio chime", () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const scheduledNotes: Array<{ freq: number; start: number; stop: number }> = [];

    class FakeAudioContext implements MinimalAudioContext {
        currentTime = 1.0;
        state = "running";
        destination = {};
        closed = false;

        createOscillator() {
            const note = { freq: 0, start: -1, stop: -1 };
            scheduledNotes.push(note);
            return {
                type: "sine" as OscillatorType,
                frequency: {
                    value: 440,
                    setValueAtTime: (val: number) => {
                        note.freq = val;
                    },
                },
                connect: () => {},
                start: (when = 0) => {
                    note.start = when;
                },
                stop: (when = 0) => {
                    note.stop = when;
                },
                onended: null as (() => void) | null,
            };
        }

        createGain() {
            return {
                gain: {
                    value: 0,
                    setValueAtTime: () => {},
                    linearRampToValueAtTime: () => {},
                    exponentialRampToValueAtTime: () => {},
                },
                connect: () => {},
            };
        }

        async close() {
            this.closed = true;
        }
    }

    beforeEach(() => {
        scheduledNotes.length = 0;
        Object.assign(globalThis, {
            window: {
                localStorage: createMemoryStorage(),
                sessionStorage: createMemoryStorage(),
                location: { protocol: "http:" },
                AudioContext: FakeAudioContext,
            },
        });
        setActiveUserScope("workspace-sound");
        resetTaskCompletionSoundStateForTests();
    });

    afterEach(() => {
        resetTaskCompletionSoundStateForTests();
        if (originalWindow === undefined) {
            delete (globalThis as Record<string, unknown>).window;
        } else {
            (globalThis as Record<string, unknown>).window = originalWindow;
        }
    });

    it("defaults to false, persists per workspace, and notifies listeners", () => {
        expect(getTaskCompletionSoundEnabled()).toBe(false);
        let notifications = 0;
        const unsubscribe = onTaskCompletionSoundChange(() => {
            notifications += 1;
        });

        setTaskCompletionSoundEnabled(true);
        expect(getTaskCompletionSoundEnabled()).toBe(true);
        expect(window.localStorage.getItem(`${TASK_COMPLETION_SOUND_ENABLED_KEY}:user:workspace-sound`)).toBe("true");
        expect(notifications).toBe(1);

        setActiveUserScope("workspace-other");
        expect(getTaskCompletionSoundEnabled()).toBe(false);
        expect(notifications).toBe(2);

        unsubscribe();
    });

    it("plays a 2-note chime, throttles within 1500ms, and catches missing AudioContext safely", () => {
        expect(playTaskCompletionChime({ now: 5000 })).toBe(true);
        expect(scheduledNotes).toHaveLength(2);
        expect(scheduledNotes[0]?.freq).toBeCloseTo(587.33, 1);
        expect(scheduledNotes[1]?.freq).toBe(880);

        // Throttled within 1500ms window
        expect(playTaskCompletionChime({ now: 5000 + TASK_COMPLETION_CHIME_THROTTLE_MS - 100 })).toBe(false);
        expect(scheduledNotes).toHaveLength(2);

        // Allowed once 1500ms has elapsed
        expect(playTaskCompletionChime({ now: 5000 + TASK_COMPLETION_CHIME_THROTTLE_MS })).toBe(true);
        expect(scheduledNotes).toHaveLength(4);

        // Missing AudioContext in headless environments returns false without throwing
        delete (window as unknown as Record<string, unknown>).AudioContext;
        expect(playTaskCompletionChime({ force: true })).toBe(false);
    });

    it("triggers task completion sound only when enabled and deduplicates per taskId", () => {
        expect(triggerSoundForCompletedTask("task-101")).toBe(false);
        expect(hasTaskCompletionSoundPlayed("task-101")).toBe(false);
        expect(scheduledNotes).toHaveLength(0);

        setTaskCompletionSoundEnabled(true);
        expect(triggerSoundForCompletedTask("task-101")).toBe(true);
        expect(hasTaskCompletionSoundPlayed("task-101")).toBe(true);
        expect(scheduledNotes).toHaveLength(2);

        // Same taskId never chimes twice even after throttle window
        resetTaskCompletionSoundStateForTests();
        // Re-seed task-101 and verify deduplication
        expect(triggerSoundForCompletedTask("task-101")).toBe(true);
        expect(triggerSoundForCompletedTask("task-101")).toBe(false);
    });
});
