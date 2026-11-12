import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Focusable } from "react-aria-components";

import { Tooltip } from "@/components/ui/base/tooltip";
import { formatInlineCostEstimate, type InlineCostDisplay } from "@/lib/generation-cost-estimate";
import { cn } from "@/lib/utils";
import { estimateGenerationCost, type CostEstimate, type CostEstimateTarget, type GenerationCostEstimate } from "@/services/api/cost-estimate";

export type CostEstimateFetcher = (targets: CostEstimateTarget[], signal?: AbortSignal) => Promise<GenerationCostEstimate>;

export function useGenerationCostEstimate(
    target: CostEstimateTarget | null,
    options?: {
        debounceMs?: number;
        fetcher?: CostEstimateFetcher;
        refreshKey?: string | number;
    },
): CostEstimate | null {
    const targetKey = useMemo(() => (target ? JSON.stringify(target) : ""), [target]);
    const debounceMs = options?.debounceMs ?? (target?.kind === "audio" ? 220 : 60);
    const fetcher = options?.fetcher ?? estimateGenerationCost;
    const refreshKey = options?.refreshKey ?? "";
    const [state, setState] = useState<{ scopeKey: string; estimate: CostEstimate | null }>({ scopeKey: "", estimate: null });
    const scopeKey = target ? `${target.kind}:${target.modelKey}:${String(refreshKey)}` : "";

    useEffect(() => {
        if (!targetKey) {
            setState({ scopeKey: "", estimate: null });
            return;
        }
        const parsed = JSON.parse(targetKey) as CostEstimateTarget;
        const nextScopeKey = `${parsed.kind}:${parsed.modelKey}:${String(refreshKey)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void fetcher([parsed], controller.signal).then(
                (result) => {
                    if (controller.signal.aborted) return;
                    setState({ scopeKey: nextScopeKey, estimate: result.items[0] ?? null });
                },
                () => {
                    if (controller.signal.aborted) return;
                    setState({ scopeKey: nextScopeKey, estimate: null });
                },
            );
        }, debounceMs);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [debounceMs, fetcher, refreshKey, targetKey]);

    if (!targetKey || state.scopeKey !== scopeKey) return null;
    return state.estimate;
}

export function GenerationCostLabel({
    display,
    className,
    style,
}: {
    display: InlineCostDisplay;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <Tooltip title={display.tooltip}>
            <Focusable>
                <span
                    role="button"
                    tabIndex={0}
                    data-testid="generation-cost-badge"
                    aria-label={`价格预估：${display.tooltip}`}
                    className={cn(
                        "inline-flex shrink-0 cursor-default select-none items-center whitespace-nowrap tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        className,
                    )}
                    style={style}
                >
                    <span>{display.label}</span>
                </span>
            </Focusable>
        </Tooltip>
    );
}

export function GenerationCostBadge({
    target,
    hideVariableRate,
    refreshKey,
    fetcher,
    className,
    style,
}: {
    target: CostEstimateTarget | null;
    hideVariableRate?: boolean;
    refreshKey?: string | number;
    fetcher?: CostEstimateFetcher;
    className?: string;
    style?: CSSProperties;
}) {
    const estimate = useGenerationCostEstimate(target, { fetcher, refreshKey });
    const display = useMemo(() => formatInlineCostEstimate(estimate, { hideVariableRate }), [estimate, hideVariableRate]);
    if (!display) return null;
    return <GenerationCostLabel display={display} className={className} style={style} />;
}
