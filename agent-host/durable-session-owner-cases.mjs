import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { durableCompletion, durableToolReplay, publicDurableTurn } from './durable-session-owner.mjs';
const worker = fileURLToPath(new URL('./durable-owner-fixture.mjs', import.meta.url));
const processTest = (name, fn) => test(name, { timeout: 60000 }, fn);
test('failed or unanswered submission cannot reuse a prior assistant as a successful reply', () => {
  const prior = { stopReason: 'stop', content: [{ type: 'text', text: 'old reply' }] };
  const failed = durableCompletion({ status: 'unanswered', reason: 'model_error', detail: 'fixture failure' }, prior);
  assert.equal(failed.reply, ''); assert.equal(failed.errorReason, 'model_error'); assert(failed.error);
  const absent = durableCompletion({ status: 'done' }, null); assert(absent.error); assert.equal(absent.reply, '');
  const stopped = durableCompletion({ status: 'unanswered', reason: 'aborted' }, null);
  assert(stopped.cancelled); assert.equal(stopped.reply, '');
  const budget = durableCompletion({ status: 'unanswered', reason: 'model_error' }, null, { reason: 'turn_request_budget_exhausted', message: 'limit' });
  assert.equal(budget.errorReason, 'turn_request_budget_exhausted');
});
for (const phase of ['pending-success', 'pending-failure', 'pending-stop', 'partial-stop', 'multi-steer', 'persisted-supplement-stop', 'prep-error-partial']) processTest(`official owner ${phase} preserves latest input and current partial`, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-durable-${phase}-`)); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await run(directory, phase); assert.equal(result.code, 0, result.output);
});
for(const mode of ['read-only','canvas','full']) processTest(`official provider sees Go-authorized ${mode} schema and frozen history`,async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-durable-permission-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const result=await run(directory,`permission-${mode}`);assert.equal(result.code,0,result.output);
 const saved=JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8'));
 assert.equal(saved.record.permissionMode,mode==='full'?'full-access':mode);
 assert.equal(saved.state.executions,mode==='full'?1:0);
});
processTest('crash recovery rejects authority changing frozen read-only to full-access without dispatch',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'beeftv-durable-mode-upgrade-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const crash=await run(directory,'permission-crash');assertCheckpointKill(crash,directory,'permission-crash');
 const recovered=await run(directory,'permission-upgrade');assert.equal(recovered.code,0,recovered.output);
});
test('history projection excludes native media bytes and replay defaults unknown writes to unsafe', () => {
  const projected = publicDurableTurn({ turnId: 't', userText: 'read', content: [{ type: 'image', data: 'large-native-image' }],
    log: [{ data: 'secret' }], result: {}, effects: {}, supplementContents: [{ content: 'raw' }],
    supplementInputs: [{ message: '', attachments: [{ resourceId: 'r' }], skills: [] }] }, true);
  assert(!JSON.stringify(projected).includes('large-native-image'));
  assert.equal(projected.status, 'running'); assert.equal(projected.supplementInputs[0].message, '');
  assert.equal(durableToolReplay({ label: 'canvas.nodes.create' }), 'safe');
  assert.equal(durableToolReplay({ label: 'future.paid.submit' }), 'unsafe');
});
const run = (directory, phase) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [worker, directory, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`fixture timeout ${phase}: ${output}`)); }, 20000);
  child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  child.on('error', reject);
});
function assertCheckpointKill(result, directory, phase) {
  const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, 'crash-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.phase, phase);
  if (phase === 'crash' || phase === 'unsafe-crash') {
    assert.equal(checkpoint.state.nodes, 2); assert.equal(checkpoint.state.executions, 1);
    assert.equal(Object.keys(checkpoint.state.receipts).length, 1);
  }
  if (phase === 'complete-crash' || phase === 'fence-crash') assert.equal(checkpoint.state.completed, 1);
  if (phase === 'persisted-supplement-stop-crash') { assert.equal(checkpoint.state.completed, 1); assert.equal(checkpoint.state.unadmitted, true); assert.equal(checkpoint.state.executions, 0); }
  const files = fs.readdirSync(path.join(directory, 'sessions'), { recursive: true }).filter(file => String(file).endsWith('.sqlite'));
  assert.equal(files.length, 1, 'official Durable SQLite checkpoint missing');
  assert.equal(fs.readFileSync(path.join(directory, 'sessions', files[0])).subarray(0, 16).toString(), 'SQLite format 3\0');
  if (process.platform === 'win32') { assert.equal(result.signal, null, result.output); assert.equal(result.code, 1, result.output); }
  else assert.equal(result.signal, 'SIGKILL', result.output);
}
processTest('hard kill after receipt commit replays one stable tool task and never duplicates business effects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-crash-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'crash'); assertCheckpointKill(crash, directory, 'crash');
  const denied = await run(directory, 'denied'); assert.equal(denied.code, 0, denied.output);
  const resume = await run(directory, 'resume'); assert.equal(resume.code, 0, resume.output);
  const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  assert.equal(result.state.nodes, 2); assert.equal(result.state.edges, 2);
  assert.equal(Object.keys(result.state.receipts).length, 2);
  assert(Object.keys(result.state.receipts).every((id) => /^durable:[a-f0-9-]{36}:\d+$/.test(id)));
});
processTest('disconnect only cancels a wait; same-session supplement and pinned skill survive', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-wait-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = await run(directory, 'wait'); assert.equal(result.code, 0, result.output);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  assert.deepEqual(saved.record.supplements, ['Use landscape']);
});
processTest('completion crash only reconstructs history after Go is closed; no model dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-complete-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'complete-crash'); assertCheckpointKill(crash, directory, 'complete-crash');
  const resume = await run(directory, 'closed-resume'); assert.equal(resume.code, 0, resume.output);
});
processTest('unknown future paid write is unsafe and never rerun after effect-before-result crash', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-unsafe-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'unsafe-crash'); assertCheckpointKill(crash, directory, 'unsafe-crash');
  const resume = await run(directory, 'unsafe-resume'); assert.equal(resume.code, 0, resume.output);
});
processTest('explicit stop aborts official work and records cancellation without canvas writes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-stop-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stopped = await run(directory, 'stop'); assert.equal(stopped.code, 0, stopped.output);
});
processTest('supplement persists across hard kill and is placed before the recovered model request', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-supplement-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'supplement-crash'); assertCheckpointKill(crash, directory, 'supplement-crash');
  const resumed = await run(directory, 'supplement-resume'); assert.equal(resumed.code, 0, resumed.output);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
  assert.deepEqual(saved.record.supplements, ['Use landscape']);
  assert.equal(saved.record.supplementInputs[0].message, 'Use landscape');
});
processTest('persisted stop before Go close survives crash without dispatching a closed placed submission', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-fence-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'fence-crash'); assertCheckpointKill(crash, directory, 'fence-crash');
  const resumed = await run(directory, 'fence-resume'); assert.equal(resumed.code, 0, resumed.output);
});
processTest('stopped recovery skips persisted but unadmitted supplemental input and preserves its own partial', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-durable-admission-gap-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const crash = await run(directory, 'persisted-supplement-stop-crash'); assertCheckpointKill(crash, directory, 'persisted-supplement-stop-crash');
  const resumed = await run(directory, 'persisted-supplement-stop-resume'); assert.equal(resumed.code, 0, resumed.output);
});
processTest('actual default Durable host accepts attachment-only steer and blocks writes during image preparation', async () => {
  const probe = fileURLToPath(new URL('./test-support/durable-attachment-steer-probe.mjs', import.meta.url));
  const child = spawn(process.execPath, [probe, path.resolve(path.dirname(worker), '..')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }); clearTimeout(timer);
  assert.equal(code, 0, output); assert(output.includes('"attachmentOnly":true'));
});
