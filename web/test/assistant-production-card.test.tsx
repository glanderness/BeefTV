import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import { assistantProposalProgress, assistantProposalText } from "@/pages/canvas/canvas-assistant-copy";
import { productionConfirmationErrorMessage } from "@/pages/canvas/use-canvas-assistant-proposal";
import { ApiError } from "@/services/api/request";
import { normalizeAssistantProposal, type AssistantGenerationProposal, type AssistantScriptProposal, type AssistantTurn } from "@/services/api/agent-assistant";

const proposal: AssistantGenerationProposal = {
    proposalId:"gp-film",kind:"image",nodeIds:["frame"],model:"image",modelKey:"custom::image",
    production:{targets:[
        {nodeId:"frame",title:"首帧",kind:"image",modelKey:"custom::image",prompt:"晨光洒进花店",parameters:{size:"9:16",count:"1"},referenceNodeIds:[]},
        {nodeId:"speech",title:"中文旁白",kind:"audio",modelKey:"custom::speech",prompt:"把春天带回家。",parameters:{audioVoice:"female-tianmei",audioSpeed:"1",audioFormat:"mp3"},referenceNodeIds:[]},
    ],estimate:{amount:0,priced:0,unknown:2,text:"预计费用：暂无价格，按所选渠道实际计费"}},source:{canvasId:"canvas",canvasRevision:1,modelConfigRevision:1},
};
test("confirmation shows the paid text, voice, aspect ratio and quantity",()=>{
    const text=assistantProposalText(proposal);
    for(const expected of ["晨光洒进花店","把春天带回家。","female-tianmei","9:16","1 个","预计费用","重新计费"]) expect(text).toContain(expected);
    const progress=assistantProposalProgress(proposal,[]);
    expect(progress.ready).toBe(false);
    expect(progress.text).toContain("0/2");
});
test("production confirmation shows the backend estimate for each shot and the total",()=>{
    const fullProposal: AssistantGenerationProposal = {
        proposalId: "gp-h3",
        kind: "image",
        nodeIds: ["img-1"],
        model: "gpt-image-2",
        modelKey: "beeftv::gpt-image-2",
        production: {
            targets: [
                { nodeId: "img-1", title: "分镜1-首帧图", kind: "image", modelKey: "beeftv::gpt-image-2", prompt: "镜头1首帧", parameters: { size: "16:9", count: "1" }, referenceNodeIds: [],
                    estimate: { amount: 0.35, basis: "1K 低质量 ¥0.35/张 × 1 张", text: "预计 ¥0.35（1K 低质量 ¥0.35/张 × 1 张）" } },
                { nodeId: "vid-1", title: "分镜1-6s视频", kind: "video", modelKey: "beeftv::seedance-2.0", prompt: "镜头1视频", parameters: { vquality: "720p", seconds: "6", count: "1" }, referenceNodeIds: ["img-1"],
                    estimate: { amount: 5.9616, approx: true, basis: "720p ¥0.9936/秒 × 6 秒，按 Token 折算", text: "约 ¥5.96（720p ¥0.9936/秒 × 6 秒，按 Token 折算）" } },
                { nodeId: "tts-1", title: "旁白1", kind: "audio", modelKey: "byok::speech", prompt: "旁白台词", parameters: { count: "1" }, referenceNodeIds: [],
                    estimate: { amount: null, basis: "自带 Key 的渠道暂无价格，按该渠道实际计费", text: "自带 Key 的渠道暂无价格，按该渠道实际计费" } },
            ],
            estimate: { amount: 6.3116, priced: 2, unknown: 1, approx: true, text: "预计费用：已知部分约 ¥6.31，另有 1 项暂无价格" },
        },
        source: { canvasId: "canvas", canvasRevision: 1, modelConfigRevision: 1 },
    };
    const text = assistantProposalText(fullProposal);
    expect(text).toContain("整片制作方案：1 张图片、1 段视频、1 段配音\n预计费用：已知部分约 ¥6.31，另有 1 项暂无价格");
    expect(text).toContain("费用：约 ¥5.96（720p ¥0.9936/秒 × 6 秒，按 Token 折算）");
    expect(text).toContain("费用：自带 Key 的渠道暂无价格，按该渠道实际计费");
    const submitted = assistantProposalText(fullProposal, [], false);
    expect(submitted).not.toContain("费用");
});
test("proposal card reflects started progress when Pi confirms and admits tasks on canvas nodes",()=>{
    const turn: AssistantTurn = {
        turnId: "turn-1",
        userText: "开始制作",
        selectedNodeIds: [],
        reply: "请确认方案",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-10-26",
        proposals: [proposal],
        proposalsInvalidated: true,
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[{
                id: "frame",
                type: "image",
                title: "首帧",
                x: 0,
                y: 0,
                width: 320,
                height: 180,
                metadata: {
                    status: "loading",
                    taskStatus: "running",
                    taskClientOperationId: "proposal:gp-film:frame",
                },
            }]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).not.toContain("已失效");
    expect(html).toContain("生成中，0/2 个结果已就绪。");
});
test("started production does not ask the user to manually continue the next step",()=>{
    const turn:AssistantTurn={turnId:"film",userText:"做短片",selectedNodeIds:[],reply:"",toolCalls:[],change:null,error:null,cancelled:false,createdAt:"2026-10-19",proposals:[proposal]};
    const html=renderToStaticMarkup(<CanvasAssistantTurnView turn={turn} handledProposals={new Set([proposal.proposalId])} nodes={[]}
        onLocate={()=>{}} onUndo={()=>{}} onRunProposal={()=>{}} onDismissProposal={()=>{}} onCheckResults={()=>{}} />);
    expect(html).not.toContain("填入检查要求");
    expect(html).not.toContain(">检查结果<");
    expect(html).toContain("0/2");
});
test("production proposal card collapses per-item target details by default while keeping overview and confirm action visible",()=>{
    const turn: AssistantTurn = {
        turnId: "turn-collapsed",
        userText: "做一支花店短片",
        selectedNodeIds: [],
        reply: "已为你准备好花店短片方案。",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-10-28",
        proposals: [proposal],
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).toContain("已为你准备好花店短片方案。");
    expect(html).toContain("整片制作方案：1 张图片、0 段视频、1 段配音");
    expect(html).toContain("<details class=\"canvas-assistant-proposal-details\"><summary>查看 2 项镜头与提示词明细</summary>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("确认并制作整片");
});
test("legacy proposal without turn reply shows proposal note inside the card without pretending to be a model reply",()=>{
    const turn: AssistantTurn = {
        turnId: "turn-legacy-note",
        userText: "把首帧改成 9:16",
        selectedNodeIds: [],
        reply: "",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-10-28",
        proposals: [{ ...proposal, note: "已将首帧调整为竖屏 9:16。" }],
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).not.toContain("canvas-assistant-reply");
    expect(html).toContain("canvas-assistant-proposal-note");
    expect(html).toContain("已将首帧调整为竖屏 9:16。");
});
test("assistantProposalProgress treats retrievable failed and fetching tasks as running until ready and bound",()=>{
    const withOutcome = (meta: Record<string, unknown>) => meta as NonNullable<Parameters<typeof assistantProposalProgress>[1][number]["metadata"]>;
    const inFlight = assistantProposalProgress(proposal, [
        {
            id: "frame",
            type: "image",
            title: "首帧",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: withOutcome({
                status: "error",
                taskStatus: "failed",
                taskClientOperationId: "proposal:gp-film:frame",
                taskOutcome: { phase: "retrievable", regenerate: "blocked", reason: "image_recovery_pending" },
            }),
        },
        {
            id: "speech",
            type: "audio",
            title: "中文旁白",
            position: { x: 0, y: 200 },
            width: 320,
            height: 120,
            metadata: withOutcome({
                status: "loading",
                taskStatus: "succeeded",
                taskClientOperationId: "proposal:gp-film:speech",
                taskOutcome: { phase: "fetching", regenerate: "blocked", reason: "result_fetching" },
            }),
        },
    ]);
    expect(inFlight.ready).toBe(false);
    expect(inFlight.text).toBe("生成中，0/2 个结果已就绪。");

    const allReady = assistantProposalProgress(proposal, [
        {
            id: "frame",
            type: "image",
            title: "首帧",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: withOutcome({
                status: "success",
                taskStatus: "succeeded",
                storageKey: "resource:frame-1",
                taskClientOperationId: "proposal:gp-film:frame",
                taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            }),
        },
        {
            id: "speech",
            type: "audio",
            title: "中文旁白",
            position: { x: 0, y: 200 },
            width: 320,
            height: 120,
            metadata: withOutcome({
                status: "success",
                taskStatus: "succeeded",
                storageKey: "resource:speech-1",
                taskClientOperationId: "proposal:gp-film:speech",
                taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            }),
        },
    ]);
    expect(allReady.ready).toBe(true);
    expect(allReady.text).toContain("2 个素材已保存");

    const settledWithFailure = assistantProposalProgress(proposal, [
        {
            id: "frame",
            type: "image",
            title: "首帧",
            position: { x: 0, y: 0 },
            width: 320,
            height: 180,
            metadata: withOutcome({
                status: "error",
                taskStatus: "failed",
                taskClientOperationId: "proposal:gp-film:frame",
                taskOutcome: { phase: "failed", regenerate: "confirm", reason: "no_result" },
            }),
        },
        {
            id: "speech",
            type: "audio",
            title: "中文旁白",
            position: { x: 0, y: 200 },
            width: 320,
            height: 120,
            metadata: withOutcome({
                status: "success",
                taskStatus: "succeeded",
                storageKey: "resource:speech-1",
                taskClientOperationId: "proposal:gp-film:speech",
                taskOutcome: { phase: "ready", regenerate: "allowed", reason: "result_ready" },
            }),
        },
    ]);
    expect(settledWithFailure.ready).toBe(true);
    expect(settledWithFailure.text).toBe("1 个结果已就绪，1 个结果因任务失败或取消而未生成。");
});

test("ordinary proposal with generation order targets renders collapsible order details", () => {
    const ordinaryWithOrder: AssistantGenerationProposal = {
        proposalId: "gp-order-1",
        orderId: "gp-order-1",
        kind: "image",
        nodeIds: ["shot-1"],
        model: "gpt-image-1.5",
        modelKey: "beeftv::gpt-image-1.5",
        pricing: "unknown",
        estimate: { amount: 0, priced: 0, unknown: 1, text: "预计费用：暂无价格，按所选渠道实际计费" },
        approvalMode: "ask",
        status: "pending",
        targets: [{
            nodeId: "shot-1",
            title: "镜头1",
            kind: "image",
            model: "gpt-image-1.5",
            modelKey: "beeftv::gpt-image-1.5",
            pricing: "unknown",
            estimate: { amount: null, basis: "自带 Key 的渠道暂无价格，按该渠道实际计费", text: "自带 Key 的渠道暂无价格，按该渠道实际计费" },
            prompt: "雨夜霓虹街角，主角回头",
            parameters: { size: "16:9", count: "1" },
            referenceNodeIds: [],
        }],
    };
    const turn: AssistantTurn = {
        turnId: "turn-order-1",
        userText: "生成镜头1的首帧",
        selectedNodeIds: ["shot-1"],
        reply: "已开出生成单，请确认。",
        toolCalls: [],
        change: null,
        error: null,
        cancelled: false,
        createdAt: "2026-11-01",
        proposals: [ordinaryWithOrder],
    };
    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={turn}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).toContain("<details class=\"canvas-assistant-proposal-details\"><summary>查看 1 项生成单明细</summary>");
    expect(html).toContain("雨夜霓虹街角，主角回头");
    expect(html).toContain("预计费用：暂无价格，按所选渠道实际计费");
    expect(html).toContain("费用：自带 Key 的渠道暂无价格，按该渠道实际计费");
    const invalidated = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={{ ...turn, proposalsInvalidated: true }}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(invalidated).toContain("雨夜霓虹街角，主角回头");
    expect(invalidated).not.toContain("费用：");
    expect(html).toContain("canvas-assistant-proposal-lines");
    expect(html).not.toContain("white-space:pre-line");
});

