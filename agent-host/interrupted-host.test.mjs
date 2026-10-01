import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { projectTurnHistory } from './canvas-turn.mjs';

const kind = 'beeftv.canvas.turn';
test('running journal entries stay hidden and completed entries replace their starts once', () => {
  const start = { type:'custom',customType:kind+'.started',data:{turnId:'aa',userText:'original'} };
  const end = { type:'custom',customType:kind,data:{turnId:'aa',userText:'original',reply:'done'} };
  expect(projectTurnHistory([start],kind,'aa')).toEqual([]);
  expect(projectTurnHistory([start],kind)[0].errorReason).toBe('turn_interrupted');
  expect(projectTurnHistory([start,end],kind)).toEqual([end.data]);
});

// The child below is the real packaged-source host and pi SDK; both network services
// are synthetic loopback fixtures. No real user canvas, credentials, or model is used.
test('SIGKILL after a tool receipt preserves the original turn in history after a real host restart', async () => {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const directory=mkdtempSync(path.join(tmpdir(),'beeftv interrupted host '));
  const hostToken='synthetic-crash-test-host';
  let child,base,env,log='',writes=0,modelCalls=0;
  const listen=s=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',()=>resolve(s.address().port));});
  const jsonBody=async req=>{let text='';for await(const part of req)text+=part;return JSON.parse(text||'{}');};
  const api=async(route,body)=>{
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','X-Beeftv-Agent-Token':hostToken},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    return response;
  };
  const ops=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.headers['x-beeftv-agent-token']!==hostToken){res.writeHead(403).end('{}');return;}
    if(req.url==='/api/ops') {
      res.end(JSON.stringify({code:0,data:{ops:[{id:'canvas.nodes.create',summary:'Create synthetic node',readOnly:false,scope:'canvas',params:{type:'object',properties:{canvasId:{type:'string'},expectedRevision:{type:'integer'},nodes:{type:'array',items:{type:'object'}}},required:['canvasId','expectedRevision','nodes']}}]}}));return;
    }
    const body=await jsonBody(req);
    if(req.url==='/api/ops/canvas.nodes.create') {
      writes++;
      res.end(JSON.stringify({code:0,data:{op:'canvas.nodes.create',opId:body.opId,replayed:false,result:{canvasId:'crash-canvas',revision:2,created:[{id:'synthetic-node',title:'new node'}]}}}));return;
    }
    res.writeHead(404).end('{}');
  });
  const model=createServer(async(req,res)=>{
    const body=await jsonBody(req);modelCalls++;
    if(modelCalls>1) return; // Keep the model turn pending until its host process is killed.
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(delta,finish)=>res.write('data: '+JSON.stringify({id:'synthetic-create',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
    send({role:'assistant',tool_calls:[{index:0,id:'crash-tool',type:'function',function:{name:'canvas_nodes_create',arguments:JSON.stringify({expectedRevision:1,nodes:[{title:'new node',type:'text'}]})}}]},null);
    send({},'tool_calls');res.end('data: [DONE]\n\n');
  });
  const waitFor=async(check,ms)=>{const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await delay(50);}throw new Error('fixture condition timed out: '+log.slice(-1500));};
  const launch=async()=>{
    child=spawn('node',[path.join(root,'agent-host/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',x=>{log+=x});child.stderr.on('data',x=>{log+=x});
    await waitFor(async()=>{if(child.exitCode!==null)throw new Error('host exited: '+log);try{return(await fetch(base+'/health',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},10000);
  };
  try {
    const opsPort=await listen(ops),modelPort=await listen(model);
    const reservation=createServer(),port=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
    base=`http://127.0.0.1:${port}`;
    env={...process.env,BEEFTV_AGENT_DATA_DIR:directory,BEEFTV_AGENT_HOST_TOKEN:hostToken,BEEFTV_AGENT_PORT:String(port),BEEFTV_OPS_URL:`http://127.0.0.1:${opsPort}/api`,BEEFTV_AGENT_API:'openai-completions',BEEFTV_AGENT_MODEL:'synthetic',BEEFTV_AGENT_API_KEY:'synthetic-only',BEEFTV_AGENT_BASE_URL:`http://127.0.0.1:${modelPort}/v1`,BEEFTV_AGENT_TOTAL_REQUEST_BUDGET:'0',BEEFTV_AGENT_MAX_REQUESTS_PER_TURN:'40',BEEFTV_AGENT_TURN_TIMEOUT_MS:'180000'};
    await launch();
    const chat=api('/chat',{canvasId:'crash-canvas',message:'Keep this original user request.',turnId:'abcddc10',revisionBefore:1}).then(r=>r.text()).catch(()=>null);
    await waitFor(()=>writes===1,12000);
    const active=await(await api('/history?canvasId=crash-canvas')).json();
    expect(active.turns).toEqual([]);
    const exited=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await exited;await chat;
    await launch();
    const history=await(await api('/history?canvasId=crash-canvas')).json();
    expect(history.turns.length,JSON.stringify(history)).toBe(1);
    expect(history.turns[0].turnId).toBe('abcddc10');
    expect(history.turns[0].userText).toBe('Keep this original user request.');
    expect(history.turns[0].errorReason).toBe('turn_interrupted');
    expect(writes).toBe(1); // Reopening history must not replay the tool.
  } finally {
    if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await Promise.race([exited,delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
    for(const server of [ops,model]) if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    rmSync(directory,{recursive:true,force:true});
  }
},35000);
