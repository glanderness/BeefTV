import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Popover } from "antd";
import { Check, ChevronRight } from "lucide-react";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { DisplayModelGroup } from "@/lib/model-selection";
import { useCreationPreferencesStore } from "@/stores/use-creation-preferences-store";
import type { ModelCapability } from "@/stores/use-config-store";

const modelLabels = { text: "文本模型", image: "图片模型", video: "视频模型", audio: "音频模型" };

export type ModelProviderGroup = { key: string; label: string; models: DisplayModelGroup[] };

export function modelMenuSurface(theme: CanvasTheme): CSSProperties {
    return {
        background: theme.canvas.background,
        color: theme.node.text,
        border: `1px solid ${theme.toolbar.border}`,
        borderRadius: 10,
        boxShadow: `0 24px 72px ${theme.spatial.shadow}`,
        padding: 6,
    };
}

export function ModelProviderMenu({ groups, current, capability, preferenceKey = capability, searchable, theme, renderOption }: {
    groups: ModelProviderGroup[];
    capability: ModelCapability;
    preferenceKey?: ModelCapability | "transcription";
    searchable?: boolean;
    current: string;
    theme: CanvasTheme;
    renderOption: (model: DisplayModelGroup) => ReactNode;
}) {
    const preferred = useCreationPreferencesStore(state => state.preferences.providers?.[preferenceKey]);
    const provider = groups.find(group => group.key === preferred)
        ?? groups.find(group => group.models.some(model => model.models.includes(current)))
        ?? groups[0]!;
    const [query, setQuery] = useState("");
    const filteredModels = provider.models.filter(model => !query || model.label.toLowerCase().includes(query.trim().toLowerCase()));
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const providerListId = useId();
    const closeProviders = () => {
        setOpen(false);
        trigger.current?.focus();
    };
    return (
        <div role="dialog" aria-label={`选择${modelLabels[capability]}`} data-canvas-settings-popover className="provider-model-menu"
            style={{ color: theme.node.text, "--provider-model-active": theme.toolbar.activeBg, "--provider-model-border": theme.toolbar.border } as CSSProperties}>
            <Popover trigger="click" open={open} onOpenChange={setOpen} arrow={false} destroyOnHidden
                placement={window.innerWidth < 520 ? "bottomRight" : "rightTop"}
                getPopupContainer={element => element.parentElement!}
                styles={{ container: modelMenuSurface(theme) }}
                afterOpenChange={visible => { if (visible) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(); }}
                content={
                    <div role="menu" aria-label="供应商" id={providerListId} ref={menu} className="model-provider-options"
                        style={{ color: theme.node.text }}
                        onKeyDown={event => {
                            event.stopPropagation();
                            if (event.key === "Escape" || event.key === "ArrowLeft") {
                                event.preventDefault();
                                closeProviders();
                            } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                                event.preventDefault();
                                const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
                                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                                const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                                buttons[next]?.focus();
                            }
                        }}>
                        {groups.map(group => (
                            <button type="button" key={group.key} role="menuitemradio" aria-checked={group.key === provider.key}
                                className="provider-model-menu-row" onClick={() => {
                                    useCreationPreferencesStore.getState().rememberModelProvider(preferenceKey, group.key);
                                    setQuery("");
                                    closeProviders();
                                }}>
                                <span className="truncate">{group.label}</span>
                                {group.key === provider.key && <Check aria-hidden="true" />}
                            </button>
                        ))}
                    </div>
                }>
                <button type="button" ref={trigger} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? providerListId : undefined}
                    className="provider-model-menu-row model-provider-trigger" onKeyDown={event => {
                        if (event.key === "ArrowRight") { event.preventDefault(); setOpen(true); }
                    }}>
                    <span className="shrink-0" style={{ color: theme.node.muted }}>默认供应商</span>
                    <span className="ml-auto truncate">{provider.label}</span><ChevronRight aria-hidden="true" />
                </button>
            </Popover>
            {searchable && <input type="search" aria-label="搜索模型" placeholder="搜索模型" className="mt-1 w-full px-2 py-1" value={query} onChange={event => setQuery(event.target.value)} />}
            <div key={provider.key} role="listbox" aria-label={`${provider.label} ${modelLabels[capability]}`} className="provider-model-options">
                {filteredModels.map(renderOption)}
                {!filteredModels.length && <span role="status" className="px-2 py-1" style={{ color: theme.node.muted }}>没有匹配的模型</span>}
            </div>
        </div>
    );
}
