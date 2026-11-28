import { useCallback, useEffect, useState } from "react";

import { isTextEditableTarget } from "@/lib/backspace-navigation-guard";
import type { TimelineProject } from "@/types/timeline";

const MAX_TIMELINE_HISTORY = 50;

type HistoryState = {
    past: TimelineProject[];
    present: TimelineProject;
    future: TimelineProject[];
};

function withComputedDuration(project: TimelineProject): TimelineProject {
    const endMs = project.clips.reduce((max, clip) => Math.max(max, clip.startMs + clip.durationMs), 0);
    return { ...project, durationMs: Math.max(endMs, 1_000) };
}

/**
 * 弹窗内局部撤销/重做历史栈（上限 50 步），与画布主历史栈隔离。
 * 拖动与滑块调节可通过 replaceDraft + recordSnapshot 合并为单步历史。
 */
export function useTimelineDraftHistory(initial: () => TimelineProject, open: boolean) {
    const [history, setHistory] = useState<HistoryState>(() => ({
        past: [],
        present: withComputedDuration(initial()),
        future: [],
    }));

    const resetDraft = useCallback((next: TimelineProject) => {
        setHistory({ past: [], present: withComputedDuration(next), future: [] });
    }, []);

    const commitDraft = useCallback((updater: (current: TimelineProject) => TimelineProject) => {
        setHistory((state) => {
            const updated = updater(state.present);
            if (updated === state.present) return state;
            const next = withComputedDuration(updated);
            const past = state.past.length >= MAX_TIMELINE_HISTORY
                ? [...state.past.slice(state.past.length - MAX_TIMELINE_HISTORY + 1), state.present]
                : [...state.past, state.present];
            return { past, present: next, future: [] };
        });
    }, []);

    const replaceDraft = useCallback((updater: (current: TimelineProject) => TimelineProject) => {
        setHistory((state) => {
            const updated = updater(state.present);
            if (updated === state.present) return state;
            return { ...state, present: withComputedDuration(updated) };
        });
    }, []);

    const recordSnapshot = useCallback((beforeGesture: TimelineProject) => {
        setHistory((state) => {
            if (state.present === beforeGesture) return state;
            const past = state.past.length >= MAX_TIMELINE_HISTORY
                ? [...state.past.slice(state.past.length - MAX_TIMELINE_HISTORY + 1), beforeGesture]
                : [...state.past, beforeGesture];
            return { past, present: state.present, future: [] };
        });
    }, []);

    const undo = useCallback(() => {
        setHistory((state) => {
            if (!state.past.length) return state;
            const previous = state.past[state.past.length - 1];
            return {
                past: state.past.slice(0, -1),
                present: previous,
                future: [state.present, ...state.future].slice(0, MAX_TIMELINE_HISTORY),
            };
        });
    }, []);

    const redo = useCallback(() => {
        setHistory((state) => {
            if (!state.future.length) return state;
            const next = state.future[0];
            return {
                past: [...state.past, state.present].slice(-MAX_TIMELINE_HISTORY),
                present: next,
                future: state.future.slice(1),
            };
        });
    }, []);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) return;
            if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
            if (isTextEditableTarget(event.target)) return;
            const key = event.key.toLowerCase();
            if (key === "z" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                undo();
            } else if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) {
                event.preventDefault();
                event.stopPropagation();
                redo();
            }
        };
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [open, redo, undo]);

    return {
        draft: history.present,
        canUndo: history.past.length > 0,
        canRedo: history.future.length > 0,
        resetDraft,
        commitDraft,
        replaceDraft,
        recordSnapshot,
        undo,
        redo,
    };
}
