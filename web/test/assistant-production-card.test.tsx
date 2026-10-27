import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasAssistantTurnView } from "@/pages/canvas/canvas-assistant-turn";
import { assistantProposalProgress, assistantProposalText } from "@/pages/canvas/canvas-assistant-copy";
import type { AssistantGenerationProposal, AssistantTurn } from "@/services/api/agent-assistant";
import type { CostEstimate } from "@/lib/generation-cost";

// 费用由后端 canvas.generation.propose 的 estimate 给出，前端只把它摆到卡片上。
const filmEstimate: CostEstimate = {
    currency: "CNY",
    total: 0.35,
    known: false,
    unknownCount: 1,
    items: [
        { nodeId: "frame", title: "首帧", kind: "image", model: "gpt-image-2", amount: 0.35, basis: "1K 每张 ¥0.35" },
        { nodeId: "speech", title: "中文旁白", kind: "audio", amount: null, basis: "按台词字数计费，暂无法折算成每次价格" },
    ],
    text: "预计费用 ¥0.35（已知部分），另有 1 项暂无价格",
};

const proposal: AssistantGenerationProposal = {
    proposalId:"gp-film",kind:"image",nodeIds:["frame"],model:"image",modelKey:"custom::image",
    production:{targets:[
        {nodeId:"frame",title:"首帧",kind:"image",modelKey:"custom::image",prompt:"晨光洒进花店",parameters:{size:"9:16",count:"1"},referenceNodeIds:[]},
        {nodeId:"speech",title:"中文旁白",kind:"audio",modelKey:"custom::speech",prompt:"把春天带回家。",parameters:{audioVoice:"female-tianmei",audioSpeed:"1",audioFormat:"mp3"},referenceNodeIds:[]},
    ]},source:{canvasId:"canvas",canvasRevision:1,modelConfigRevision:1},
    estimate: filmEstimate,
};
test("confirmation shows the paid text, voice, aspect ratio and quantity",()=>{
    const text=assistantProposalText(proposal);
    for(const expected of ["晨光洒进花店","把春天带回家。","female-tianmei","9:16","1 个","预计费用","重新计费"]) expect(text).toContain(expected);
    expect(text).toContain("预计费用 ¥0.35（已知部分），另有 1 项暂无价格");
    expect(text).toContain("预计费用 ¥0.35（1K 每张 ¥0.35）");
    expect(text).toContain("按台词字数计费，暂无法折算成每次价格");
    const progress=assistantProposalProgress(proposal,[]);
    expect(progress.ready).toBe(false);
    expect(progress.text).toContain("0/2");
});
test("production confirmation shows the backend per-shot and total price",()=>{
    const fullEstimate: CostEstimate = {
        currency: "CNY",
        total: 5.08,
        known: false,
        unknownCount: 1,
        items: [
            { nodeId: "img-1", title: "分镜1-首帧图", kind: "image", model: "gpt-image-1.5", amount: 0.35, basis: "1024x1024 每张 ¥0.35" },
            { nodeId: "vid-1", title: "分镜1-6s视频", kind: "video", model: "minimax-h3-max-turbo", amount: 2.58, basis: "1080p ¥0.43/秒 × 6秒" },
            { nodeId: "vid-2", title: "分镜2-5s视频", kind: "video", model: "minimax-h3-max-turbo", amount: 2.15, basis: "1080p ¥0.43/秒 × 5秒" },
            { nodeId: "tts-1", title: "旁白1", kind: "audio", model: "speech-2.8-hd", amount: null, basis: "按台词字数计费，暂无法折算成每次价格" },
        ],
        text: "预计费用 ¥5.08（已知部分），另有 1 项暂无价格",
    };
    const fullProposal: AssistantGenerationProposal = {
        proposalId: "gp-h3",
        kind: "image",
        nodeIds: ["img-1", "img-2"],
        model: "gpt-image-1.5",
        modelKey: "beefapi::gpt-image-1.5",
        production: {
            targets: [
                { nodeId: "img-1", title: "分镜1-首帧图", kind: "image", modelKey: "beefapi::gpt-image-1.5", prompt: "镜头1首帧", parameters: { size: "16:9", count: "1" }, referenceNodeIds: [] },
                { nodeId: "vid-1", title: "分镜1-6s视频", kind: "video", modelKey: "beefapi::minimax-h3-max-turbo", prompt: "镜头1视频", parameters: { size: "16:9", vquality: "1080p", seconds: "6", count: "1" }, referenceNodeIds: ["img-1"] },
                { nodeId: "vid-2", title: "分镜2-5s视频", kind: "video", modelKey: "beefapi::minimax-h3-max-turbo", prompt: "镜头2视频", parameters: { size: "16:9", vquality: "1080p", seconds: "5", count: "1" }, referenceNodeIds: ["img-1"] },
                { nodeId: "tts-1", title: "旁白1", kind: "audio", modelKey: "beefapi::speech-2.8-hd", prompt: "旁白台词", parameters: { audioVoice: "male-qn-qingse", count: "1" }, referenceNodeIds: [] },
            ],
        },
        source: { canvasId: "canvas", canvasRevision: 1, modelConfigRevision: 1 },
        estimate: fullEstimate,
    };
    const text = assistantProposalText(fullProposal);
    expect(text).toContain("预计费用 ¥5.08（已知部分），另有 1 项暂无价格");
    expect(text).toContain("预计费用 ¥0.35（1024x1024 每张 ¥0.35）");
    expect(text).toContain("预计费用 ¥2.58（1080p ¥0.43/秒 × 6秒）");
    expect(text).toContain("预计费用 ¥2.15（1080p ¥0.43/秒 × 5秒）");
    expect(text).toContain("按台词字数计费，暂无法折算成每次价格");
});
test("proposal without a backend estimate falls back to the channel's own rates",()=>{
    const { estimate, ...withoutEstimate } = proposal;
    const text = assistantProposalText(withoutEstimate);
    expect(estimate).toBeDefined();
    expect(text).not.toContain("预计费用");
    expect(text).toContain("素材按所选渠道计费");
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
