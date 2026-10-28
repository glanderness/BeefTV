# 助手回执恢复独立检查（2026-10-28）

## 结论

**REPAIR：当前交付不能记为独立检查通过。** 已独立证明作者新增的两个基本用例在基线失败、在交付通过；但另有 **1 项 P1、1 项 P2**，分别涉及旧历史响应覆盖新轮的停止目标，以及手动重新读取再次读错对话。建议修复这两项后再进入正式 PR 验收。本次只新增本报告，未改产品代码、未开 PR、未合并或发布。

## 发现（按严重度）

### P1：点击「知道了」后，在途旧历史可以覆盖下一轮的请求标识

- 位置（均为交付提交）：`web/src/pages/canvas/use-canvas-assistant.ts:656`、`:299`、`:329`、`:398`、`:630`。
- `dismissError → clearPendingSend` 清掉 `recovery`，允许下一次 `send`；但没有增加 `historyRequest`，新发送也没有使之前的历史读取失效。旧响应仍能通过 `request === run.historyRequest`。随后 `history.active` 无条件改写 `pendingUserText`、`recovery`、`requestId`，即使新的观察流已经在运行。
- 独立复现：第一轮断流 → 按住已经截取第一轮活动状态的轮询响应 → 第一轮在假宿主结束 → 点击「知道了」并发出第二轮 → 第二轮收到正文后释放旧响应 → 点「停止」。第二轮正文仍是“新轮内容”，待处理消息却变回“第一条”，`/assistant/cancel` 发出的 **requestId 等于第一轮，而不是第二轮**。
- 没有发送下一轮时，旧响应同样会在「知道了」之后恢复第一轮的 `pendingUserText`、`streaming=true`、`backgroundActive/recovery`，重新启动后台读取；此时界面会把发送视为对旧轮的补充，不能当作“这次发送已收尾”。
- 实际风险：用户要停第二轮，客户端却只中止第二轮的观察流，并向宿主取消第一轮。宿主按 requestId 定向取消（`agent-host/server.mjs:499`、`agent-host/durable-session-owner.mjs:879`），因此不能靠宿主兜底停止第二轮。**错误取消目标已由假宿主收到的请求证明；第二轮真实模型是否继续执行未运行，本结论依据宿主定向取消代码。**
- 最小修正方向：让「知道了」及新发送使此前的历史读取失效，并让活动历史只影响它对应的发送。复用已有 `historyRequest` / 发送身份判断即可，不需要新恢复框架。正式回归应固定“旧响应截取 → 旧轮结束 → 新轮开始 → 旧响应返回”的顺序，并检查停止请求确实指向新轮。

### P2：手动「重新读取」仍按画布指针读取，并把后续轮询带到错误对话

- 位置：`web/src/pages/canvas/use-canvas-assistant.ts:809`、`:310`、`:349`、`:386`；入口在 `web/src/pages/canvas/canvas-assistant-sidebar.tsx:316`。
- 四处自动读取已传入 `run.sessionId`，公开的 `reloadHistory: () => loadHistory(canvasId)` 仍省略会话。等待 s1 回执时，画布指针若已移到 s2，用户点提示中的「重新读取」，历史响应便把 `run.sessionId` 改成 s2，原 `recovery.sessionId` 仍是 s1；新轮询又使用 s2，永远无法认领 s1 已存在的回执。
- 独立复现：第一轮在 s1 断流 → 将假宿主当前指针改成 s2，同时把第一轮完成回执放入 s1 → 手动读取 → 等待一次自动轮询。实测 `session=s2`、`awaiting=true`、历史为空，最后请求由 `?canvasId=c1` 变成 `?canvasId=c1&sessionId=s2`。
- 这是原有路径没有修完整，不是自动读取新增的回归。用户恰好按错误提示操作，就能重新触发本次要修的卡住问题。
- 最小修正方向：等待某次发送结果时，手动读取也使用那次发送的会话；显式切换对话仍走 `activateSession`。相关测试若因相同 URL 的并发 GET 被浏览器串行处理而失去预期时序，应调整假宿主或测试拦截来控制响应顺序，不能为保留测试 URL 差异而保留错误的产品读取目标。

## 固定范围与检查方法

