/**
 * Issue #305 P0 — 真实 Chrome E2E。
 *
 * 无新增依赖：只用 Bun/Node 内置 spawn / fetch / WebSocket / fs。
 * 自己启动 Vite DEV 与 headless Chrome，通过 CDP 驱动 /dev/director-repro。
 * 所有等待都有硬超时；任何断言失败 → exit 1。
 * finally 只终止本脚本记录的 PID，只删除本脚本 mkdtemp 创建的 profile。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

const CHROME_CANDIDATES = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

/** 唯一允许出现的浏览器噪声：精确匹配，其他一律判失败。 */
const ALLOWED_NOISE = ["Warning: [antd: InputNumber] `addonAfter` is deprecated. Please use `Space.Compact` instead.", "Warning: [antd: InputNumber] `addonBefore` is deprecated. Please use `Space.Compact` instead."];

/**
 * 网络与资源失败绝不放行：复现台必须是真正的同源本地确定性场景。
 * 出现 4xx/5xx/ERR_* 一律判失败，由根因修复，而不是扩大 allowlist。
 */

const results = [];
let failures = 0;

function pass(name, detail = "") {
    results.push({ ok: true, name, detail });
    console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail = "") {
    results.push({ ok: false, name, detail });
    failures += 1;
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
}

function assert(condition, name, detail = "") {
    if (condition) pass(name, detail);
    else fail(name, detail);
    return Boolean(condition);
}

async function openDirectorTools(cdp) {
    const transformMenu = await cdp.click('.director-viewport-dock > button[aria-haspopup="menu"]');
    return transformMenu && await cdp.clickText("更多导演台工具", '[role="menuitem"]');
}

async function openDirectorNavigation(cdp) {
    const toolsMenu = await openDirectorTools(cdp);
    return toolsMenu && await cdp.clickText("导演台导航", '[role="menuitem"]');
}

async function openSceneTree(cdp) {
    return cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="场景"]');
}

/** Reset fixture-dependent loading scenarios explicitly; the page now opens on the actor parity scene. */
async function prepareP0Fixture(cdp, scenario) {
    const clicked = await cdp.click('[data-testid="load-p0-repro-scene"]');
    if (!clicked) throw new Error(`${scenario}: P0 fixture button not clickable`);
    const ready = await cdp.poll(`(() => {
        const count = document.querySelector('[data-testid="object-count"]')?.textContent || '';
        const offline = document.querySelector('[data-testid="offline-tag"]')?.textContent || '';
        return count.includes('3') && offline.includes('fixture 无网络资产');
    })()`, `${scenario} P0 fixture`, 10000);
    if (!ready) throw new Error(`${scenario}: P0 fixture did not restore`);
}

function resolveChrome() {
    for (const candidate of CHROME_CANDIDATES) {
        if (candidate && existsSync(candidate)) return candidate;
    }
    throw new Error("No Chrome binary found. Set CHROME_BIN or install google-chrome/chromium. Tried:\n  " + CHROME_CANDIDATES.join("\n  "));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动 Vite DEV，等待 ready 行或 TCP 可连接；超时即抛。 */
async function launchVite(port, apiTarget) {
    const child = spawn("bunx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
        cwd: process.cwd(),
        env: { ...process.env, VITE_API_PROXY_TARGET: apiTarget },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => {
        log += d.toString();
    });
    child.stderr.on("data", (d) => {
        log += d.toString();
    });

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Vite exited early (code ${child.exitCode}):\n${log}`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/dev/director-repro`);
            if (res.ok) return child;
        } catch {
            // not up yet
        }
        await sleep(500);
    }
    throw new Error(`Vite did not become ready within 120s:\n${log}`);
}

async function launchApiFixture() {
    const server = createHttpServer((request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/api/canvas-projects") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ code: 0, data: { items: [], total: 0 } }));
            return;
        }
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ code: 404, message: "fixture route not found" }));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("API fixture did not expose a TCP port");
    return { server, target: `http://127.0.0.1:${address.port}` };
}

async function stopApiFixture(server) {
    if (!server) return;
    await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
    });
}

