import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright";

let browser: Browser, server: ReturnType<typeof Bun.serve>;
let scratch: string;
const resources = new Map<string, { bytes: Buffer; kind: string; mimeType: string }>();
const chats: Record<string, any>[] = [], supplements: Record<string, any>[] = [];
const externalConnections: Record<string, any>[] = [];
const undoRequests: Record<string, any>[] = [];
const sessionConfigRequests: Record<string, any>[] = [];
const compactRequests: Record<string, any>[] = [];
let serverSessionId = "s1";
let serverThinkingLevel: string | undefined = "low";
let serverContextUsage: Record<string, any> | null = null;
let rejectNextSessionConfig = false;
let rejectNextUndo = false;
let running = false, cancelled = false, nextId = 0, failNextAsset = false;
let activePermissionMode: string | undefined;
let statusPayload: Record<string, any> = { available: true };
let statusCalls = 0, historyCalls = 0;
let holdHistory: (() => Promise<void>) | null = null;
let pausedTurnReason: string | undefined;
let failHistoryStatus = 0;
let sessionSummaries: { sessionId: string; title: string; updatedAt: string; turnCount: number }[] = [];
const uploadKeys: string[] = [];
const uploadMetadata: { name: string; width: string | null; height: string | null; durationMs: string | null }[] = [];
const registeredAssets: Record<string, any>[] = [];
const turns: Record<string, any>[] = [];
let png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=", "base64");
let wav: Buffer, longWav: Buffer, video: Buffer, jpeg: Buffer;
const mediaRequests: { path: string; token: string | null }[] = [];
let holdFirstPreview = true, releaseFirstPreview: (() => void) | null = null;
let markFirstPreviewStarted!: () => void;
const firstPreviewStarted = new Promise<void>(resolve => { markFirstPreviewStarted = resolve; });
const selectedSkill = { skillId: "story", versionId: "story-v1", contentHash: "a".repeat(64), skillName: "分镜", version: "1.0", status: 1, isAdded: true };
let installedSkills = [selectedSkill];
const skillInstalls: { sourceType: string; isPrivate: string; fileName: string }[] = [];
beforeAll(async () => {
    scratch = mkdtempSync(tmpdir() + "/assistant-input-");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=0.25", scratch + "/beat.wav"]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=12", scratch + "/long-beat.wav"]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=64x48:r=24:d=0.25", "-c:v", "libx264", "-pix_fmt", "yuv420p", scratch + "/motion.mp4"]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=64x48", "-frames:v", "1", "-threads", "1", scratch + "/portrait.png"]);
    png = readFileSync(scratch + "/portrait.png");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=64x48", "-frames:v", "1", "-threads", "1", scratch + "/portrait.jpg"]);
    jpeg = readFileSync(scratch + "/portrait.jpg");
    wav = readFileSync(scratch + "/beat.wav"); video = readFileSync(scratch + "/motion.mp4");
    longWav = readFileSync(scratch + "/long-beat.wav");
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/assistant-input-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"',
        "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "test-source", setup(builder) {
        builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
        builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
        builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text(), css = await build.outputs.find(output => output.path.endsWith(".css"))?.text() || "";
    const ok = (data: unknown) => Response.json({ code: 0, data });
    server = Bun.serve({ port: 0, async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        if (pathname === "/harness.css") return new Response(css, { headers: { "content-type": "text/css" } });
        if (pathname === "/api/agent-clients" && req.method === "POST") {
            externalConnections.push(await req.json());
            return ok({ client: { id: "external-fixture", kind: "codex", label: "Codex", mode: "read-write" }, setup: { kind: "codex", title: "Codex", command: "beeftv connect fixture-only" } });
        }
        if (pathname === "/api/resources" && req.method === "POST") {
            uploadKeys.push(req.headers.get("X-Idempotency-Key") || "");
            const form = await req.formData(), file = form.get("file") as File, kind = String(form.get("kind"));
            uploadMetadata.push({ name: file.name, width: form.get("width") as string | null, height: form.get("height") as string | null, durationMs: form.get("durationMs") as string | null });
            const id = "r" + (++nextId); resources.set(id, { bytes: Buffer.from(await file.arrayBuffer()), kind, mimeType: file.type });
            // The real local resource service can omit dimensions/duration in a ready receipt.
            return ok({ resource: { id, status: "ready", kind, mimeType: file.type, size: file.size } });
        }
        if (pathname.startsWith("/api/resources/") && pathname.endsWith("/file")) {
            mediaRequests.push({ path: new URL(req.url).pathname + new URL(req.url).search, token: req.headers.get("X-Desktop-Token") });
            if (req.headers.get("X-Desktop-Token") !== "synthetic-desktop-preview") return Response.json({ code: 403 }, { status: 403 });
            if (holdFirstPreview && pathname.includes("/r1/")) { holdFirstPreview = false; await new Promise<void>(resolve => { releaseFirstPreview = resolve; markFirstPreviewStarted(); }); }
            const file = resources.get(pathname.split("/")[3]) || { bytes: png, mimeType: "image/png" };
            return new Response(file.bytes, { headers: { "content-type": file.mimeType } });
        }
        if (/^\/api\/resources\/[^/]+$/.test(pathname)) {
            const id = pathname.split("/")[3], file = resources.get(id);
            return ok({ resource: { id, status: "ready", provider: "local", kind: file?.kind || "video", playbackStatus: file?.kind === "video" ? "ready" : "none" } });
        }
        if (pathname.startsWith("/api/assets/") && req.method === "PUT") {
            if (failNextAsset) { failNextAsset = false; return Response.json({ code: 500, message: "素材登记失败" }, { status: 500 }); }
            const body = await req.json();
            registeredAssets.push(body.asset);
            return ok({ asset: { id: body.asset.id } });
        }
        if (pathname === "/api/assets" && req.method === "GET") {
            const assets = registeredAssets;
            return ok({ assets, page: 1, pageSize: 100, total: assets.length, hasMore: false });
        }
        if (pathname.endsWith("/skills/install")) {
            const form = await req.formData();
            skillInstalls.push({ sourceType: String(form.get("sourceType")), isPrivate: String(form.get("isPrivate")), fileName: (form.get("file") as File).name });
            const skill = { ...selectedSkill, skillId: "coffee", skillName: "咖啡审片", versionId: "coffee-v2", version: "2.0", contentHash: "b".repeat(64) };
            installedSkills = [skill];
            return ok({ skill });
        }
        if (pathname.endsWith("/skills/added")) return ok({ skills: installedSkills });
        if (pathname.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-only", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (pathname.endsWith("/assistant/status")) { statusCalls += 1; return ok(statusPayload); }
        if (pathname.endsWith("/assistant/sessions") && req.method === "GET") return ok({ currentSessionId: "s1", sessions: sessionSummaries });
        if (pathname.includes("/assistant/sessions/") && req.method === "DELETE") {
            const deletedId = decodeURIComponent(pathname.split("/").pop() || "");
            sessionSummaries = sessionSummaries.filter(item => item.sessionId !== deletedId);
            return ok({ deleted: true, sessionId: deletedId, currentSessionId: "s1" });
        }
        if (pathname.endsWith("/assistant/history")) {
            historyCalls += 1;
            if (holdHistory) await holdHistory();
            if (failHistoryStatus > 0) {
                return Response.json({ code: failHistoryStatus, reason: "host_unreachable", msg: "host unreachable" }, { status: failHistoryStatus });
            }
            return ok({
                sessionId: serverSessionId,
                turns,
                ...(serverThinkingLevel ? { thinkingLevel: serverThinkingLevel } : {}),
                ...(serverContextUsage ? { contextUsage: serverContextUsage } : {}),
                ...(pausedTurnReason ? { pausedTurnReason } : {}),
                active: running && !cancelled ? { turnId: "busy", userText: "继续创作", permissionMode: activePermissionMode, selectedNodeIds: [], attachments: [], skills: [], supplements: [], status: "running", createdAt: "2026-10-08" } : null,
            });
        }
        if (pathname.endsWith("/assistant/session-config") && req.method === "POST") {
            const body = await req.json();
            sessionConfigRequests.push(body);
            if (rejectNextSessionConfig) {
                rejectNextSessionConfig = false;
                return Response.json({ code: 503, reason: "host_unreachable" }, { status: 503 });
            }
            if (typeof body.thinkingLevel === "string") serverThinkingLevel = body.thinkingLevel;
            return ok({ sessionId: body.sessionId || serverSessionId, thinkingLevel: serverThinkingLevel, ...(serverContextUsage ? { contextUsage: serverContextUsage } : {}) });
        }
        if (pathname.endsWith("/assistant/compact") && req.method === "POST") {
            const body = await req.json();
            compactRequests.push(body);
            if (serverContextUsage) {
                serverContextUsage = { ...serverContextUsage, estimatedTokens: 16000, percent: 8 };
            }
            return ok({ sessionId: body.sessionId || serverSessionId, compacted: true, entryId: 12, thinkingLevel: serverThinkingLevel, ...(serverContextUsage ? { contextUsage: serverContextUsage } : {}) });
        }
        if (pathname.endsWith("/assistant/steer")) { supplements.push(await req.json()); return ok({ accepted: true }); }
        if (pathname.endsWith("/assistant/cancel")) { cancelled = true; running = false; return ok({ accepted: true }); }
        if (pathname.includes("/assistant/turns/") && pathname.endsWith("/undo")) {
            undoRequests.push(await req.json());
            if (rejectNextUndo) { rejectNextUndo = false; return Response.json({ code: 409, reason: "canvas_changed_since_turn" }, { status: 409 }); }
            return ok({ revision: 3 });
        }
        if (pathname.endsWith("/assistant/chat")) {
            const body = await req.json(); chats.push(body);
            const mainChange = { revisionBefore: 1, revisionAfter: 2, createdNodeIds: ["main-new"], updatedNodeIds: [], deletedNodeIds: ["gone"], createdEdgeIds: [], deletedEdgeIds: ["old-edge"] };
            const change = body.message === "改两个画布" ? { ...mainChange, canvasChanges: [
                { ...mainChange, canvasId: "input-canvas", operationIds: ["op1"] },
                { revisionBefore: 4, revisionAfter: 5, createdNodeIds: ["other-new"], updatedNodeIds: [], createdEdgeIds: [], timelineUpdated: true, canvasId: "other-canvas", operationIds: ["op2"] },
            ] } : null;
            const turn = { turnId: "t" + chats.length, userText: body.message, permissionMode: body.permissionMode, selectedNodeIds: [], reply: "已读取提供的参考素材。", attachments: body.attachments, skills: body.skills,
                toolCalls: [], proposals: [], change, error: null, cancelled: false, createdAt: "2026-10-08" };
            turns.push(turn);
            return new Response(JSON.stringify({ type: "turn_end", ...turn }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
        }
        if (pathname.startsWith("/api/")) return ok({});
        return new Response('<html><meta name="viewport" content="width=device-width"><style>:root{--background:#fff;--foreground:#222;--muted:#f4f4f4;--muted-foreground:#666;--border:#ddd;--card:#fff;--fs-body:14px}*{box-sizing:border-box}body{margin:0}</style><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { "content-type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((item): item is string => Boolean(item && existsSync(item)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); if (scratch) rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => {
    registeredAssets.length = 0;
    statusPayload = { available: true };
    statusCalls = 0;
    historyCalls = 0;
    holdHistory = null;
    pausedTurnReason = undefined;
    failHistoryStatus = 0;
    sessionSummaries = [];
    sessionConfigRequests.length = 0;
    compactRequests.length = 0;
    serverSessionId = "s1";
    serverThinkingLevel = "low";
    serverContextUsage = null;
    rejectNextSessionConfig = false;
});

test("real Sidebar handles file, paste, drop, attachment-only, purpose/range, draft restore and busy supplement", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加文件或素材"]')?.disabled);
    await page.locator('input[type="file"]').setInputFiles({ name: "portrait.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await page.getByRole("combobox", { name: "portrait.jpg 的用途" }).waitFor();
    await page.getByText("正在读取预览…", { exact: true }).waitFor({ timeout: 3000 }).catch(async error => { throw new Error(error.message + " BODY " + await page.locator("body").innerText() + " MEDIA " + JSON.stringify(mediaRequests)); });
    await firstPreviewStarted;
    expect(releaseFirstPreview).not.toBeNull(); releaseFirstPreview!();
    await page.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('img[alt="portrait.jpg"]'); return image?.src.startsWith("blob:") && image.complete && image.naturalWidth === 64; });
    expect(mediaRequests.some(item => item.token === "synthetic-desktop-preview" && item.path.includes("proxy=1"))).toBe(true);
    await page.getByRole("combobox", { name: "portrait.jpg 的用途" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("首帧", { exact: true }).waitFor();
    const imagePurposes = await (await page.waitForFunction(() => { const labels = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")].map(item => item.textContent); return labels.length === 6 ? labels : null; })).jsonValue();
    expect(imagePurposes).toContain("首帧"); expect(imagePurposes).toContain("人物参考");
    expect(imagePurposes).not.toContain("声音参考"); expect(imagePurposes).not.toContain("节奏参考");
    await page.getByRole("combobox", { name: "portrait.jpg 的用途" }).press("Escape");
    await page.getByRole("button", { name: "选择技能", exact: true }).click(); await page.getByRole("button", { name: "分镜 · 1.0", exact: true }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("已读取提供的参考素材。", { exact: true }).waitFor();
    expect(chats[0]?.message).toBe(""); expect(chats[0]?.attachments[0]?.assetId).toBeDefined();
    expect(chats[0]?.references).toEqual([{ kind: "asset", id: chats[0]?.attachments[0]?.assetId }]);
    expect(chats[0]?.skills).toEqual([{ skillId: "story", versionId: "story-v1", contentHash: "a".repeat(64) }]);
    await page.evaluate(bytes => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" })); document.querySelector('.canvas-assistant-composer')!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer })); }, [...png]);
    await page.getByRole("combobox", { name: "paste.png 的用途" }).waitFor();
    await page.evaluate(bytes => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], "motion.mp4", { type: "video/mp4" })); document.querySelector('.canvas-assistant-composer')!.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer })); }, [...video]);
    await page.getByRole("combobox", { name: "motion.mp4 的用途" }).waitFor();
    await page.waitForFunction(() => { const video = document.querySelector<HTMLVideoElement>('video[aria-label="motion.mp4"]'); return video?.src.startsWith("blob:") && video.readyState >= 1 && video.videoWidth === 64; });
    expect(mediaRequests.some(item => item.path.includes("variant=playback") && item.token === "synthetic-desktop-preview")).toBe(true);
    await page.getByRole("combobox", { name: "motion.mp4 的用途" }).click(); await page.locator('.ant-select-item-option-content').getByText("运镜参考", { exact: true }).click();
    await page.getByRole("spinbutton", { name: "motion.mp4 起始秒" }).fill("0"); await page.getByRole("spinbutton", { name: "motion.mp4 结束秒" }).fill("0.2");
    await page.getByRole("spinbutton", { name: "motion.mp4 结束秒" }).press("Tab");
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "motion.mp4" && item.end === 0.2));
    await page.reload(); await page.getByRole("combobox", { name: "motion.mp4 的用途" }).waitFor();
    expect(await page.getByRole("spinbutton", { name: "motion.mp4 结束秒" }).inputValue()).toBe("0.2");
    await page.getByRole("button", { name: "画布素材", exact: true }).click(); await page.getByRole("button", { name: "画布人像", exact: true }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.canvas-assistant-log .canvas-assistant-reply').length === 2);
    expect(chats[1]?.attachments.some((item: any) => item.name === "motion.mp4" && item.purpose === "motion" && item.end === 0.2)).toBe(true);
    expect(chats[1]?.attachments.some((item: any) => item.nodeId === "n1" && item.resourceId === "existing")).toBe(true);
    running = true; await page.reload(); await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    await page.locator('input[type="file"]').setInputFiles({ name: "beat.wav", mimeType: "audio/wav", buffer: wav });
    await page.getByRole("combobox", { name: "beat.wav 的用途" }).waitFor();
    await page.waitForFunction(() => { const audio = document.querySelector<HTMLAudioElement>('audio[aria-label="beat.wav"]'); return audio?.src.startsWith("blob:") && audio.readyState >= 1; });
    expect(mediaRequests.every(item => item.token === "synthetic-desktop-preview")).toBe(true);
    await page.getByRole("combobox", { name: "beat.wav 的用途" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("声音参考", { exact: true }).waitFor();
    const audioPurposes = await (await page.waitForFunction(() => { const labels = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")].map(item => item.textContent); return labels.length === 3 ? labels : null; })).jsonValue();
    expect(audioPurposes).toEqual(["仅分析", "节奏参考", "声音参考"]);
    expect(audioPurposes).not.toContain("首帧"); expect(audioPurposes).not.toContain("人物参考");
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("声音参考", { exact: true }).click();
    await page.getByRole("button", { name: /^补\s*充$/ }).click({ timeout: 8000 }).catch(async error => { throw new Error(error.message + " UI " + await page.locator('body').innerText()); }); await page.getByText("助手已收到补充要求。", { exact: true }).waitFor({ timeout: 8000 });
    expect(supplements).toHaveLength(1); expect(supplements[0]?.message).toBe(""); expect(supplements[0]?.attachments[0]?.kind).toBe("audio"); expect(supplements[0]?.attachments[0]?.purpose).toBe("sound");
    expect(chats).toHaveLength(2);
    running = false;
    turns.push({ turnId: "busy", userText: "继续创作", selectedNodeIds: [], reply: "补充的音频已加入本次创作。", attachments: [], skills: [], supplements: [], supplementInputs: supplements.map(item => ({ message: item.message, attachments: item.attachments, skills: item.skills })), toolCalls: [], proposals: [], change: null, error: null, cancelled: false, createdAt: "2026-10-08" });
    await page.getByText("补充的音频已加入本次创作。", { exact: true }).waitFor({ timeout: 8000 });
    expect(await page.getByRole("button", { name: "停止", exact: true }).count()).toBe(0);
    expect(chats).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/beeftv-assistant-input-ui.png" }); await page.close();
    // 这条用例串了文件、粘贴、拖放和草稿恢复；机器繁忙时 30 秒会不够，超时会被 bun 杀掉
    // 共享浏览器，连累同文件其余用例，所以和其他重用例一样给 60 秒。
}, 60000);

test("asset registration failure remains unsent; explicit upload retry keeps its idempotency key and invalid range blocks send", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加文件或素材"]')?.disabled);
    const before = chats.length, firstKey = uploadKeys.length;
    failNextAsset = true;
    await page.locator('input[type="file"]').setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "重试上传", exact: true }).waitFor();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.assets())).toEqual([]);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.libraryInvalidated())).toBe(false);
    expect(await page.getByRole("button", { name: "发送", exact: true }).isDisabled()).toBe(true);
    expect(chats).toHaveLength(before);
    await page.getByRole("button", { name: "重试上传", exact: true }).click();
    await page.getByRole("combobox", { name: "retry.png 的用途" }).waitFor();
    expect(uploadKeys[firstKey]).not.toBe(""); expect(uploadKeys[firstKey + 1]).toBe(uploadKeys[firstKey]);
    await page.locator('input[type="file"]').setInputFiles({ name: "range.wav", mimeType: "audio/wav", buffer: wav });
    await page.getByRole("spinbutton", { name: "range.wav 结束秒" }).fill("3");
    await page.getByText("结束时间超过素材时长", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "发送", exact: true }).isDisabled()).toBe(true);
    expect(chats).toHaveLength(before);
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "range.wav" && item.end === 3));
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("beeftv-assistant-input");
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const database = opening.result, transaction = database.transaction("drafts", "readwrite"), store = transaction.objectStore("drafts");
            const read = store.get("guest:input-canvas");
            read.onsuccess = () => { const draft = read.result; draft.attachments.find((item: { kind: string }) => item.kind === "audio").purpose = "first-frame"; store.put(draft, "guest:input-canvas"); };
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error);
        };
    }));
    await page.reload();
    const legacy = page.locator('.canvas-assistant-attachment').filter({ hasText: "range.wav" });
    await legacy.locator('.ant-select').getByText("首帧", { exact: true }).waitFor({ timeout: 4000 }).catch(async error => { throw new Error(error.message + " UI " + await page.locator("body").innerText()); });
    expect(await legacy.locator('.ant-select').innerText()).toBe("首帧");
    await page.getByRole("combobox", { name: "range.wav 的用途" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("声音参考", { exact: true }).waitFor();
    expect(await (await page.waitForFunction(() => { const labels = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")].map(item => item.textContent); return labels.length === 3 ? labels : null; })).jsonValue()).toEqual(["仅分析", "节奏参考", "声音参考"]);
    await page.getByRole("combobox", { name: "range.wav 的用途" }).press("Escape");
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "range.wav" && item.purpose === "first-frame"));
    expect(await legacy.locator('.ant-select').innerText()).toBe("首帧");
    await page.close();
}, 15000);

test("native-local Sidebar publishes accepted uploads for immediate @ reuse, and removal preserves ownership", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加文件或素材"]')?.disabled);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.nativeLocal())).toBe(true);
    await page.locator('input[type="file"]').setInputFiles({ name: "reuse.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await page.getByRole("combobox", { name: "reuse.jpg 的用途" }).waitFor();
    const registered = await page.evaluate(() => (window as any).assistantInputFixture.assets());
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ title: "reuse.jpg", kind: "image" });
    expect(registered[0].data).toMatchObject({ width: 64, height: 48 });
    expect(registeredAssets.find(asset => asset.id === registered[0].id)?.data).toEqual(registered[0].data);
    expect(uploadMetadata.find(upload => upload.name === "reuse.jpg")).toMatchObject({ width: "64", height: "48" });
    expect(await page.evaluate(() => (window as any).assistantInputFixture.libraryInvalidated())).toBe(true);
    await page.getByRole("button", { name: "移除 reuse.jpg", exact: true }).click();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.assets())).toEqual(registered);
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("@reuse");
    await page.locator('.canvas-resource-mention-item').getByText("reuse.jpg", { exact: true }).click();
    const before = chats.length;
    const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await sent;
    await page.getByText("已读取提供的参考素材。", { exact: true }).last().waitFor();
    expect(chats).toHaveLength(before + 1);
    expect(chats[before]?.message).toContain(`@[asset:${registered[0].id}]`);
    expect(chats[before]?.references).toEqual([{ kind: "asset", id: registered[0].id }]);
    expect(chats[before]?.attachments).toBeUndefined();

    await page.close();
}, 15000);

