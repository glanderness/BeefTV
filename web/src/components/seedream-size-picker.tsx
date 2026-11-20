import { seedreamResolutionTiers, seedreamSizePresets } from "@/lib/seedream-image";
import type { ImageCapabilityConfig } from "@/lib/model-capabilities";
import { ImageRatioGrid } from "./image-ratio-grid";

// A named tier lets the provider choose the aspect ratio. An explicit ratio
// uses pixel dimensions; layer decomposition only accepts a tier or "auto".
export function SeedreamSizePicker({ profile, size, layers, onChange }: {
    profile: ImageCapabilityConfig; size: string; layers: boolean; onChange: (size: string) => void;
}) {
    const tiers = seedreamResolutionTiers(profile);
    const presets = seedreamSizePresets(tiers);
    const selected = presets.find(preset => preset.size === size);
    const namedTier = tiers.find(value => value.toLowerCase() === size.toLowerCase());
    const activeTier = namedTier || selected?.tier;
    const tier = activeTier || profile.size.default;
    return <div className="image-size-picker">
        <div className="image-size-label">分辨率</div>
        <div className="image-size-tiers">{tiers.map(value =>
            <button type="button" key={value} aria-pressed={activeTier === value} onClick={() => onChange(
                (!layers && selected && presets.find(preset => preset.ratio === selected.ratio && preset.tier === value)?.size) || value
            )}>{value}</button>
        )}{layers && <button type="button" aria-pressed={size === "auto"} onClick={() => onChange("auto")}>跟随原图</button>}</div>
        {!layers && profile.size.allowCustom && <>
            <div className="image-size-label">宽高比</div>
            <ImageRatioGrid choices={presets.filter(preset => preset.tier === tier)} selectedSize={selected?.size}
                onSelect={preset => onChange(preset.size)}
                automatic={<button type="button" aria-pressed={Boolean(namedTier)} onClick={() => onChange(tier)}>自适应</button>} />
        </>}
    </div>;
}