- 原约定：读取 #90（`nRosfm44AQ3gqKdp2ZfAg`）的完整 spec；仅检查已确认的助手客户端问题，不改生成任务取回、重试和扣费判定。
- 基线：`6a155448096d2425aa07e81cc6016410091ad0be`。
- 交付：`772d4d7384b07058ac3a304051438792efd2be81`，经只读远端 fetch 核对该分支头一致。
- 差异：4 文件、220 增行 / 10 删行；产品代码只有 `use-canvas-assistant.ts`，其余是两处测试文件及作者调查报告。未变更依赖和锁文件。
- 按 structural-review 的窄范围直接检查方式，由本次独立检查会话完成；未调用外部模型或其他代理。先读固定差异、原 spec、API 与宿主调用、既有测试，形成初步判断后才读取作者调查报告。不能把作者结论当独立证据。
- 关联调用已核对：前端 `getAssistantHistory` 按可选会话组装 URL；Go `agent_proxy.go:344` 透传指定会话；宿主 `server.mjs:457` 未指定时才取当前指针，指定旧会话则读该会话；`findRecoveredAssistantTurn` 仍要求同一会话、唯一新回合及匹配输入。
- 运行使用交付/基线的独立源码快照、真实 React hook、随机回环端口假宿主和无头 Chrome 的临时浏览器上下文。未启动正式 BeefTV、未访问用户正式数据、未调用真实模型或付费上游。基线测试仅覆盖交付新增的测试及其夹具按钮，产品源码保持基线原样。
- 环境：Bun `1.4.2`、React `19.2.7`、Playwright `1.63.0`、TypeScript `7.0.2`；仓库声明的 Bun 为 `1.3.9`，本次未另装该版本。复用了现有依赖目录，未执行新的依赖安装。
- 交付产品文件 SHA-256：`58946281b6cbfded885c5e7b4cb6ba514d664d02418cf9c36a5ff8043ae69ba4`；锁文件 SHA-256：`ffbebdaa5aede031ae0ff3158ae5fd6442509f3ba47f97b4f2d87738c0fe9795`。

## 独立验证结果

| 验证 | 结果及能够证明的内容 |
| --- | --- |
| 基线 + 交付新增 `assistant-receipt-recovery.browser.test.ts` 及夹具 | 0 通过、2 失败，退出码 1。第一条等待 8 秒超时；第二条点「知道了」后 awaiting 仍为 true。证明两个基本用例确实能检出旧缺陷。 |
| 交付上的 receipt-recovery、stop、stream-progress、proposal-invalidation 四个浏览器文件 | 15 通过、0 失败、115 次断言，退出码 0。覆盖基本回执恢复、停止前后、观察流断开、账号切换、正文/思考与提案失效等既有行为。 |
| `bun run typecheck` | 退出码 0。 |
| 独立补充夹具（附录） | 两次复跑均为 2 通过、3 失败；第二次明确设置“旧轮在新轮发送前已经结束”。三条失败对应上述两个发现；显式切换对话使旧读取失效、停止仍指向原对话两条通过。 |
| `bun run test`（项目正式全量入口） | 退出码 0。主测试脚本：592 个文件，4299 通过、15 跳过、0 失败；额外的 pretest 为 6 文件、55 通过。跳过主要是未开启的原生/浏览器 FFmpeg 和视频预览专项，不计为已验证。 |

补充夹具中的成功/失败断言检查目标行为，故交付下的 3 条失败是评审发现，不计入作者已有全量套件，也没有改变它的任何断言。`assistant-stop-harness` 的“开始”按钮本身没有真实输入框的 disabled 行为；15 项通过不能替代全部侧栏交互验收。输入方式与停止目标的后果另结合 `canvas-assistant-sidebar` 的发送条件及宿主代码核实。

全量统计按每次 Bun 的结果摘要汇总，主脚本是共享批次 474 文件 + 118 个隔离文件，含 pretest 共 598 次文件执行。作者的“586 文件、4357 项”计数本次未复现；本次只确认上述实际执行数量及退出码。全量进程启动时就已完成测试文件枚举，独立补充夹具放在 `web/` 根目录，没有进入正式套件的 `test/` / `src/` 扫描范围。

独立补测的关键观测（请求标识用 A/B 表示）：

```text
手动读取后：session=s2, awaiting=true, pending=第一条, history=[]
最后读取：...&sessionId=s1 → ...?canvasId=c1 → ...&sessionId=s2

知道了后旧响应返回：pending=第一条, streaming=true, error=null
发送第二轮后旧响应返回：pending=第一条, streamed=新轮内容
chat[0].requestId=A; chat[1].requestId=B; A != B
cancel.body={canvasId:c1, sessionId:s1, requestId:A}  # 应为 B
```

## 结构判断与作者说明核对

`clearPendingSend` 把既有停止清理复用到「知道了」，局部抽取合理；自动读取在调用点指定会话也符合现有 API。没有证据要求拆大文件、加层次或扩大重构，文件原本较长本身不构成发现。实际问题是同一个可变 `CanvasRun` 同时承接旧历史与新发送，已有读取序号没有覆盖“放弃等待 → 再发送”的转换，而手动读取与自动读取的目标又不一致。这两点属于当前修改必须处理的职责遗漏。