test("missing resource duration is recovered from a real twelve-second WAV for registration, draft and range validation", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加文件或素材"]')?.disabled);
    await page.locator('input[type="file"]').setInputFiles({ name: "twelve-seconds.wav", mimeType: "audio/wav", buffer: longWav });
    await page.getByRole("combobox", { name: "twelve-seconds.wav 的用途" }).waitFor();
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "twelve-seconds.wav" && item.durationMs === 12000));
    expect(uploadMetadata.find(upload => upload.name === "twelve-seconds.wav")?.durationMs).toBe("12000");
    const draft = await page.evaluate(() => (window as any).assistantInputFixture.draft());
    expect(draft.attachments[0].durationMs).toBe(12000);
    expect(registeredAssets.find(asset => asset.title === "twelve-seconds.wav")?.data.durationMs).toBe(12000);
    expect((await page.evaluate(() => (window as any).assistantInputFixture.assets()))[0].data.durationMs).toBe(12000);
    const before = chats.length;
    await page.getByRole("spinbutton", { name: "twelve-seconds.wav 结束秒" }).fill("12.1");
    await page.getByText("结束时间超过素材时长", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "发送", exact: true }).isDisabled()).toBe(true);
    expect(chats).toHaveLength(before);
    await page.close();
}, 15000);

