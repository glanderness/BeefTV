import { describe, expect, test } from "bun:test";

import { rebaseCanvasDocumentThreeWay } from "../src/lib/canvas/canvas-document-rebase";
import { interruptFileUpload } from "../src/lib/canvas/canvas-file-upload";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, title: string, metadata: CanvasNodeData["metadata"] = {}, position = { x: 0, y: 0 }): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title, position, width: 320, height: 220, metadata };
}

function project(nodes: CanvasNodeData[], revision: number, title = "画布"): CanvasProject {
    return {
        id: "c1",
        revision,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes,
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "grid",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

describe("rebaseCanvasDocumentThreeWay upload settlement", () => {
    test("completed upload is not rolled back to uploading when store or remote snapshot holds an earlier placeholder", () => {
        const remoteUploadingImg = node("upload-img-1", "ref.png", {
            fileUpload: "uploading",
            fileUploadProgress: 60,
            bytes: 2048,
            mimeType: "image/png",
        });
        const localCompletedImg = node("upload-img-1", "ref.png", {
            content: "https://example.test/ref.png",
            storageKey: "resource:ref-1",
            status: "success",
            bytes: 2048,
            mimeType: "image/png",
        });
        const remoteUploadingVid: CanvasNodeData = {
            id: "upload-vid-1",
            type: CanvasNodeType.Video,
            title: "clip.mp4",
            position: { x: 100, y: 100 },
            width: 720,
            height: 405,
            metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
        };
        const localCompletedVid: CanvasNodeData = {
            ...remoteUploadingVid,
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/clip.mp4",
                storageKey: "resource:clip-1",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
                bytes: 9000,
                mimeType: "video/mp4",
            },
        };
        const runningVideo = node("gen-v1", "生成视频", {
            taskId: "task-v1",
            status: "loading",
            taskStatus: "running",
            taskStage: "正在查询视频生成结果",
        });

        const fromEmptyBase = rebaseCanvasDocumentThreeWay({
            base: project([runningVideo], 10),
            local: project([runningVideo, localCompletedImg, localCompletedVid], 10),
            remote: project([runningVideo, remoteUploadingImg, remoteUploadingVid], 11),
        });
        expect(fromEmptyBase.conflict).toBe(false);
        const mergedImg = fromEmptyBase.project.nodes.find((item) => item.id === "upload-img-1");
        expect(mergedImg?.metadata?.fileUpload).toBeUndefined();
        expect(mergedImg?.metadata?.fileUploadProgress).toBeUndefined();
        expect(mergedImg?.metadata?.status).toBe("success");
        expect(mergedImg?.metadata?.content).toBe("https://example.test/ref.png");
        const mergedVid = fromEmptyBase.project.nodes.find((item) => item.id === "upload-vid-1");
        expect(mergedVid?.width).toBe(420);
        expect(mergedVid?.height).toBe(746);
        expect(mergedVid?.position).toEqual({ x: 250, y: -70.5 });
        expect(mergedVid?.metadata?.fileUpload).toBeUndefined();
        expect(mergedVid?.metadata?.status).toBe("success");

        const fromUploadingBase = rebaseCanvasDocumentThreeWay({
            base: project([{ ...remoteUploadingImg, metadata: { ...remoteUploadingImg.metadata, fileUploadProgress: 20 } }], 10),
            local: project([localCompletedImg], 10),
            remote: project([{ ...remoteUploadingImg, metadata: { ...remoteUploadingImg.metadata, fileUploadProgress: 85 } }], 11),
        });
        expect(fromUploadingBase.conflict).toBe(false);
        expect(fromUploadingBase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(fromUploadingBase.project.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();
        expect(fromUploadingBase.project.nodes[0]?.metadata?.status).toBe("success");
    });

    test("remote upload completion settles local placeholder while active replacement uploads stay uploading", () => {
        const baseUploading = node("up-remote", "remote.png", { fileUpload: "uploading", fileUploadProgress: 10 }, { x: 10, y: 20 });
        const localDraggedUploading = { ...baseUploading, position: { x: 120, y: 240 }, metadata: { fileUpload: "uploading" as const, fileUploadProgress: 40 } };
        const remoteSettled = node("up-remote", "remote.png", {
            content: "https://example.test/remote.png",
            storageKey: "resource:remote",
            status: "success",
        }, { x: 10, y: 20 });

        const remoteFinished = rebaseCanvasDocumentThreeWay({
            base: project([baseUploading], 10),
            local: project([localDraggedUploading], 10),
            remote: project([remoteSettled], 11),
        });
        expect(remoteFinished.conflict).toBe(false);
        expect(remoteFinished.project.nodes[0]?.position).toEqual({ x: 120, y: 240 });
        expect(remoteFinished.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(remoteFinished.project.nodes[0]?.metadata?.content).toBe("https://example.test/remote.png");

        const existingImage = node("replace-1", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localReplacingSame = node("replace-1", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 35,
        });
        const replacingSameRebase = rebaseCanvasDocumentThreeWay({
            base: project([existingImage], 10),
            local: project([localReplacingSame], 10),
            remote: project([existingImage, node("other", "新增文本", { content: "hi" })], 11),
        });
        expect(replacingSameRebase.conflict).toBe(false);
        expect(replacingSameRebase.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(replacingSameRebase.project.nodes[0]?.metadata?.fileUploadProgress).toBe(35);
        expect(replacingSameRebase.project.nodes[0]?.metadata?.status).toBeUndefined();
    });

    test("uploading placeholder carrying media distinct from settled base is preserved in both directions and conflicts when both sides diverge", () => {
        const baseSettledB = node("rep-distinct", "shot.png", {
            content: "https://example.test/b.png",
            storageKey: "resource:b",
            status: "success",
        });
        const uploadingC = node("rep-distinct", "shot.png", {
            content: "https://example.test/c.png",
            storageKey: "resource:c",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 42,
        });
        const settledD = node("rep-distinct", "shot.png", {
            content: "https://example.test/d.png",
            storageKey: "resource:d",
            status: "success",
        });

        const remoteUploadingC = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([baseSettledB], 10),
            remote: project([uploadingC], 11),
        });
        expect(remoteUploadingC.conflict).toBe(false);
        expect(remoteUploadingC.project.nodes[0]?.metadata?.content).toBe("https://example.test/c.png");
        expect(remoteUploadingC.project.nodes[0]?.metadata?.storageKey).toBe("resource:c");
        expect(remoteUploadingC.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(remoteUploadingC.project.nodes[0]?.metadata?.fileUploadProgress).toBe(42);
        expect(remoteUploadingC.project.nodes[0]?.metadata?.status).toBeUndefined();

        const localUploadingC = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([uploadingC], 10),
            remote: project([baseSettledB], 11),
        });
        expect(localUploadingC.conflict).toBe(false);
        expect(localUploadingC.project.nodes[0]?.metadata?.content).toBe("https://example.test/c.png");
        expect(localUploadingC.project.nodes[0]?.metadata?.storageKey).toBe("resource:c");
        expect(localUploadingC.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(localUploadingC.project.nodes[0]?.metadata?.fileUploadProgress).toBe(42);
        expect(localUploadingC.project.nodes[0]?.metadata?.status).toBeUndefined();

        const bothDivergedLocalSettled = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([settledD], 10),
            remote: project([{ ...uploadingC, width: 720, height: 405 }], 11),
        });
        expect(bothDivergedLocalSettled.conflict).toBe(true);
        expect(bothDivergedLocalSettled.project.nodes[0]?.width).toBe(320);
        expect(bothDivergedLocalSettled.project.nodes[0]?.height).toBe(220);
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.content).toBe("https://example.test/d.png");
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.storageKey).toBe("resource:d");
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.status).toBe("success");
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(bothDivergedLocalSettled.project.nodes[0]?.metadata?.fileUploadProgress).toBeUndefined();

        const bothDivergedLocalUploading = rebaseCanvasDocumentThreeWay({
            base: project([baseSettledB], 10),
            local: project([uploadingC], 10),
            remote: project([settledD], 11),
        });
        expect(bothDivergedLocalUploading.conflict).toBe(true);
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.content).toBe("https://example.test/c.png");
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.storageKey).toBe("resource:c");
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.status).toBeUndefined();
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(bothDivergedLocalUploading.project.nodes[0]?.metadata?.fileUploadProgress).toBe(42);
    });

    test("stale uploading flag on a distinct settled remote media preserves true conflict instead of treating remote as placeholder", () => {
        const baseNode = node("n-conflict", "img.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localNode = node("n-conflict", "img.png", {
            content: "https://example.test/local-new.png",
            storageKey: "resource:local-new",
            status: "success",
        });
        const remoteCorruptedDifferent = node("n-conflict", "img.png", {
            content: "https://example.test/remote-new.png",
            storageKey: "resource:remote-new",
            status: "success",
            fileUpload: "uploading",
            fileUploadProgress: 100,
        });

        const differentResult = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([localNode], 10),
            remote: project([remoteCorruptedDifferent], 11),
        });
        expect(differentResult.conflict).toBe(true);
        expect(differentResult.project.nodes[0]?.metadata?.content).toBe("https://example.test/local-new.png");
        expect(differentResult.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();

        const remoteCorruptedSame = node("n-conflict", "img.png", {
            content: "https://example.test/local-new.png",
            storageKey: "resource:local-new",
            status: "success",
            fileUpload: "uploading",
            fileUploadProgress: 100,
        });
        const sameResult = rebaseCanvasDocumentThreeWay({
            base: project([baseNode], 10),
            local: project([localNode], 10),
            remote: project([remoteCorruptedSame], 11),
        });
        expect(sameResult.conflict).toBe(false);
        expect(sameResult.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
    });

    test("upload settlement preserves concurrent non-upload edits, manual resize, and dragged video position in both directions", () => {
        const baseVid: CanvasNodeData = {
            id: "vid-edit",
            type: CanvasNodeType.Video,
            title: "clip.mp4",
            position: { x: 100, y: 100 },
            width: 720,
            height: 405,
            metadata: { fileUpload: "uploading", fileUploadProgress: 15, bytes: 9000, mimeType: "video/mp4" },
        };
        const settledVidAutoCentered: CanvasNodeData = {
            ...baseVid,
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/clip.mp4",
                storageKey: "resource:clip",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
                bytes: 9000,
                mimeType: "video/mp4",
            },
        };
        const uploadingEditedAndDragged: CanvasNodeData = {
            ...baseVid,
            title: "主角特写",
            position: { x: 400, y: 300 },
            metadata: {
                ...baseVid.metadata,
                fileUploadProgress: 50,
                prompt: "慢镜头备注",
                locked: true,
            },
        };

        const localUploadingRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseVid], 10),
            local: project([uploadingEditedAndDragged], 10),
            remote: project([settledVidAutoCentered], 11),
        });
        expect(localUploadingRebase.conflict).toBe(false);
        const mergedLocal = localUploadingRebase.project.nodes[0]!;
        expect(mergedLocal.title).toBe("主角特写");
        expect(mergedLocal.width).toBe(420);
        expect(mergedLocal.height).toBe(746);
        expect(mergedLocal.position).toEqual({ x: 550, y: 129.5 });
        expect(mergedLocal.metadata?.fileUpload).toBeUndefined();
        expect(mergedLocal.metadata?.status).toBe("success");
        expect(mergedLocal.metadata?.prompt).toBe("慢镜头备注");
        expect(mergedLocal.metadata?.locked).toBe(true);

        const remoteUploadingRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseVid], 10),
            local: project([settledVidAutoCentered], 10),
            remote: project([uploadingEditedAndDragged], 11),
        });
        expect(remoteUploadingRebase.conflict).toBe(false);
        const mergedRemote = remoteUploadingRebase.project.nodes[0]!;
        expect(mergedRemote.title).toBe("主角特写");
        expect(mergedRemote.width).toBe(420);
        expect(mergedRemote.height).toBe(746);
        expect(mergedRemote.position).toEqual({ x: 550, y: 129.5 });
        expect(mergedRemote.metadata?.fileUpload).toBeUndefined();
        expect(mergedRemote.metadata?.prompt).toBe("慢镜头备注");
        expect(mergedRemote.metadata?.locked).toBe(true);

        const baseImgUploading = node("img-resize", "pic.png", { fileUpload: "uploading" }, { x: 100, y: 100 });
        const resizedImgUploading = {
            ...baseImgUploading,
            width: 500,
            height: 344,
            position: { x: 80, y: 80 },
            metadata: { ...baseImgUploading.metadata, manualSize: true },
        };
        const settledImg = node("img-resize", "pic.png", {
            content: "https://example.test/pic.png",
            storageKey: "resource:pic",
            status: "success",
        }, { x: 100, y: 100 });
        const resizedRebase = rebaseCanvasDocumentThreeWay({
            base: project([baseImgUploading], 10),
            local: project([resizedImgUploading], 10),
            remote: project([settledImg], 11),
        });
        expect(resizedRebase.conflict).toBe(false);
        expect(resizedRebase.project.nodes[0]?.width).toBe(500);
        expect(resizedRebase.project.nodes[0]?.height).toBe(344);
        expect(resizedRebase.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(resizedRebase.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(resizedRebase.project.nodes[0]?.metadata?.status).toBe("success");

        // 手动尺寸已先被自动保存进 base，uploading 与 base 同为 500x344+manualSize=true 时仍不被完成侧 320x220 覆盖
        const autosavedResizedRebase = rebaseCanvasDocumentThreeWay({
            base: project([resizedImgUploading], 10),
            local: project([resizedImgUploading], 10),
            remote: project([settledImg], 11),
        });
        expect(autosavedResizedRebase.conflict).toBe(false);
        expect(autosavedResizedRebase.project.nodes[0]?.width).toBe(500);
        expect(autosavedResizedRebase.project.nodes[0]?.height).toBe(344);
        expect(autosavedResizedRebase.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(autosavedResizedRebase.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(autosavedResizedRebase.project.nodes[0]?.metadata?.status).toBe("success");

        const autosavedResizedReverse = rebaseCanvasDocumentThreeWay({
            base: project([resizedImgUploading], 10),
            local: project([settledImg], 10),
            remote: project([resizedImgUploading], 11),
        });
        expect(autosavedResizedReverse.conflict).toBe(false);
        expect(autosavedResizedReverse.project.nodes[0]?.width).toBe(500);
        expect(autosavedResizedReverse.project.nodes[0]?.height).toBe(344);
        expect(autosavedResizedReverse.project.nodes[0]?.position).toEqual({ x: 80, y: 80 });
        expect(autosavedResizedReverse.project.nodes[0]?.metadata?.manualSize).toBe(true);
        expect(autosavedResizedReverse.project.nodes[0]?.metadata?.status).toBe("success");
    });

    test("concurrent uploading placeholders with different fileUploadProgress do not trigger false rebase conflict", () => {
        const baseSettled = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: "success",
        });
        const localUploading = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 35,
        });
        const remoteUploading = node("up-prog", "old.png", {
            content: "https://example.test/old.png",
            storageKey: "resource:old",
            status: undefined,
            fileUpload: "uploading",
            fileUploadProgress: 60,
        });

        const rebased = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([localUploading], 10),
            remote: project([remoteUploading], 11),
        });
        expect(rebased.conflict).toBe(false);
        expect(rebased.project.nodes[0]?.metadata?.fileUpload).toBe("uploading");
        expect(rebased.project.nodes[0]?.metadata?.fileUploadProgress).toBe(35);
    });

    test("settled base is not wiped or rolled back when the other snapshot still holds a bare initial-upload placeholder", () => {
        const baseCompleted = node("done-1", "角色定稿", {
            content: "https://example.test/done.png",
            storageKey: "resource:done",
            status: "success",
            prompt: "服装细节说明",
            locked: true,
        }, { x: 360, y: 180 });
        const staleBarePlaceholder = node("done-1", "raw_upload.png", {
            fileUpload: "uploading",
            fileUploadProgress: 45,
            bytes: 4096,
            mimeType: "image/png",
        }, { x: 100, y: 100 });
        const settledWithFollowupEdit = {
            ...baseCompleted,
            title: "角色定稿 v2",
            metadata: { ...baseCompleted.metadata, prompt: "服装与光影说明" },
        };

        const remoteStale = rebaseCanvasDocumentThreeWay({
            base: project([baseCompleted], 10),
            local: project([settledWithFollowupEdit], 10),
            remote: project([staleBarePlaceholder], 11),
        });
        expect(remoteStale.conflict).toBe(false);
        expect(remoteStale.project.nodes[0]?.title).toBe("角色定稿 v2");
        expect(remoteStale.project.nodes[0]?.position).toEqual({ x: 360, y: 180 });
        expect(remoteStale.project.nodes[0]?.metadata?.content).toBe("https://example.test/done.png");
        expect(remoteStale.project.nodes[0]?.metadata?.storageKey).toBe("resource:done");
        expect(remoteStale.project.nodes[0]?.metadata?.status).toBe("success");
        expect(remoteStale.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(remoteStale.project.nodes[0]?.metadata?.prompt).toBe("服装与光影说明");
        expect(remoteStale.project.nodes[0]?.metadata?.locked).toBe(true);

        const localStale = rebaseCanvasDocumentThreeWay({
            base: project([baseCompleted], 10),
            local: project([staleBarePlaceholder], 10),
            remote: project([settledWithFollowupEdit], 11),
        });
        expect(localStale.conflict).toBe(false);
        expect(localStale.project.nodes[0]?.title).toBe("角色定稿 v2");
        expect(localStale.project.nodes[0]?.position).toEqual({ x: 360, y: 180 });
        expect(localStale.project.nodes[0]?.metadata?.content).toBe("https://example.test/done.png");
        expect(localStale.project.nodes[0]?.metadata?.storageKey).toBe("resource:done");
        expect(localStale.project.nodes[0]?.metadata?.status).toBe("success");
        expect(localStale.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
        expect(localStale.project.nodes[0]?.metadata?.prompt).toBe("服装与光影说明");
        expect(localStale.project.nodes[0]?.metadata?.locked).toBe(true);
    });

    test("portrait video replacement settles cleanly and missing-base divergent title/position keeps local while marking conflict", () => {
        const basePortraitVid: CanvasNodeData = {
            id: "vid-replace",
            type: CanvasNodeType.Video,
            title: "镜头一",
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/old.mp4",
                storageKey: "resource:old-vid",
                status: "success",
                taskId: "task-old",
                prompt: "人物转身",
                locked: true,
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };
        const replacingVidPlaceholder: CanvasNodeData = {
            ...basePortraitVid,
            width: 720,
            height: 405,
            metadata: {
                content: "https://example.test/old.mp4",
                storageKey: "resource:old-vid",
                status: undefined,
                fileUpload: "uploading",
                fileUploadProgress: 70,
            },
        };
        const settledReplacementVid: CanvasNodeData = {
            ...basePortraitVid,
            position: { x: 400, y: -241 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/new.mp4",
                storageKey: "resource:new-vid",
                status: "success",
                prompt: "人物转身",
                locked: true,
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };

        const replacedOverRemotePlaceholder = rebaseCanvasDocumentThreeWay({
            base: project([basePortraitVid], 10),
            local: project([settledReplacementVid], 10),
            remote: project([replacingVidPlaceholder], 11),
        });
        expect(replacedOverRemotePlaceholder.conflict).toBe(false);
        const mergedVid = replacedOverRemotePlaceholder.project.nodes[0]!;
        expect(mergedVid.width).toBe(420);
        expect(mergedVid.height).toBe(746);
        expect(mergedVid.position).toEqual({ x: 400, y: -241 });
        expect(mergedVid.metadata?.content).toBe("https://example.test/new.mp4");
        expect(mergedVid.metadata?.status).toBe("success");
        expect(mergedVid.metadata?.fileUpload).toBeUndefined();
        expect(mergedVid.metadata?.taskId).toBeUndefined();
        expect(mergedVid.metadata?.prompt).toBe("人物转身");
        expect(mergedVid.metadata?.locked).toBe(true);

        const replacedOverAncientBarePlaceholder = rebaseCanvasDocumentThreeWay({
            base: project([basePortraitVid], 10),
            local: project([settledReplacementVid], 10),
            remote: project([{
                id: "vid-replace",
                type: CanvasNodeType.Video,
                title: "raw.mp4",
                position: { x: 0, y: 0 },
                width: 720,
                height: 405,
                metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
            }], 11),
        });
        expect(replacedOverAncientBarePlaceholder.conflict).toBe(false);
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.position).toEqual({ x: 400, y: -241 });
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.title).toBe("镜头一");
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.metadata?.prompt).toBe("人物转身");
        expect(replacedOverAncientBarePlaceholder.project.nodes[0]?.metadata?.locked).toBe(true);

        // 无 base 剧本导入默认去扩展名标题对齐，不产生假冲突
        const scriptUploading: CanvasNodeData = {
            id: "script-1",
            type: CanvasNodeType.Text,
            title: "ep1.txt",
            position: { x: 50, y: 60 },
            width: 360,
            height: 240,
            metadata: { fileUpload: "uploading" },
        };
        const scriptSettled: CanvasNodeData = {
            ...scriptUploading,
            title: "ep1",
            metadata: { content: "第一集正文", prompt: "第一集正文", storageKey: "resource:ep1", status: "success" },
        };
        const scriptRebased = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([scriptUploading], 10),
            remote: project([scriptSettled], 11),
        });
        expect(scriptRebased.conflict).toBe(false);
        expect(scriptRebased.project.nodes[0]?.title).toBe("ep1");
        expect(scriptRebased.project.nodes[0]?.metadata?.status).toBe("success");

        // 无 base 远端 uploading 已改名/拖拽 vs 本地 settled 原始文件名/位置：不静默覆盖远端修改，标记 conflict
        const localRawSettled = node("new-remote-edit", "raw_123.png", {
            content: "https://example.test/hero.png",
            storageKey: "resource:hero",
            status: "success",
        }, { x: 100, y: 100 });
        const remoteRenamedDraggedUploading = node("new-remote-edit", "主角设定", {
            fileUpload: "uploading",
            fileUploadProgress: 50,
        }, { x: 300, y: 300 });
        const remoteEditedMissingBase = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([localRawSettled], 10),
            remote: project([remoteRenamedDraggedUploading], 11),
        });
        expect(remoteEditedMissingBase.conflict).toBe(true);
        expect(remoteEditedMissingBase.project.nodes[0]?.title).toBe("raw_123.png");
        expect(remoteEditedMissingBase.project.nodes[0]?.position).toEqual({ x: 100, y: 100 });
        expect(remoteEditedMissingBase.project.nodes[0]?.metadata?.status).toBe("success");
        expect(remoteEditedMissingBase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();

        // 无 base 本地 uploading 改成带扩展名标题 Final.mp4 并拖拽 vs 远端 settled raw.mp4：保留本地 Final.mp4 与拖拽中心并标记 conflict
        const localUploadingWithExt: CanvasNodeData = {
            id: "new-local-ext",
            type: CanvasNodeType.Video,
            title: "Final.mp4",
            position: { x: 400, y: 300 },
            width: 720,
            height: 405,
            metadata: { fileUpload: "uploading", bytes: 9000, mimeType: "video/mp4" },
        };
        const remoteSettledRawVid: CanvasNodeData = {
            id: "new-local-ext",
            type: CanvasNodeType.Video,
            title: "raw.mp4",
            position: { x: 250, y: -70.5 },
            width: 420,
            height: 746,
            metadata: {
                content: "https://example.test/raw.mp4",
                storageKey: "resource:raw-vid",
                status: "success",
                naturalWidth: 1080,
                naturalHeight: 1920,
            },
        };
        const localExtMissingBase = rebaseCanvasDocumentThreeWay({
            base: project([], 10),
            local: project([localUploadingWithExt], 10),
            remote: project([remoteSettledRawVid], 11),
        });
        expect(localExtMissingBase.conflict).toBe(true);
        expect(localExtMissingBase.project.nodes[0]?.title).toBe("Final.mp4");
        expect(localExtMissingBase.project.nodes[0]?.width).toBe(420);
        expect(localExtMissingBase.project.nodes[0]?.height).toBe(746);
        expect(localExtMissingBase.project.nodes[0]?.position).toEqual({ x: 550, y: 129.5 });
        expect(localExtMissingBase.project.nodes[0]?.metadata?.status).toBe("success");
        expect(localExtMissingBase.project.nodes[0]?.metadata?.fileUpload).toBeUndefined();
    });

    test("deleting a settled upload node does not false-conflict against stale fileUpload flags", () => {
        const baseSettled = node("del-1", "img.png", {
            content: "https://example.test/img.png",
            storageKey: "resource:img",
            status: "success",
        });
        const staleUploading = {
            ...baseSettled,
            metadata: { ...baseSettled.metadata, fileUpload: "uploading" as const, fileUploadProgress: 100 },
        };
        const interruptedSample = interruptFileUpload(node("del-1", "img.png", { fileUpload: "uploading" }));
        const staleInterrupted = {
            ...baseSettled,
            metadata: {
                ...baseSettled.metadata,
                fileUpload: interruptedSample.metadata?.fileUpload,
                errorDetails: interruptedSample.metadata?.errorDetails,
            },
        };

        const localDeleteAgainstUploading = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([], 10),
            remote: project([staleUploading], 11),
        });
        expect(localDeleteAgainstUploading.conflict).toBe(false);
        expect(localDeleteAgainstUploading.project.nodes).toHaveLength(0);

        const remoteDeleteAgainstInterrupted = rebaseCanvasDocumentThreeWay({
            base: project([baseSettled], 10),
            local: project([staleInterrupted], 10),
            remote: project([], 11),
        });
        expect(remoteDeleteAgainstInterrupted.conflict).toBe(false);
        expect(remoteDeleteAgainstInterrupted.project.nodes).toHaveLength(0);
    });
});