/** 启动 headless Chrome 并等待 CDP /json/version；超时即抛。 */
async function launchChrome(chromePath, cdpPort, profileDir) {
    const args = [
        "--headless=new",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,1000",
        // 保留 WebGL：不要 --disable-gpu。SwiftShader 提供确定性软件渲染。
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
    ];
    if (process.platform === "linux" || process.env.CI) args.push("--no-sandbox", "--disable-dev-shm-usage");
    args.push("about:blank");

    const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => {
        log += d.toString();
    });
    child.stderr.on("data", (d) => {
        log += d.toString();
    });

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Chrome exited early (code ${child.exitCode}):\n${log}`);
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
            if (res.ok) return child;
        } catch {
            // not up yet
        }
        await sleep(400);
    }
    throw new Error(`Chrome CDP did not become ready within 60s:\n${log}`);
}

/**
 * CDP 客户端：id/pending map + 事件收集。
 * 只放行 ALLOWED_NOISE 精确匹配，其他异常/console error/网络失败全部记入 problems。
 */
async function connectCdp(cdpPort) {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const target = list.find((t) => t.type === "page");
    if (!target) throw new Error("No CDP page target found");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CDP websocket open timeout")), 20000);
        ws.addEventListener(
            "open",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
        ws.addEventListener(
            "error",
            (e) => {
                clearTimeout(timer);
                reject(new Error("CDP websocket error: " + String(e?.message || e)));
            },
            { once: true },
        );
    });

    const pending = new Map();
    let nextId = 0;
    const problems = [];
    const record = (kind, text) => {
        const clean = String(text ?? "").trim();
        if (!clean) return;
        if (ALLOWED_NOISE.includes(clean)) return;
        problems.push({ kind, text: clean });
    };

    ws.addEventListener("message", (ev) => {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }

        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
            else resolve(msg.result);
            return;
        }

        const p = msg.params;
        switch (msg.method) {
            case "Runtime.exceptionThrown":
                record("exception", p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text);
                break;
            case "Log.entryAdded":
                if (p?.entry?.level === "error") record("log.error", p.entry.text);
                break;
            case "Runtime.consoleAPICalled":
                if (p?.type === "error") record("console.error", (p.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
                break;
            case "Network.loadingFailed":
                record("network.failed", `${p?.type || "?"} ${p?.errorText || "?"}`);
                break;
            case "Network.responseReceived":
                if (typeof p?.response?.status === "number" && p.response.status >= 400) {
                    record("network.status", `${p.response.status} ${p.response.url}`);
                }
                break;
            default:
                break;
        }
    });

    const send = (method, params = {}) => {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, 30000);
        });
    };

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Log.enable");
    await send("Network.enable");

    const evaluate = async (expression) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) {
            throw new Error("evaluate threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        }
        return r.result.value;
    };

    const poll = async (expression, label, timeout = 15000, interval = 250) => {
        const deadline = Date.now() + timeout;
        let last;
        while (Date.now() < deadline) {
            last = await evaluate(expression);
            if (last) return true;
            await sleep(interval);
        }
        console.log(`      (poll timed out after ${timeout}ms: ${label}, last=${JSON.stringify(last)})`);
        return false;
    };

    /**
     * 真实鼠标点击：等待目标中心稳定且位于最上层，再派发 Input.dispatchMouseEvent。
     * 不用 el.click()，因为那是 untrusted 合成事件，拿不到真实 user gesture。
     */
    const clickPoint = async (locatorExpression, label) => {
        const readInteractiveBox = () =>
            evaluate(`(() => {
            const el = ${locatorExpression};
            if (!(el instanceof HTMLElement)) return null;
            el.scrollIntoView({ block: "center", inline: "center" });
            // A temporarily stable center is not enough while an ancestor modal
            // is entering: compositor hit testing can still use the previous frame.
            for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
                if (ancestor.getAnimations().some((animation) => animation.playState === "running" || animation.pending)) return null;
            }
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || Number(style.opacity) <= 0 || el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") return null;
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
            const hit = document.elementFromPoint(x, y);
            if (!hit || (hit !== el && !el.contains(hit))) return null;
            return { x: Math.round(x), y: Math.round(y) };
        })()`);
        const deadline = Date.now() + 5000;
        let previous = null;
        let box = null;
        while (Date.now() < deadline) {
            const next = await readInteractiveBox();
            if (next && previous && next.x === previous.x && next.y === previous.y) {
                await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
                const painted = await readInteractiveBox();
                if (painted && painted.x === next.x && painted.y === next.y) {
                    box = painted;
                    break;
                }
                previous = painted;
                await sleep(100);
                continue;
            }
            previous = next;
            await sleep(100);
        }
        if (!box) {
            console.log(`      (click target not interactable: ${label})`);
            return false;
        }
        const point = { x: box.x, y: box.y, button: "left" };
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, buttons: 1, clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, buttons: 0, clickCount: 1 });
        return true;
    };

    const click = (selector) => clickPoint(`document.querySelector(${JSON.stringify(selector)})`, selector);

    const clickText = (text, tag = "button") =>
        clickPoint(`[...document.querySelectorAll(${JSON.stringify(tag)})].find((element) => (element.textContent || "").trim() === ${JSON.stringify(text)} && element.getClientRects().length > 0)`, `${tag}:text-is(${text})`);

    /** 每个场景都从干净页面开始：诊断缓冲区与 store 都重置。 */
    const navigateFresh = async (url) => {
        // 必须在导航前清空：导航后再清会吞掉 bootstrap 阶段的真实异常。
        problems.length = 0;
        await send("Page.navigate", { url });
        const ok = await poll(`!!document.querySelector('[data-testid="inject-local-model"]')`, "lab mounted", 60000);
        if (!ok) throw new Error("Repro lab did not mount within 60s");
        return true;
    };

    return { send, evaluate, poll, click, clickText, navigateFresh, problems, close: () => ws.close() };
}

/**
 * 只终止本脚本记录的子进程：先 SIGTERM，有界等待后才对同一 PID SIGKILL。
 *
 * 被信号杀死的 Node 子进程 exitCode 仍为 null，只有 signalCode 有值，
 * 因此「已停止」必须同时看两者，否则会误判成还在运行并一路等到硬截止。
 */
async function stopExact(child, name) {
    if (!child) return;
    const stopped = () => child.exitCode !== null || child.signalCode !== null;
    if (stopped()) return;

    try {
        child.kill("SIGTERM");
    } catch {
        /* already gone */
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !stopped()) await sleep(200);

    if (!stopped()) {
        try {
            child.kill("SIGKILL");
        } catch {
            /* already gone */
        }
        const hard = Date.now() + 4000;
        while (Date.now() < hard && !stopped()) await sleep(200);
    }

    if (!stopped()) {
        throw new Error(`Failed to stop ${name} (pid=${child.pid}) after SIGTERM and SIGKILL`);
    }
    console.log(`      stopped ${name} (pid=${child.pid}, exit=${child.exitCode}, signal=${child.signalCode})`);
}

/** 场景 A：复现台 + 工作台基础集成链路（AutoKey 默认、新增、Undo）。 */
async function smokeWorkbench(cdp, baseUrl) {
    console.log("\n=== A. workbench smoke ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const initial = await cdp.evaluate(`(() => {
        const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent || "");
        return {
            snapshot: headings.some((t) => t.includes('环境快照')),
            matrix15: headings.some((t) => t.includes('P0 手工复现矩阵（15）')),
            injectLocal: !!document.querySelector('[data-testid="inject-local-model"]'),
            injectMissing: !!document.querySelector('[data-testid="inject-missing-model"]'),
            shellCount: document.querySelectorAll('.director-viewport-shell').length,
            offline: document.querySelector('[data-testid="offline-tag"]')?.textContent?.includes('fixture 无网络资产') === true,
            objectCount: document.querySelector('[data-testid="object-count"]')?.textContent || '',
            p0SceneButton: !!document.querySelector('[data-testid="load-p0-repro-scene"]'),
        };
    })()`);
    assert(initial.snapshot, "A1 环境快照 rendered");
    assert(initial.matrix15, "A2 P0 手工复现矩阵（15）rendered");
    assert(initial.injectLocal && initial.injectMissing, "A3 both inject buttons present");
    assert(initial.offline && initial.objectCount.includes("1") && initial.p0SceneButton, "A3a 默认打开人物对照场景，且保留显式 P0 测试场景入口", JSON.stringify(initial));
    await cdp.click('[data-testid="toggle-workbench"]');
    const actorCanvas = await cdp.poll(`(() => {
        const canvas = document.querySelector('.director-viewport-shell canvas');
        return !!canvas && canvas.clientWidth > 0 && document.body.innerText.includes('演员 1');
    })()`, "offline actor rendered in director viewport", 40000);
    assert(actorCanvas, "A3b 默认人物场景在真实导演台画布可见");
    const actorRequests = await cdp.evaluate(`performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /Xbot\\.glb|director-default-actor/i.test(name))`);
    assert(actorRequests.length === 0, "A3c 人物视觉对照不请求默认远程 GLB", JSON.stringify(actorRequests));
    const actorSceneTab = await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="场景"]');
    const actorCameraTab = actorSceneTab && await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="添加机位"]');
    const sideFollowPreset = actorCameraTab && await cdp.click('[data-director-left-dock] button[aria-label="侧面跟拍"]');
    const sideFollowWired = sideFollowPreset && await cdp.poll(`(() => {
        const inspector = document.querySelector('[data-director-property-inspector="true"]');
        const lines = (inspector?.innerText || '').split('\\n').map((line) => line.trim());
        const followIndex = lines.indexOf('跟随目标');
        const lookAtIndex = lines.indexOf('注视目标');
        return followIndex >= 0 && lookAtIndex >= 0 && lines[followIndex + 1] === '演员 1' && lines[lookAtIndex + 1] === '演员 1';
    })()`, "side-follow binds actor for follow and look-at", 5000);
    const sideFollowState = await cdp.evaluate(`(() => ({
        created: ${JSON.stringify(sideFollowPreset)},
        selectedFollowAndLookAt: (() => { const lines = (document.querySelector('[data-director-property-inspector="true"]')?.innerText || '').split('\\n').map((line) => line.trim()); const followIndex = lines.indexOf('跟随目标'); const lookAtIndex = lines.indexOf('注视目标'); return { follow: followIndex >= 0 ? lines[followIndex + 1] : null, lookAt: lookAtIndex >= 0 ? lines[lookAtIndex + 1] : null }; })(),
        inspector: document.querySelector('[data-director-property-inspector="true"]')?.innerText.slice(0, 400) || '',
    }))()`);
    assert(sideFollowWired, "A3c-i 侧面跟拍预设自动绑定演员跟随与注视目标", JSON.stringify(sideFollowState));
    const actorClosed = await cdp.click('[aria-label="关闭导演台"]');
    if (!actorClosed) throw new Error("A: close control not clickable after default actor render");
    const p0Loaded = await cdp.click('[data-testid="load-p0-repro-scene"]');
    if (!p0Loaded) throw new Error("A: P0 fixture button not clickable after closing actor workbench");
    const p0Fixture = await cdp.evaluate(`(() => ({
        offline: document.querySelector('[data-testid="offline-tag"]')?.textContent?.includes('fixture 无网络资产') === true,
        objectCount: document.querySelector('[data-testid="object-count"]')?.textContent || '',
    }))()`);
    assert(p0Fixture.offline && p0Fixture.objectCount.includes("3"), "A3d P0 测试场景可一键恢复确定性几何体 fixture", JSON.stringify(p0Fixture));

    assert(initial.shellCount === 0, "A4 workbench closed initially", `shellCount=${initial.shellCount}`);

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("A: toggle-workbench not clickable");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "A5 real canvas present in viewport shell");
    const entryState = await cdp.evaluate(`(() => ({
        mode: document.querySelector('[aria-label="导演台视口工具"]')?.getAttribute('data-director-mode'),
        cameraTab: document.querySelector('[aria-label="添加机位"]')?.getAttribute('aria-pressed'),
        inspector: document.querySelector('[data-director-property-inspector="true"]')?.innerText.slice(0, 80) || '',
    }))()`);
    assert(entryState.mode === "camera" && entryState.cameraTab === "true" && entryState.inspector.includes("摄像机"), "A5-entry 首次进入默认呈现机位预设与当前摄影机属性", JSON.stringify(entryState));
    const rendererReady = await cdp.poll(`document.querySelector('.director-viewport-shell[data-renderer-ready="true"]') !== null`, "live WebGL renderer", 20000);
    assert(rendererReady, "A5-render 3D 视口在捕获布局前完成首帧渲染");
    const cameraMenu = await openDirectorNavigation(cdp);
    const cameraMode = cameraMenu && await cdp.clickText("摄影机", '[role="menuitem"]');
    if (!cameraMode) throw new Error("A: 更多视口工具中的摄影机模式不可点击");
    const cameraPreviewReady = await cdp.poll(`(() => {
        const card = document.querySelector('[aria-label="摄影机预览"]');
        const image = card?.querySelector('img');
        return !!card && !!image && image.complete && image.naturalWidth === 384 && image.naturalHeight === 216;
    })()`, "camera preview image", 20000);
    assert(cameraPreviewReady, "A5-camera 当前机位生成真实 384×216 离屏预览");
    const cameraPreviewPixels = await cdp.evaluate(`(() => {
        const image = document.querySelector('[aria-label="摄影机预览"] img');
        if (!image || !image.complete || !image.naturalWidth) return { coloredPixels: 0, brightnessRange: 0 };
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let coloredPixels = 0;
        let min = 255;
        let max = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
            const luminance = Math.round((pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3);
            if (luminance > 20) coloredPixels += 1;
            min = Math.min(min, luminance);
            max = Math.max(max, luminance);
        }
        return { coloredPixels, brightnessRange: max - min };
    })()`);
    assert(cameraPreviewPixels.coloredPixels > 3000 && cameraPreviewPixels.brightnessRange > 80, "A5-camera 缩略图确实渲染出场景画面而非纯黑帧", JSON.stringify(cameraPreviewPixels));
    if (process.env.DIRECTOR_E2E_CAMERA_SCREENSHOT) {
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(process.env.DIRECTOR_E2E_CAMERA_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
    }
    const cameraPreviewState = await cdp.evaluate(`(() => {
        const canvas = document.querySelector('.director-viewport-shell canvas');
        const image = document.querySelector('[aria-label="摄影机预览"] img');
        return { canvasCount: document.querySelectorAll('.director-viewport-shell canvas').length, previewSrc: image?.getAttribute('src') || '', ready: document.querySelector('.director-viewport-shell[data-renderer-ready="true"]') !== null };
    })()`);
    assert(cameraPreviewState.canvasCount === 1 && cameraPreviewState.previewSrc.startsWith('blob:') && cameraPreviewState.ready, "A5-camera 离屏预览复用唯一 WebGL renderer，主视口仍就绪", JSON.stringify(cameraPreviewState));
    const cameraPreviewExpanded = await cdp.click('[aria-label="放大摄影机预览"]');
    const cameraPreviewModal = cameraPreviewExpanded && await cdp.poll(`!![...document.querySelectorAll('[role="dialog"]')].find((dialog) => (dialog.innerText || '').includes('主摄影机') && dialog.querySelector('img'))`, "expanded camera preview", 10000);
    assert(cameraPreviewModal, "A5-camera 放大按钮打开同一机位画面预览");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    const cameraPreviewClosed = await cdp.poll(`![...document.querySelectorAll('[role="dialog"]')].some((dialog) => (dialog.innerText || '').includes('主摄影机') && dialog.querySelector('img'))`, "expanded camera preview closed", 5000);
    assert(cameraPreviewClosed, "A5-camera 预览放大层可通过 Escape 关闭");
    const cameraPresetsOpened = await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="添加机位"]');
    if (!cameraPresetsOpened) throw new Error("A: 添加机位 rail button not clickable");
    const cameraPresetGeometry = await cdp.evaluate(`(() => {
        const button=[...document.querySelectorAll('[data-director-left-dock] button')].find((item)=>(item.innerText||'').trim()==='当前视角');
        const r=button?.getBoundingClientRect();
        return r?{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}:null;
    })()`);
    assert(cameraPresetGeometry?.x === 56 && cameraPresetGeometry.y === 100 && cameraPresetGeometry.width === 104 && cameraPresetGeometry.height === 72, "A5-camera 左侧预设网格卡片尺寸与 LibTV 一致", JSON.stringify(cameraPresetGeometry));
    const addedPreset = await cdp.clickText("当前视角");
    if (!addedPreset) throw new Error("A: current-view camera preset not clickable");
    const presetActivated = await cdp.poll(`(() => {
        const cameraView=document.querySelector('[aria-label="机位视角"]')?.getAttribute('aria-pressed');
        const name=document.querySelector('[data-director-property-inspector] input')?.value;
        return cameraView==='true' && name==='机位 2';
    })()`, "preset camera becomes active", 10000);
    assert(presetActivated, "A5-camera 选择预设后创建机位、切换为机位视角并同步属性面板");
    const undoPresetMenu = await openDirectorNavigation(cdp);
    const undoPreset = undoPresetMenu && await cdp.clickText("撤销", '[role="menuitem"]');
    const presetUndone = undoPreset && await cdp.poll(`(() => {
        return document.querySelector('[data-director-property-inspector] input')?.value==='主摄影机';
    })()`, "preset camera undo", 10000);
    assert(presetUndone, "A5-camera 创建预设机位可由工作台撤销完整回退");
    const sceneRailRestored = await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="场景"]');
    if (!sceneRailRestored) throw new Error("A: 场景 rail button not clickable after camera preset comparison");
    const layoutModeRestored = await cdp.poll(`document.querySelector('[aria-label="导演台视口工具"]')?.getAttribute('data-director-mode') === 'layout'`, "layout mode restored by scene rail", 5000);
    if (!layoutModeRestored) throw new Error("A: 场景 rail 未切回摆场模式");
    const cameraInspectorClosed = await cdp.poll(`!document.querySelector('[aria-label="摄影机预览"]')`, "camera inspector hidden outside camera mode", 5000);
    assert(cameraInspectorClosed, "A5-camera 离开摄影机模式后预览检查器正确收起");
    const viewToolbarLayout = await cdp.evaluate(`(() => {
        const root = document.querySelector('[data-director-workbench="true"]');
        const modeButton = root?.querySelector('[aria-label="导演台取景模式"] button');
        const modeGroup = root?.querySelector('[aria-label="导演台取景模式"]');
        const axisWidget = root?.querySelector('[aria-label="方向球"] > div');
        const modeButtonRect = modeButton?.getBoundingClientRect();
        const modeGroupRect = modeGroup?.getBoundingClientRect();
        return {
            modeButtonTop: Math.round(modeButtonRect?.top ?? -1),
            axisWidgetTop: Math.round(axisWidget?.getBoundingClientRect().top ?? -1),
            modeGroupLeft: Math.round(modeGroupRect?.left ?? -1),
            legacyTopbarTools: !!root?.querySelector('[data-director-topbar-group="tools"]'),
        };
    })()`);
    assert(Math.abs(viewToolbarLayout.modeButtonTop - 10) <= 1 && viewToolbarLayout.axisWidgetTop === 18 && !viewToolbarLayout.legacyTopbarTools, "A5-view-toolbar 取景控件对齐 LibTV 且顶栏不再显示冗余模式切换", JSON.stringify(viewToolbarLayout));
    const assetDock = await cdp.evaluate(`(() => {
        const root = document.querySelector('[data-director-workbench="true"]');
        const tree = root?.querySelector('[data-director-scene-tree="true"]');
        const viewport = root?.querySelector('main');
        const rail = root?.querySelector('nav[aria-label="导演台工作区"]');
        const leftDock = root?.querySelector('[data-director-left-dock="true"]');
        const rightDock = root?.querySelector('[data-director-right-dock="true"]');
        const props = root?.querySelector('[data-director-property-inspector="true"]');
        const titleInput = root?.querySelector('input[aria-label="场景名称"]');
        const topbarActions = root?.querySelector('[data-director-topbar-group="actions"]');
        const saveStatus = root?.querySelector('[aria-label="导演台保存状态"]');
        const topbarTools = root?.querySelector('[data-director-topbar-group="tools"]');
        const projectTitle = root?.querySelector('[data-director-topbar-group="project"]')?.innerText || '';
        const projectHeaderRect = root?.querySelector('[data-director-topbar-group="project"]')?.getBoundingClientRect();
        const railRect = rail?.getBoundingClientRect();
        const railButton = (label) => rail?.querySelector('[aria-label="' + label + '"]')?.getBoundingClientRect();
        const sceneRailButton = railButton('场景');
        const actorRailButton = railButton('添加角色');
        const cameraRailButton = railButton('添加机位');
        const helpRailElement = rail?.querySelector('[aria-label="帮助与快捷键"]');
        const helpRailButton = helpRailElement?.getBoundingClientRect();
        const leftDockRect = leftDock?.getBoundingClientRect();
        const rightDockRect = rightDock?.getBoundingClientRect();
        const treeRect = tree?.getBoundingClientRect();
        const viewportRect = viewport?.getBoundingClientRect();
        const propsRect = props?.getBoundingClientRect();
        return {
            treeInLeftDock: !!treeRect && !!viewportRect && !!railRect && treeRect.left >= railRect.right && treeRect.right <= viewportRect.left,
            rightDockInspectorOnly: !!rightDockRect && !!viewportRect && !!props && rightDockRect.left >= viewportRect.right && !rightDock?.querySelector('[data-director-scene-tree="true"]'),
            topbarActionsMovedOutOfViewportHeader: !topbarActions,
            saveStatusInProjectHeader: !!saveStatus && saveStatus.closest('[data-director-topbar-group="project"]') !== null,
            leftDockWidthMatchesLibTv: !!leftDockRect && Math.round(leftDockRect.width) === 280,
            rightDockWidthMatchesLibTv: !!rightDockRect && Math.round(rightDockRect.width) === 280,
            leftDockHasRailAndTree: !!leftDockRect && !!rail && leftDockRect.width >= 260,
            propertyInspectorPresent: !!props,
            compactBrandTitle: !titleInput && projectTitle.includes('3D导演台'),
            noLegacyTopbarTools: !topbarTools,
            projectHeaderAligned: !!leftDockRect && !!projectHeaderRect && Math.abs(projectHeaderRect.left) <= 1 && Math.abs(projectHeaderRect.top) <= 1 && Math.abs(projectHeaderRect.right - leftDockRect.right) <= 1 && Math.abs(projectHeaderRect.height - 52) <= 1,
            leftRailStartsBelowLibTvHeader: !!railRect && Math.abs(railRect.top - 52) <= 1,
            railButtonsMatchLibTvGeometry: !!sceneRailButton && !!actorRailButton && !!cameraRailButton
                && Math.abs(sceneRailButton.x - 7.5) < 1 && Math.abs(sceneRailButton.y - 60) < 1 && sceneRailButton.width === 32 && sceneRailButton.height === 32
                && Math.abs(actorRailButton.y - 116) < 1 && Math.abs(cameraRailButton.y - 156) < 1,
            railHelpPinnedToBottom: !!railRect && !!helpRailButton && Math.abs(railRect.bottom - helpRailButton.bottom - 8) < 1,
            propertyInspectorStartsAtTop: !!propsRect && Math.abs(propsRect.top) <= 1,
            treeStartsBelowBrand: !!treeRect && treeRect.top >= 52,
        };
    })()`);
    assert(assetDock.treeInLeftDock && assetDock.rightDockInspectorOnly && assetDock.topbarActionsMovedOutOfViewportHeader && assetDock.saveStatusInProjectHeader && assetDock.leftDockWidthMatchesLibTv && assetDock.rightDockWidthMatchesLibTv && assetDock.leftDockHasRailAndTree && assetDock.propertyInspectorPresent && assetDock.compactBrandTitle && assetDock.noLegacyTopbarTools && assetDock.projectHeaderAligned && assetDock.leftRailStartsBelowLibTvHeader && assetDock.railButtonsMatchLibTvGeometry && assetDock.railHelpPinnedToBottom && assetDock.propertyInspectorStartsAtTop && assetDock.treeStartsBelowBrand, "A5-assets 侧栏与工具轨道贴合 LibTV", JSON.stringify(assetDock));
    const sceneComposerLayout = await cdp.evaluate(`(() => {
        const composer = document.querySelector('[role="group"][aria-label="场景描述"]');
        const input = composer?.querySelector('textarea[aria-label="场景描述"]');
        const guide = document.querySelector('[aria-label="导演台上手引导"]');
        const dock = document.querySelector('.director-viewport-dock');
        const controlBar = document.querySelector('.director-scene-control-bar');
        const rect = (element) => element?.getBoundingClientRect();
        const a = rect(composer), b = rect(guide), c = rect(dock);
        const overlaps = (x, y) => !!x && !!y && x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
        const viewport = document.querySelector('[data-director-workbench="true"] main')?.getBoundingClientRect();
        const rowAligned = !!a && !!c && Math.abs((a.top + a.bottom) / 2 - (c.top + c.bottom) / 2) <= 12;
        const composerSize = a && [Math.round(a.width), Math.round(a.height)];
        const dockSize = c && [Math.round(c.width), Math.round(c.height)];
        const matchesLibTvSize = !!composerSize && Math.abs(composerSize[0] - 224) <= 2 && Math.abs(composerSize[1] - 48) <= 2 && !!dockSize && Math.abs(dockSize[0] - 130) <= 3 && Math.abs(dockSize[1] - 48) <= 2;
        return { present: !!input && input.getAttribute('placeholder') === '描述想搭建的场景', clearOfGuide: !overlaps(a, b), clearOfDock: !overlaps(a, c), input: !!input, rowAligned: !!controlBar && getComputedStyle(controlBar).flexDirection === 'row' && rowAligned, fitsViewport: !!controlBar && !!viewport && controlBar.getBoundingClientRect().right <= viewport.right && controlBar.getBoundingClientRect().left >= viewport.left, matchesLibTvSize, composerSize, dockSize };
    })()`);
    assert(sceneComposerLayout.present && sceneComposerLayout.clearOfGuide && sceneComposerLayout.clearOfDock && sceneComposerLayout.rowAligned && sceneComposerLayout.fitsViewport && sceneComposerLayout.matchesLibTvSize, "A5-scene-composer LibTV 紧凑尺寸下的场景描述条同排且不遮挡/溢出", JSON.stringify(sceneComposerLayout));
    const sceneComposerFocused = await cdp.click('[role="group"][aria-label="场景描述"] textarea');
    if (sceneComposerFocused) await cdp.send("Input.insertText", { text: "E2E 场景描述" });
    const sceneComposerEdited = sceneComposerFocused && await cdp.poll(`document.querySelector('[role="group"][aria-label="场景描述"] textarea')?.value === 'E2E 场景描述'`, "scene description input", 5000);
    assert(sceneComposerEdited, "A5-scene-composer-i 输入内容进入当前镜头描述，不触发生成操作");
    const initialViewportWidth = await cdp.evaluate(`Math.round(document.querySelector('[data-director-workbench="true"] main')?.getBoundingClientRect().width || 0)`);
    const collapseSidebar = await cdp.click('[aria-label="折叠场景面板"]');
    assert(collapseSidebar, "A5-assets-collapse LibTV 式场景面板折叠入口可用");
    if (collapseSidebar) {
        const collapsedState = await cdp.poll(`(() => {
            const tree = document.querySelector('[data-director-scene-tree="true"]');
            const rail = document.querySelector('[data-director-workbench="true"] nav[aria-label="导演台工作区"]');
            const viewport = document.querySelector('[data-director-workbench="true"] main');
            const reopen = document.querySelector('[aria-label="展开场景面板"]');
            const project = document.querySelector('[data-director-topbar-group="project"]');
            const root = document.querySelector('[data-director-workbench="true"]');
            return !!tree && tree.getClientRects().length === 0 && Math.round(rail?.getBoundingClientRect().width || 0) === 48 && reopen?.getAttribute('aria-expanded') === 'false' && root?.getAttribute('data-left-dock-collapsed') === 'true' && Math.round(project?.getBoundingClientRect().width || 0) === 48 && !!viewport && Math.round(viewport.getBoundingClientRect().width) >= ${initialViewportWidth} + 220;
        })()`, "collapsed scene panel and expanded viewport", 5000);
        assert(collapsedState, "A5-assets-collapse-i 折叠后保留工具轨道且主视口获得宽度", `initial=${initialViewportWidth}`);
        if (process.env.DIRECTOR_E2E_COLLAPSED_SCREENSHOT) {
            const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            writeFileSync(process.env.DIRECTOR_E2E_COLLAPSED_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
        }
        const expandSidebar = await cdp.click('[aria-label="展开场景面板"]');
        assert(expandSidebar, "A5-assets-collapse-ii 可从收起态重新展开场景面板");
        const expandedState = await cdp.poll(`document.querySelector('[data-director-scene-tree="true"]')?.getClientRects().length > 0 && document.querySelector('[aria-label="折叠场景面板"]')?.getAttribute('aria-expanded') === 'true' && !!document.querySelector('[data-director-property-inspector="true"]')`, "scene tree restored after expansion", 5000);
        assert(expandedState, "A5-assets-collapse-iii 展开后场景树与右侧检查器恢复");
    }
    const lightRowPoint = await cdp.evaluate(`(() => { const row = document.querySelector('[data-director-scene-tree="true"] [data-director-row-label="球体 B"]'); if (!row) return null; const r = row.getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
    const viewportPoint = await cdp.evaluate(`(() => { const r = document.querySelector('[data-director-workbench="true"] main')?.getBoundingClientRect(); return r ? {x:Math.round(r.left + r.width / 2),y:Math.round(r.top + r.height / 2)} : null; })()`);
    if (viewportPoint) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...viewportPoint, buttons: 0 });
    await sleep(250);
    const idleRowControls = await cdp.evaluate(`(() => { const row = document.querySelector('[data-director-scene-tree="true"] [data-director-row-label="球体 B"]'); const button = row?.querySelector('button[aria-label="隐藏球体 B"]'); return {opacity: button ? Number(getComputedStyle(button).opacity) : null, pointerEvents: button ? getComputedStyle(button).pointerEvents : null}; })()`);
    if (lightRowPoint) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...lightRowPoint, buttons: 0 });
    await sleep(250);
    const rowControlsRevealed = await cdp.poll(`(() => { const row = document.querySelector('[data-director-scene-tree="true"] [data-director-row-label="球体 B"]'); const button = row?.querySelector('button[aria-label="隐藏球体 B"]'); return !!button && Number(getComputedStyle(button).opacity) >= 0.95 && getComputedStyle(button).pointerEvents !== 'none'; })()`, "hover row controls fade in", 1200);
    const hoverRowControls = await cdp.evaluate(`(() => { const row = document.querySelector('[data-director-scene-tree="true"] [data-director-row-label="球体 B"]'); const button = row?.querySelector('button[aria-label="隐藏球体 B"]'); return {opacity: button ? Number(getComputedStyle(button).opacity) : null, pointerEvents: button ? getComputedStyle(button).pointerEvents : null}; })()`);
    assert(idleRowControls.opacity === 0 && idleRowControls.pointerEvents === "none" && rowControlsRevealed && hoverRowControls.opacity >= 0.95 && hoverRowControls.pointerEvents !== "none", "A5-assets-row 次级显隐操作默认收起，悬浮后出现并可点击", JSON.stringify({ idleRowControls, hoverRowControls }));
    const selectSceneObject = await cdp.click('[data-director-scene-tree="true"] [data-director-row-label="立方体 A"] > button:first-child');
    assert(selectSceneObject, "A5-assets-i 从左侧场景树选择对象");
    const inspectorTracksSelection = await cdp.poll(`(() => {
        const tree = document.querySelector('[data-director-scene-tree="true"]');
        const row = tree?.querySelector('[data-director-row-label="立方体 A"]');
        const inspector = document.querySelector('[data-director-property-inspector="true"]');
        const title = inspector?.querySelector('input');
        return row?.getAttribute('data-active') === 'true' && title?.value === '立方体 A';
    })()`, "selected object inspector", 5000);
    const selectionState = await cdp.evaluate(`(() => {
        const row = document.querySelector('[data-director-scene-tree="true"] [data-director-row-label="立方体 A"]');
        const title = document.querySelector('[data-director-property-inspector="true"] input');
        return { rowActive: row?.getAttribute('data-active'), inspectorTitle: title?.value || null };
    })()`);
    assert(inspectorTracksSelection, "A5-assets-ii 选择左侧树项后右侧检查器同步显示对象属性", JSON.stringify(selectionState));
    const cameraModeForFocus = await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="添加机位"]');
    if (!cameraModeForFocus) throw new Error("A: camera mode unavailable before asset-focus regression");
    const cameraModeReadyForFocus = await cdp.poll(`document.querySelector('[aria-label="导演台视口工具"]')?.getAttribute('data-director-mode') === 'camera'`, "camera mode before asset focus", 5000);
    if (!cameraModeReadyForFocus) throw new Error("A: camera mode did not activate before asset-focus regression");
    const sceneTreeForFocus = await openSceneTree(cdp);
    if (!sceneTreeForFocus) throw new Error("A: scene tree unavailable before asset-focus regression");
    const sceneRevisionBeforeFocus = await cdp.evaluate(`(() => [...document.querySelectorAll('section span')].find((item) => item.textContent === '场景 updatedAt')?.nextElementSibling?.textContent || '')()`);
    const focusRowPoint = await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('[data-director-scene-row]')].find((candidate) => candidate.getAttribute('data-director-row-label') === '立方体 A');
        const rect = row?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
    })()`);
    if (focusRowPoint) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...focusRowPoint, buttons: 0 });
        await sleep(250);
    }
    const focusCube = await cdp.click('[data-director-scene-row][data-director-row-label="立方体 A"] button[aria-label="聚焦立方体 A"]');
    const focusedCube = focusCube && await cdp.poll(`(() => document.querySelector('[aria-label="导演视角"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[aria-label="导演台视口工具"]')?.getAttribute('data-director-mode') === 'layout' && document.querySelector('[data-director-scene-row][data-director-row-label="立方体 A"]')?.getAttribute('data-active') === 'true')()`, "asset focus recenters free camera without losing inspector target", 5000);
    const sceneRevisionAfterFocus = await cdp.evaluate(`(() => [...document.querySelectorAll('section span')].find((item) => item.textContent === '场景 updatedAt')?.nextElementSibling?.textContent || '')()`);
    assert(focusedCube && sceneRevisionBeforeFocus === sceneRevisionAfterFocus, "A5-assets-focus 从摄影机模式聚焦资产后切换导演视角、保留属性选择且不改场景数据", JSON.stringify({ focusCube, focusedCube, sceneRevisionBeforeFocus, sceneRevisionAfterFocus }));
    const addSecondaryCameraTab = await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="添加机位"]');
    const addSecondaryCamera = addSecondaryCameraTab && await cdp.click('[data-director-left-dock] button[aria-label="当前视角"]');
    if (!addSecondaryCamera) throw new Error("A: unable to prepare a non-active camera focus regression");
    const returnToTreeForCameraFocus = await openSceneTree(cdp);
    if (!returnToTreeForCameraFocus) throw new Error("A: unable to restore scene tree for camera focus regression");
    const sceneRevisionBeforeCameraFocus = await cdp.evaluate(`(() => [...document.querySelectorAll('section span')].find((item) => item.textContent === '场景 updatedAt')?.nextElementSibling?.textContent || '')()`);
    const cameraRowPoint = await cdp.evaluate(`(() => { const row = [...document.querySelectorAll('[data-director-scene-row]')].find((item) => item.getAttribute('data-director-row-label') === '主摄影机'); const rect = row?.getBoundingClientRect(); return rect && rect.width > 0 && rect.height > 0 ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`);
    if (cameraRowPoint) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...cameraRowPoint, buttons: 0 });
        await sleep(250);
    }
    const focusNonActiveCamera = await cdp.click('[data-director-scene-row][data-director-row-label="主摄影机"] button[aria-label="聚焦主摄影机"]');
    const cameraFocusSettled = focusNonActiveCamera && await cdp.poll(`document.querySelector('[aria-label="导演视角"]')?.getAttribute('aria-pressed') === 'true'`, "focus non-active camera without selecting it for active shot", 5000);
    const sceneRevisionAfterCameraFocus = await cdp.evaluate(`(() => [...document.querySelectorAll('section span')].find((item) => item.textContent === '场景 updatedAt')?.nextElementSibling?.textContent || '')()`);
    assert(cameraFocusSettled && sceneRevisionBeforeCameraFocus === sceneRevisionAfterCameraFocus, "A5-assets-focus-camera 聚焦非当前机位只移动编辑视角，不替换镜头机位或写入场景", JSON.stringify({ focusNonActiveCamera, cameraFocusSettled, sceneRevisionBeforeCameraFocus, sceneRevisionAfterCameraFocus }));
    const backToLayoutForNavigation = await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="场景"]');
    if (!backToLayoutForNavigation) throw new Error("A: could not restore scene workspace after focus test");
    const switchedNavigation = await cdp.click('[data-director-workbench="true"] nav[aria-label="导演台工作区"] button[aria-label="添加角色"]');
    assert(switchedNavigation, "A5-assets-iii 场景资产栏可切换至角色导航");
    const onboardingPlacement = await cdp.evaluate(`(() => {
        const onboarding = document.querySelector('[aria-label="导演台上手引导"]');
        const actorButton = document.querySelector('[data-director-workbench="true"] nav[aria-label="导演台工作区"] button[aria-label="添加角色"]');
        const onboardingRect = onboarding?.getBoundingClientRect();
        const actorRect = actorButton?.getBoundingClientRect();
        return { visible: !!onboardingRect && onboardingRect.width > 0, clearOfRail: !!onboardingRect && !!actorRect && (onboardingRect.right <= actorRect.left || onboardingRect.left >= actorRect.right || onboardingRect.bottom <= actorRect.top || onboardingRect.top >= actorRect.bottom) };
    })()`);
    assert(onboardingPlacement.visible && onboardingPlacement.clearOfRail, "A5-assets-iii-a 新手引导浮层不再覆盖左侧工具轨道", JSON.stringify(onboardingPlacement));
    const dismissOnboarding = await cdp.click('[aria-label="导演台上手引导"] button:first-of-type');
    const onboardingDismissed = await cdp.poll(`!document.querySelector('[aria-label="导演台上手引导"]')`, "onboarding dismissed", 3000);
    const helpButton = await cdp.click('[data-director-rail-help="true"]');
    const onboardingReopened = await cdp.poll(`document.querySelector('[aria-label="导演台上手引导"] p')?.textContent === '添加并选中演员'`, "help reopens onboarding at first step", 5000);
    assert(dismissOnboarding && onboardingDismissed && helpButton && onboardingReopened, "A5-assets-iii-b 左侧帮助入口可重新打开并从首步启动引导");
    const navRestored = await cdp.poll(`(() => {
        const root = document.querySelector('[data-director-workbench="true"]');
        const tree = root?.querySelector('[data-director-scene-tree="true"]');
        const actors = (root?.innerText || '').includes('添加角色');
        return !tree && actors;
    })()`, "actor navigation content", 5000);
    assert(navRestored, "A5-assets-iv 切换工具栏后资产树收起且既有角色面板正常显示");
    const actorPresetPanel = await cdp.evaluate(`(() => {
        const panel = document.querySelector('[data-director-left-dock="true"]');
        const wanted = ['本地上传', '标准男性', '标准女性', '健硕', '纤细', '少年', '儿童', '宽厚', '二头身', '群众 (3x3)', '几何模型'];
        const labels = [...(panel?.querySelectorAll('button') || [])].map((button) => button.getAttribute('aria-label') || (button.innerText || '').trim());
        return { present: wanted.filter((label) => labels.includes(label)), boxes: [...(panel?.querySelectorAll('[data-testid^="director-actor-preset-"]') || [])].slice(0, 2).map((button) => { const r=button.getBoundingClientRect(); return [Math.round(r.width),Math.round(r.height)]; }) };
    })()`);
    assert(actorPresetPanel.present.length === 11 && actorPresetPanel.boxes.every(([width, height]) => width > 200 && height === 32), "A5-assets-iv-a 角色面板复刻 LibTV 的本地上传/人物体型/群众/几何预设纵向列表", JSON.stringify(actorPresetPanel));
    const geometryOpened = await cdp.click('[data-testid="director-actor-preset-geometric"]');
    const geometryItems = geometryOpened && await cdp.evaluate(`(() => { const menu = document.querySelector('[data-testid="director-geometry-submenu"]'); const labels = [...(menu?.querySelectorAll('button') || [])].map((button) => button.innerText.trim()); return ['上传文件','立方体','球体','圆柱体','环状体','圆锥','棱锥','添加空对象'].every((label) => labels.includes(label)); })()`);
    assert(geometryItems, "A5-assets-iv-a-i 几何模型展开 LibTV 对照中的完整子菜单");
    for (const [id, label] of [['torus', '环状体'], ['cone', '圆锥'], ['pyramid', '棱锥'], ['empty', '添加空对象']]) {
        await cdp.evaluate(`(() => { const item=document.querySelector('[data-testid="director-geometry-${id}"]'); item?.scrollIntoView({block:'nearest'}); return !!item; })()`);
        const added = await cdp.click(`[data-testid="director-geometry-${id}"]`);
        const sceneTab = added && await openSceneTree(cdp);
        const visible = sceneTab && await cdp.poll(`(() => [...document.querySelectorAll('[data-director-scene-tree="true"] [data-director-scene-row]')].some((row) => (row.innerText || '').includes(${JSON.stringify(label)})))()`, `${label} scene row`, 5000);
        assert(visible, `A5-assets-iv-a-ii ${label}从几何子菜单创建并加入场景`);
        await cdp.click('[data-director-workbench="true"] nav[aria-label="导演台工作区"] button[aria-label="添加角色"]');
    }
    for (let index = 0; index < 4; index += 1) {
        const undoMenu = await openDirectorNavigation(cdp);
        await cdp.evaluate(`document.querySelector('[role="menuitem"]')?.scrollIntoView({block:'nearest'})`);
        const undo = undoMenu && await cdp.clickText("撤销", '[role="menuitem"]');
        if (!undo) throw new Error(`A5-assets-iv-a-iii 几何模型 ${index + 1} 撤销失败`);
    }
    await cdp.click('[data-testid="director-actor-preset-geometric"]');
    const addLocalPreset = await cdp.click('[data-testid="director-actor-preset-standard_female"]');
    const localPresetAdded = addLocalPreset && await cdp.poll(`(() => {
        const rows = [...document.querySelectorAll('[data-director-scene-row]')];
        return rows.some((row) => (row.innerText || '').includes('标准女性 1'));
    })()`, "local female preset row", 5000);
    assert(localPresetAdded, "A5-assets-iv-b 选择角色预设后立即新增离线可编辑人物");
    const presetColor = await cdp.evaluate(`(() => document.querySelector('[data-director-property-inspector] [aria-label="设置颜色 #2f7de1"]')?.classList.contains('is-active'))()`);
    assert(presetColor, "A5-assets-iv-b-i 内置角色默认使用 LibTV 蓝色材质");
    const presetRequests = await cdp.evaluate(`performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /Xbot\\.glb|director-default-actor/i.test(name))`);
    assert(presetRequests.length === 0, "A5-assets-iv-c 添加角色预设不下载远程模型", JSON.stringify(presetRequests));
    const crowdClicked = await cdp.click('[data-testid="director-actor-crowd-3x3"]');
    const crowdConfigOpened = crowdClicked && await cdp.poll(`!!document.querySelector('[data-testid="director-crowd-dialog"]')`, "crowd configuration popover", 3000);
    assert(crowdConfigOpened, "A5-assets-iv-d 群众入口先打开阵列配置，不立即创建角色");
    const crowdBeforeCancel = await cdp.evaluate(`document.querySelectorAll('[data-director-left-dock="true"] [data-director-scene-row]').length`);
    const crowdCancel = await cdp.click('[data-testid="director-crowd-cancel"]');
    const crowdCancelUnchanged = crowdCancel && await cdp.poll(`!document.querySelector('[data-testid="director-crowd-dialog"]') && document.querySelectorAll('[data-director-left-dock="true"] [data-director-scene-row]').length === ${crowdBeforeCancel}`, "crowd cancel leaves scene unchanged", 3000);
    assert(crowdCancelUnchanged, "A5-assets-iv-d-i 取消群众配置关闭浮层且不改场景");
    const crowdReopen = await cdp.click('[data-testid="director-actor-crowd-3x3"]');
    const crowdInputs = crowdReopen && await cdp.poll(`!!document.querySelector('[data-testid="director-crowd-rows"]')`, "crowd fields available", 3000);
    if (crowdInputs) {
        for (const [selector, value] of [['[data-testid="director-crowd-rows"]', '2'], ['[data-testid="director-crowd-columns"]', '2'], ['[data-testid="director-crowd-spacing"]', '2']]) {
            await cdp.evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input?.focus(); input?.select(); return document.activeElement===input; })()`);
            await cdp.send("Input.insertText", { text: value });
        }
    }
    const crowdConfigured = crowdInputs && await cdp.poll(`Number(document.querySelector('[data-testid="director-crowd-rows"]')?.value) === 2 && Number(document.querySelector('[data-testid="director-crowd-columns"]')?.value) === 2 && Number(document.querySelector('[data-testid="director-crowd-spacing"]')?.value) === 2 && document.querySelector('[data-testid="director-crowd-count"]')?.innerText.includes('共 4 人')`, "crowd configuration reflects user input", 2000);
    assert(crowdConfigured, "A5-assets-iv-d-ii 配置输入与人数摘要同步为 2×2 / 4 人");
    const crowdAdd = crowdInputs && await cdp.click('[data-testid="director-crowd-add"]');
    const crowdReady = crowdAdd && await cdp.poll(`document.querySelectorAll('[data-director-left-dock="true"] [data-director-scene-row]').length === 5`, "four-member configured crowd rows", 7000);
    assert(crowdReady, "A5-assets-iv-d 配置 2×2 后创建四个群众角色");
    const crowdUndoMenu = await openDirectorNavigation(cdp);
    const crowdUndo = crowdUndoMenu && await cdp.clickText("撤销", '[role="menuitem"]');
    const crowdUndone = crowdUndo && await cdp.poll(`document.querySelectorAll('[data-director-left-dock="true"] [data-director-scene-row]').length === 1`, "crowd one-step undo", 5000);
    assert(crowdUndone, "A5-assets-iv-e 群众创建为单个可撤销历史步骤");
    const sceneImportOpened = await cdp.click('[data-director-workbench="true"] nav[aria-label="导演台工作区"] button[aria-label="AI 识图导入"]');
    const sceneImportPanel = sceneImportOpened && await cdp.poll(`!!document.querySelector('[role="dialog"] [data-testid="director-reference-dropzone"]') && !!document.querySelector('[role="dialog"] [data-testid="director-scene-history-tab"]')`, "scene image import modal", 4000);
    assert(sceneImportPanel, "A5-assets-iv-f AI 识图导入入口打开本地上传/历史记录弹窗");
    const recognitionFlowReady = await cdp.evaluate(`(() => { const root=document.querySelector('[role="dialog"]'); const generate=[...root?.querySelectorAll('button') || []].find(button => button.textContent?.includes('生成站位参考')); return !!generate && generate.disabled && !!root?.querySelector('[data-testid="director-layout-insert"]') && !!root?.querySelector('[data-testid="director-layout-replace"]') && (root.innerText || '').includes('作为站位参考层插入') && (root.innerText || '').includes('关闭不会中断识图任务'); })()`);
    assert(recognitionFlowReady, "A5-assets-iv-g 无参考图时禁用识图，并说明插入/覆盖语义及关闭后任务持续");
    const historyTab = await cdp.click('[data-testid="director-scene-history-tab"]');
    const historyVisible = historyTab && await cdp.poll(`document.querySelector('[role="dialog"]')?.innerText.includes('暂无图片历史') || !!document.querySelector('[role="dialog"] img')`, "image history tab", 4000);
    assert(historyVisible, "A5-assets-iv-h 识图历史可切换且保留素材入口");
    const assetsTab = await cdp.click('[data-testid="director-scene-assets-tab-modal"]');
    const oldAssetsVisible = assetsTab && await cdp.poll(`(document.querySelector('[role="dialog"]')?.innerText || '').includes('画布图片立牌') && (document.querySelector('[role="dialog"]')?.innerText || '').includes('图片素材历史')`, "preserved director assets", 4000);
    assert(oldAssetsVisible, "A5-assets-iv-i 旧 3D 模型与画布图片素材入口仍可用");
    const closeImportModal = await cdp.click('.ant-modal-close');
    const importModalClosed = closeImportModal && await cdp.poll(`!Array.from(document.querySelectorAll('.ant-modal-wrap')).some(node => { const rect=node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'; }) && document.querySelector('[data-director-workbench="true"] nav[aria-label="导演台工作区"] button[aria-label="场景"]')?.getAttribute('aria-pressed') === 'true'`, "image import modal closed and scene panel restored", 4000);
    assert(importModalClosed, "A5-assets-iv-j 关闭识图弹窗后返回导演台场景面板");
    const sceneButtonBox = await cdp.evaluate(`(() => { const button = document.querySelector('[data-director-workbench="true"] nav[aria-label="导演台工作区"] button[aria-label="场景"]'); if (!button) return null; const r = button.getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
    if (sceneButtonBox) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...sceneButtonBox, button: "left", buttons: 0 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...sceneButtonBox, button: "left", buttons: 1, clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...sceneButtonBox, button: "left", buttons: 0, clickCount: 1 });
    }
    const backToSceneAssets = await cdp.poll(`document.querySelector('[data-director-workbench="true"] nav[aria-label="导演台工作区"] button[aria-label="场景"]')?.getAttribute('aria-pressed') === 'true'`, "scene rail selection", 5000);
    assert(backToSceneAssets, "A5-assets-v 从角色导航可信点击返回项目资产栏", JSON.stringify(sceneButtonBox));
    const treeRestored = await cdp.poll(`!!document.querySelector('[data-director-scene-tree="true"]') && !!document.querySelector('[data-director-property-inspector="true"]')`, "scene assets navigation restored", 5000);
    assert(treeRestored, "A5-assets-vi 返回场景后资产树和属性检查器恢复");
    // Test the actual responsive CSS viewport; mobile emulation without a viewport meta tag
    // expands the layout viewport to 980px and makes the 390px assertions meaningless.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    const narrowDock = await cdp.evaluate(`(() => {
        const root = document.querySelector('[data-director-workbench="true"]');
        const viewport = root?.querySelector('main');
        const tree = root?.querySelector('[data-director-scene-tree="true"]');
        const rail = root?.querySelector('nav[aria-label="导演台工作区"]');
        const rootRect = root?.getBoundingClientRect();
        const viewportRect = viewport?.getBoundingClientRect();
        const treeRect = tree?.getBoundingClientRect();
        return {
            viewportFits: !!rootRect && !!viewportRect && viewportRect.width > 0 && viewportRect.left >= 0 && viewportRect.right <= rootRect.right,
            noHorizontalOverflow: !!rootRect && rootRect.width <= 390 && root.scrollWidth <= root.clientWidth,
            treeScrollable: !!tree && tree.scrollHeight >= tree.clientHeight,
            treeInLeftDock: !!treeRect && !!viewportRect && !!rail && treeRect.left >= rail.getBoundingClientRect().right && treeRect.right <= viewportRect.left,
            railWidth: Math.round(rail?.getBoundingClientRect().width || 0),
            viewportWidth: Math.round(viewportRect?.width || 0),
            rootWidth: Math.round(rootRect?.width || 0),
            rootClientWidth: root?.clientWidth || 0,
            rootScrollWidth: root?.scrollWidth || 0,
            windowWidth: window.innerWidth,
            visualViewportWidth: Math.round(window.visualViewport?.width || 0),
            gridColumns: root?.querySelector('.grid') ? getComputedStyle(root.querySelector('.grid')).gridTemplateColumns : '',
            treeHeight: Math.round(treeRect?.height || 0),
        };
    })()`);
    assert(narrowDock.viewportFits && narrowDock.noHorizontalOverflow && narrowDock.treeInLeftDock && narrowDock.railWidth <= 64, "A5-assets-vii 手机宽度下场景树仍位于左侧轨道旁且无横向溢出", JSON.stringify(narrowDock));
    const narrowControlBar = await cdp.evaluate(`(() => {
        const root = document.querySelector('[data-director-workbench="true"]');
        const viewport = root?.querySelector('main');
        const bar = root?.querySelector('.director-scene-control-bar');
        const dock = bar?.querySelector('.director-viewport-dock');
        const composer = bar?.querySelector('[role="group"][aria-label="场景描述"]');
        const rect = (element) => element?.getBoundingClientRect();
        const r = rect(bar), v = rect(viewport), d = rect(dock), c = rect(composer);
        return {
            stacked: !!bar && getComputedStyle(bar).flexDirection === 'column-reverse',
            visible: !!d && !!c && d.width > 0 && c.width > 0,
            fitsViewport: !!r && !!v && r.left >= v.left && r.right <= v.right,
            noHorizontalOverflow: !!root && root.scrollWidth <= root.clientWidth,
        };
    })()`);
    assert(narrowControlBar.stacked && narrowControlBar.visible && narrowControlBar.fitsViewport && narrowControlBar.noHorizontalOverflow, "A5-assets-vii-a 手机宽度下场景描述与工具栏纵向排列且完整可见", JSON.stringify(narrowControlBar));
    const narrowViewportWidth = narrowDock.viewportWidth;
    const narrowCollapse = await cdp.click('[aria-label="折叠场景面板"]');
    assert(narrowCollapse, "A5-assets-viii 窄屏顶部滚动栏中的折叠按钮可触达");
    if (narrowCollapse) {
        const narrowCollapsed = await cdp.poll(`(() => {
            const tree = document.querySelector('[data-director-scene-tree="true"]');
            const viewport = document.querySelector('[data-director-workbench="true"] main');
            const root = document.querySelector('[data-director-workbench="true"]');
            return !!tree && tree.getClientRects().length === 0 && !!root && root.scrollWidth <= root.clientWidth && Math.round(viewport?.getBoundingClientRect().width || 0) >= ${narrowViewportWidth} + 100;
        })()`, "narrow collapsed scene panel", 5000);
        assert(narrowCollapsed, "A5-assets-viii-a 窄屏折叠后场景树收起、视口扩展且无横向溢出", `initial=${narrowViewportWidth}`);
        const narrowExpand = await cdp.click('[aria-label="展开场景面板"]');
        assert(narrowExpand, "A5-assets-viii-b 窄屏可重新展开场景面板");
        const narrowRestored = await cdp.poll(`document.querySelector('[data-director-scene-tree="true"]')?.getClientRects().length > 0`, "narrow scene panel restored", 5000);
        assert(narrowRestored, "A5-assets-viii-c 窄屏展开后场景树恢复");
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.poll(`window.innerWidth >= 1280`, "desktop viewport restored", 5000);
    await cdp.poll(`window.innerWidth > 390`, "desktop viewport restored", 5000);
    const floatingHeader = await cdp.evaluate(`(() => {
        const header = document.querySelector('[data-director-topbar="true"]');
        const viewport = document.querySelector('[data-director-workbench="true"] main');
        const actions = header?.querySelector('[data-director-topbar-group="actions"]');
        const actionRect = actions?.getBoundingClientRect();
        return {
            floating: !!header && getComputedStyle(header).position === 'absolute',
            groups: header?.querySelectorAll('[data-director-topbar-group]').length || 0,
            viewportStartsAtTop: !!viewport && Math.round(viewport.getBoundingClientRect().top) === 0,
            actionsMovedOut: !actions,
            saveStatusVisible: !!header?.querySelector('[aria-label="导演台保存状态"]'),
            actionWidth: Math.round(actionRect?.width || 0),
        };
    })()`);
    assert(floatingHeader.floating && floatingHeader.groups === 1 && floatingHeader.viewportStartsAtTop && floatingHeader.actionsMovedOut && floatingHeader.saveStatusVisible, "A5-top 顶栏收敛为项目标题，保存状态保留", JSON.stringify(floatingHeader));
    const toolsMenuOpened = await openDirectorTools(cdp);
    assert(toolsMenuOpened, "A5-tools 三工具 dock 的扩展工具子菜单可达");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    const sceneAddOpened = await cdp.click('[aria-label="添加场景对象"]');
    const sceneAddInventory = sceneAddOpened && await cdp.evaluate(`(() => {
        const text = document.body.innerText || '';
        return ["演员", "立方体", "球体", "上传模型"].every((label) => text.includes(label));
    })()`);
    assert(sceneAddInventory, "A5-tools-i 场景对象添加统一位于场景树标题菜单");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    if (process.env.DIRECTOR_E2E_SCENE_SCREENSHOT) {
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(process.env.DIRECTOR_E2E_SCENE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
    }

    const previewMenu = await openDirectorNavigation(cdp);
    const preview = previewMenu && await cdp.clickText("成片预演", '[role="menuitem"]');
    if (!preview) throw new Error("A: 成片预演工作区按钮 not clickable");
    const previewReady = await cdp.poll(`(() => {
        const grid = document.querySelector('[data-director-workbench="true"] > .grid');
        return document.querySelector('[data-director-workbench="true"]')?.getAttribute('data-workspace-view') === 'preview'
            && document.querySelectorAll('.director-sequencer').length === 1
            && document.querySelector('.director-sequencer[data-presentation="preview"]')
            && !!document.querySelector('input[type="range"][aria-label="时间线缩放"]')
            && !!document.querySelector('[role="slider"][aria-label="预演时间线"]')
            && !!document.querySelector('button[aria-label="新增镜头"]')
            && !document.querySelector('button[title="自动关键帧"]')
            && !document.querySelector('button[title="吸附到帧"]')
            && !document.querySelector('button[title="记录当前关键帧"]')
            && !document.querySelector('.director-sequencer-resizer')
            && !!document.querySelector('textarea[aria-label="当前镜头意图"]')
            && !!document.querySelector('[data-director-aspect-frame="16:9"]')
            && !document.querySelector('[aria-label="导演台取景模式"]')
            && !document.querySelector('[aria-label="方向球"]')
            && document.querySelectorAll('nav[aria-label="导演台工作区"]').length === 0
            && document.querySelectorAll('nav[aria-label="导演台模式"]').length === 0
            && grid && getComputedStyle(grid).gridTemplateColumns.split(' ').length === 1;
    })()`, "cinema preview workspace", 20000);
    assert(previewReady, "A5a 成片预演聚焦单画布并显示时间线");
    const scrubbed = await cdp.click('[role="slider"][aria-label="预演时间线"]');
    if (!scrubbed) throw new Error("A: preview timeline not clickable");
    const scrubReady = await cdp.poll(`Number(document.querySelector('[role="slider"][aria-label="预演时间线"]')?.getAttribute('aria-valuenow') || 0) > 0`, "preview playhead scrub", 5000);
    assert(scrubReady, "A5a-i 预演时间线点击可定位播放头");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const narrowReady = await cdp.poll(`(() => {
        const sequencer = document.querySelector('.director-sequencer[data-presentation="preview"]');
        const rect = sequencer?.getBoundingClientRect();
        return !!rect && rect.width <= 390 && !!document.querySelector('input[aria-label="时间线缩放"]') && !!document.querySelector('button[aria-label="收起时间轴"]');
    })()`, "narrow preview timeline", 5000);
    assert(narrowReady, "A5a-ii 窄屏预演控件仍可见且不溢出视口");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    if (process.env.DIRECTOR_E2E_SCREENSHOT) {
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(process.env.DIRECTOR_E2E_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
    }
    const sceneMenu = await openDirectorNavigation(cdp);
    const sceneMenuVisible = sceneMenu && await cdp.poll(`!![...document.querySelectorAll('[role="menuitem"]')].find((item) => (item.textContent || '').trim() === '场景调度')`, "scene menu item visible", 5000);
    const sceneView = sceneMenuVisible && await cdp.clickText("场景调度", '[role="menuitem"]');
    if (!sceneView) throw new Error("A: 场景调度工作区按钮 not clickable");
    const sceneRestored = await cdp.poll(`(() => {
        return document.querySelector('[data-director-workbench="true"]')?.getAttribute('data-workspace-view') === 'scene'
            && document.querySelectorAll('nav[aria-label="导演台工作区"]').length === 1
            && document.querySelectorAll('.director-sequencer').length === 0;
    })()`, "scene workspace restored", 20000);
    assert(sceneRestored, "A5b 返回场景调度后恢复编辑栏和时间线状态");

    // P1-A 起 AutoKey/时间轴归属动画模式：默认摆场模式下它们必须不存在。
    const layoutGating = await cdp.evaluate(`(() => ({
        mode: document.querySelector('[aria-label="导演台视口工具"]')?.getAttribute('data-director-mode') ?? null,
        sequencer: document.querySelectorAll('.director-sequencer').length,
        autoKey: document.querySelectorAll('button[title="自动关键帧"]').length,
    }))()`);
    assert(layoutGating.mode === "layout", "A6 默认进入摆场模式", `got ${JSON.stringify(layoutGating.mode)}`);
    assert(layoutGating.sequencer === 0 && layoutGating.autoKey === 0, "A7 摆场模式不显示时间轴与 AutoKey", JSON.stringify(layoutGating));

    // 原 A6 的断言意图（AutoKey 默认不开启）在它真正存在的模式里继续守住。
    const animateMenu = await openDirectorNavigation(cdp);
    const switched = animateMenu && await cdp.clickText("动画", '[role="menuitem"]');
    if (!switched) throw new Error("A: 更多视口工具中的动画模式不可点击");
    const sequencerShown = await cdp.poll(`document.querySelectorAll('.director-sequencer').length === 1`, "sequencer in animate mode", 20000);
    assert(sequencerShown, "A8 动画模式显示时间轴");

    const autoKey = await cdp.evaluate(`document.querySelector('button[title="自动关键帧"]')?.getAttribute('aria-pressed') ?? null`);
    assert(autoKey === "false", "A9 AutoKey defaults to aria-pressed=false", `got ${JSON.stringify(autoKey)}`);

    const sceneAdd = await cdp.click('[aria-label="添加场景对象"]');
    if (!sceneAdd) throw new Error("A: 添加场景对象 button not clickable");
    const cubeMenuItemVisible = await cdp.poll(`!![...document.querySelectorAll('[role="menuitem"]')].find((item) => (item.textContent || '').trim() === '立方体')`, "add cube menu item visible", 5000);
    if (!cubeMenuItemVisible) throw new Error("A: 场景面板立方体 menu item 未渲染");
    const addedCube = await cdp.clickText("立方体", '[role="menuitem"]');
    if (!addedCube) throw new Error("A: 场景面板立方体 menu item not clickable");
    const cubeAppeared = await cdp.poll(`[...document.querySelectorAll('[data-director-scene-row]')].some((row) => (row.innerText || '').trim() === '立方体')`, "cube row", 20000);
    assert(cubeAppeared, "A10 added cube appears in object list");

    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "r", code: "KeyR", text: "r", windowsVirtualKeyCode: 82 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "r", code: "KeyR", windowsVirtualKeyCode: 82 });
    const rotateShortcutWorks = await cdp.poll(`document.querySelector('[aria-label="导演台视口工具"] button[aria-label="旋转"]') !== null`, "rotate shortcut after menu selection", 5000);
    assert(rotateShortcutWorks, "A10-hotkey 菜单添加对象后 R 变换快捷键仍可触发");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "w", code: "KeyW", text: "w", windowsVirtualKeyCode: 87 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "w", code: "KeyW", windowsVirtualKeyCode: 87 });
    const translateShortcutRestored = await cdp.poll(`document.querySelector('[aria-label="导演台视口工具"] button[aria-label="移动"]') !== null`, "translate shortcut restored", 5000);
    assert(translateShortcutRestored, "A10-hotkey-i W 变换快捷键可从菜单操作后恢复移动模式");

    const undoMenu = await openDirectorNavigation(cdp);
    const undone = undoMenu && await cdp.clickText("撤销", '[role="menuitem"]');
    if (!undone) throw new Error("A: 撤销 button not clickable");
    const cubeGone = await cdp.poll(`![...document.querySelectorAll('[data-director-scene-row]')].some((row) => (row.innerText || '').trim() === '立方体')`, "cube removed by undo", 20000);
    assert(cubeGone, "A11 Undo removes the added cube");

    // 场景结束前必须真实关闭：下一个场景要重新导航，不能靠忽略 beforeunload 绕过未保存态。
    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("A: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 30000);
    assert(shellGone, "A12 workbench closed cleanly before leaving scenario A");

    assert(cdp.problems.length === 0, "A13 no browser problems in scenario A", JSON.stringify(cdp.problems));
}

/** Isolated, fast browser regression for the actual side-follow preset interaction. */
async function sideFollowPreset(cdp, baseUrl) {
    console.log("\n=== G. actor side-follow camera preset ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("G: director workbench could not open");
    const canvasReady = await cdp.poll(`!!document.querySelector('.director-viewport-shell canvas')`, "actor scene canvas", 30000);
    if (!canvasReady) throw new Error("G: actor scene did not mount");
    const sceneTab = await openSceneTree(cdp);
    const camerasTab = sceneTab && await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="添加机位"]');
    const presetClicked = camerasTab && await cdp.click('[data-director-left-dock] button[aria-label="侧面跟拍"]');
    if (!presetClicked) throw new Error("G: side-follow preset could not be selected");
    const bound = await cdp.poll(`(() => {
        const lines = (document.querySelector('[data-director-property-inspector="true"]')?.innerText || '').split('\\n').map((line) => line.trim());
        const follow = lines.indexOf('跟随目标');
        const lookAt = lines.indexOf('注视目标');
        return follow >= 0 && lookAt >= 0 && lines[follow + 1] === '演员 1' && lines[lookAt + 1] === '演员 1';
    })()`, "side-follow fields bind to actor", 5000);
    const visibleValues = await cdp.evaluate(`(() => {
        const lines = (document.querySelector('[data-director-property-inspector="true"]')?.innerText || '').split('\\n').map((line) => line.trim());
        const follow = lines.indexOf('跟随目标');
        const lookAt = lines.indexOf('注视目标');
        return { follow: follow >= 0 ? lines[follow + 1] : null, lookAt: lookAt >= 0 ? lines[lookAt + 1] : null };
    })()`);
    assert(bound, "G1 侧面跟拍真实预设自动绑定当前演员的位置跟随和注视", JSON.stringify(visibleValues));
    const actorRequests = await cdp.evaluate(`performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /Xbot\\.glb|director-default-actor/i.test(name))`);
    assert(actorRequests.length === 0, "G2 侧面跟拍保持本地人物场景离线", JSON.stringify(actorRequests));
}

/** The selected actor inspector keeps staging properties separate from pose and rig controls. */
async function actorPoseInspector(cdp, baseUrl) {
    console.log("\n=== H. actor property/pose inspector ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("H: director workbench could not open");
    const canvasReady = await cdp.poll(`!!document.querySelector('.director-viewport-shell canvas')`, "actor scene canvas", 30000);
    if (!canvasReady) throw new Error("H: actor scene did not mount");
    const sceneTab = await openSceneTree(cdp);
    if (!sceneTab) throw new Error("H: scene tree could not open");
    const actorRow = '[data-director-scene-row][data-director-row-label="演员 1"] button:first-child';
    const actorReady = await cdp.poll(`!!document.querySelector(${JSON.stringify(actorRow)})`, "actor scene row", 10000);
    assert(actorReady, "H1 default scene exposes selectable actor");
    await cdp.click(actorRow);
    const navigation = await openDirectorNavigation(cdp);
    const poseMode = navigation && await cdp.clickText("姿态", '[role="menuitem"]');
    if (!poseMode) throw new Error("H: pose mode menu item not clickable");
    const tabsReady = await cdp.poll(`!!document.querySelector('[role="tablist"][aria-label="角色属性"]')`, "actor property/pose tabs", 5000);
    assert(tabsReady, "H2 selected actor exposes distinct 属性 / 姿势 tabs");
    const propertiesVisible = await cdp.evaluate(`(() => {
        const panel = document.querySelector('[data-director-property-inspector="true"]');
        const tabs = panel?.querySelector('[role="tablist"][aria-label="角色属性"]');
        return tabs?.querySelector('[role="tab"]')?.getAttribute('aria-selected') === 'true'
            && (panel?.innerText || '').includes('统一缩放')
            && !panel?.querySelector('.director-pose-grid');
    })()`);
    assert(propertiesVisible, "H3 属性 tab shows transform controls without duplicating pose controls");
    await cdp.click('[role="tablist"][aria-label="角色属性"] [role="tab"]:last-child');
    const poseVisible = await cdp.poll(`(() => {
        const panel = document.querySelector('[data-director-property-inspector="true"]');
        const tabs = panel?.querySelector('[role="tablist"][aria-label="角色属性"]');
        return tabs?.querySelector('[role="tab"]:last-child')?.getAttribute('aria-selected') === 'true'
            && panel?.querySelectorAll('.director-pose-button').length === 20
            && ![...panel.querySelectorAll('input')].some((input) => input.getAttribute('aria-label') === '统一缩放滑杆');
    })()`, "pose tab shows presets only", 5000);
    assert(poseVisible, "H4 姿势 tab contains all 20 pose presets and hides staging controls");
    await cdp.click('.director-pose-button[title="招手"]');
    const poseApplied = await cdp.poll(`document.querySelector('.director-pose-button[title="招手"]')?.classList.contains('is-active')`, "wave pose applies", 5000);
    assert(poseApplied, "H5 choosing a pose updates the active actor pose");
    const headChoiceReady = await cdp.poll(`!!document.querySelector('[aria-label="选择骨骼 头部"]')`, "quick head-bone selection", 30000);
    assert(headChoiceReady, "H6 rig-ready actor exposes body-grouped bone shortcuts");
    if (headChoiceReady) await cdp.click('[aria-label="选择骨骼 头部"]');
    const headSelected = headChoiceReady && await cdp.poll(`document.querySelector('[aria-label="选择骨骼 头部"]')?.getAttribute('aria-pressed') === 'true'`, "head bone selected", 5000);
    assert(headSelected, "H7 selecting head shortcut targets the head for existing gizmo/rotation controls");
    const detailedBonesReady = await cdp.poll(`(() => {
        const rows = document.querySelectorAll('[data-director-bone-row]');
        const headAngle = document.querySelector('[aria-label="头部 X 角度"]');
        return rows.length >= 15 && !!headAngle;
    })()`, "all bone angle controls", 5000);
    assert(detailedBonesReady, "H8 pose inspector exposes per-bone angle controls instead of requiring one-at-a-time selection");

    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    const offlineFixture = await cdp.clickText("人物视觉对照场景", "button");
    const offlineWorkbench = offlineFixture && await cdp.click('[data-testid="toggle-workbench"]');
    if (!offlineWorkbench) throw new Error("H: offline procedural actor fixture could not open");
    await cdp.click('[data-director-left-dock] nav[aria-label="导演台工作区"] button[aria-label="场景"]');
    const offlineActorRow = '[data-director-scene-row][data-director-row-label="演员 1"] button:first-child';
    const offlineActorReady = await cdp.poll(`!!document.querySelector(${JSON.stringify(offlineActorRow)})`, "offline actor scene row", 10000);
    assert(offlineActorReady, "H9 offline parity fixture exposes a selectable procedural actor");
    if (offlineActorReady) await cdp.click(offlineActorRow);
    const offlineNavigation = await openDirectorNavigation(cdp);
    const offlinePoseMode = offlineNavigation && await cdp.clickText("姿态", '[role="menuitem"]');
    if (!offlinePoseMode) throw new Error("H: offline pose mode menu item not clickable");
    await cdp.click('[role="tablist"][aria-label="角色属性"] [role="tab"]:last-child');
    const offlineHeadReady = await cdp.poll(`!!document.querySelector('[aria-label="选择骨骼 头部"]')`, "offline actor head joint", 5000);
    assert(offlineHeadReady, "H10 offline procedural actor exposes directly selectable bones");
    if (offlineHeadReady) await cdp.click('[aria-label="选择骨骼 头部"]');
    const offlineGizmoReady = offlineHeadReady && await cdp.poll(`document.querySelector('[data-director-actor-label]')?.getAttribute('data-director-bone-gizmo-target') === 'head'`, "offline head rotation gizmo target", 5000);
    assert(offlineGizmoReady, "H11 selecting an offline bone activates its direct viewport rotation gizmo");
    if (offlineGizmoReady) {
        const gizmoPoint = await cdp.evaluate(`(() => {
            const label = document.querySelector('[data-director-actor-label]')?.getBoundingClientRect();
            return label ? { x: Math.round(label.left + label.width / 2 + 40), y: Math.round(label.bottom + 26) } : null;
        })()`);
        if (!gizmoPoint) throw new Error("H: selected offline actor label missing before gizmo drag");
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...gizmoPoint, buttons: 0 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...gizmoPoint, button: "left", buttons: 1, clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: gizmoPoint.x, y: gizmoPoint.y + 24, button: "left", buttons: 1, clickCount: 1, deltaX: 0, deltaY: 24 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: gizmoPoint.x, y: gizmoPoint.y + 24, button: "left", buttons: 0, clickCount: 1 });
        const directRotation = await cdp.poll(`(() => {
            const target = document.querySelector('[data-director-actor-label]')?.getAttribute('data-director-bone-gizmo-target');
            const values = [...document.querySelectorAll('[data-director-bone-row="head"] input')].map((input) => Number(input.value));
            return target === 'head' && values.some((value) => Math.abs(value) > 0.1);
        })()`, "drag updates offline head rotation without losing selection", 5000);
        assert(directRotation, "H12 dragging the offline bone gizmo previews and commits a visible joint rotation");
    }
}

/** Camera aids are selectable in the viewport and expose the same transform gizmo as actors. */
async function cameraDirectManipulation(cdp, baseUrl) {
    console.log("\n=== I. direct camera selection/manipulation ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("I: director workbench could not open");
    const sceneTab = await openSceneTree(cdp);
    if (!sceneTab) throw new Error("I: scene tree could not open");
    const marker = await cdp.poll(`!!document.querySelector('[data-director-camera-label]')`, "camera viewport marker", 15000);
    assert(marker, "I1 scene renders a camera aid that can be directly selected");
    if (marker) {
        const point = await cdp.evaluate(`(() => {
            const label = document.querySelector('[data-director-camera-label]')?.getBoundingClientRect();
            return label ? { x: Math.round(label.left + label.width / 2), y: Math.round(label.bottom + 20) } : null;
        })()`);
        if (!point) throw new Error("I: camera aid label missing before selection");
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
        const selected = await cdp.poll(`!!document.querySelector('[data-director-camera-gizmo-target]')`, "camera selected from viewport", 5000);
        assert(selected, "I2 clicking the visible camera aid selects it and shows its gizmo");
        if (selected) {
            const initialX = await cdp.evaluate(`(() => {
                const field = [...document.querySelectorAll('[data-director-property-inspector] label')].find((label) => (label.innerText || '').trim() === '摄影机位置');
                return Number(field?.querySelector('input')?.value);
            })()`);
            const axisPoint = await cdp.evaluate(`(() => {
                const label = document.querySelector('[data-director-camera-gizmo-target]')?.getBoundingClientRect();
                return label ? { x: Math.round(label.left + label.width / 2 + 65), y: Math.round(label.bottom + 29) } : null;
            })()`);
            const initialLabelX = await cdp.evaluate(`document.querySelector('[data-director-camera-gizmo-target]')?.getBoundingClientRect().left ?? NaN`);
            if (!axisPoint || !Number.isFinite(initialX)) throw new Error(`I: camera gizmo or position field missing before drag (point=${JSON.stringify(axisPoint)}, x=${initialX})`);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...axisPoint, buttons: 0 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...axisPoint, button: "left", buttons: 1, clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: axisPoint.x + 36, y: axisPoint.y, button: "left", buttons: 1, clickCount: 1, deltaX: 36, deltaY: 0 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: axisPoint.x + 36, y: axisPoint.y, button: "left", buttons: 0, clickCount: 1 });
            const moved = await cdp.poll(`(() => {
                const field = [...document.querySelectorAll('[data-director-property-inspector] label')].find((label) => (label.innerText || '').trim() === '摄影机位置');
                return Math.abs(Number(field?.querySelector('input')?.value) - ${initialX}) > 0.05;
            })()`, "camera drag updates position field", 5000);
            assert(moved, "I3 dragging the camera X gizmo commits a matching inspector position");
            const aidFollowed = await cdp.poll(`Math.abs((document.querySelector('[data-director-camera-gizmo-target]')?.getBoundingClientRect().left ?? ${initialLabelX}) - ${initialLabelX}) > 1`, "camera frustum/label follows live transform", 5000);
            assert(aidFollowed, "I4 camera label and frustum follow the dragged camera body");
            const stillSelected = await cdp.evaluate(`!!document.querySelector('[data-director-camera-gizmo-target]')`);
            assert(stillSelected, "I5 camera remains selected after its transform commits");
            await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "r", code: "KeyR", text: "r", windowsVirtualKeyCode: 82 });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "r", code: "KeyR", windowsVirtualKeyCode: 82 });
            const rotateMode = await cdp.poll(`!!document.querySelector('[aria-label="导演台视口工具"] button[aria-label="旋转"]')`, "camera rotation transform mode", 5000);
            if (!rotateMode) throw new Error("I: rotate transform mode could not be selected");
            const rotationPoint = await cdp.evaluate(`(() => {
                const label = document.querySelector('[data-director-camera-gizmo-target]')?.getBoundingClientRect();
                return label ? { x: Math.round(label.left + label.width / 2 + 90), y: Math.round(label.bottom + 20) } : null;
            })()`);
            if (!rotationPoint) throw new Error("I: camera rotation ring not available");
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...rotationPoint, buttons: 0 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...rotationPoint, button: "left", buttons: 1, clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rotationPoint.x + 2, y: rotationPoint.y + 28, button: "left", buttons: 1, clickCount: 1, deltaX: 2, deltaY: 28 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rotationPoint.x + 2, y: rotationPoint.y + 28, button: "left", buttons: 0, clickCount: 1 });
            const rotationAffectsFraming = await cdp.poll(`document.querySelector('[data-director-camera-gizmo-target]')?.getAttribute('data-director-camera-look-at-mode') === 'rotation'`, "camera rotation changes the active look-at semantics", 5000);
            assert(rotationAffectsFraming, "I6 rotating the camera updates the actual view direction mode");
        }
        if (process.env.DIRECTOR_E2E_CAMERA_SCREENSHOT) {
            const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            writeFileSync(process.env.DIRECTOR_E2E_CAMERA_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
        }
    }
    assert(cdp.problems.length === 0, "I6 no browser problems in camera manipulation scenario", JSON.stringify(cdp.problems));
}

/**
 * 场景 B：本地 triangle glTF。
 * 判据是集成层面的稳定窗口：5s 内不出现任何失败态且 canvas 持续可用。
 * 名称出现只证明对象在场景里，不等于 loader ready，因此不作为 ready 断言。
 */
async function localModel(cdp, baseUrl) {
    console.log("\n=== B. local triangle model ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await prepareP0Fixture(cdp, "B");

    const injected = await cdp.click('[data-testid="inject-local-model"]');
    if (!injected) throw new Error("B: inject-local-model not clickable");
    const counted = await cdp.poll(`(document.querySelector('[data-testid="object-count"]')?.textContent || "").includes('4')`, "object count 4", 15000);
    assert(counted, "B1 local model injected into scene");

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("B: toggle-workbench not clickable");

    const workbenchReady = await cdp.poll(`!!document.querySelector('[data-director-workbench="true"]')`, "workbench mounted", 20000);
    assert(workbenchReady, "B1a workbench mounted before reading scene rows");
    const sceneTreeOpened = await openSceneTree(cdp);
    assert(sceneTreeOpened, "B1b 场景树从默认机位工作区可达");

    const rowReady = await cdp.poll(`[...document.querySelectorAll('[data-director-scene-row]')].some((row) => (row.innerText || '').includes('本地模型 repro triangle'))`, "model row", 30000);
    assert(rowReady, "B2 local model row present in object list");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "B3 real canvas present");

    await sleep(5000);

    const stable = await cdp.evaluate(`(() => {
        const t = document.body.innerText || "";
        const c = document.querySelector('.director-viewport-shell canvas');
        return {
            modelFailed: t.includes('个 3D 模型加载失败'),
            retryLoad: [...document.querySelectorAll('.director-viewport-notice button')].some((b) => (b.textContent || "").includes('重试加载') && b.getClientRects().length > 0),
            renderFailed: t.includes('3D 视口渲染失败'),
            contextLost: t.includes('3D 显示上下文已丢失'),
            canvasUsable: !!c && c.clientWidth > 0 && c.clientHeight > 0,
        };
    })()`);
    assert(!stable.modelFailed, "B4 no model-load-failed notice", JSON.stringify(stable));
    assert(!stable.retryLoad, "B5 no retry-load affordance");
    assert(!stable.renderFailed, "B6 no viewport render failure");
    assert(!stable.contextLost, "B7 no WebGL context-lost notice");
    assert(stable.canvasUsable, "B8 5s 稳定窗口内无失败且 canvas 持续可用");

    assert(cdp.problems.length === 0, "B9 no browser problems in scenario B", JSON.stringify(cdp.problems));
}

/** Offline real GLTF animation: exercise clip selection, FPS-snapped start time, timeline placement and rendered motion. */
async function animatedPersonMotionClip(cdp, baseUrl) {
    console.log("\n=== G. animated person motion clip ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await prepareP0Fixture(cdp, "G");
    const injected = await cdp.click('[data-testid="inject-animated-person"]');
    assert(injected, "G1 offline animated person injection control works");
    const objectReady = await cdp.poll(`(document.querySelector('[data-testid="object-count"]')?.textContent || '').includes('4')`, "animated person injected", 10000);
    assert(objectReady, "G2 same-origin animated person added once");
    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("G: workbench not opened");
    const workbenchReady = await cdp.poll(`!!document.querySelector('[data-director-workbench="true"]')`, "animated workbench mounted", 20000);
    assert(workbenchReady, "G3 real workbench opened for animated person");
    const tree = await openSceneTree(cdp);
    assert(tree, "G4 scene tree opened");
    const rowSelector = '[data-director-scene-row][data-director-row-label="离线动画人物"] button:first-child';
    const rowReady = await cdp.poll(`!!document.querySelector(${JSON.stringify(rowSelector)})`, "animated person scene row", 10000);
    assert(rowReady, "G5 animated person is selectable in scene tree");
    await cdp.click(rowSelector);

    const navigation = await openDirectorNavigation(cdp);
    const poseMode = navigation && await cdp.clickText("姿态", '[role="menuitem"]');
    if (!poseMode) throw new Error("G: pose mode menu item not clickable");
    const clipSelectorReady = await cdp.poll(`!!document.querySelector('[aria-label="动作片段"]')`, "loaded motion clip inspector", 30000);
    assert(clipSelectorReady, "G6 GLTFLoader exposed its real animation clip to the inspector");
    const selectClicked = await cdp.click('[aria-label="动作片段"]');
    assert(selectClicked, "G6a action clip selector opens from its accessible name");
    const optionReady = await cdp.poll(`!![...document.querySelectorAll('.ant-select-item-option-content')].find((item) => (item.textContent || '').trim() === '手臂摆动')`, "motion clip option", 5000);
    const selectorDebug = optionReady ? null : await cdp.evaluate(`(() => ({
        controls: [...document.querySelectorAll('[aria-label="动作片段"]')].map((item) => ({ tag: item.tagName, role: item.getAttribute('role'), html: item.outerHTML.slice(0, 700) })),
        options: [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent?.trim()),
        menus: [...document.querySelectorAll('.ant-select-dropdown')].map((item) => ({ text: item.innerText, display: getComputedStyle(item).display, visibility: getComputedStyle(item).visibility })),
    }))()`);
    assert(optionReady, "G7 animated asset offers 手臂摆动 clip", JSON.stringify(selectorDebug));
    const optionDebug = await cdp.evaluate(`(() => ({ contents: [...document.querySelectorAll('.ant-select-dropdown *')].filter((item) => item.childElementCount === 0 && (item.textContent || '').trim() === '手臂摆动').map((item) => ({ tag: item.tagName, cls: item.className, role: item.getAttribute('role'), html: item.outerHTML.slice(0, 500), rect: (() => { const r = item.getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height }; })(), hit: (() => { const r=item.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,250) })() })) }))()`);
    const selected = await cdp.clickOptionContent("手臂摆动");
    if (!selected) console.log(`      motion option DOM: ${JSON.stringify(optionDebug)}`);
    if (!selected) throw new Error("G: motion clip option not clickable");
    const selectedClip = await cdp.poll(`[...document.querySelectorAll('.ant-select-selection-item')].some((item) => item.textContent?.trim() === '手臂摆动')`, "selected motion clip", 5000);
    assert(selectedClip, "G7 animated asset offers and selects 手臂摆动 clip");
    const startInputReady = await cdp.poll(`!!document.querySelector('input[aria-label="动作开始时间"]')`, "motion start control", 5000);
    assert(startInputReady, "G8 selecting a clip reveals its start-time control");
    const startInput = await cdp.click('input[aria-label="动作开始时间"]');
    if (!startInput) throw new Error("G: motion start input not clickable");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Meta", code: "MetaLeft", modifiers: 4 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", modifiers: 0 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "1", code: "Digit1", text: "1", unmodifiedText: "1" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "1", code: "Digit1" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ".", code: "Period", text: ".", unmodifiedText: "." });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ".", code: "Period" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "2", code: "Digit2", text: "2", unmodifiedText: "2" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "2", code: "Digit2" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "5", code: "Digit5", text: "5", unmodifiedText: "5" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "5", code: "Digit5" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    const snapped = await cdp.poll(`document.querySelector('input[aria-label="动作开始时间"]')?.value === '1.25'`, "motion start snapped to frame", 5000);
    const inputDebug = snapped ? null : await cdp.evaluate(`(() => ({ value: document.querySelector('input[aria-label="动作开始时间"]')?.value, html: document.querySelector('input[aria-label="动作开始时间"]')?.outerHTML, timeline: document.querySelector('.director-sequencer')?.outerHTML.slice(0, 500) }))()`);
    assert(snapped, "G9 start time is editable and retained on the 24fps frame grid", JSON.stringify(inputDebug));
    const timelinePlacement = await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('.director-sequencer-row')].find((item) => item.querySelector('.director-sequencer-label')?.textContent?.trim() === '动作片段');
        const clip = row?.querySelector('.director-sequencer-clip');
        return { left: clip?.style.left || '', width: clip?.style.width || '', label: clip?.textContent?.trim() || '' };
    })()`);
    assert(timelinePlacement.left === "31.25%" && timelinePlacement.label.includes("手臂摆动"), "G10 action clip position follows its start time on the timeline", JSON.stringify(timelinePlacement));

    const canvasRect = await cdp.evaluate(`(() => { const rect = document.querySelector('.director-viewport-shell canvas')?.getBoundingClientRect(); return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()`);
    if (!canvasRect) throw new Error("G: rendered canvas unavailable for motion comparison");
    const before = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...canvasRect, scale: 1 } });
    const trackClicked = await cdp.click('.director-sequencer-ruler');
    if (!trackClicked) throw new Error("G: preview timeline not clickable");
    const moved = await cdp.poll(`document.querySelector('.director-sequencer-playhead')?.style.left === '50%'`, "timeline playhead advanced to two seconds", 5000);
    const afterRect = await cdp.evaluate(`(() => { const rect = document.querySelector('.director-viewport-shell canvas')?.getBoundingClientRect(); return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()`);
    const after = afterRect && await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...afterRect, scale: 1 } });
    assert(trackClicked && moved && Boolean(after) && before.data !== after.data, "G11 scrubbing the timeline visibly changes the animated GLTF render");
    assert(cdp.problems.length === 0, "G12 no browser errors while playing an offline GLTF animation", JSON.stringify(cdp.problems));
    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("G: close workbench failed");
}