test("permission choices persist; trusted active mode locks the turn and supplements cannot elevate it", async () => {
    running = false; cancelled = false;
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    const selector = page.getByRole("combobox", { name: "助手权限" });
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    const selectedText = () => selector.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').innerText();
    expect(await selectedText()).toBe("当前画布");
    await selector.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("完全访问", { exact: true }).click();
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("查看全部项目");
    const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
    await page.getByRole("button", { name: "发送", exact: true }).click(); await sent;
    expect(chats.at(-1)?.permissionMode).toBe("full-access");
    await page.reload();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    expect(await selectedText()).toBe("完全访问");
    activePermissionMode = "read-only"; running = true;
    await page.reload(); await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    expect(await selector.isDisabled()).toBe(true);
    expect(await selectedText()).toBe("只读");
    await selector.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').hover();
    await page.getByRole("tooltip").getByText("本轮权限已固定，结束后可更改", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("继续分析");
    const supplemented = page.waitForResponse(response => response.url().endsWith("/assistant/steer"));
    await page.getByRole("button", { name: /^补\s*充$/ }).click(); await supplemented;
    expect(supplements.at(-1)?.permissionMode).toBeUndefined();
    activePermissionMode = undefined;
    await page.reload(); await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    expect(await selectedText()).toBe("当前画布"); // Legacy active turns keep their original scope.
    expect(await selector.isDisabled()).toBe(true);
    running = false;
    await page.reload();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    expect(await selectedText()).toBe("完全访问");
    // 助手侧栏有 220ms 的进场位移动画，动画期间页面会短暂比视口宽；这里等它出现并停稳，
    // 断言的是稳定后的布局，不会因为恰好取到动画中间一帧而失败。
    await page.waitForFunction(() => {
        const sidebars = [...document.querySelectorAll(".canvas-assistant-sidebar")];
        return sidebars.length > 0 && sidebars.every(el => el.getAnimations().every(animation => animation.playState !== "running"));
    }, { timeout: 5000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/beeftv-assistant-permissions-390.png" });
    await page.close();
}, 20000);

test("external Agent connection has no permission chooser and submits only the client kind", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.getByRole("button", { name: "连接外部 Agent", exact: true }).click();
    const panel = page.locator(".agent-connect-panel");
    await panel.getByText("连接后可使用 BeefTV 的全部创作工具。每次操作的审批由 Codex 负责。", { exact: true }).waitFor();
    expect(await panel.getByRole("radio").count()).toBe(0);
    const connected = page.waitForResponse(response => response.url().endsWith("/agent-clients"));
    await panel.getByRole("button", { name: "生成连接配置", exact: true }).click(); await connected;
    expect(externalConnections.at(-1)).toEqual({ kind: "codex" });
    await panel.getByRole("status").filter({ hasText: "等待工具连接" }).waitFor();
    await page.screenshot({ path: "/tmp/beeftv-external-agent-connect.png" });
    await page.close();
}, 15000);

test("cross-canvas receipts report every target and one atomic undo refreshes all canvases only after success", async () => {
    running = false;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="助手权限"]')?.disabled);
    await page.getByRole("combobox", { name: "助手权限" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText("完全访问", { exact: true }).click();
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("改两个画布");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("修改了 2 个画布，新建 2 个节点，删除 1 个节点，删除 1 条线，修改时间线", { exact: true }).waitFor();
    await page.getByText("撤销会恢复这 2 个画布本轮的全部改动。", { exact: true }).waitFor();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.changedCanvases())).toEqual(["input-canvas", "other-canvas"]);
    await page.getByRole("button", { name: "在画布上查看", exact: true }).click();
    expect(await page.evaluate(() => (window as any).assistantInputFixture.locatedNodes())).toEqual([["main-new"]]);
    const before = undoRequests.length;
    rejectNextUndo = true;
    await page.getByRole("button", { name: "撤销这一轮", exact: true }).click();
    await page.getByText("其中一个画布后来又改过，这一轮未撤销。", { exact: true }).waitFor();
    expect(undoRequests).toHaveLength(before + 1);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.changedCanvases())).toEqual(["input-canvas", "other-canvas"]);
    await page.getByRole("button", { name: "撤销这一轮", exact: true }).click();
    await page.getByText("已撤销这一轮全部画布改动", { exact: true }).waitFor();
    expect(undoRequests).toHaveLength(before + 2);
    expect(undoRequests.at(-1)).toEqual({ canvasId: "input-canvas" });
    expect(await page.evaluate(() => (window as any).assistantInputFixture.changedCanvases())).toEqual(["input-canvas", "other-canvas", "input-canvas", "other-canvas"]);
    await page.screenshot({ path: "/tmp/beeftv-assistant-cross-canvas-undo.png" });
    await page.close();
}, 15000);

