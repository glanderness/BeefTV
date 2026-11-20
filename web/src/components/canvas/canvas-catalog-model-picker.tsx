import { useRef, useState } from "react";
import { Popover } from "antd";
import { Check, ChevronDown } from "lucide-react";
import { ModelProviderMenu, modelMenuSurface, type ModelProviderGroup } from "@/components/model-provider-menu";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { decodeChannelModel, useConfigStore, type ModelCapability } from "@/stores/use-config-store";

type CatalogOption = { value: string; label: string; provider?: string };

// Workflow and media tools supply narrower catalogs than the general generation picker.
export function CanvasCatalogModelPicker({ options, capability, preferenceKey, value, label, onChange, disabled, searchable, placeholder }: {
    options: CatalogOption[];
    capability: ModelCapability;
    preferenceKey?: "transcription";
    value?: string;
    label: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    searchable?: boolean;
    placeholder?: string;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const channels = useConfigStore(state => state.config.channels);
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const groups = new Map<string, ModelProviderGroup>();
    let selectedLabel = value;
    for (const option of options) {
        const key = option.provider ?? decodeChannelModel(option.value)?.channelId ?? "";
        let group = groups.get(key);
        if (!group) {
            const name = channels.find(channel => channel.id === key)?.name;
            group = { key, label: key === "local" ? "本机" : name || (key === "beeftv" ? "BeefTV" : key || "当前渠道"), models: [] };
            groups.set(key, group);
        }
        const suffix = " · " + key;
        const name = option.label.endsWith(suffix) ? option.label.slice(0, -suffix.length) : option.label;
        group.models.push({ key: option.value, label: name, models: [option.value] });
        if (value === option.value) selectedLabel = name;
    }
    const close = () => {
        setOpen(false);
        trigger.current?.focus();
    };
    return <Popover open={open && !disabled && groups.size > 0} onOpenChange={setOpen} trigger="click" arrow={false}
        placement="bottomLeft" destroyOnHidden fresh styles={{ container: modelMenuSurface(theme) }}
        afterOpenChange={visible => { if (visible) panel.current?.focus(); }}
        content={groups.size > 0 && <div ref={panel} tabIndex={-1} data-canvas-no-zoom onPointerDown={event => event.stopPropagation()}
            onKeyDown={event => {
                event.stopPropagation();
                if (event.key === "Escape") { event.preventDefault(); close(); }
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
                const active = rows.indexOf(document.activeElement as HTMLButtonElement);
                rows[Math.max(0, Math.min(rows.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
            }}>
            <ModelProviderMenu groups={Array.from(groups.values())} current={value ?? ""} capability={capability} preferenceKey={preferenceKey}
                theme={theme} searchable={searchable} renderOption={option => <button type="button" key={option.key} role="option"
                    aria-selected={value === option.key} className="provider-model-menu-row" title={option.label}
                    onClick={() => { onChange(option.key); close(); }}>
                    <span className="truncate">{option.label}</span>{value === option.key && <Check aria-hidden="true" />}
                </button>} />
        </div>}>
        <button type="button" ref={trigger} aria-label={label} aria-haspopup="dialog" aria-expanded={open && !disabled && groups.size > 0}
            className="canvas-composer-model-picker w-full min-w-0 disabled:opacity-50" disabled={disabled || !groups.size}
            onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
            <span className="truncate">{selectedLabel || placeholder || "选择模型"}</span><ChevronDown className="size-3.5 shrink-0" />
        </button>
    </Popover>;
}
