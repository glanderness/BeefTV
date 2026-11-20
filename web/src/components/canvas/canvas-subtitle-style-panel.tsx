import { ColorPicker, InputNumber, Segmented } from "antd";

import { Switch } from "@/components/ui/base/switch";
import { DEFAULT_MAX_CHARS_PER_ENTRY, MAX_CHARS_PER_ENTRY_LIMIT, MIN_CHARS_PER_ENTRY } from "@/lib/timeline/srt-resegment";
import type { SubtitlePosition, SubtitleStyle } from "@/types/timeline";
import { SubtitleHighlightedText } from "./canvas-subtitle-text";

const sample = { entryIndex: 1, sourceText: "字幕样例", highlightText: "样例", start: 2, end: 4 };
const spacingFields = [
    ["highlightPaddingX", "水平边距"],
    ["highlightPaddingY", "垂直边距"],
    ["highlightRadius", "圆角"],
] as const;

export function SubtitleStylePanel({ style, onChange }: { style: SubtitleStyle; onChange: (patch: Partial<SubtitleStyle>) => void }) {
    return (
        <div className="subtitle-style-controls thin-scrollbar">
            <div className="subtitle-style-sample" data-position={style.position} style={{ paddingBlock: style.highlightEnabled ? Math.max(4, style.highlightPaddingY) : 4 }} aria-label="字幕样式示例">
                <span style={{ color: style.color, fontSize: style.fontSize }}>
                    <SubtitleHighlightedText text={sample.sourceText} highlight={sample} style={style} />
                </span>
            </div>
            <div className="subtitle-style-pair">
                <label>字号<InputNumber aria-label="字幕字号" size="small" min={12} max={40} value={style.fontSize} onChange={(value) => onChange({ fontSize: value ?? style.fontSize })} /></label>
                <label>文字色<ColorPicker aria-label="字幕文字色" size="small" value={style.color} onChange={(value) => onChange({ color: value.toHexString() })} /></label>
            </div>
            <div className="subtitle-style-row">
                <span>位置</span>
                <Segmented<SubtitlePosition> aria-label="字幕位置" size="small" value={style.position}
                    options={[{ label: "顶部", value: "top" }, { label: "居中", value: "center" }, { label: "底部", value: "bottom" }]}
                    onChange={(position) => onChange({ position })} />
            </div>
            <label className="subtitle-style-row">
                单条上限（字）
                <InputNumber aria-label="单条字幕字数上限" size="small" min={MIN_CHARS_PER_ENTRY} max={MAX_CHARS_PER_ENTRY_LIMIT}
                    className="subtitle-character-limit" precision={0} value={style.maxCharsPerEntry} onChange={(value) => onChange({ maxCharsPerEntry: value ?? DEFAULT_MAX_CHARS_PER_ENTRY })} />
            </label>
            <div className="subtitle-style-row subtitle-highlight-heading">
                <span>关键词高亮</span>
                <Switch aria-label="关键词高亮" size="sm" checked={style.highlightEnabled} onChange={(highlightEnabled) => onChange({ highlightEnabled })} />
            </div>
            {style.highlightEnabled && <>
                <div className="subtitle-style-pair">
                    <label>背景色<ColorPicker aria-label="高亮背景色" size="small" value={style.highlightBackgroundColor} onChange={(value) => onChange({ highlightBackgroundColor: value.toHexString() })} /></label>
                    <label>文字色<ColorPicker aria-label="高亮文字色" size="small" value={style.highlightTextColor} onChange={(value) => onChange({ highlightTextColor: value.toHexString() })} /></label>
                </div>
                <div className="subtitle-style-spacing" role="group" aria-label="高亮边距与圆角">
                    {spacingFields.map(([key, label]) => (
                        <label key={key}>{label}<InputNumber aria-label={label} size="small" precision={0} min={0} max={24} value={style[key]} onChange={(value) => onChange({ [key]: value ?? 0 })} /></label>
                    ))}
                </div>
            </>}
        </div>
    );
}