for (const mode of ["markdown", "zip"] as const) {
    test(`assistant installs ${mode} privately and sends the installed version pin`, async () => {
        running = false; installedSkills = [];
        const page = await browser.newPage();
        await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
        await page.getByRole("button", { name: "选择技能", exact: true }).click();
        await page.getByText("还没有已安装的技能。", { exact: true }).waitFor();
        await page.getByRole("button", { name: "安装技能", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "安装技能" });
        expect(await dialog.getByText("公开状态", { exact: true }).isVisible()).toBe(false);
        expect(await dialog.getByRole("button", { name: "从空白创建单文件技能" }).count()).toBe(0);
        if (mode === "zip") await dialog.getByText("ZIP 技能包", { exact: true }).click();
        await dialog.locator('input[type="file"]').setInputFiles({ name: mode === "zip" ? "coffee.zip" : "SKILL.md", mimeType: mode === "zip" ? "application/zip" : "text/markdown", buffer: Buffer.from("# Coffee review\nCheck the actual video.") });
        await dialog.getByRole("button", { name: "安装技能", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "移除技能 咖啡审片", exact: true }).waitFor();
        await page.getByRole("button", { name: "咖啡审片 · 2.0", exact: true }).waitFor();
        expect(skillInstalls.at(-1)).toEqual({ sourceType: mode, isPrivate: "true", fileName: mode === "zip" ? "coffee.zip" : "SKILL.md" });
        await page.getByRole("textbox", { name: "给助手的消息" }).fill("请审查咖啡短片");
        const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
        await page.getByRole("button", { name: "发送", exact: true }).click(); await sent;
        expect(chats.at(-1)?.skills).toEqual([{ skillId: "coffee", versionId: "coffee-v2", contentHash: "b".repeat(64) }]);
        await page.close();
    }, 20000);
}