作者保留全部既有测试及断言，确实没有靠删除测试获得通过。关于浏览器可能串行处理相同 URL 的解释，只能说明某个测试的时序安排需要改变，不能证明手动读取当前指针符合等待回执时的行为约定；本次独立夹具已展示实际错误。

作者称“已显示内容与历史回合不动”也需更正：`clearPendingSend` 明确清除 `streamed`、`reasoning` 及当前思考展开状态。历史 `turns` 保留属实，但尚未成为历史的已收到内容会被清除。这一文字与实现的不一致不另要求产品设计扩张。

## 原始客户故障：已知事实与仍缺的证据

只读核对了原飞书需求行的“需求内容”“报错日志”“进度说明”。“报错日志”为空；复制的排查信息在采集者的“进度说明”里，记录版本 v2.0.4、构建 `542124b`、原因代码 `model_error`、工具调用 0 / 失败 0、无 Trace ID。需求行还保留截图附件，但本次没有下载截图或客户完整诊断包，未接触客户客户端。仓库报告不保存客户身份及原行完整内容。

因此可以确认这是已登记的客户现象及采集记录，也可以确认当前客户端确有两条基本缺陷，且本次修复在指定条件下有效。**不能仅凭 `model_error + 工具数 0` 断定客户一定在第一次模型请求就失败，更不能排除传输、宿主或客户端同时存在问题。** 原因代码是归类，不是上游原始错误、请求次数或费用凭据。作者引用的假模型超时测试能证明超时可进入这个归类，不能证明客户这次就是超时。

同样，客户那次是否发生会话指针移动、是否拿到第一行 session、最终回执是否写入、为什么没有收到 turn_end，均缺原机对应记录。本次能重现的是客户端缺陷，不能声称完整重放了客户的那次上游失败。作者报告首段“是模型侧失败，不是客户端缺陷”应收敛为“采集信息将其归为 model_error，精确原因仍待原始诊断”。没有生成工具调用的记录支持本次不修改生成取回/扣费路径；它也不能证明模型推理没有费用。

## 最小后续修正与复查要求

1. 产品修正集中在 `web/src/pages/canvas/use-canvas-assistant.ts`：统一等待期间手动与自动读取的会话目标；在放弃等待和开始新发送时，使旧历史响应失效，避免旧活动快照改写新发送。
2. 将附录三条失败转成正式回归，保留既有两条回执恢复与停止/提案/思考测试；若调整既有并发测试，仅调整受控时序，不降低行为断言。
3. 修正 `docs/investigations/2026-10-28-assistant-turn-incomplete.md` 的客户根因、内容保留与“永远可退出”等过度结论。
4. 此次不动生成任务恢复、付费判断、宿主执行循环；不自动向 #90 长会话追加意见。后续修复和 PR/飞书流程由 Chief 统筹，本次评审不代替 Lucas 的检查。

本轮验证结束后已清理一次性源码快照、假宿主与浏览器进程；可重放夹具和必要观测保存在本报告中，未提交原始客户记录或整份测试日志。通用回归方法已同步到项目记忆及 nmem（`c2a307dc-ea19-4740-91dc-fbfdac9b8f43`），未保存客户数据。

## 附录：可重放的独立夹具

在仓库可读到两个固定提交、已准备前端依赖和 Chrome 的条件下，用一次性源码快照复跑。不要在正式客户端、用户数据或共享只读缓存中操作。将 `$REVIEW_DIR/web/node_modules` 链接到可信的现有依赖目录，或按仓库 Bun 锁文件在隔离快照中准备依赖。

```bash
REVIEW_DIR=$(mktemp -d)
git archive 772d4d7384b07058ac3a304051438792efd2be81 | tar -x -C "$REVIEW_DIR"
python3 - "$REVIEW_DIR" <<'PY'
import re, sys
from pathlib import Path
report = Path('docs/reviews/2026-10-28-assistant-receipt-review.md').read_text()
for name, lang in [('review-harness.tsx', 'tsx'), ('review-probe.browser.test.ts', 'ts')]:
    pattern = r'<!-- ' + re.escape(name) + r' -->\n```' + lang + r'\n(.*?)\n```'
    source = re.search(pattern, report, re.S).group(1)
    (Path(sys.argv[1]) / 'web' / name).write_text(source + '\n')
PY
# 准备隔离依赖后执行；这三条缺陷尚在时，预期 2 通过、3 失败。
cd "$REVIEW_DIR/web"
bun test ./review-probe.browser.test.ts
```