/**
 * 场景 C：缺失模型失败 → 用户重试 → 第二轮失败。
 * 通过「提示消失再重新出现」证明重试真的重跑了加载，而不是命中陈旧提示。
 */
async function missingRetry(cdp, baseUrl) {
    console.log("\n=== C. missing model failure and retry ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await prepareP0Fixture(cdp, "C");

    const injected = await cdp.click('[data-testid="inject-missing-model"]');
    if (!injected) throw new Error("C: inject-missing-model not clickable");
    const counted = await cdp.poll(`(document.querySelector('[data-testid="object-count"]')?.textContent || "").includes('4')`, "object count 4", 15000);
    assert(counted, "C1 missing model injected into scene");

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("C: toggle-workbench not clickable");

    const failed = await cdp.poll(`/个 3D 模型加载失败/.test(document.body.innerText || "")`, "load-failed notice", 40000);
    assert(failed, "C2 model-load-failed notice appears");
    const retryVisible = await cdp.poll(`[...document.querySelectorAll('button')].some((b) => (b.textContent || "").includes('重试加载'))`, "retry affordance", 20000);
    assert(retryVisible, "C3 actionable 重试加载 affordance present");

    const clickedRetry = await cdp.clickText("重试加载");
    if (!clickedRetry) throw new Error("C: 重试加载 button not clickable");

    const noticeCleared = await cdp.poll(`!/个 3D 模型加载失败/.test(document.body.innerText || "")`, "notice cleared after retry", 20000);
    assert(noticeCleared, "C4 notice clears when retry restarts the load");
    const failedAgain = await cdp.poll(`/个 3D 模型加载失败/.test(document.body.innerText || "")`, "second-round failure", 40000);
    assert(failedAgain, "C5 second-round failure after retry");

    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("C: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 20000);
    assert(shellGone, "C6 workbench closed cleanly");

    const refreshed = await cdp.click('[data-testid="refresh-events"]');
    if (!refreshed) throw new Error("C: refresh-events not clickable");

    const hasRetryCode = await cdp.poll(`(document.body.innerText || "").includes('DIRECTOR_MODEL_LOAD_RETRY')`, "retry diagnostic", 20000);
    assert(hasRetryCode, "C7 DIRECTOR_MODEL_LOAD_RETRY recorded");
    const twoFailures = await cdp.poll(`((document.body.innerText || "").match(/DIRECTOR_MODEL_LOAD_FAILED/g) || []).length >= 2`, "two load failures", 20000);
    const failCount = await cdp.evaluate(`((document.body.innerText || "").match(/DIRECTOR_MODEL_LOAD_FAILED/g) || []).length`);
    assert(twoFailures, "C8 DIRECTOR_MODEL_LOAD_FAILED recorded at least twice", `count=${failCount}`);

    assert(cdp.problems.length === 0, "C9 no browser problems in scenario C", JSON.stringify(cdp.problems));
}

/**
 * 场景 D：加载中删除。
 * 用真实网络节流把 GLB 拉长到仍在飞行中，再立刻删除对象；
 * 恢复网络后必须没有晚到回流，也不能为已删除对象记任何失败诊断。
 */
async function deleteWhileLoading(cdp, baseUrl) {
    console.log("\n=== D. delete while loading (throttled) ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);
    await prepareP0Fixture(cdp, "D");

    try {
        await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 3000,
            downloadThroughput: 20000,
            uploadThroughput: 20000,
            connectionType: "cellular3g",
        });

        const injected = await cdp.click('[data-testid="inject-local-model"]');
        if (!injected) throw new Error("D: inject-local-model not clickable");
        const opened = await cdp.click('[data-testid="toggle-workbench"]');
        if (!opened) throw new Error("D: toggle-workbench not clickable");

        const workbenchReady = await cdp.poll(`!!document.querySelector('[data-director-workbench="true"]')`, "workbench mounted", 20000);
        assert(workbenchReady, "D0a workbench mounted before reading scene rows");
        const sceneTreeOpened = await openSceneTree(cdp);
        assert(sceneTreeOpened, "D0b 加载中删除用例可切入场景树");

        const rowReady = await cdp.poll(`[...document.querySelectorAll('[data-director-scene-row]')].some((row) => (row.innerText || '').includes('本地模型 repro triangle'))`, "model row", 30000);
        assert(rowReady, "D1 model row present while load still in flight");

        const selected = await cdp.clickText("本地模型 repro triangle");
        if (!selected) throw new Error("D: model row not selectable");
        const deleteReady = await cdp.poll(`!!document.querySelector('[data-director-property-inspector] button[aria-label="删除"]')`, "selected model delete action", 10000);
        assert(deleteReady, "D1a selecting model exposes inspector delete action");
        const deleteButtonRect = await cdp.evaluate(`(() => {
            const button=document.querySelector('[data-director-property-inspector] button[aria-label="删除"]');
            const r=button?.getBoundingClientRect();
            if (!button || !r) return null;
            const x=r.left+r.width/2, y=r.top+r.height/2, hit=document.elementFromPoint(x,y);
            return {top:Math.round(r.top),bottom:Math.round(r.bottom),hitTarget:hit===button||button.contains(hit),visible:r.width>0&&r.height>0};
        })()`);
        assert(deleteButtonRect && deleteButtonRect.visible && deleteButtonRect.hitTarget, "D1b inspector delete control remains independently clickable outside the floating topbar hit region", JSON.stringify(deleteButtonRect));
        const deleted = await cdp.click('[data-director-property-inspector] button[aria-label="删除"]');
        if (!deleted) throw new Error("D: inspector delete action not clickable");
        const gone = await cdp.poll(`!(document.body.innerText || "").includes('本地模型 repro triangle')`, "name removed", 20000);
        assert(gone, "D2 object removed while its load was in flight");
    } finally {
        await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
        });
    }

    await sleep(5000);

    const settled = await cdp.evaluate(`(() => {
        const t = document.body.innerText || "";
        const c = document.querySelector('.director-viewport-shell canvas');
        return {
            nameBack: t.includes('本地模型 repro triangle'),
            modelFailed: t.includes('个 3D 模型加载失败'),
            retryLoad: [...document.querySelectorAll('.director-viewport-notice button')].some((b) => (b.textContent || "").includes('重试加载') && b.getClientRects().length > 0),
            renderFailed: t.includes('3D 视口渲染失败'),
            contextLost: t.includes('3D 显示上下文已丢失'),
            canvasUsable: !!c && c.clientWidth > 0 && c.clientHeight > 0,
        };
    })()`);
    assert(!settled.nameBack, "D3 no late-arriving reflow of the deleted object", JSON.stringify(settled));
    assert(!settled.modelFailed && !settled.retryLoad, "D4 no failure/retry surfaced for deleted object");
    assert(!settled.renderFailed && !settled.contextLost, "D5 viewport stayed healthy");
    assert(settled.canvasUsable, "D6 canvas still usable after in-flight delete");

    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("D: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 20000);
    assert(shellGone, "D7 workbench closed cleanly");

    const refreshed = await cdp.click('[data-testid="refresh-events"]');
    if (!refreshed) throw new Error("D: refresh-events not clickable");
    await sleep(600);

    const localDiag = await cdp.evaluate(`(() => [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')]
        .map((r) => [...r.querySelectorAll('td')].map((td) => td.innerText).join(" "))
        .filter((row) => row.includes('repro-model-local') && (row.includes('DIRECTOR_MODEL_LOAD_FAILED') || row.includes('DIRECTOR_MODEL_ADOPT_FAILED'))))()`);
    assert(localDiag.length === 0, "D8 no LOAD_FAILED/ADOPT_FAILED for the deleted object", JSON.stringify(localDiag));

    assert(cdp.problems.length === 0, "D9 no browser problems in scenario D", JSON.stringify(cdp.problems));
}