test("status polling does not pile up initial history reads and reloads paused turn even when status recovers mid-flight", async () => {
    running = false;
    cancelled = false;
    turns.length = 0;
    turns.push({
        turnId: "paused-1",
        userText: "继续分镜脚本",
        selectedNodeIds: [],
        reply: "",
        attachments: [],
        skills: [],
        toolCalls: [],
        proposals: [],
        change: null,
        error: "上一轮已中断",
        errorReason: "turn_interrupted",
        cancelled: false,
        createdAt: "2026-10-08",
    });
    pausedTurnReason = "model_unavailable_for_resume";
    statusPayload = { available: false, reason: "host_busy" };
    let releaseInitialHistory!: () => void;
    const initialHistoryGate = new Promise<void>(resolve => { releaseInitialHistory = resolve; });
    holdHistory = () => initialHistoryGate;

    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
        await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));

        // 1. Wait for initial /assistant/history (#1) and at least two transient /assistant/status polls while #1 is held in flight.
        const pollDeadline = Date.now() + 8000;
        while ((statusCalls < 2 || historyCalls < 1) && Date.now() < pollDeadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(statusCalls).toBeGreaterThanOrEqual(2);
        expect(historyCalls).toBe(1);

        // 2. Flip /assistant/status to available WHILE initial /assistant/history (#1) is STILL in flight!
        const statusCallsBeforeAvailable = statusCalls;
        statusPayload = { available: true, model: { channelId: "ch-1", channelName: "Local", id: "restored-model", name: "Restored" } };
        const availableDeadline = Date.now() + 6000;
        while (statusCalls <= statusCallsBeforeAvailable && Date.now() < availableDeadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Give the browser a moment to apply setStatus({ available: true }) while history #1 is still held:
        // historyLoading lock must keep historyCalls === 1 during flight, NOT drop a concurrent duplicate.
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(historyCalls).toBe(1);

        // 3. Now let history #1 finish with pausedTurnReason="model_unavailable_for_resume", and prepare history #2 with the resumed reply:
        // settling history #1 must immediately detect that status recovered mid-flight and trigger history #2!
        holdHistory = async () => {
            if (historyCalls >= 2) {
                pausedTurnReason = undefined;
                turns.splice(0, turns.length, {
                    turnId: "paused-1",
                    userText: "继续分镜脚本",
                    selectedNodeIds: [],
                    reply: "模型恢复后已完成续跑。",
                    attachments: [],
                    skills: [],
                    toolCalls: [],
                    proposals: [],
                    change: null,
                    error: null,
                    cancelled: false,
                    createdAt: "2026-10-08",
                });
            }
        };
        releaseInitialHistory();
        await page.getByText("模型恢复后已完成续跑。", { exact: true }).waitFor({ timeout: 6000 });
        expect(historyCalls).toBe(2);
    } finally {
        releaseInitialHistory();
        await page.close();
    }
}, 20000);

