import { ColorPicker, Slider } from "antd";

import { Switch } from "@/components/ui/base/switch";
import type { DirectorScene } from "@/types/director";

type SceneEnvironmentPatch = Partial<Pick<DirectorScene, "background" | "environmentIntensity" | "gridVisible">>;

export function DirectorSceneInspector({ scene, onChange }: { scene: DirectorScene; onChange: (patch: SceneEnvironmentPatch) => void }) {
    return (
        <div className="space-y-5 p-3">
            <h2 className="text-sm font-semibold">3D场景</h2>
            <div className="space-y-2">
                <div className="text-xs opacity-65">天空颜色</div>
                <ColorPicker showText value={scene.background} onChangeComplete={(color) => onChange({ background: color.toHexString() })} />
            </div>
            <div className="space-y-2">
                <div className="flex items-center justify-between text-xs"><span className="opacity-65">环境亮度</span><span>{Math.round(scene.environmentIntensity * 100)}%</span></div>
                <Slider min={0} max={2} step={0.05} value={scene.environmentIntensity} onChangeComplete={(environmentIntensity) => onChange({ environmentIntensity })} />
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
                <span>显示网格</span>
                <Switch size="sm" aria-label="显示网格" checked={scene.gridVisible} onChange={(gridVisible) => onChange({ gridVisible })} />
            </div>
        </div>
    );
}
