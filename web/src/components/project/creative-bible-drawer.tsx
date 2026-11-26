import { App, Button, Input, Tabs } from "antd";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DetailDrawer } from "@/components/ui/product/app-drawer";
import { createClientId } from "@/lib/client-id";
import {
    getCanvasCreativeBible,
    getProjectCreativeBible,
    saveCanvasCreativeBible,
    saveProjectCreativeBible,
    type CreativeBible,
    type CreativeBibleCharacter,
    type CreativeBibleLocation,
} from "@/services/api/creative-bible";

type Props = {
    open: boolean;
    onClose: () => void;
    /** 传 projectId 时直接读写项目共享设定集；传 canvasId 时自动解析到所属项目或当前画布设定集。 */
    projectId?: string;
    canvasId?: string;
    onSaved?: (bible: CreativeBible) => void;
};

type DraftState = {
    title: string;
    logline: string;
    visualStyle: string;
    colorPalette: string;
    cameraRules: string;
    taboos: string;
    characters: CreativeBibleCharacter[];
    locations: CreativeBibleLocation[];
    revision: number;
    scopeKind: "project" | "canvas";
};

function emptyDraft(): DraftState {
    return {
        title: "",
        logline: "",
        visualStyle: "",
        colorPalette: "",
        cameraRules: "",
        taboos: "",
        characters: [],
        locations: [],
        revision: 0,
        scopeKind: "canvas",
    };
}

function fromBible(bible: CreativeBible): DraftState {
    return {
        title: bible.title || "",
        logline: bible.logline || "",
        visualStyle: bible.visualStyle || "",
        colorPalette: bible.colorPalette || "",
        cameraRules: bible.cameraRules || "",
        taboos: bible.taboos || "",
        characters: Array.isArray(bible.characters) ? bible.characters : [],
        locations: Array.isArray(bible.locations) ? bible.locations : [],
        revision: bible.revision || 0,
        scopeKind: bible.scopeKind,
    };
}