test("cold-start 503 hides false failure banner until ready and deleting non-current session never wedges polling", async () => {
    running = false;
    cancelled = false;
    turns.length = 0;
    failHistoryStatus = 503;
    sessionSummaries = [
        { sessionId: "s1", title: "当前主对话", updatedAt: "2026-10-08", turnCount: 1 },
        { sessionId: "s2", title: "旧支线对话", updatedAt: "2026-10-07", turnCount: 1 },
    ];
    statusPayload = { available: false, reason: "host_starting" };

    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));

    // Cold-start host_starting defers /assistant/history (0 wasted 503 calls) while showing "正在读取对话…" without flashing errors!
    await page.getByText("正在读取对话…", { exact: true }).waitFor({ timeout: 5000 });
    const pollDeadline = Date.now() + 6000;
    while (statusCalls < 2 && Date.now() < pollDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await page.getByText("没能读取对话。请重新读取。").count()).toBe(0);
    expect(historyCalls).toBe(0);

    // Once status becomes model_not_configured (read-only host ready), history loads (#1) with s1+s2 and paused turn!
    failHistoryStatus = 0;
    pausedTurnReason = "model_unavailable_for_resume";
    turns.push({
        turnId: "busy",
        userText: "首次读取失败后的对话",
        selectedNodeIds: [],
        reply: "",
        attachments: [],
        skills: [],
        toolCalls: [],
        proposals: [],
        change: null,
        error: "上一轮已中断",
        errorReason: "turn_interrupted",
        cancelled: false,
        createdAt: "2026-10-08",
    });
    statusPayload = { available: false, reason: "model_not_configured" };
    await page.getByText("首次读取失败后的对话", { exact: true }).waitFor({ timeout: 6000 });
    expect(historyCalls).toBe(1);

    // Open session dropdown (s1 + s2 loaded), trigger paused-turn reload (#2) via status becoming available,
    // delete non-current session s2 WHILE #2 is held in flight, let #2 return an active turn (2s poll),
    // and verify 2s background poll #3 still fires (proving historyInFlight returned to 0)!
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.getByRole("button", { name: "删除会话 旧支线对话", exact: true }).waitFor({ timeout: 4000 });
    let releaseSecondRead!: () => void;
    const secondReadGate = new Promise<void>(resolve => { releaseSecondRead = resolve; });
    let markSecondReadEntered!: () => void;
    const secondReadEntered = new Promise<void>(resolve => { markSecondReadEntered = resolve; });
    holdHistory = async () => {
        if (historyCalls === 2) {
            markSecondReadEntered();
            await secondReadGate;
            pausedTurnReason = undefined;
            running = true;
            turns.length = 0;
        } else if (historyCalls >= 3) {
            running = false;
            turns.splice(0, turns.length, {
                turnId: "busy",
                userText: "首次读取失败后的对话",
                selectedNodeIds: [],
                reply: "删除支线会话后自动刷新仍然正常。",
                attachments: [],
                skills: [],
                toolCalls: [],
                proposals: [],
                change: null,
                error: null,
                cancelled: false,
                createdAt: "2026-10-08",
            });
        }
    };
    statusPayload = { available: true, model: { channelId: "ch-1", channelName: "Local", id: "restored-model", name: "Restored" } };
    await secondReadEntered;
    await page.getByRole("button", { name: "删除会话 旧支线对话", exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 150));
    releaseSecondRead();

    await page.getByText("删除支线会话后自动刷新仍然正常。", { exact: true }).waitFor({ timeout: 8000 });
    expect(historyCalls).toBe(3);
    expect(await page.getByRole("button", { name: "删除会话 旧支线对话", exact: true }).count()).toBe(0);
    await page.close();
}, 35000);

