import { expect, test } from "bun:test";
import { resolveWorkflowVideoControls, workflowVideoControlFields, workflowVideoControlSummary, workflowParameterDefaults } from "@/lib/workflow-video-controls";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { defaultConfig, type WorkflowFieldMapping } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";

const fields: WorkflowFieldMapping[] = [
    { nodeId:"27",fieldName:"value",label:"Float (duration)",fieldType:"NUMBER",fieldValue:20,enabled:true,min:1,max:30 },
    { nodeId:"29",fieldName:"aspect_ratio",classType:"ResolutionSelector",fieldType:"SELECT",fieldValue:"16:9 (Widescreen)",enabled:true },
    { nodeId:"8",fieldName:"steps",fieldType:"NUMBER",fieldValue:10,enabled:true },
    { nodeId:"77",fieldName:"fps",fieldType:"NUMBER",fieldValue:24,enabled:true },
];

test("video toolbar maps only unique enabled semantic fields and keeps exact provider values", () => {
    const controls = resolveWorkflowVideoControls(fields);
    expect(controls.map((item) => [item.key,item.enabled,item.field?.nodeId])).toEqual([["resolution",false,undefined],["aspectRatio",true,"29"],["duration",true,"27"]]);
    expect(workflowVideoControlSummary(fields,undefined,{})).toBe("16:9 · 20s");
    expect(workflowVideoControlSummary(fields,undefined,{"field:29:aspect_ratio":"9:16","field:27:value":12.5})).toBe("9:16 · 12.5s");
    expect(workflowVideoControlFields(fields,undefined).map((item) => item.label)).toEqual(["长宽比","时长"]);
});

test("manual mapping, switch off, missing or disabled fields never silently select another field", () => {
    const duplicate = [...fields,{...fields[0],nodeId:"28"}];
    expect(resolveWorkflowVideoControls(duplicate).find((item)=>item.key==="duration")?.enabled).toBe(false);
    expect(resolveWorkflowVideoControls(duplicate,{duration:{fieldKey:"field:28:value",enabled:true}}).find((item)=>item.key==="duration")?.field?.nodeId).toBe("28");
    expect(workflowVideoControlSummary(fields,{duration:{fieldKey:"field:27:value",enabled:false}},{})).toBe("16:9");
    expect(resolveWorkflowVideoControls(fields,{duration:{fieldKey:"field:missing:value",enabled:true}}).find((item)=>item.key==="duration")?.enabled).toBe(false);
    expect(resolveWorkflowVideoControls(fields.map((field)=>({...field,enabled:false}))).every((item)=>!item.enabled)).toBe(true);
});

test("workflow parameter defaults and task fields ignore stale ordinary model settings", () => {
    const config = {...defaultConfig,videoSeconds:"5",vquality:"480p",size:"1:1",runningHub:{...defaultConfig.runningHub,enabled:true,workflows:[{workflowId:"mapped",kind:"workflow" as const,capability:"video" as const,fields:fields.map((field)=>({...field,source:field.nodeId==="27"?"videoSeconds":field.nodeId==="29"?"aspectRatio":""}))}]}};
    const node = {id:"video",type:CanvasNodeType.Video,title:"视频",width:320,height:180,position:{x:0,y:0},metadata:{workflowProvider:"runninghub" as const,runningHubWorkflowId:"mapped",seconds:"8",size:"1:1",workflowParameters:{"field:29:aspect_ratio":"9:16","field:27:value":12.5}}};
    const selected = buildGenerationConfig(config,node,"video");
    const actual = selected.runningHub.workflows[0].fields!;
    expect(actual[0].fieldValue).toBe(12.5);
    expect(actual[1].fieldValue).toBe("9:16 (Portrait Widescreen)");
    expect(actual[0].source).toBe("");
    expect(actual[1].source).toBe("");
    expect(actual[2].fieldValue).toBe(10);
    expect(workflowParameterDefaults(fields,{})).toMatchObject({"field:27:value":20,"field:8:steps":10});
    const defaults = buildGenerationConfig(config,{...node,metadata:{...node.metadata,workflowParameters:{}}},"video").runningHub.workflows[0].fields!;
    expect(defaults[0].fieldValue).toBe(20);
    expect(defaults[1].fieldValue).toBe("16:9 (Widescreen)");
});

test("toolbar defaults preserve random seeds and explicit random switches", () => {
    const seed = {nodeId:"11",fieldName:"noise_seed",fieldType:"NUMBER",fieldValue:42,randomEnabled:true,enabled:true};
    const config = {...defaultConfig,runningHub:{...defaultConfig.runningHub,enabled:true,workflows:[{workflowId:"seed",capability:"video" as const,fields:[seed]}]}};
    const node = {id:"video",type:CanvasNodeType.Video,title:"视频",width:320,height:180,position:{x:0,y:0},metadata:{workflowProvider:"runninghub" as const,runningHubWorkflowId:"seed"}};
    expect(buildGenerationConfig(config,node,"video").runningHub.workflows[0].fields?.[0].randomEnabled).toBe(true);
    expect(buildGenerationConfig(config,{...node,metadata:{...node.metadata,workflowParameters:{"field:11:noise_seed":99,"random:11:noise_seed":false}}},"video").runningHub.workflows[0].fields?.[0].randomEnabled).toBe(false);
});
