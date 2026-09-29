import type { DirectorCamera, DirectorLight, DirectorObject, DirectorScene } from "@/types/director";

export type DirectorSceneSearchItem =
    | { kind: "camera"; id: string; name: string; camera: DirectorCamera }
    | { kind: "object"; id: string; name: string; object: DirectorObject }
    | { kind: "light"; id: string; name: string; light: DirectorLight };

/** Flat scene hierarchy shown by the director sidebar; filtering never changes the scene. */
export function searchDirectorSceneItems(scene: DirectorScene, query: string): DirectorSceneSearchItem[] {
    const items: DirectorSceneSearchItem[] = [
        ...scene.cameras.map((camera) => ({ kind: "camera" as const, id: camera.id, name: camera.name, camera })),
        ...scene.objects.map((object) => ({ kind: "object" as const, id: object.id, name: object.name, object })),
        ...scene.lights.map((light) => ({ kind: "light" as const, id: light.id, name: light.name, light })),
    ];
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? items.filter((item) => item.name.toLocaleLowerCase().includes(normalized)) : items;
}

/** 场景行的 Shift 连续多选。筛选使锚点不在当前列表时退化为单选。 */
export function resolveDirectorSceneSelection(order: string[], current: string[], anchor: string | null, target: string, shift: boolean): string[] {
    const targetIndex = order.indexOf(target);
    if (targetIndex < 0) return current.filter((id) => order.includes(id));
    const anchorIndex = anchor ? order.indexOf(anchor) : -1;
    if (!shift || anchorIndex < 0) return [target];
    return order.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
}
