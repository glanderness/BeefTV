import { ColorPicker, InputNumber, Slider } from "antd";

import { Switch } from "@/components/ui/base/switch";
import type { DirectorScene } from "@/types/director";

type SceneEnvironmentPatch = Partial<Pick<DirectorScene, "background" | "environmentIntensity" | "gridVisible" | "panorama">>;

export function DirectorSceneInspector({ scene, onChange }: { scene: DirectorScene; onChange: (patch: SceneEnvironmentPatch) => void }) {
    return (
        <div className="text-sm">
            <h2 className="border-b px-4 py-4 text-base font-semibold" style={{ borderColor: "var(--border)" }}>3D场景</h2>
            <section className="space-y-4 border-b px-4 py-5" style={{ borderColor: "var(--border)" }} aria-label="全景背景">
                <h3 className="font-semibold">全景背景</h3>
                <div className="space-y-2">
                    <span className="text-xs opacity-65">已连接全景图</span>
                    {scene.panorama ? <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--border)" }}>
                        <span className="min-w-0 truncate">{scene.panorama.name || "全景图片"}</span>
                        <button type="button" aria-label="移除全景图" className="shrink-0 opacity-65 hover:opacity-100" onClick={() => onChange({ panorama: undefined })}>移除</button>
                    </div> : <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs opacity-55" style={{ borderColor: "var(--border)" }}>从左侧上传或选择图片</div>}
                </div>
                <div className="space-y-2">
                    <div className="text-xs opacity-65">天空颜色</div>
                    <ColorPicker showText value={scene.background} onChangeComplete={(color) => onChange({ background: color.toHexString() })} />
                </div>
            </section>
            <section className="space-y-4 border-b px-4 py-5" style={{ borderColor: "var(--border)" }} aria-label="全景球">
                <h3 className="font-semibold">全景球</h3>
                <div className="text-xs opacity-65">水平旋转</div>
                <div className="flex items-center gap-3">
                    <Slider aria-label="全景球水平旋转" className="m-0 min-w-0 flex-1" min={-180} max={180} step={1} disabled={!scene.panorama} value={scene.panorama?.rotation ?? 0} onChangeComplete={(rotation) => { if (scene.panorama) onChange({ panorama: { ...scene.panorama, rotation } }); }} />
                    <InputNumber aria-label="全景球旋转角度" className="w-[72px] shrink-0" size="small" min={-180} max={180} step={1} suffix="°" disabled={!scene.panorama} value={scene.panorama?.rotation ?? 0} onChange={(rotation) => { if (scene.panorama && rotation !== null) onChange({ panorama: { ...scene.panorama, rotation } }); }} />
                </div>
            </section>
            <div className="space-y-5 px-4 py-5">
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs"><span className="opacity-65">环境亮度</span><span>{Math.round(scene.environmentIntensity * 100)}%</span></div>
                    <Slider min={0} max={2} step={0.05} value={scene.environmentIntensity} onChangeComplete={(environmentIntensity) => onChange({ environmentIntensity })} />
                </div>
                <div className="flex items-center justify-between gap-3 text-xs">
                    <span>显示网格</span>
                    <Switch size="sm" aria-label="显示网格" checked={scene.gridVisible} onChange={(gridVisible) => onChange({ gridVisible })} />
                </div>
            </div>
        </div>
    );
}