test("real Sidebar attaches arbitrary document files without polluting asset library and sends resource references", async () => {
    running = false;
    cancelled = false;
    turns.length = 0;
    const beforeChats = chats.length;
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.evaluate(() => new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase("beeftv-assistant-input");
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
    }));
    await page.reload();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="添加文件或素材"]')?.disabled);
    const beforeMediaRequests = mediaRequests.length;
    const mdBytes = Buffer.from("# 广告分镜脚本\n\n第 1 镜：清晨咖啡店窗边特写。\n", "utf-8");
    const docxBytes = Buffer.from("PK\x03\x04fake-docx-payload-for-upload-test", "binary");
    const xlsxBytes = Buffer.from("PK\x03\x04fake-xlsx-payload-for-long-name-overflow-check", "binary");
    await page.locator('input[type="file"]').setInputFiles([
        { name: "script-outline.md", mimeType: "text/markdown", buffer: mdBytes },
        { name: "brand-brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docxBytes },
        { name: "2026-Q4-advertising-creative-breakdown-table-very-long-name.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsxBytes },
    ]);
    await page.getByRole("combobox", { name: "script-outline.md 的用途" }).waitFor();
    await page.getByRole("combobox", { name: "brand-brief.docx 的用途" }).waitFor();
    await page.getByRole("combobox", { name: "2026-Q4-advertising-creative-breakdown-table-very-long-name.xlsx 的用途" }).waitFor();
    expect(registeredAssets).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).assistantInputFixture.assets())).toEqual([]);
    expect(mediaRequests.length).toBe(beforeMediaRequests);
    expect(await page.locator(".canvas-assistant-file-card").count()).toBe(3);
    expect((await page.locator(".canvas-assistant-file-ext").allInnerTexts()).sort()).toEqual(["DOCX", "MD", "XLSX"]);
    expect(await page.getByRole("spinbutton").count()).toBe(0);
    await page.getByRole("combobox", { name: "script-outline.md 的用途" }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("参考资料", { exact: true }).waitFor();
    const filePurposes = await (await page.waitForFunction(() => {
        const labels = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")].map(item => item.textContent);
        return labels.length === 2 ? labels : null;
    })).jsonValue();
    expect(filePurposes).toEqual(["仅分析", "参考资料"]);
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("参考资料", { exact: true }).click();
    await page.waitForFunction(async () => (await (window as any).assistantInputFixture.draft())?.attachments.some((item: any) => item.name === "script-outline.md" && item.purpose === "reference"));
    await page.reload();
    await page.getByRole("combobox", { name: "script-outline.md 的用途" }).waitFor();
    expect(await page.locator(".canvas-assistant-file-card").count()).toBe(3);
    await page.locator(".canvas-assistant-sidebar").evaluate(async sidebar => {
        await Promise.all(sidebar.getAnimations().map(animation => animation.finished));
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("textbox", { name: "给助手的消息" }).fill("按这些文档拆解镜头");
    const sent = page.waitForResponse(response => response.url().endsWith("/assistant/chat"));
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await sent;
    await page.getByText("已读取提供的参考素材。", { exact: true }).last().waitFor();
    const chat = chats[beforeChats];
    expect(chat?.attachments).toHaveLength(3);
    expect(chat?.attachments.every((item: any) => item.kind === "file" && !item.assetId && Boolean(item.resourceId))).toBe(true);
    expect(chat?.attachments.find((item: any) => item.name === "script-outline.md")?.purpose).toBe("reference");
    expect(chat?.references).toEqual(chat?.attachments.map((item: any) => ({ kind: "resource", id: item.resourceId })));
    await page.close();
}, 30000);

test("thinking level switcher, context usage pill, manual compaction, and 16-item canvas reference limit work in real Sidebar", async () => {
    running = false;
    cancelled = false;
    turns.length = 0;
    turns.push({
        turnId: "ctx-1",
        userText: "帮我拆解前五镜分镜脚本",
        selectedNodeIds: [],
        reply: "已经整理好前五镜的分镜结构，可以继续细化人物与灯光。",
        attachments: [],
        skills: [],
        toolCalls: [],
        proposals: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-10-08",
    });
    const durableId = "durable:11111111-1111-1111-1111-111111111111";
    serverSessionId = durableId;
    serverThinkingLevel = "low";
    serverContextUsage = {
        estimatedTokens: 48200,
        contextWindow: 200000,
        percent: 24,
        totalInput: 52000,
        totalOutput: 3400,
        cacheRead: 36000,
        cacheWrite: 1200,
    };

    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(server.url.toString().replace("localhost", "127.0.0.1"));
    await page.evaluate(() => new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase("beeftv-assistant-input");
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
    }));
    await page.reload();

    await page.getByText("上下文 24%", { exact: true }).waitFor();
    const thinkingSelect = page.getByRole("combobox", { name: "思考深度" });
    const thinkingText = () => thinkingSelect.locator('xpath=ancestor::div[contains(@class,"ant-select")][1]').innerText();
    expect(await thinkingText()).toBe("轻量思考");

    // 切换思考深度失败时必须回滚显示，且不污染本地偏好
    rejectNextSessionConfig = true;
    await thinkingSelect.click();
    const failedConfigRes = page.waitForResponse(response => response.url().endsWith("/assistant/session-config"));
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("关闭思考", { exact: true }).click();
    await failedConfigRes;
    expect(await thinkingText()).toBe("轻量思考");

    // 切换思考深度成功 -> 调用 /api/assistant/session-config 并持久化
    await thinkingSelect.click();
    const configRes = page.waitForResponse(response => response.url().endsWith("/assistant/session-config"));
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("深度思考", { exact: true }).click();
    await configRes;
    expect(sessionConfigRequests.at(-1)).toEqual({ canvasId: "input-canvas", sessionId: durableId, thinkingLevel: "high" });
    expect(await thinkingText()).toBe("深度思考");

    // 悬停上下文占用显示上下文估算与缓存复用量（使用用户语，不暴露英文 token 术语）
    await page.getByText("上下文 24%", { exact: true }).hover();
    await page.getByRole("tooltip").getByText(/48k \/ 200k.*缓存 36k/).waitFor();

    // 等入场动画稳定后检查无横向溢出
    await page.waitForFunction(() => {
        const sidebars = [...document.querySelectorAll(".canvas-assistant-sidebar")];
        return sidebars.length > 0 && sidebars.every(el => el.getAnimations().every(animation => animation.playState !== "running"));
    }, { timeout: 5000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // 触发手动压缩上下文 -> 调用 /api/assistant/compact 并更新占用与提示
    const compactRes = page.waitForResponse(response => response.url().endsWith("/assistant/compact"));
    await page.getByRole("button", { name: "压缩上下文", exact: true }).click();
    await compactRes;
    expect(compactRequests.at(-1)).toEqual({ canvasId: "input-canvas", sessionId: durableId });
    await page.getByText("上下文 8%", { exact: true }).waitFor();
    await page.getByText("已压缩较早对话上下文，后续对话会保留关键信息。", { exact: true }).waitFor();

    // 画布参考素材上限统一为 16（超过旧上限 8 仍可添加到 16，第 17 个报新上限提示）
    for (let i = 0; i < 16; i++) {
        await page.getByRole("button", { name: "画布素材", exact: true }).click();
        await page.getByRole("button", { name: "画布人像", exact: true }).click();
    }
    expect(await page.locator(".canvas-assistant-attachment").count()).toBe(16);
    expect(await page.getByText("一次最多添加 8 份参考素材").count()).toBe(0);
    await page.getByRole("button", { name: "画布素材", exact: true }).click();
    await page.getByRole("button", { name: "画布人像", exact: true }).click();
    await page.getByText("一次最多添加 16 个文件或素材", { exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // 刷新后思考深度保持深度思考；非 Durable 旧会话不展示压缩按钮
    await page.reload();
    await page.getByText("上下文 8%", { exact: true }).waitFor();
    expect(await thinkingText()).toBe("深度思考");
    serverSessionId = "legacy-jsonl-1";
    serverThinkingLevel = undefined;
    serverContextUsage = null;
    await page.reload();
    await page.getByText("已经整理好前五镜的分镜结构，可以继续细化人物与灯光。", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "压缩上下文", exact: true }).count()).toBe(0);
    await page.close();
}, 45000);