test("skill script proposal card renders confirmation actions and collapsible output after execution", () => {
    const scriptProposal: AssistantScriptProposal = {
        proposalId: "sp-audio-1",
        turnId: "turn-script-1",
        canvasId: "canvas-1",
        skillId: "audio-skill",
        skillName: "声音审片",
        versionId: "v1",
        version: "1.0",
        contentHash: "a".repeat(64),
        scriptPath: "scripts/listen.py",
        interpreter: "python3",
        args: ["--check", "shot-1"],
        timeoutSec: 120,
        note: "检查第一镜音频静音区间",
        status: "pending",
    };
    const pendingTurn: AssistantTurn = {
        turnId: "turn-script-1",
        userText: "检查声音",
        selectedNodeIds: [],
        reply: "请确认运行声音检查脚本。",
        toolCalls: [],
        change: null,
        proposals: [],
        scriptProposals: [scriptProposal],
        error: null,
        cancelled: false,
        createdAt: "2026-11-06",
    };
    const pendingHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={pendingTurn}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onRunScriptProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(pendingHtml).toContain("运行技能脚本 · 声音审片（1.0）");
    expect(pendingHtml).toContain("脚本路径：scripts/listen.py");
    expect(pendingHtml).toContain("运行方式：Python 3");
    expect(pendingHtml).toContain("启动参数：--check shot-1");
    expect(pendingHtml).toContain("不会修改已安装的技能文件，也不会读取你的模型密钥");
    expect(pendingHtml).toContain("运行脚本");
    expect(pendingHtml).toContain("本对话始终允许");
    expect(pendingHtml).toContain("先不用");

    const completedHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={{
                ...pendingTurn,
                scriptProposals: [{
                    ...scriptProposal,
                    status: "completed",
                    result: {
                        exitCode: 0,
                        timedOut: false,
                        cancelled: false,
                        durationMs: 420,
                        stdout: "检测到 00:01.20-00:01.80 停顿",
                        stderr: "",
                    },
                }],
            }}
            handledProposals={new Set(["sp-audio-1"])}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onRunScriptProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(completedHtml).toContain("已完成（耗时 0.4 秒）");
    expect(completedHtml).toContain("查看脚本输出");
    expect(completedHtml).toContain("检测到 00:01.20-00:01.80 停顿");
    expect(completedHtml).not.toContain("本对话始终允许");
});

