import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useDirectorWorkbenchStore } from "../src/stores/canvas/use-director-workbench-store";

/**
 * 生产接线回归：模板与模式的领域函数正确，不代表真实入口用上了。
 * 这里锁住「新建必须选模板」「已有场景不弹模板」「模式切换安全清理」三条链路。
 */
const workbench = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-workbench.tsx"), "utf8");
const dock = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/director-viewport-dock.tsx"), "utf8");
const viewport = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/director-viewport.tsx"), "utf8");
const hook = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-director.ts"), "utf8");
const uploadHook = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-upload.ts"), "utf8");
const project = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
const modal = readFileSync(resolve(import.meta.dir, "../src/components/canvas/director/canvas-director-template-modal.tsx"), "utf8");
const store = readFileSync(resolve(import.meta.dir, "../src/stores/canvas/use-director-workbench-store.ts"), "utf8");
const styles = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");

function slice(source: string, from: string, to: string) {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(to, start + from.length);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe("新建场景必须显式选模板", () => {
    test("createDirectorShot 第一个参数是 templateId，没有默认值", () => {
        expect(hook).toContain("const createDirectorShot = useCallback((templateId: DirectorTemplateId, position?: Position) => {");
        // 有默认模板等于又回到「无条件塞演员」。
        expect(hook).not.toContain("templateId: DirectorTemplateId = ");
    });

    test("新建走模板工厂，不再走带默认演员的 createDirectorScene", () => {
        expect(hook).toContain("createDirectorSceneFromTemplate(templateId, `镜头 ${shotIndex}`)");
        expect(hook).not.toContain("createDirectorScene(");
    });

    test("两个新建入口都先开模板选择，而不是直接建场景", () => {
        expect(project).toContain("onOpenDirector={() => setDirectorTemplateRequest({})}");
        expect(project).toContain("onOpenDirector={(position) => setDirectorTemplateRequest({ position })}");
        expect(project).not.toContain("onOpenDirector={() => createDirectorShot()}");
        expect(project).not.toContain("onOpenDirector={createDirectorShot}");
    });

    test("选中模板后带着 position 建场景", () => {
        const element = slice(project, "<CanvasDirectorTemplateModal", "/>");
        expect(element).toContain("open={Boolean(directorTemplateRequest)}");
        expect(element).toContain("onSelect={(templateId) => createDirectorShot(templateId, directorTemplateRequest?.position)}");
    });

    test("新建导演台节点采用 LibTV 的大预览与宽描述框比例", () => {
        expect(hook).toContain("node.width = 768;");
        expect(hook).toContain("node.height = 704;");
    });

    test("模板弹窗把 5 个模板全列出来，没有「默认」快捷项", () => {
        expect(modal).toContain("DIRECTOR_TEMPLATES.map");
        expect(modal).toContain("onSelect(template.id)");
        expect(modal).not.toContain("默认模板");
    });
});

describe("已有场景不触发模板选择", () => {
    test("openDirectorWorkbench 命中已存在场景时不建新场景、不弹模板", () => {
        const opener = slice(hook, "const openDirectorWorkbench = useCallback", "/** 每次保存都基于 store");
        // 只有找不到场景（孤儿节点修复）才补建。
        expect(opener).toContain("if (!scene) {");
        expect(opener).toContain('createDirectorSceneFromTemplate("empty"');
        expect(opener).not.toContain("setDirectorTemplateRequest");
    });

    test("导演节点提交描述时写入对应镜头并在缺少镜头引用时回退当前镜头", () => {
        const opener = slice(hook, "const openDirectorWorkbench = useCallback", "/** 每次保存都基于 store");
        expect(opener).toContain("updateDirectorShotPrompt(scene, node.metadata?.directorShotId, initialPrompt)");
        expect(project).toContain("onSubmit={() => openDirectorWorkbench(contentNode.id, contentNode.metadata?.composerContent || \"\")}");
    });

    test("孤儿修复用空场景兜底：用户没选过就不许塞演员", () => {
        const opener = slice(hook, "const openDirectorWorkbench = useCallback", "/** 每次保存都基于 store");
        expect(opener).not.toContain('createDirectorSceneFromTemplate("monologue"');
        expect(opener).not.toContain("createDirectorActor");
    });

    test("workbench 自身不含模板选择逻辑：打开已保存场景不改写内容", () => {
        expect(workbench).not.toContain("DIRECTOR_TEMPLATES");
        expect(workbench).not.toContain("createDirectorSceneFromTemplate");
    });
});

describe("导演台场景菜单的相机与灯光操作", () => {
    test("添加菜单提供 LibTV 同类的机位、太阳光、点光源、聚光灯并接入真实创建逻辑", () => {
        const menu = slice(workbench, "const addObjectMenuItems:", "const addShot =");
        expect(menu).toContain('key: "camera"');
        expect(menu).toContain('addPresetCamera("current")');
        expect(menu).toContain('key: "sun"');
        expect(menu).toContain('addLight("directional", "太阳光"');
        expect(menu).toContain('key: "point-light"');
        expect(menu).toContain('addLight("point", "点光源"');
        expect(menu).toContain('key: "spotlight"');
        expect(menu).toContain('addLight("spot", "聚光灯"');
        expect(slice(workbench, "const addObject = (object:", "const addPrimitive =")).toContain('setMode(object.kind === "actor" ? "pose" : "layout")');
        expect(slice(workbench, "const addPresetCamera =", "const addLight =")).toContain('setMode("camera")');
        expect(slice(workbench, "const addLight =", "const addLightMenuItems:")).toContain('setMode("layout")');
    });
});

describe("LibTV 场景资产聚焦交互", () => {
    test("机位、对象、灯光场景树行都提供聚焦动作并调用视口取景控制", () => {
        expect(workbench).toContain("onFocus={() => focusSceneCamera(item.camera)}");
        expect(workbench).toContain("onFocus={() => focusSceneObject(item.object)}");
        expect(workbench).toContain("onFocus={() => focusSceneLight(item.light)}");
        expect(workbench).toContain("aria-label={`聚焦${label}`}");
        expect(viewport).toContain("focusOnPoint: (point: DirectorVec3, radius: number) => boolean");
        expect(viewport).toContain("controls.target.fromArray(frame.target)");
        expect(viewport).toContain('onViewModeChange?.("free")');
    });
});

describe("导演节点参考图入口", () => {
    test("加号走图片专用上传，并把上传结果连到对应导演镜头", () => {
        expect(project).toContain("onAddReference={() => handleUploadReferenceRequest(contentNode.id");
        expect(uploadHook).toContain('imageInputRef.current.accept = "image/*";');
        expect(uploadHook).toContain("uploadNodeType(file) === CanvasNodeType.Image");
        expect(uploadHook).toContain("connectDirectorReferenceNodes(nodesRef.current, connectionsRef.current, createdIds, uploadTarget.referenceToNodeId");
        expect(uploadHook).toContain("setConnections(linked.connections)");
        expect(project).toContain("references={mentionReferencesByNodeId.get(contentNode.id) || EMPTY_RESOURCE_REFERENCES}");
        expect(project).toContain("onRemoveReference={(reference) => handleRemoveNodeReference(contentNode.id, reference)}");
    });
});

describe("模式接线", () => {
    test("workbench 从 store 读 mode，并按 capabilities 派生显示", () => {
        expect(workbench).toContain("const mode = useDirectorWorkbenchStore((state) => state.mode);");
        expect(workbench).toContain("const capabilities = directorModeCapabilities(mode);");
    });

    test("动画模式把 Transform 轨迹接入视口，隐藏演员和零长度轨迹不显示", () => {
        expect(workbench).toContain("showMotionPaths={workspaceView === \"scene\" && sequencerVisible}");
        expect(viewport).toContain('object.visible && (object.kind === "actor" || object.primitive === "character")');
        expect(viewport).toContain("directorTransformPathLength(object.keyframes) > 0.001");
        expect(viewport).toContain("<Line points={points}");
        expect(viewport).toContain("interpolateDirectorTransform(sorted[0].transform, sorted, playhead).position");
    });

    test("骨骼/姿势入口只对演员开放，且由 bones 把关", () => {
        const inspector = slice(workbench, "function ObjectInspector(", "function LightInspector(");
        expect(inspector).toContain("isActor && capabilities.bones ? <>");
        expect(inspector).toContain('role="tablist" aria-label="角色属性"');
        // motionClips 不得再作为放行条件：带动画的普通模型不是演员。
        expect(workbench).not.toContain('object.primitive === "character" || motionClips.length) ? <>');
    });

    test("姿态模式提供全身与逐骨骼重置，不删除动画轨道", () => {
        const inspector = slice(workbench, "function ObjectInspector(", "function LightInspector(");
        expect(inspector).toContain('onClick={() => applyPose("stand")}>重置姿态</Button>');
        expect(inspector).toContain("delete boneOverrides[bone]");
        expect(inspector).toContain('aria-label={`重置骨骼 ${directorBoneLabel(bone)}`}');
        expect(inspector).not.toContain("boneTracks: []");
    });

    test("动作片段与骨骼入口解耦：任何带 Clip 的对象都能调播放速度/循环", () => {
        expect(workbench).toContain('{motionClips.length ? <><Field label="动作片段">');
        const inspector = slice(workbench, "function ObjectInspector(", "function LightInspector(");
        expect(inspector).toContain('aria-label="动作开始时间"');
        expect(inspector).toContain("snapDirectorTime(value ?? 0, fps)");
        expect(workbench).toContain("fps={activeShot?.fps || 24} shotDuration={activeShot?.duration || 15}");
    });

    test("关键帧入口由 keyframes 把关", () => {
        expect(workbench).toContain("{capabilities.keyframes ? <>");
    });

    test("渲染视图下拉按当前模式过滤，而不是写死五项", () => {
        expect(dock).toContain("renderModes: DirectorRenderMode[];");
        expect(dock).toContain("RENDER_VIEW_BUTTONS.filter((item) => renderModes.includes(item.mode))");
        expect(workbench).toContain("renderModes={capabilities.renderModes}");
    });

    test("dock 不是绕过模式门控的第二条路径：渲染视图按钮同样按 renderModes 过滤", () => {
        expect(dock).toContain("renderModes: DirectorRenderMode[];");
        expect(dock).toContain("RENDER_VIEW_BUTTONS.filter((item) => renderModes.includes(item.mode))");
        // 写死的按钮会绕过门控。
        expect(dock).not.toContain('onClick={() => onRenderModeChange("pose")}');
        expect(workbench).toContain("renderModes={capabilities.renderModes}");
    });

    test("store 层夹住 renderMode：任何路径都无法设置当前模式不允许的视图", () => {
        expect(store).toContain("setRenderMode: (renderMode) => set((state) => (directorModeCapabilities(state.mode).renderModes.includes(renderMode) ? { renderMode } : {})),");
    });

    test("摄影机模式固定显示 shot/camera 检查器", () => {
        expect(workbench).toContain("selectedObject && !capabilities.cameraTools ?");
        expect(workbench).toContain("selectedLight && !capabilities.cameraTools ?");
    });

    test("运镜生成只更新首尾帧并提示到动画模式继续编辑，不清空手工关键帧", () => {
        expect(workbench).toContain("resolveDirectorCameraMoveKeyframes(item.keyframes");
        expect(workbench).toContain("已更新运镜首尾关键帧，可在动画模式继续编辑");
        expect(workbench).not.toContain("keyframes: [{ id: nanoid(), time: 0, transform: start }");
    });

    test("小屏把属性检查器放到下方而不是隐藏，姿态与骨骼入口仍可达", () => {
        expect(workbench).toContain("max-lg:col-span-2 max-lg:max-h-[40vh] max-lg:border-l-0 max-lg:border-t");
        expect(workbench).not.toContain("border-l max-lg:hidden");
    });

    test("store 切离动画模式时停止播放、关闭 Auto Key，并夹回允许的渲染视图", () => {
        const directorStore = useDirectorWorkbenchStore;
        directorStore.getState().reset();
        directorStore.getState().setMode("animate");
        directorStore.getState().setRenderMode("pose");
        directorStore.getState().setPlaying(true);
        directorStore.getState().setAutoKey(true);
        directorStore.getState().setMode("layout");
        expect(directorStore.getState().playing).toBe(false);
        expect(directorStore.getState().autoKey).toBe(false);
        expect(directorStore.getState().renderMode).toBe("beauty");
        directorStore.getState().reset();
    });

    test("mode 不写进 DirectorScene：类型文件里没有 mode 字段", () => {
        const types = readFileSync(resolve(import.meta.dir, "../src/types/director.ts"), "utf8");
        const sceneType = slice(types, "export type DirectorScene = {", "};");
        expect(sceneType).not.toContain("mode");
    });

    test("切模式不重建会话：初始化 effect 的依赖里没有 mode", () => {
        const initEffect = slice(workbench, "// 会话初始化只认 scene id", "// 打开会话时检查合法本地恢复候选");
        // 依赖里出现 mode 就意味着换视图会 resetWorkbench + 清空 history。
        expect(initEffect).toContain("}, [open, resetWorkbench, scene, writeDraft]);");
        expect(initEffect).not.toContain("mode");
    });

    test("draft/history/save 的生命周期 effect 一律不依赖 mode", () => {
        // 逐个锁住依赖数组：任一处混入 mode，切模式就会掉草稿或掉历史。
        expect(workbench).toContain("}, [message, modal, open, scene, writeDraft]);");
        expect(workbench).toContain("}, [mirrorDraft, stagedTransaction]);");
        expect(workbench).toContain("}, [mirrorDraft]);");
        // 弹窗开关需暂停快捷键；mode 切换仍不得反复重挂监听器。
        expect(workbench).toContain("}, [open, panoramaAIOpen, panoramaHistoryOpen]);");
    });
});

describe("异步导演台输出使用最新权威状态", () => {
    test("上传后重新核验节点与场景，并把预览引用合入最新 scene", () => {
        expect(hook).toContain("const sourceNodeAtStart = nodesRef.current.find");
        expect(hook).toContain("const outputProjectId = projectId;");
        expect(hook).toContain("projectIdRef.current !== outputProjectId");
        expect(hook).toContain("const outputProject = useCanvasStore.getState().projects.find((item) => item.id === outputProjectId);");
        expect(hook).toContain("const sourceNode = nodesRef.current.find((item) => item.id === sourceNodeId);");
        expect(hook).toContain("const latestScene = outputProject?.directorScenes.find");
        expect(hook).toContain("mergeDirectorOutputPreview(latestScene");
        expect(hook).toContain("saveDirectorScene(mergedScene);");
        expect(hook).not.toContain("saveDirectorScene({ ...output.scene");
    });
});

describe("编辑模式迁移到导演工具菜单", () => {
    test("所有模式入口保留可见名称、快捷提示并正确调用模式切换", () => {
        const modeMenu = slice(dock, 'key: "director-mode"', 'key: "workspace-view"');
        expect(modeMenu).toContain("DIRECTOR_MODES.map");
        expect(modeMenu).toContain("title: item.hint");
        expect(modeMenu).toContain("onModeChange(item.mode)");
        expect(modeMenu).toContain("releaseMenuFocus(domEvent.detail)");
    });

    test("菜单保持当前模式与工作区的选中态", () => {
        expect(dock).toContain("`director-mode-${mode}`");
        expect(dock).toContain("`workspace-${workspaceView}`");
    });

    test("模式样式继续使用主题感知语义 token，不新增硬编码颜色", () => {
        const block = slice(styles, "/* 一级模式切换。", ".director-actor-colors {");
        expect(block).toContain("var(--control-selected-bg)");
        expect(block).toContain("var(--control-focus-ring)");
        expect(block).not.toMatch(/rgba?\(/);
        expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    });
});

describe("LibTV 导演台紧凑顶栏入口迁移", () => {
    test("顶栏不再占用独立编辑模式或场景/预演切换条", () => {
        expect(workbench).not.toContain('<nav className="director-mode-switch" aria-label="导演台模式">');
        expect(workbench).not.toContain('aria-label="导演台工作区视图"');
    });

    test("底部更多工具菜单保留模式、工作区、历史与工作台功能；对象添加统一从场景面板进入", () => {
        expect(dock).toContain('label: "导演台模式"');
        expect(dock).toContain('key: "director-navigation", label: "导演台导航"');
        expect(dock).toContain("DIRECTOR_MODES.map");
        expect(dock).toContain('label: "工作区视图"');
        expect(dock).toContain('label: "场景调度"');
        expect(dock).toContain('label: "成片预演"');
        expect(dock).toContain("onModeChange(item.mode)");
        expect(dock).toContain('onWorkspaceViewChange("scene")');
        expect(dock).toContain('onWorkspaceViewChange("preview")');
        expect(dock).toContain('key: "export-clay"');
        expect(dock).toContain('key: "apply-to-canvas"');
        expect(dock).not.toContain('key: "add-actor"');
        expect(dock).not.toContain('key: "add-box"');
        expect(dock).not.toContain('aria-label="导演台导航" aria-haspopup="menu"');
        expect(workbench).toContain('AddMenuButton label="添加场景对象" items={addObjectMenuItems}');
    });

    test("左 rail 的场景、角色、机位入口同时切换到匹配的编辑能力", () => {
        const railHandler = slice(workbench, "onChange={(tab) => {", "}} />");
        expect(railHandler).toContain('if (tab === "scene") setMode("layout")');
        expect(railHandler).toContain('else if (tab === "actors") setMode("pose")');
        expect(railHandler).toContain('else if (tab === "cameras") setMode("camera")');
    });
});
