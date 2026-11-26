import type { AiConfig } from "@/stores/use-config-store";
import type { ImageCapabilityConfig } from "@/lib/model-capabilities";
import { seedreamSupportsLayerSplit } from "@/lib/seedream-image";
import { Switch } from "@/components/ui/base/switch";

type Key = "size" | "transparentBackground" | "seedreamMode" | "seedreamMaxImages" | "seedreamOutputFormat" | "seedreamOptimize" | "seedreamWatermark";

export function SeedreamSettings({ config, family, profile, onChange }: {
    config: AiConfig; family: string; profile: ImageCapabilityConfig; onChange: (key: Key, value: string) => void;
}) {
    const modern = seedreamSupportsLayerSplit(family);
    const supportsFast = family === "pro" || family === "4.0";
    const layers = config.seedreamMode === "layers";
    const transparent = config.transparentBackground === "true";
    const format = !transparent && config.seedreamOutputFormat === "jpeg" ? "jpeg" : "png";
    const toggleLayers = (checked: boolean) => {
        onChange("seedreamMode", checked ? "layers" : "image");
        if (checked) onChange("transparentBackground", "false");
        if (checked && !profile.size.values.includes(config.size)) onChange("size", "auto");
        if (!checked && config.size === "auto") onChange("size", profile.size.default);
    };
    return <>
        {modern && <div className="image-output-row">
            <span>图层拆分</span><Switch aria-label="图层拆分" size="sm" checked={layers} onChange={toggleLayers} />
        </div>}
        {modern && layers && <p className="image-size-hint">连接一张参考图，可在提示词中指定要分离的元素。</p>}
        <div className="image-output-row"><span>AI 水印</span><Switch aria-label="AI 水印" size="sm" checked={config.seedreamWatermark === "true"} onChange={checked => onChange("seedreamWatermark", checked ? "true" : "false")} /></div>
        {supportsFast && <div className="image-setting-inline"><span>提示词优化</span><div className="image-size-tiers">
            {["standard", "fast"].map(value => <button type="button" key={value}
                aria-pressed={(config.seedreamOptimize === "fast" ? "fast" : "standard") === value}
                onClick={() => onChange("seedreamOptimize", value)}>{value === "fast" ? "快速" : "标准"}</button>)}
        </div></div>}
        {profile.outputFormat.supported && <div className="image-setting-inline">
            <span>{layers ? "底图格式" : "图片格式"}</span><div className="image-size-tiers">
                {["png", "jpeg"].map(value => <button type="button" key={value} disabled={transparent && value === "jpeg"}
                    aria-pressed={format === value} onClick={() => onChange("seedreamOutputFormat", value)}>{value.toUpperCase()}</button>)}
            </div>
        </div>}
    </>;
}