test("production proposal tolerates legacy null referenceNodeIds and parameters without crashing", () => {
    const legacyProposal = {
        proposalId: "gp-null-refs",
        kind: "image",
        nodeIds: ["img-solo"],
        model: "dola-seedream-5-0-flash-260915",
        modelKey: "beeftv::dola-seedream-5-0-flash-260915",
        production: {
            targets: [
                {
                    nodeId: "img-solo",
                    title: "橘猫侦探定妆图",
                    kind: "image",
                    modelKey: "beeftv::dola-seedream-5-0-flash-260915",
                    prompt: "赛博雨夜橘猫侦探",
                    parameters: null,
                    referenceNodeIds: null,
                    estimate: { amount: 0.0122, text: "预计 ¥0.0122（2K ¥0.0122/张 × 1 张）" },
                },
            ],
            estimate: { amount: 0.0122, priced: 1, unknown: 0, text: "预计费用：¥0.0122" },
        },
        source: { canvasId: "canvas", canvasRevision: 1, modelConfigRevision: 1 },
    } as unknown as AssistantGenerationProposal;

    const normalized = normalizeAssistantProposal(legacyProposal);
    expect(normalized.production?.targets[0]?.referenceNodeIds).toEqual([]);
    expect(normalized.production?.targets[0]?.parameters).toEqual({});

    const text = assistantProposalText(legacyProposal);
    expect(text).toContain("生成方案：1 张图片");
    expect(text).not.toContain("整片制作方案");
    expect(text).toContain("橘猫侦探定妆图 · dola-seedream-5-0-flash-260915 · 1 个");
    expect(text).toContain("赛博雨夜橘猫侦探");

    const progress = assistantProposalProgress(legacyProposal, []);
    expect(progress.text).toContain("0/1");

    const html = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={{
                turnId: "turn-null-refs",
                userText: "画一张橘猫侦探定妆图",
                selectedNodeIds: [],
                reply: "",
                toolCalls: [],
                change: null,
                error: null,
                cancelled: false,
                createdAt: "2026-11-22",
                proposals: [legacyProposal],
            }}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(html).toContain("橘猫侦探定妆图");
    expect(html).toContain("确认并生成");
    expect(html).not.toContain("确认并制作整片");
});

