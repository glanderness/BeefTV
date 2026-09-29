/**
 * 内置创作助手 — 零模型验收（真实浏览器 + 真实 CLI，不调用任何模型）。
 *
 * 覆盖不需要模型的确定性链路，供每次改动脚本/前端后快速回归：
 * - 脚本路径解析不硬编码个人工作树；
 * - CLI 改目标镜头 → 真实编辑器 composer 显示新值（面板作用域 + 换选节点交叉证明）；
 * - 手工新增 → 撤销不会倒退外部刚写入的字段，也不改动连线。
 *
 * 用法：bun scripts/agent-product-zero-model-check.mjs
 * 产物：.local/agent-product/results-zero-model-<stamp>.json 与截图。
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "..");
const WS = resolve(process.env.BEEFTV_WORKSPACE || join(WEB_ROOT, ".."));
const APD = resolve(process.env.BEEFTV_AGENT_PRODUCT_DIR || join(WS, ".local/agent-product"));
const API = process.env.AGENT_E2E_API || "http://127.0.0.1:18090/api";
const WEB_PORT = Number(process.env.AGENT_E2E_WEB_PORT || 18400);
const OWNER = readFileSync(join(APD, "data/agent_owner_token"), "utf8").trim();
const CLI = process.env.BEEFTV_CLI || join(APD, "beeftv");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
async function api(method, path, body) { const res = await fetch(API + path, { method, headers: { "Content-Type": "application/json", "X-Beeftv-Owner": OWNER }, body: body ? JSON.stringify(body) : undefined }); return await res.json().catch(() => null); }

// 1) 路径解析（脚本不硬编码工作树路径）
const scriptSource = readFileSync(join(WEB_ROOT, "scripts/agent-product-browser-e2e.mjs"), "utf8");
const srcSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
check("脚本不含硬编码个人工作树路径", !scriptSource.includes("/Volumes/"), "读取 scripts/agent-product-browser-e2e.mjs");
const srcConfig = srcSource.slice(0, srcSource.indexOf("const sleep ="));
check("零模型脚本同样从自身位置推导路径", srcConfig.includes("fileURLToPath(import.meta.url)") && srcConfig.includes("BEEFTV_WORKSPACE") && !srcConfig.includes("/Volumes/"), "读取 scripts/agent-product-zero-model-check.mjs 的配置段");
check("脚本用 import.meta.url 推导工作区根", scriptSource.includes("fileURLToPath(import.meta.url)") && scriptSource.includes("BEEFTV_WORKSPACE"));
check("工作区根与产物目录推导正确", APD === join(WS, ".local/agent-product"), APD);

const vite = spawn("bunx", ["vite", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], { cwd: WEB_ROOT, env: { ...process.env, VITE_API_PROXY_TARGET: "http://127.0.0.1:18090" }, stdio: "pipe" });
for (let i = 0; i < 90; i++) { try { const r = await fetch(`http://127.0.0.1:${WEB_PORT}/`); if (r.ok) break; } catch {} await sleep(500); }

const s = Date.now(); const A = `hc-${s}`;
const img = (id, title, x, composer) => ({ id, type: "image", title, position: { x, y: 160 }, width: 360, height: 300, metadata: { prompt: composer, composerContent: composer, content: "" } });
await api("PUT", `/canvas-projects/${A}`, { project: { id: A, revision: 0, title: "helper 校验", workspaceProjectId: `ws-${s}`, nodes: [img("n1", "镜头1-开场", 120, "开场草稿"), img("n2", "镜头2-冲突", 560, "冲突草稿"), img("n3", "镜头3-收尾", 1000, "收尾草稿")], connections: [{ id: "e1", fromNodeId: "n1", toNodeId: "n2" }, { id: "e2", fromNodeId: "n2", toNodeId: "n3" }] } });
const before = (await api("GET", `/canvas-projects/${A}`)).data.project;

// 2) CLI 改目标镜头（真实 CLI + 真实服务端，零模型）
const cli = spawnSync(CLI, ["canvas", "node", "update", "--canvas", A, "--node", "n2", "--expected-revision", String(before.revision), "--content", "夜景：雨夜巷口对峙", "--op-id", `hc-cli-${s}`, "--json"], { env: { ...process.env, BEEFTV_BASE_URL: API, BEEFTV_OWNER_TOKEN: OWNER }, encoding: "utf8" });
check("CLI 改目标镜头成功（零模型）", cli.status === 0, `exit=${cli.status}`);

const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`http://127.0.0.1:${WEB_PORT}/canvas/${A}`, { waitUntil: "domcontentloaded" });
await sleep(8000);
await page.getByRole("button", { name: "适合屏幕", exact: true }).first().click().catch(() => {});
await sleep(1500);

async function selectNode(nodeId) {
  const box = await page.evaluate((id) => { const n = document.querySelector(`[data-node-id="${id}"]`); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + Math.min(60, r.width / 2), y: r.y + Math.min(18, r.height / 2) }; }, nodeId);
  if (!box) return false;
  await page.mouse.click(box.x, box.y); await sleep(2000); return true;
}
async function readComposer() {
  return page.evaluate(() => {
    const composers = Array.from(document.querySelectorAll("textarea")).filter((t) => t.placeholder !== "用自然语言描述创作需求…");
    const composer = composers[0];
    if (!composer) return { value: "", dragHandles: 0, composerCount: 0 };
    let panel = composer;
    for (let d = 0; d < 12 && panel.parentElement; d += 1) { if (panel.querySelector("[data-canvas-node-drag-handle]")) break; panel = panel.parentElement; }
    return { value: composer.value || "", dragHandles: panel.querySelectorAll("[data-canvas-node-drag-handle]").length, composerCount: composers.length };
  });
}

// 3) readPromptInUi 的作用域与交叉校验
let target = { value: "", dragHandles: 0, composerCount: 0 };
for (let i = 0; i < 10; i += 1) { if (await selectNode("n2")) { target = await readComposer(); if (target.value.includes("雨夜巷口对峙")) break; } await sleep(1500); }
check("选中目标节点后 composer 显示 CLI 新值", target.value.includes("雨夜巷口对峙"), JSON.stringify(target));
check("composer 面板唯一（一个拖拽手柄、页面上一个 composer）", target.dragHandles === 1 && target.composerCount === 1, JSON.stringify(target));
await selectNode("n3"); await sleep(1500);
const other = await readComposer();
check("换选另一个镜头读到它自己的值（证明不是全页巧合）", other.value.includes("收尾草稿") && !other.value.includes("雨夜巷口对峙"), JSON.stringify(other));
await page.screenshot({ path: join(APD, "screenshots", `helper-check-${s}.png`) });

// 4) 撤销不倒退外部修改（零模型）
const domCount = async () => (await page.evaluate(() => Array.from(document.querySelectorAll("[data-node-id]")).length));
await page.keyboard.press("Escape");
const beforeAdd = await domCount();
await page.getByRole("button", { name: "添加节点", exact: true }).first().click().catch(() => {});
await sleep(1200);
await page.getByRole("button", { name: "文本", exact: true }).first().click().catch(() => {});
await sleep(2500);
const afterAdd = await domCount();
await page.keyboard.press("Escape"); await sleep(400);
await page.keyboard.press("Meta+z"); await sleep(2500);
const afterUndo = await domCount();
const afterDoc = (await api("GET", `/canvas-projects/${A}`)).data.project;
const t = afterDoc.nodes.find((n) => n.id === "n2");
check("手工新增/撤销节点数正确", afterAdd === beforeAdd + 1 && afterUndo === beforeAdd, `${beforeAdd}->${afterAdd}->${afterUndo}`);
check("撤销未倒退 CLI 写入的目标字段", t?.metadata?.composerContent === "夜景：雨夜巷口对峙", String(t?.metadata?.composerContent));
check("撤销未改动连线", afterDoc.connections.length === 2, String(afterDoc.connections.length));

await browser.close(); vite.kill("SIGTERM");
const summary = { ok: checks.every((c) => c.ok), checks, script: "web/scripts/agent-product-browser-e2e.mjs", modelCalls: 0 };
const out = join(APD, `results-zero-model-${s}.json`);
(await import("node:fs")).writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\n结果写入 ${out}\n零模型校验 ${checks.filter((c) => c.ok).length}/${checks.length} 通过`);
process.exit(summary.ok ? 0 : 1);
