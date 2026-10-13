// Skills follow the conversation transcript, and the root agent's reasoning
// level reaches the provider request. Local fake model only; no paid calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { agentThinkingLevel, createDurableSessionStore } from './durable-session-owner.mjs';

const hash = (c) => c.repeat(64);
const batches = { skillId: 'batches', versionId: 'v1', contentHash: hash('a') };
const landscape = { skillId: 'landscape', versionId: 'v1', contentHash: hash('b') };
const catalogOnly = { skillId: 'catalog-only', versionId: 'v3', contentHash: hash('c') };
const bodies = {
  batches: { name: '短剧资产分批', description: '先出角色，再出场景', instruction: '第一步：只做 4 张竖版角色图，做完停下等确认。第二步：场景图。' },
  landscape: { name: '横版改写', description: '改为横版', instruction: '所有画面改为 16:9 横版。' },
  'catalog-only': { name: '采访切片', description: '保留采访原话', instruction: '按原话切出三个镜头。' },
};
const resourceFor = (pin) => ({ pin, ...bodies[pin.skillId], version: pin.versionId.slice(1), files: [], unsupportedCapabilities: [] });

async function skillFixture(directory, { thinkingLevel, script = () => null, gate = async () => {} } = {}) {
  const payloads = [], reads = [], catalogs = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body);
    await gate(body, payloads.length);
    const tool = script(body, payloads.length);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (tool) frame({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${payloads.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
    else frame({ role: 'assistant', content: `reply ${payloads.length}` });
    frame({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('beeftv', { api: 'openai-completions', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: 'thinker', name: 'thinker', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 16384,
      compat: { supportsReasoningEffort: true }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const models = createModels(); models.setProvider(runtime.getProvider('beeftv'));
  const store = createDurableSessionStore({ sessionRoot: path.join(directory, 'sessions'), workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models, getModelRef: () => ({ provider: 'beeftv', modelId: 'thinker' }), buildTools: () => [],
    authorizeTurn: async () => ({ open: true, canvasId: 'canvas', permissionMode: 'canvas' }), settings: { retry: { maxRetries: 0 } },
    ...(thinkingLevel ? { thinkingLevel } : {}),
    skills: {
      readVersion: async (_entry, pin, _signal, turnId) => { reads.push({ pin, turnId }); return resourceFor(pin); },
      readCatalog: async () => { catalogs.push(1); return { skills: [batches, catalogOnly].map((pin) => ({ pin, name: bodies[pin.skillId].name, description: bodies[pin.skillId].description })) }; },
    } });
  return { store, payloads, reads, catalogs,
    async close() { await store.disposeAll(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

const text = (message) => typeof message.content === 'string' ? message.content : (message.content || []).map((part) => part.text || '').join('');
const userText = (payload) => payload.messages.filter((m) => m.role === 'user').map(text).join('\n');
const systemText = (payload) => payload.messages.filter((m) => m.role === 'system' || m.role === 'developer').map(text).join('\n');
const count = (haystack, needle) => haystack.split(needle).length - 1;
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `beeftv-skills-${name}-`));

test('a selected skill lives in the transcript for later turns, survives restart, and is not duplicated', { timeout: 60000 }, async () => {
  const directory = temp('transcript');
  let fixture;
  try {
    fixture = await skillFixture(directory);
    const entry = await fixture.store.createSession('canvas');
    const first = await fixture.store.submit(entry, { turnId: 'turn-1', content: '按技能做角色图', userText: '按技能做角色图', skills: [{ ...batches, skillName: '短剧资产分批' }] });
    assert.equal((await fixture.store.wait(entry, first)).error, null);
    const one = fixture.payloads.at(-1);
    assert.match(userText(one), /<skill name="短剧资产分批" version="1" skillId="batches"/);
    assert.match(userText(one), /第一步：只做 4 张竖版角色图[\s\S]*<\/skill>\n\n按技能做角色图/);
    assert.doesNotMatch(systemText(one), /第一步/, 'skill body must not be a per-turn system section');
    assert.match(systemText(one), /<available_skills>[\s\S]*<id>catalog-only<\/id>/);
    assert.deepEqual(fixture.reads.map((read) => read.turnId), ['turn-1']);

    const second = await fixture.store.submit(entry, { turnId: 'turn-2', content: 'A', userText: 'A' });
    assert.equal((await fixture.store.wait(entry, second)).error, null);
    const two = fixture.payloads.at(-1);
    const all = JSON.stringify(two.messages);
    assert(!all.includes('Removed system prompt section'), all);
    assert.equal(count(userText(two), '第一步：只做 4 张竖版角色图'), 1);
    assert.equal(systemText(two), systemText(one), 'system prompt must stay byte-stable between turns');
    assert.equal(fixture.reads.length, 1);

    const history = await fixture.store.history('canvas', entry.sessionId);
    assert.deepEqual(history.turns.map((turn) => turn.userText), ['按技能做角色图', 'A']);
    assert(!JSON.stringify(history).includes('<skill'), 'history must show only the user text');
    assert.equal(history.turns[0].skills[0].skillId, 'batches');
    const listed = await fixture.store.listCanvasSessions('canvas');
    assert.equal(listed[0].title, '按技能做角色图');

    await fixture.close();
    fixture = await skillFixture(directory);
    const restored = await fixture.store.ensureSession('canvas', entry.sessionId);
    const third = await fixture.store.submit(restored, { turnId: 'turn-3', content: '重新选了同一个技能', userText: '重新选了同一个技能', skills: [batches] });
    assert.equal((await fixture.store.wait(restored, third)).error, null);
    const three = fixture.payloads.at(-1);
    assert.equal(fixture.reads.length, 0, 'loaded skills survive restart');
    assert.equal(count(userText(three), '第一步：只做 4 张竖版角色图'), 1, 'identical re-selection must not duplicate the body');
    assert(!JSON.stringify(three.messages).includes('Removed system prompt section'));
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a skill selected with a supplement joins the transcript once', { timeout: 60000 }, async () => {
  const directory = temp('supplement');
  let fixture, release, arrived;
  const held = new Promise((resolve) => { release = resolve; });
  const first = new Promise((resolve) => { arrived = resolve; });
  try {
    fixture = await skillFixture(directory, { gate: async (_body, index) => { if (index === 1) { arrived(); await held; } } });
    const entry = await fixture.store.createSession('canvas');
    const submission = await fixture.store.submit(entry, { turnId: 'turn-1', content: '做角色图', userText: '做角色图' });
    await first;
    await fixture.store.supplement(entry, { requestId: 'wide', content: '改成横版', input: { message: '改成横版', attachments: [], skills: [landscape] } });
    // A retried identical supplement is accepted without loading again.
    await fixture.store.supplement(entry, { requestId: 'wide', content: '改成横版', input: { message: '改成横版', attachments: [], skills: [landscape] } });
    release();
    const record = await fixture.store.wait(entry, submission);
    assert.equal(record.error, null);
    assert.deepEqual(record.supplements, ['改成横版']);
    const last = fixture.payloads.at(-1);
    assert.equal(count(userText(last), '所有画面改为 16:9 横版。'), 1);
    assert.match(userText(last), /<\/skill>\n\n改成横版/);
    assert.equal(fixture.reads.length, 1);
    assert(!JSON.stringify(record).includes('<skill'));
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('recovering an interrupted round resubmits the stored expanded input without reloading', { timeout: 60000 }, async () => {
  const directory = temp('recover');
  let fixture, arrived;
  const first = new Promise((resolve) => { arrived = resolve; });
  try {
    fixture = await skillFixture(directory, { gate: async () => { arrived(); await new Promise(() => {}); } });
    const entry = await fixture.store.createSession('canvas');
    await fixture.store.submit(entry, { turnId: 'turn-1', content: '做角色图', userText: '做角色图', skills: [batches] });
    await first;
    assert.equal(fixture.reads.length, 1);
    await fixture.close();
    fixture = await skillFixture(directory);
    const restored = await fixture.store.ensureSession('canvas', entry.sessionId);
    const submission = await fixture.store.recover(restored);
    const record = await fixture.store.wait(restored, submission);
    assert.equal(record.error, null, JSON.stringify(record));
    assert.equal(fixture.reads.length, 0, 'recovery must not reload the skill');
    assert.equal(count(userText(fixture.payloads.at(-1)), '第一步：只做 4 张竖版角色图'), 1);
    assert.equal(record.userText, '做角色图');
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('skill_load loads an advertised skill into the transcript and records it', { timeout: 60000 }, async () => {
  const directory = temp('load');
  let fixture;
  try {
    fixture = await skillFixture(directory, { script: (body) => body.messages.some((m) => m.role === 'tool') ? null : { name: 'skill_load', args: { id: 'catalog-only' } } });
    const entry = await fixture.store.createSession('canvas');
    const first = await fixture.store.submit(entry, { turnId: 'turn-1', content: '帮我切采访', userText: '帮我切采访' });
    assert.equal((await fixture.store.wait(entry, first)).error, null);
    assert(fixture.payloads[0].tools.some((tool) => tool.function?.name === 'skill_load'));
    const result = fixture.payloads[1].messages.find((m) => m.role === 'tool');
    assert.match(text(result), /<skill name="采访切片" version="3" skillId="catalog-only"[\s\S]*按原话切出三个镜头。/);
    assert.deepEqual(fixture.reads.map((read) => read.pin), [{ skillId: 'catalog-only', versionId: 'v3', contentHash: hash('c') }]);
    // Selecting the loaded version later does not expand it a second time.
    const second = await fixture.store.submit(entry, { turnId: 'turn-2', content: '继续', userText: '继续', skills: [catalogOnly] });
    assert.equal((await fixture.store.wait(entry, second)).error, null);
    assert.equal(fixture.reads.length, 1);
    assert.equal(count(JSON.stringify(fixture.payloads.at(-1).messages), '按原话切出三个镜头。'), 1);
  } finally { await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('thinking level defaults to low, honours the env, and reaches existing conversations on their next turn', { timeout: 60000 }, async () => {
  assert.equal(agentThinkingLevel({}), 'low');
  assert.equal(agentThinkingLevel({ BEEFTV_AGENT_THINKING: 'HIGH' }), 'high');
  assert.equal(agentThinkingLevel({ BEEFTV_AGENT_THINKING: 'off' }), 'off');
  assert.equal(agentThinkingLevel({ BEEFTV_AGENT_THINKING: 'xhigh' }), 'low');
  const directory = temp('thinking');
  let fixture;
  const previous = process.env.BEEFTV_AGENT_THINKING;
  try {
    delete process.env.BEEFTV_AGENT_THINKING;
    fixture = await skillFixture(directory);
    const entry = await fixture.store.createSession('canvas');
    const first = await fixture.store.submit(entry, { turnId: 'turn-1', content: '你好', userText: '你好' });
    assert.equal((await fixture.store.wait(entry, first)).error, null);
    assert.equal(fixture.payloads.at(-1).reasoning_effort, 'low');
    await fixture.close();
    fixture = await skillFixture(directory, { thinkingLevel: 'off' });
    const off = await fixture.store.ensureSession('canvas', entry.sessionId);
    const second = await fixture.store.submit(off, { turnId: 'turn-2', content: '再来', userText: '再来' });
    assert.equal((await fixture.store.wait(off, second)).error, null);
    assert.equal(fixture.payloads.at(-1).reasoning_effort, undefined);
    await fixture.close();
    process.env.BEEFTV_AGENT_THINKING = 'medium';
    fixture = await skillFixture(directory);
    const medium = await fixture.store.ensureSession('canvas', entry.sessionId);
    const third = await fixture.store.submit(medium, { turnId: 'turn-3', content: '继续', userText: '继续' });
    assert.equal((await fixture.store.wait(medium, third)).error, null);
    assert.equal(fixture.payloads.at(-1).reasoning_effort, 'medium');
  } finally {
    if (previous === undefined) delete process.env.BEEFTV_AGENT_THINKING; else process.env.BEEFTV_AGENT_THINKING = previous;
    await fixture?.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
