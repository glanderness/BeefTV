import { ColorPicker, InputNumber, Slider } from "antd";

import { Switch } from "@/components/ui/base/switch";
import { directorGroundSettings } from "@/lib/canvas/director/director-ground";
import { directorStageTransform } from "@/lib/canvas/director/director-stage-transform";
import type { DirectorScene, DirectorVec3 } from "@/types/director";

type SceneEnvironmentPatch = Partial<Pick<DirectorScene, "background" | "environmentIntensity" | "gridVisible" | "panorama" | "ground" | "stageTransform" | "labelsVisible">>;

export function DirectorSceneInspector({ scene, onChange }: { scene: DirectorScene; onChange: (patch: SceneEnvironmentPatch) => void }) {
    const ground = directorGroundSettings(scene);
    const stage = directorStageTransform(scene);
    const updateGround = (patch: Partial<typeof ground>) => onChange({ ground: { ...ground, ...patch } });
    const updateAxis = (field: "position" | "rotation", axis: number, value: number) => {
        const next = [...stage[field]] as DirectorVec3;
        next[axis] = value;
        onChange({ stageTransform: { ...stage, [field]: next } });
    };
    return (
        <div className="text-sm">
            <h2 className="border-b px-4 py-4 text-base font-semibold" style={{ borderColor: "var(--border)" }}>3D场景</h2>
            <section className="space-y-4 border-b px-4 py-5" style={{ borderColor: "var(--border)" }} aria-label="场景变换">
                <h3 className="font-semibold">场景变换</h3>
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs"><span className="opacity-65">场景缩放</span><span>{Math.round(stage.scale * 100)}%</span></div>
                    <div className="flex items-center gap-3">
                        <Slider ariaLabelForHandle="场景缩放" className="m-0 min-w-0 flex-1" min={0.1} max={10} step={0.1} value={stage.scale} onChangeComplete={(scale) => onChange({ stageTransform: { ...stage, scale } })} />
                        <InputNumber aria-label="场景缩放百分比" className="w-[72px] shrink-0" size="small" min={10} max={1000} step={10} suffix="%" value={Math.round(stage.scale * 100)} onChange={(percent) => { if (percent !== null) onChange({ stageTransform: { ...stage, scale: percent / 100 } }); }} />
                    </div>
                </div>
                {(["position", "rotation"] as const).map((field) => <div key={field} className="space-y-2">
                    <div className="text-xs opacity-65">场景{field === "position" ? "平移" : "旋转"}</div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis} className="min-w-0">
                            <span className="mb-1 block text-[10px] opacity-55">{axis}</span>
                            <InputNumber aria-label={`场景${field === "position" ? "平移" : "旋转"}${axis}`} className="w-full" size="small" step={field === "position" ? 0.1 : 1} precision={field === "position" ? 1 : 0} value={stage[field][index]} onChange={(value) => { if (value !== null) updateAxis(field, index, value); }} />
                        </label>)}
                    </div>
                </div>)}
            </section>
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
            <div className="flex items-center justify-between gap-3 border-b px-4 py-4 text-xs" style={{ borderColor: "var(--border)" }}>
                <span>角色标签</span>
                <Switch size="sm" aria-label="角色标签" checked={scene.labelsVisible !== false} onChange={(labelsVisible) => onChange({ labelsVisible })} />
            </div>
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
            <section className="space-y-4 border-t px-4 py-5" style={{ borderColor: "var(--border)" }} aria-label="地面设置">
                <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold">地面</h3>
                    <Switch size="sm" aria-label="显示地面" checked={ground.visible} onChange={(visible) => updateGround({ visible })} />
                </div>
                <div className="space-y-1.5">
                    <div className="text-xs opacity-65">透明度</div>
                    <div className="flex items-center gap-3">
                        <Slider ariaLabelForHandle="地面透明度" className="m-0 min-w-0 flex-1" min={0} max={1} step={0.05} disabled={!ground.visible} value={ground.opacity} onChangeComplete={(opacity) => updateGround({ opacity })} />
                        <InputNumber aria-label="地面透明度数值" className="w-[72px] shrink-0" size="small" min={0} max={1} step={0.05} precision={2} disabled={!ground.visible} value={ground.opacity} onChange={(opacity) => { if (opacity !== null) updateGround({ opacity }); }} />
                    </div>
                </div>
                <div className="space-y-1.5">
                    <div className="text-xs opacity-65">高度</div>
                    <div className="flex items-center gap-3">
                        <Slider ariaLabelForHandle="地面高度" className="m-0 min-w-0 flex-1" min={-2} max={2} step={0.05} disabled={!ground.visible} value={ground.height} onChangeComplete={(height) => updateGround({ height })} />
                        <InputNumber aria-label="地面高度数值" className="w-[72px] shrink-0" size="small" min={-2} max={2} step={0.05} precision={1} disabled={!ground.visible} value={ground.height} onChange={(height) => { if (height !== null) updateGround({ height }); }} />
                    </div>
                </div>
            </section>
        </div>
    );
}
