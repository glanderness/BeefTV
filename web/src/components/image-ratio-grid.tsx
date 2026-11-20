import type { ReactNode } from "react";

type RatioChoice = { size: string; ratio: string; width: number; height: number };

export function ImageRatioGrid<T extends RatioChoice>({ choices, selectedSize, onSelect, automatic }: {
    choices: T[]; selectedSize?: string; onSelect: (choice: T) => void; automatic?: ReactNode;
}) {
    return <div className="image-size-ratios">
        {choices.map(preset => <button type="button" key={`${preset.ratio}:${preset.size}`}
            title={`${preset.ratio} · ${preset.width} × ${preset.height}`}
            aria-pressed={selectedSize === preset.size} onClick={() => onSelect(preset)}>
            <span aria-hidden className="image-size-ratio-icon" style={{
                width: `calc(var(--ratio-icon-size, 24px) * ${Math.min(1, preset.width / preset.height)})`,
                height: `calc(var(--ratio-icon-size, 24px) * ${Math.min(1, preset.height / preset.width)})`,
            }} />
            <span>{preset.ratio}</span>
        </button>)}
        {automatic}
    </div>;
}