下面代码只为独立回放，不是新增产品实现或第二套恢复路径。正式修复可把同样的时序断言并入既有浏览器测试，无需保留独立框架。

<!-- review-harness.tsx -->
```tsx
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { useCanvasAssistant } from "@/pages/canvas/use-canvas-assistant";
import { hydrateModelConfig } from "@/services/model-config-repository";
await hydrateModelConfig();
function Harness() {
    const [canvas, setCanvas] = useState("c1");
    const a = useCanvasAssistant({ canvasId: canvas });
    (window as any).review = { a, setCanvas };
    return <pre id="state">{JSON.stringify({ canvas, session: a.sessionId, awaiting: a.awaitingReceipt,
        streaming: a.streaming, pending: a.pendingUserText, error: a.error,
        history: a.turns.map(t => t.reply), streamed: a.streamed, loaded: a.historyLoaded,
        sessionBusy: a.sessionBusy })}</pre>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
```

<!-- review-probe.browser.test.ts -->
```ts
import { beforeAll, beforeEach, afterAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
let browser: Browser, server: ReturnType<typeof Bun.serve>;
let chats: any[], cancels: any[], reads: string[], pointer: string, turns: any[];
let held: { release: () => void }[], holdNext: boolean, chatLive: boolean, secondLive: boolean;
const enc = new TextEncoder();
const ok = (data: any) => Response.json({ code: 0, data });
const turn = (cancelled = false) => ({ sessionId: "s1", turnId: "t1", userText: "第一条", selectedNodeIds: [],
    reply: cancelled ? "已停止" : "第一轮完成", toolCalls: [], change: null, proposals: [], error: null, cancelled });
beforeEach(() => { chats = []; cancels = []; reads = []; held = []; pointer = "s1"; turns = [];
    holdNext = false; chatLive = false; secondLive = false; });
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/review-harness.tsx"], target: "browser", define: {
        "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"',
        "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"',
        "process.env.NODE_ENV": '"production"',
    }, plugins: [{ name: "source", setup(b) { b.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("./src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(o => o.path.endsWith(".js"))!.text();
    server = Bun.serve({ port: 0, async fetch(req) {
        const u = new URL(req.url), p = u.pathname;
        if (p === "/harness.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        if (p.endsWith("/assistant/ui-session")) return ok({ token: "synthetic-review", expiresAt: new Date(Date.now() + 1800000).toISOString() });
        if (p.endsWith("/assistant/status")) return ok({ available: true });
        if (p.endsWith("/assistant/sessions/activate")) { pointer = (await req.json()).sessionId; return ok({ sessionId: pointer }); }
        if (p.endsWith("/assistant/sessions")) return ok({ currentSessionId: pointer, sessions: [] });
        if (p.endsWith("/assistant/history")) {
            reads.push(u.search);
            const sessionId = u.searchParams.get("sessionId") || pointer;
            if (holdNext) {
                holdNext = false;
                const snapshot = { sessionId: "s1", turns: [], active: { sessionId: "s1", turnId: "t1",
                    requestId: chats[0].requestId, userText: "第一条", selectedNodeIds: [], streamed: "旧进度", status: "running" } };
                return new Promise<Response>(resolve => held.push({ release: () => resolve(ok(snapshot)) }));
            }
            return ok({ sessionId, turns: sessionId === "s1" ? turns : [], active: null });
        }
        if (p.endsWith("/assistant/cancel")) {
            cancels.push(await req.json()); turns = [turn(true)]; return ok({ accepted: true });
        }
        if (p.endsWith("/assistant/chat")) {
            const body = await req.json(); chats.push(body);
            const n = chats.length, sessionId = body.sessionId;
            const lines = [{ type: "session", sessionId, turnId: "t" + n }, { type: "text_delta", delta: n === 1 ? "旧进度" : "新轮内容" }];
            if (n === 1 && !chatLive) return new Response(lines.map(x => JSON.stringify(x)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
            if (n > 1 && !secondLive) lines.push({ type: "turn_end", sessionId, turnId: "t" + n, reply: "新轮完成", toolCalls: [], change: null, proposals: [] } as any);
            return new Response(new ReadableStream({ start(c) {
                c.enqueue(enc.encode(lines.map(x => JSON.stringify(x)).join("\n") + "\n"));
                if (n > 1 && !secondLive) c.close();
            } }), { headers: { "content-type": "application/x-ndjson" } });
        }
        if (p.startsWith("/api/")) return ok({});
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
async function state(page: Page) { return JSON.parse(await page.locator("#state").innerText()); }
async function waitHeld() { for (let n = 0; !held.length && n < 200; n++) await Bun.sleep(20); expect(held.length).toBe(1); }
async function start(page: Page) {
    await page.goto(server.url.toString());
    await page.waitForFunction(() => (window as any).review?.a.historyLoaded);
    await page.evaluate(() => void (window as any).review.a.send("第一条", []));
    if (!chatLive) await page.waitForFunction(() => (window as any).review.a.awaitingReceipt && Boolean((window as any).review.a.error));
    else await page.waitForFunction(() => (window as any).review.a.streamed === "旧进度");
}
async function holdPoll() { holdNext = true; await waitHeld(); }
test("手动重新读取也应留在等待回执的对话", async () => {
    const page = await browser.newPage();
    try {
        await start(page); pointer = "s2"; turns = [turn()];
        await page.evaluate(() => (window as any).review.a.reloadHistory());
        await Bun.sleep(2400);
        console.log("手动读取", JSON.stringify({ state: await state(page), reads: reads.slice(-4) }));
        expect((await state(page)).awaiting).toBe(false);
        expect((await state(page)).session).toBe("s1");
    } finally { await page.close(); }
}, 15000);
test("知道了之后晚到的活动历史不得恢复旧轮状态", async () => {
    const page = await browser.newPage();
    try {
        await start(page); await holdPoll();
        await page.evaluate(() => (window as any).review.a.dismissError());
        expect((await state(page)).awaiting).toBe(false);
        held.shift()!.release();
        await page.waitForFunction(() => (window as any).review.a.pendingUserText === "第一条");
        console.log("知道了后晚到", JSON.stringify(await state(page)));
        expect((await state(page)).pending).toBe(null);
        expect((await state(page)).streaming).toBe(false);
    } finally { held.splice(0).forEach(x => x.release()); await page.close(); }
}, 15000);
test("知道了后发送第二条，晚到的第一轮历史不得改变停止目标", async () => {
    secondLive = true;
    const page = await browser.newPage();
    try {
        await start(page); await holdPoll();
        // 旧轮在宿主上已经结束，只有先前截取的活动历史响应仍在网络中。
        turns = [turn()];
        await page.evaluate(() => { (window as any).review.a.dismissError(); void (window as any).review.a.send("第二条", []); });
        await page.waitForFunction(() => (window as any).review.a.streamed === "新轮内容");
        expect(chats.length).toBe(2); expect(chats[1].requestId).not.toBe(chats[0].requestId);
        held.shift()!.release();
        await page.waitForFunction(() => (window as any).review.a.pendingUserText === "第一条");
        console.log("下一轮被覆盖", JSON.stringify(await state(page)));
        await page.evaluate(() => (window as any).review.a.stop());
        console.log("停止目标", JSON.stringify({ first: chats[0].requestId, second: chats[1].requestId, cancels }));
        expect(cancels[0].requestId).toBe(chats[1].requestId);
    } finally { held.splice(0).forEach(x => x.release()); await page.close(); }
}, 15000);
test("等待中切换对话使旧读取失效，后续输入属于新对话", async () => {
    const page = await browser.newPage();
    try {
        await start(page); await holdPoll();
        await page.evaluate(() => (window as any).review.a.activateSession("s2"));
        held.shift()!.release(); await Bun.sleep(150);
        expect((await state(page)).session).toBe("s2"); expect((await state(page)).awaiting).toBe(false);
        expect((await state(page)).pending).toBe(null);
        await page.evaluate(() => (window as any).review.a.send("第二条", []));
        await page.waitForFunction(() => !(window as any).review.a.streaming);
        expect(chats[1].sessionId).toBe("s2"); expect((await state(page)).history).toEqual(["新轮完成"]);
    } finally { held.splice(0).forEach(x => x.release()); await page.close(); }
}, 15000);
test("停止在指针已移动时仍取消并读取原对话的回执", async () => {
    chatLive = true;
    const page = await browser.newPage();
    try {
        await start(page); pointer = "s2";
        await page.evaluate(() => (window as any).review.a.stop());
        await page.waitForFunction(() => !(window as any).review.a.streaming);
        expect(cancels).toEqual([{ canvasId: "c1", sessionId: "s1", requestId: chats[0].requestId }]);
        expect((await state(page)).session).toBe("s1"); expect((await state(page)).awaiting).toBe(false);
        expect((await state(page)).history).toEqual(["已停止"]); expect((await state(page)).pending).toBe(null);
        expect(chats.length).toBe(1);
    } finally { await page.close(); }
}, 15000);
```