/**
 * 场景 E：真实 WebGL 上下文丢失与恢复。
 * 用 WEBGL_lose_context 扩展驱动真实 GPU 事件，不伪造 DOM 状态。
 */
async function webglLossRestore(cdp, baseUrl) {
    console.log("\n=== E. WebGL context lost and restored ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("E: toggle-workbench not clickable");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "E1 real canvas present before context loss");

    // 真实就绪门：capture context 已登记且未 lost，说明监听器已安装。
    // 早于此触发 loseContext 会让事件落在监听器安装之前。
    const rendererReady = await cdp.poll(`document.querySelector('.director-viewport-shell')?.getAttribute('data-renderer-ready') === 'true'`, "renderer ready", 30000);
    assert(rendererReady, "E2 capture renderer registered before context loss");

    const prepared = await cdp.evaluate(`(() => {
        const canvas = document.querySelector('.director-viewport-shell canvas');
        if (!canvas) return false;
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return false;
        const ext = gl.getExtension('WEBGL_lose_context');
        if (!ext || typeof ext.loseContext !== 'function' || typeof ext.restoreContext !== 'function') return false;
        window.__directorE2ELoseContext = ext;
        return true;
    })()`);
    if (!prepared) throw new Error("E: WEBGL_lose_context extension unavailable — cannot drive a real context loss");
    assert(prepared, "E3 WEBGL_lose_context extension acquired from live context");

    await cdp.evaluate(`(() => { window.__directorE2ELoseContext.loseContext(); return true; })()`);
    const lostNotice = await cdp.poll(`(document.body.innerText || "").includes('3D 显示上下文已丢失')`, "context-lost notice", 30000);
    assert(lostNotice, "E4 context-lost notice surfaced in DOM");

    await cdp.evaluate(`(() => { window.__directorE2ELoseContext.restoreContext(); return true; })()`);
    const restored = await cdp.poll(`!(document.body.innerText || "").includes('3D 显示上下文已丢失')`, "context-lost notice cleared", 30000);
    assert(restored, "E5 context-lost notice cleared after restore");
    const canvasUsable = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0 && c.clientHeight > 0; })()`, "canvas usable after restore", 20000);
    assert(canvasUsable, "E6 canvas remains usable after restore");

    const closed = await cdp.click('[aria-label="关闭导演台"]');
    if (!closed) throw new Error("E: 关闭导演台 button not clickable");
    const shellGone = await cdp.poll(`document.querySelectorAll('.director-viewport-shell').length === 0`, "workbench closed", 20000);
    assert(shellGone, "E7 workbench closed cleanly");

    const refreshed = await cdp.click('[data-testid="refresh-events"]');
    if (!refreshed) throw new Error("E: refresh-events not clickable");
    const hasLost = await cdp.poll(`(document.body.innerText || "").includes('DIRECTOR_VIEWPORT_CONTEXT_LOST')`, "lost diagnostic", 20000);
    assert(hasLost, "E8 DIRECTOR_VIEWPORT_CONTEXT_LOST recorded");
    const hasRestored = await cdp.poll(`(document.body.innerText || "").includes('DIRECTOR_VIEWPORT_CONTEXT_RESTORED')`, "restored diagnostic", 20000);
    assert(hasRestored, "E9 DIRECTOR_VIEWPORT_CONTEXT_RESTORED recorded");

    assert(cdp.problems.length === 0, "E10 no browser problems in scenario E", JSON.stringify(cdp.problems));
}

/**
 * 场景 F：强制保存失败 → 头部错误态与重试入口 → 关闭走确认保护。
 * 选择「留在导演台」后 workbench 必须仍然存在（onClose 不得被调用）。
 */
async function saveFailureCloseGuard(cdp, baseUrl) {
    console.log("\n=== F. save failure and close guard ===");
    await cdp.navigateFresh(`${baseUrl}/dev/director-repro`);

    const toggledFailure = await cdp.click('[data-testid="force-save-failure"]');
    if (!toggledFailure) throw new Error("F: force-save-failure switch not clickable");
    const failureOn = await cdp.poll(`document.querySelector('[data-testid="force-save-failure"]')?.getAttribute('aria-checked') === 'true'`, "failure switch on", 15000);
    assert(failureOn, "F1 forced save failure enabled");

    const opened = await cdp.click('[data-testid="toggle-workbench"]');
    if (!opened) throw new Error("F: toggle-workbench not clickable");
    const hasCanvas = await cdp.poll(`(() => { const c = document.querySelector('.director-viewport-shell canvas'); return !!c && c.clientWidth > 0; })()`, "canvas", 40000);
    assert(hasCanvas, "F2 workbench open with real canvas");
    const sceneTreeOpened = await openSceneTree(cdp);
    assert(sceneTreeOpened, "F2a 保存失败用例可切入场景树");

    // canonical 改动：场景树新增立方体会走 commit → coordinator.edit → flush（被强制失败）。
    const sceneAdd = await cdp.click('[aria-label="添加场景对象"]');
    if (!sceneAdd) throw new Error("F: 添加场景对象 button not clickable");
    const addedCube = await cdp.clickText("立方体", '[role="menuitem"]');
    if (!addedCube) throw new Error("F: 场景面板立方体 menu item not clickable");

    const errorState = await cdp.poll(`(document.body.innerText || "").includes('保存失败')`, "save failure header", 40000);
    assert(errorState, "F3 header surfaces 保存失败 after forced flush failure");
    const toolsMenuOpened = await openDirectorTools(cdp);
    const retryVisible = toolsMenuOpened && await cdp.poll(`!![...document.querySelectorAll('[role="menu"] li')].find((item) => (item.textContent || "").includes('重试保存'))`, "retry save affordance in viewport tools", 20000);
    assert(retryVisible, "F4 actionable 重试保存 affordance present in the viewport tools menu");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

    const closeClicked = await cdp.click('[aria-label="关闭导演台"]');
    if (!closeClicked) throw new Error("F: 关闭导演台 button not clickable");

    const modalShown = await cdp.poll(`!!document.querySelector('.ant-modal-confirm') && (document.body.innerText || "").includes('留在导演台')`, "close confirm modal", 40000);
    assert(modalShown, "F5 close is guarded by a confirm dialog, not silent exit");

    await cdp.evaluate(`(() => {
        window.__directorCancelEvents = [];
        for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, (event) => {
            const button = event.target instanceof Element ? event.target.closest('button') : null;
            window.__directorCancelEvents.push({ type, trusted: event.isTrusted, button: (button?.textContent || '').trim(), target: event.target instanceof Element ? event.target.tagName : '', x: event.clientX, y: event.clientY });
        }, true);
        return true;
    })()`);
    const stayClicked = await cdp.click(".ant-modal-confirm .ant-modal-confirm-btns button:first-child");
    if (!stayClicked) throw new Error("F: 留在导演台 button not clickable");
    const cancelEvents = await cdp.evaluate(`window.__directorCancelEvents`);
    assert(
        cancelEvents.some((event) => event.type === "click" && event.trusted && event.button === "留在导演台"),
        "F6a trusted click reaches stay button",
        JSON.stringify(cancelEvents),
    );
    const modalGone = await cdp.poll(
        `![...document.querySelectorAll('.ant-modal-confirm')].some((modal) => {
            const rect = modal.getBoundingClientRect();
            const style = getComputedStyle(modal);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        })`,
        "modal dismissed",
        20000,
    );
    const remainingModals = modalGone
        ? []
        : await cdp.evaluate(`({ events: window.__directorCancelEvents, modals: [
        ...document.querySelectorAll('.ant-modal-confirm')
    ].map((modal) => ({ text: (modal.innerText || '').slice(0, 300), className: modal.className, opacity: getComputedStyle(modal).opacity })) })`);
    assert(modalGone, "F6 confirm dialog dismissed after choosing 留在导演台", JSON.stringify(remainingModals));

    await sleep(1000);
    const stillOpen = await cdp.evaluate(`document.querySelectorAll('.director-viewport-shell').length`);
    assert(stillOpen === 1, "F7 workbench remains open after choosing 留在导演台", `shellCount=${stillOpen}`);

    assert(cdp.problems.length === 0, "F8 no browser problems in scenario F", JSON.stringify(cdp.problems));
}

async function main() {
    const chromePath = resolveChrome();
    console.log(`Chrome binary: ${chromePath}`);

    const vitePort = await freePort();
    const cdpPort = await freePort();
    const baseUrl = `http://127.0.0.1:${vitePort}`;
    const profileDir = mkdtempSync(join(tmpdir(), "director-p0-e2e-"));

    let vite = null;
    let chrome = null;
    let cdp = null;
    let apiFixture = null;

    try {
        apiFixture = await launchApiFixture();
        console.log(`API fixture listening on ${apiFixture.target}`);
        console.log(`Starting Vite on ${baseUrl} ...`);
        vite = await launchVite(vitePort, apiFixture.target);
        console.log(`      vite pid=${vite.pid}`);

        console.log(`Starting Chrome with CDP on 127.0.0.1:${cdpPort} ...`);
        chrome = await launchChrome(chromePath, cdpPort, profileDir);
        console.log(`      chrome pid=${chrome.pid}, profile=${profileDir}`);

        cdp = await connectCdp(cdpPort);
        console.log("      CDP connected (Runtime, Page, Log, Network enabled)");

        const allScenarios = [smokeWorkbench, sideFollowPreset, actorPoseInspector, cameraDirectManipulation, localModel, missingRetry, deleteWhileLoading, webglLossRestore, saveFailureCloseGuard];
        const selectedScenario = process.env.DIRECTOR_E2E_SCENARIO;
        const scenarios = selectedScenario ? allScenarios.filter((scenario) => scenario.name === selectedScenario) : allScenarios;
        if (selectedScenario && scenarios.length === 0) throw new Error(`Unknown DIRECTOR_E2E_SCENARIO: ${selectedScenario}`);
        for (const scenario of scenarios) {
            try {
                await scenario(cdp, baseUrl);
            } catch (error) {
                fail(`${scenario.name} threw`, String(error?.message || error));
            }
        }
    } finally {
        try {
            cdp?.close();
        } catch {
            /* socket already closed */
        }
        // 三个清理步骤互不阻塞：任一失败都记为断言失败（最终 exit 1），但不吞掉其余清理。
        try {
            await stopExact(chrome, "chrome");
        } catch (error) {
            fail("cleanup: stop chrome", String(error?.message || error));
        }
        try {
            await stopExact(vite, "vite");
        } catch (error) {
            fail("cleanup: stop vite", String(error?.message || error));
        }
        try {
            await stopApiFixture(apiFixture?.server);
        } catch (error) {
            fail("cleanup: stop API fixture", String(error?.message || error));
        }
        try {
            rmSync(profileDir, { recursive: true, force: true });
            console.log(`      removed profile ${profileDir}`);
        } catch (error) {
            fail("cleanup: remove profile", `${profileDir}: ${String(error?.message || error)}`);
        }
    }

    const passed = results.filter((r) => r.ok).length;
    console.log("\n================ SUMMARY ================");
    console.log(`assertions: ${passed} passed, ${failures} failed, ${results.length} total`);
    for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}${r.detail ? " — " + r.detail : ""}`);
    console.log("=========================================");

    if (failures > 0) {
        console.error(`\nDirector P0 Chrome E2E FAILED (${failures} assertion(s)).`);
        process.exit(1);
    }
    console.log("\nDirector P0 Chrome E2E PASSED.");
}

main().catch((error) => {
    console.error("\nDirector P0 Chrome E2E crashed:", error?.stack || error);
    process.exit(1);
});