test("production confirmation footer does not mislead users into typing confirmation in chat, and surfaces 4xx ApiError messages", () => {
    const text = assistantProposalText(proposal);
    expect(text).toContain("请点击下方按钮确认开始");
    expect(text).not.toContain("直接发送「确认」");

    expect(productionConfirmationErrorMessage(new ApiError("制作方案已变化，请重新确认", { status: 409, reason: "production_changed" }))).toBe("制作方案已变化，请重新确认");
    expect(productionConfirmationErrorMessage(new ApiError("素材模型暂不可用", { status: 200, code: 412, reason: "generation_model_unavailable" }))).toBe("素材模型暂不可用");
    expect(productionConfirmationErrorMessage(new ApiError("intent changed", { status: 409, reason: "continuation_intent_changed" }))).toBe("要求已更新，请让助手重新提出生成方案。");
    expect(productionConfirmationErrorMessage(new ApiError("timeout", { status: 504 }))).toBe("暂未确认制作是否开始，请重试查询同一方案，不会重复提交已接受的素材。");
    expect(productionConfirmationErrorMessage(new Error("network down"))).toBe("暂未确认制作是否开始，请重试查询同一方案，不会重复提交已接受的素材。");
});

test("single-step and single-kind proposals do not label the confirmation button as full-film production", () => {
    const singleImagePlan: AssistantGenerationProposal = {
        proposalId: "gp-single-img",
        kind: "image",
        nodeIds: ["img-1"],
        model: "gpt-image-2",
        modelKey: "beeftv::gpt-image-2",
        production: {
            targets: [
                {
                    nodeId: "img-1",
                    title: "角色定妆图",
                    kind: "image",
                    modelKey: "beeftv::gpt-image-2",
                    prompt: "暖光胶片感人像",
                    parameters: { size: "9:16", count: "1" },
                    referenceNodeIds: [],
                },
            ],
            estimate: { amount: 0.35, priced: 1, unknown: 0, text: "预计费用：¥0.35" },
        },
        source: { canvasId: "canvas", canvasRevision: 1, modelConfigRevision: 1 },
    };

    const singleHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={{
                turnId: "turn-single-img",
                userText: "帮我画一张角色定妆图",
                selectedNodeIds: [],
                reply: "已准备好定妆图方案。",
                toolCalls: [],
                change: null,
                error: null,
                cancelled: false,
                createdAt: "2026-11-24",
                proposals: [singleImagePlan],
            }}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(singleHtml).toContain("生成方案：1 张图片");
    expect(singleHtml).toContain("确认并生成");
    expect(singleHtml).not.toContain("确认并制作整片");
    expect(singleHtml).not.toContain("整片制作方案");
    expect(singleHtml).not.toContain("声音、字幕和剪辑");

    const stagedImagesPlan: AssistantGenerationProposal = {
        proposalId: "gp-staged-imgs",
        kind: "image",
        nodeIds: ["char-1"],
        model: "gpt-image-2",
        modelKey: "beeftv::gpt-image-2",
        production: {
            targets: [
                {
                    nodeId: "char-1",
                    title: "主角设定",
                    kind: "image",
                    modelKey: "beeftv::gpt-image-2",
                    prompt: "雨衣侦探",
                    parameters: { size: "16:9", count: "1" },
                    referenceNodeIds: [],
                },
                {
                    nodeId: "scene-1",
                    title: "街角场景",
                    kind: "image",
                    modelKey: "beeftv::gpt-image-2",
                    prompt: "雨夜街角回头",
                    parameters: { size: "16:9", count: "1" },
                    referenceNodeIds: ["char-1"],
                },
            ],
            estimate: { amount: 0.7, priced: 2, unknown: 0, text: "预计费用：¥0.70" },
        },
        source: { canvasId: "canvas", canvasRevision: 1, modelConfigRevision: 1 },
    };

    const stagedHtml = renderToStaticMarkup(
        <CanvasAssistantTurnView
            turn={{
                turnId: "turn-staged-imgs",
                userText: "先出主角设定，再按主角出街角首帧",
                selectedNodeIds: [],
                reply: "已准备好分步出图方案。",
                toolCalls: [],
                change: null,
                error: null,
                cancelled: false,
                createdAt: "2026-11-24",
                proposals: [stagedImagesPlan],
            }}
            handledProposals={new Set()}
            nodes={[]}
            onLocate={() => {}}
            onUndo={() => {}}
            onRunProposal={() => {}}
            onDismissProposal={() => {}}
        />,
    );
    expect(stagedHtml).toContain("分步生成方案：2 张图片");
    expect(stagedHtml).toContain("确认制作方案");
    expect(stagedHtml).not.toContain("确认并制作整片");
    expect(stagedHtml).not.toContain("声音、字幕和剪辑");
});
