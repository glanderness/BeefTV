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
                <p className="m-0 text-xs leading-5 text-[var(--user-ink-muted)]">
                    {scopeLabel} · 保存后内置画布助手每轮会自动读取这里的画风、角色、场景和禁忌；外部接入的 Claude Code / Codex 也可读写同一份设定集。
                </p>

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
                                    ) : draft.characters.map((char) => (
                                        <div key={char.id} className="grid gap-2 rounded-lg border border-[var(--border)] p-3">
                                            <div className="flex items-center gap-2">
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
                                            <Input.TextArea
                                                rows={2}
                                                placeholder="外貌特征（年龄、五官、发型、标志性细节）"
                                                value={char.appearance || ""}
                                                onChange={(e) => updateCharacter(char.id, { appearance: e.target.value })}
                                            />
                                            <div className="grid gap-2 sm:grid-cols-2">
                                                <Input
                                                    placeholder="固定服装"
                                                    value={char.wardrobe || ""}
                                                    onChange={(e) => updateCharacter(char.id, { wardrobe: e.target.value })}
                                                />
                                                <Input
                                                    placeholder="配音音色 / 说话风格"
                                                    value={char.voice || ""}
                                                    onChange={(e) => updateCharacter(char.id, { voice: e.target.value })}
                                                />
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
                                    ) : draft.locations.map((loc) => (
                                        <div key={loc.id} className="grid gap-2 rounded-lg border border-[var(--border)] p-3">
                                            <div className="flex items-center gap-2">
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
                                            <Input.TextArea
                                                rows={2}
                                                placeholder="空间结构、关键陈设、材质与天气"
                                                value={loc.description || ""}
                                                onChange={(e) => updateLocation(loc.id, { description: e.target.value })}
                                            />
                                            <Input
                                                placeholder="主光与氛围（例如：雨夜霓虹反射、冷色顶灯）"
                                                value={loc.lighting || ""}
                                                onChange={(e) => updateLocation(loc.id, { lighting: e.target.value })}
                                            />
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