export function CreativeBibleDrawer({ open, onClose, projectId, canvasId, onSaved }: Props) {
    const { message } = App.useApp();
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [draft, setDraft] = useState<DraftState>(emptyDraft);

    const load = useCallback(async (signal?: AbortSignal) => {
        if (!projectId && !canvasId) return;
        setLoading(true);
        setLoadError("");
        try {
            const res = projectId
                ? await getProjectCreativeBible(projectId, signal)
                : await getCanvasCreativeBible(canvasId!, signal);
            setDraft(fromBible(res.bible));
        } catch (error) {
            if (signal?.aborted) return;
            setLoadError(error instanceof Error ? error.message : "无法读取创作设定集");
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, [canvasId, projectId]);

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [open, load]);

    const handleSave = async () => {
        if (!projectId && !canvasId) return;
        setSaving(true);
        try {
            const payload = {
                expectedRevision: draft.revision,
                title: draft.title,
                logline: draft.logline,
                visualStyle: draft.visualStyle,
                colorPalette: draft.colorPalette,
                cameraRules: draft.cameraRules,
                taboos: draft.taboos,
                characters: draft.characters.filter((item) => item.name.trim().length > 0),
                locations: draft.locations.filter((item) => item.name.trim().length > 0),
            };
            const res = projectId
                ? await saveProjectCreativeBible(projectId, payload)
                : await saveCanvasCreativeBible(canvasId!, payload);
            setDraft(fromBible(res.bible));
            onSaved?.(res.bible);
            message.success("创作设定集已保存，内置助手与外部 MCP 将自动沿用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存设定集失败");
        } finally {
            setSaving(false);
        }
    };

    const addCharacter = () => {
        setDraft((prev) => ({
            ...prev,
            characters: [
                ...prev.characters,
                { id: `char-${createClientId().slice(0, 8)}`, name: "", appearance: "", wardrobe: "", voice: "", notes: "" },
            ],
        }));
    };

    const updateCharacter = (id: string, patch: Partial<CreativeBibleCharacter>) => {
        setDraft((prev) => ({
            ...prev,
            characters: prev.characters.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        }));
    };

    const removeCharacter = (id: string) => {
        setDraft((prev) => ({ ...prev, characters: prev.characters.filter((item) => item.id !== id) }));
    };

    const addLocation = () => {
        setDraft((prev) => ({
            ...prev,
            locations: [
                ...prev.locations,
                { id: `loc-${createClientId().slice(0, 8)}`, name: "", description: "", lighting: "", notes: "" },
            ],
        }));
    };

    const updateLocation = (id: string, patch: Partial<CreativeBibleLocation>) => {
        setDraft((prev) => ({
            ...prev,
            locations: prev.locations.map((item) => (item.id === id ? { ...item, ...patch } : item)),
        }));
    };

    const removeLocation = (id: string) => {
        setDraft((prev) => ({ ...prev, locations: prev.locations.filter((item) => item.id !== id) }));
    };

    const scopeLabel = draft.scopeKind === "project" ? "当前项目全部画布共享" : "当前画布专属";

    return (
        <DetailDrawer
            open={open}
            onClose={onClose}
            busy={saving}
            rootClassName="agent-client-drawer agent-mcp-drawer"
            title="创作设定集"
            icon={<BookOpen size={18} aria-hidden="true" />}
            footer={
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose} disabled={saving}>取消</Button>
                    <Button type="primary" loading={saving} disabled={loading} onClick={() => void handleSave()}>
                        保存设定
                    </Button>
                </div>
            }
        >
            <div className="grid gap-4">
                <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[var(--fs-label)] font-medium text-[var(--foreground)]">
                            {scopeLabel}
                        </span>
                        {draft.revision > 0 ? (
                            <span className="inline-flex items-center rounded-full bg-[var(--muted)] px-2 py-0.5 text-[var(--fs-label)] font-medium tabular-nums text-[var(--muted-foreground)]">
                                v{draft.revision}
                            </span>
                        ) : null}
                    </div>
                    <p className="m-0 text-xs leading-5 text-[var(--user-ink-muted)]">
                        内置助手与外部 MCP 读写同一份设定集，每轮对话自动同步。
                    </p>
                </div>

                {loadError ? (
                    <div role="alert" className="agent-mcp-error-box">
                        {loadError} <Button size="small" type="link" onClick={() => void load()}>重试</Button>
                    </div>
                ) : null}

                <Tabs
                    size="small"
                    items={[
                        {
                            key: "world",
                            label: "画风与规范",
                            children: (
                                <div className="agent-mcp-form">
                                    <label className="agent-mcp-field">
                                        <span>作品 / 设定集名称</span>
                                        <Input
                                            placeholder="例如：霓虹雨夜 · 赛博短剧第一季"
                                            value={draft.title}
                                            onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                                        />
                                    </label>
                                    <label className="agent-mcp-field">
                                        <span>故事基调与世界观</span>
                                        <Input.TextArea
                                            rows={3}
                                            placeholder="写明时代背景、叙事基调与核心冲突"
                                            value={draft.logline}
                                            onChange={(e) => setDraft((prev) => ({ ...prev, logline: e.target.value }))}
                                        />
                                    </label>
                                    <label className="agent-mcp-field">
                                        <span>画风与质感</span>
                                        <Input.TextArea
                                            rows={3}
                                            placeholder="例如：实拍电影质感、35mm 胶片颗粒、潮湿反光地面、高对比冷暖光"
                                            value={draft.visualStyle}
                                            onChange={(e) => setDraft((prev) => ({ ...prev, visualStyle: e.target.value }))}
                                        />
                                    </label>
                                    <label className="agent-mcp-field">
                                        <span>色彩规范</span>
                                        <Input
                                            placeholder="例如：青蓝阴影 + 琥珀暖光，低饱和皮肤质感"
                                            value={draft.colorPalette}
                                            onChange={(e) => setDraft((prev) => ({ ...prev, colorPalette: e.target.value }))}
                                        />
                                    </label>
                                    <label className="agent-mcp-field">
                                        <span>镜头语言与节奏</span>
                                        <Input.TextArea
                                            rows={2}
                                            placeholder="例如：多用特写与慢推镜，避免剧烈晃动和快速跳切"
                                            value={draft.cameraRules}
                                            onChange={(e) => setDraft((prev) => ({ ...prev, cameraRules: e.target.value }))}
                                        />
                                    </label>
                                    <label className="agent-mcp-field">
                                        <span>创作禁忌（负面约束）</span>
                                        <Input.TextArea
                                            rows={2}
                                            placeholder="例如：禁止现代字幕水印、禁止二次元大眼、主角不可更换发型与外套颜色"
                                            value={draft.taboos}
                                            onChange={(e) => setDraft((prev) => ({ ...prev, taboos: e.target.value }))}
                                        />
                                    </label>
                                </div>
                            ),
                        },
                        {
                            key: "characters",
                            label: `角色档案（${draft.characters.length}）`,
                            children: (
                                <div className="grid gap-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-[var(--user-ink-muted)]">固定主角外貌、服装与音色，防止多镜生成走形。</span>
                                        <Button size="small" icon={<Plus size={14} />} onClick={addCharacter}>新增角色</Button>
                                    </div>
                                    {draft.characters.length === 0 ? (
                                        <p className="m-0 rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-[var(--user-ink-muted)]">
                                            还没有角色档案。点右上角「新增角色」，或直接让画布助手帮你整理并写入设定集。
                                        </p>
                                    ) : draft.characters.map((char, idx) => (
                                        <div key={char.id} className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3.5">
                                            <div className="flex items-center gap-2">
                                                <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--fs-label)] font-semibold text-[var(--foreground)]">
                                                    {char.name.trim().slice(0, 1) || idx + 1}
                                                </span>
                                                <Input
                                                    placeholder="角色名（必填）"
                                                    value={char.name}
                                                    onChange={(e) => updateCharacter(char.id, { name: e.target.value })}
                                                />
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    danger
                                                    aria-label={`删除角色 ${char.name || "未命名"}`}
                                                    icon={<Trash2 size={14} />}
                                                    onClick={() => removeCharacter(char.id)}
                                                />
                                            </div>
                                            <label className="grid gap-1">
                                                <span className="text-xs font-medium text-[var(--user-ink-muted)]">外貌特征</span>
                                                <Input.TextArea
                                                    rows={2}
                                                    placeholder="年龄、五官、发型、标志性细节"
                                                    value={char.appearance || ""}
                                                    onChange={(e) => updateCharacter(char.id, { appearance: e.target.value })}
                                                />
                                            </label>
                                            <div className="grid gap-2.5 sm:grid-cols-2">
                                                <label className="grid gap-1">
                                                    <span className="text-xs font-medium text-[var(--user-ink-muted)]">固定服装</span>
                                                    <Input
                                                        placeholder="服装与随身道具"
                                                        value={char.wardrobe || ""}
                                                        onChange={(e) => updateCharacter(char.id, { wardrobe: e.target.value })}
                                                    />
                                                </label>
                                                <label className="grid gap-1">
                                                    <span className="text-xs font-medium text-[var(--user-ink-muted)]">音色与语气</span>
                                                    <Input
                                                        placeholder="配音音色 / 说话风格"
                                                        value={char.voice || ""}
                                                        onChange={(e) => updateCharacter(char.id, { voice: e.target.value })}
                                                    />
                                                </label>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ),
                        },
                        {
                            key: "locations",
                            label: `场景档案（${draft.locations.length}）`,
                            children: (
                                <div className="grid gap-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-[var(--user-ink-muted)]">记录高频场景陈设与打光，保持跨镜空间一致。</span>
                                        <Button size="small" icon={<Plus size={14} />} onClick={addLocation}>新增场景</Button>
                                    </div>
                                    {draft.locations.length === 0 ? (
                                        <p className="m-0 rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-[var(--user-ink-muted)]">
                                            还没有场景档案。点右上角「新增场景」，统一核心场景与光影。
                                        </p>
                                    ) : draft.locations.map((loc, idx) => (
                                        <div key={loc.id} className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3.5">
                                            <div className="flex items-center gap-2">
                                                <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--fs-label)] font-semibold tabular-nums text-[var(--foreground)]">
                                                    {idx + 1}
                                                </span>
                                                <Input
                                                    placeholder="场景名称（必填）"
                                                    value={loc.name}
                                                    onChange={(e) => updateLocation(loc.id, { name: e.target.value })}
                                                />
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    danger
                                                    aria-label={`删除场景 ${loc.name || "未命名"}`}
                                                    icon={<Trash2 size={14} />}
                                                    onClick={() => removeLocation(loc.id)}
                                                />
                                            </div>
                                            <label className="grid gap-1">
                                                <span className="text-xs font-medium text-[var(--user-ink-muted)]">空间与陈设</span>
                                                <Input.TextArea
                                                    rows={2}
                                                    placeholder="空间结构、关键陈设、材质与天气"
                                                    value={loc.description || ""}
                                                    onChange={(e) => updateLocation(loc.id, { description: e.target.value })}
                                                />
                                            </label>
                                            <label className="grid gap-1">
                                                <span className="text-xs font-medium text-[var(--user-ink-muted)]">主光与氛围</span>
                                                <Input
                                                    placeholder="例如：雨夜霓虹反射、冷色顶灯"
                                                    value={loc.lighting || ""}
                                                    onChange={(e) => updateLocation(loc.id, { lighting: e.target.value })}
                                                />
                                            </label>
                                        </div>
                                    ))}
                                </div>
                            ),
                        },
                    ]}
                />
            </div>
        </DetailDrawer>
    );
}
