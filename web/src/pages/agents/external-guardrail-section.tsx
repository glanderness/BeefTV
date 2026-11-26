import { useQuery } from "@tanstack/react-query";
import { App, Button, InputNumber, Radio } from "antd";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { TableSurface } from "@/components/layout/workspace-page";
import {
    getExternalAgentGuardrails,
    updateExternalAgentGuardrails,
    type ExternalGuardrailMode,
} from "@/services/api/agent-guardrails";
import { ApiError } from "@/services/api/request";

const GUARDRAILS_QUERY_KEY = ["agent-clients", "guardrails"] as const;

export function ExternalGuardrailSection() {
    const { message } = App.useApp();
    const [mode, setMode] = useState<ExternalGuardrailMode>("allow");
    const [maxPerCallCny, setMaxPerCallCny] = useState<number>(0);
    const [dailyBudgetCny, setDailyBudgetCny] = useState<number>(0);
    const [saving, setSaving] = useState(false);

    const query = useQuery({
        queryKey: GUARDRAILS_QUERY_KEY,
        queryFn: ({ signal }) => getExternalAgentGuardrails(signal),
        retry: false,
    });

    useEffect(() => {
        if (!query.data) return;
        setMode(query.data.mode);
        setMaxPerCallCny(query.data.maxPerCallCny || 0);
        setDailyBudgetCny(query.data.dailyBudgetCny || 0);
    }, [query.data]);

    if (query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403)) {
        return null;
    }

    const dirty = Boolean(
        query.data && (
            query.data.mode !== mode
            || (query.data.maxPerCallCny || 0) !== (maxPerCallCny || 0)
            || (query.data.dailyBudgetCny || 0) !== (dailyBudgetCny || 0)
        ),
    );

    const handleSave = async () => {
        setSaving(true);
        try {
            const saved = await updateExternalAgentGuardrails({
                mode,
                maxPerCallCny: Number(maxPerCallCny || 0),
                dailyBudgetCny: Number(dailyBudgetCny || 0),
            });
            setMode(saved.mode);
            setMaxPerCallCny(saved.maxPerCallCny || 0);
            setDailyBudgetCny(saved.dailyBudgetCny || 0);
            message.success("已更新外部 Agent 付费护栏");
            await query.refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存护栏设置失败");
        } finally {
            setSaving(false);
        }
    };

    const todaySpent = query.data?.todaySpentCny ?? 0;

    return (
        <section className="agent-external-mcp" aria-labelledby="external-agent-guardrails-heading">
            <div className="agent-external-mcp-header">
                <h2 id="external-agent-guardrails-heading" className="inline-flex items-center gap-2">
                    <ShieldCheck size={16} aria-hidden="true" />
                    外部 Agent 付费护栏
                </h2>
                <div className="agent-external-mcp-actions">
                    <span className="text-xs text-[var(--user-ink-muted)]" style={{ fontVariantNumeric: "tabular-nums" }}>
                        今日外部已预估消耗 ¥{todaySpent.toFixed(2)}
                    </span>
                    <Button
                        size="small"
                        type={dirty ? "primary" : "default"}
                        disabled={!dirty}
                        loading={saving}
                        onClick={() => void handleSave()}
                    >
                        保存护栏
                    </Button>
                </div>
            </div>
            <TableSurface>
                <div className="grid gap-4 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="grid gap-0.5">
                            <span className="text-sm font-medium text-[var(--user-ink)]">外部付费生成策略</span>
                            <span className="text-xs text-[var(--user-ink-muted)]">
                                外部审批由 Claude Code / Codex 终端自行确认，这里可加一道防超支上限，不弹阻塞窗口。
                            </span>
                        </div>
                        <Radio.Group
                            value={mode}
                            onChange={(event) => setMode(event.target.value as ExternalGuardrailMode)}
                            optionType="button"
                            buttonStyle="outline"
                            size="small"
                            options={[
                                { value: "allow", label: "允许直接生成" },
                                { value: "propose_only", label: "仅允许提草稿" },
                            ]}
                        />
                    </div>
                    {mode === "allow" ? (
                        <div className="grid gap-3 sm:grid-cols-2 border-t border-[var(--border)] pt-4">
                            <label className="grid gap-1.5 text-xs font-medium text-[var(--user-ink)]">
                                <span>单次提交上限（元，0 表示不限）</span>
                                <InputNumber
                                    min={0}
                                    max={10000}
                                    step={1}
                                    precision={2}
                                    value={maxPerCallCny}
                                    prefix="¥"
                                    style={{ width: "100%" }}
                                    onChange={(value) => setMaxPerCallCny(Number(value ?? 0))}
                                />
                            </label>
                            <label className="grid gap-1.5 text-xs font-medium text-[var(--user-ink)]">
                                <span>每日累计上限（元，0 表示不限）</span>
                                <InputNumber
                                    min={0}
                                    max={100000}
                                    step={5}
                                    precision={2}
                                    value={dailyBudgetCny}
                                    prefix="¥"
                                    style={{ width: "100%" }}
                                    onChange={(value) => setDailyBudgetCny(Number(value ?? 0))}
                                />
                            </label>
                        </div>
                    ) : null}
                </div>
            </TableSurface>
        </section>
    );
}
