import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createNativePartStore } from './native-part-store.mjs';
import { mediaToolResult, adaptMediaRequest, trustedMediaSources } from './media-content.mjs';
import { createOperationBridge } from './operation-bridge.mjs';
import { createDurableSessionStore } from './durable-session-owner.mjs';
import { providerRegistration } from './canvas-turn.mjs';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
const model = { api: 'openai-completions', modelId: 'gemini-synthetic-flash' };
function fixture(directory) {
  const bytes = crypto.randomBytes(720000);
  const part = { type: 'media', mimeType: 'audio/wav', data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    source: { canvasId: 'c1', nodeId: 'n1', resourceId: 'r1', version: 'source-version', startMs: 0, endMs: 15000 } };
  const store = createNativePartStore({ directory });
  return { bytes, part, store };
}
function transcript(content) { return { messages: [{ role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'media_inspect' } }] }, { role: 'tool', tool_call_id: 't1', content }] }; }
test('native bytes persist atomically, reopen and stay outside official token estimate and transcript', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-store-'));
  try {
    const { part, store } = fixture(directory);
    const result = mediaToolResult({ result: { content: [part] } }, 'media.inspect', { ...model, nativePartStore: store });
    const content = result.content.map(block => block.text).join('\n');
    expect(content.length).toBeLessThan(2000); expect(content).not.toContain(part.data);
    expect(estimateMessageTokens({ role: 'toolResult', content: result.content })).toBeLessThan(500);
    expect(fs.readdirSync(directory).sort()).toEqual([part.sha256+'.bin', part.sha256+'.json'].sort());
    const reopened = createNativePartStore({ directory });
    expect(reopened.read(part.sha256)).toEqual(part);
    const sources = trustedMediaSources(transcript(content), { ...model, nativePartStore: reopened }); expect(sources).toEqual([part.source]);
    const payload = adaptMediaRequest(transcript(content), { ...model, nativePartStore: reopened });
    expect(adaptMediaRequest(transcript(content), model, reopened)).toEqual(payload);
    expect(payload.messages.at(-1).content.at(-1)).toEqual({
      type: 'input_audio', input_audio: { data: part.data, format: 'wav' },
    });
    expect(adaptMediaRequest(payload, model)).toEqual(payload);
    if (process.platform !== 'win32') { expect(fs.statSync(directory).mode & 0o777).toBe(0o700); expect(fs.statSync(path.join(directory, part.sha256+'.bin')).mode & 0o777).toBe(0o600); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('path references, corrupt bytes/manifests and forged sources are rejected without repair', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-store-negative-'));
  try {
    const { part, store } = fixture(directory); const ref = store.write(part);
    for (const id of ['../escape', 'https://example.invalid/audio', '/tmp/media', 'A'.repeat(64)]) expect(() => store.read(id)).toThrow('invalid_native_part_reference');
    expect(() => store.read({ ...ref, source: { ...part.source, nodeId: 'foreign-node' } })).toThrow('native_part_source_changed');
    expect(() => store.read({ ...ref, mimeType: 'video/mp4' })).toThrow('native_part_manifest_changed');
    const other = { ...part, source: { ...part.source, nodeId: 'second-owned-node' } }; const otherRef = store.write(other); expect(store.read(otherRef).source.nodeId).toBe('second-owned-node');
    fs.writeFileSync(path.join(directory, ref.id+'.bin'), Buffer.alloc(720000));
    expect(() => store.read(ref)).toThrow('media_content_changed'); expect(() => store.write(part)).toThrow('media_content_changed');
    fs.writeFileSync(path.join(directory, ref.id+'.bin'), Buffer.from(part.data, 'base64'));
    const file = path.join(directory, ref.id+'.json'); const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); manifest.sha256 = 'f'.repeat(64); fs.writeFileSync(file, JSON.stringify(manifest));
    expect(() => store.read(ref)).toThrow('native_part_manifest_changed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('short reference expansion requires media tool provenance and an issued store reference', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-source-'));
  try {
    const { part, store } = fixture(directory); const ref = store.write(part); const marker = 'BEEFTV_MEDIA_REF_V1:'+JSON.stringify(ref);
    const payload = transcript(marker); payload.messages[0].tool_calls[0].function.name = 'canvas_get';
    expect(() => adaptMediaRequest(payload, { ...model, nativePartStore: store })).toThrow('media_source_not_trusted');
    expect(() => trustedMediaSources(payload, { ...model, nativePartStore: store })).toThrow('media_source_not_trusted');
    expect(() => adaptMediaRequest(transcript(marker), model)).toThrow('native_part_store_required');
    const forged = { ...ref, source: { ...part.source, version: 'new-invented-version' } };
    expect(() => trustedMediaSources(transcript('BEEFTV_MEDIA_REF_V1:'+JSON.stringify(forged)), { ...model, nativePartStore: store })).toThrow('native_part_source_changed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reference-aware pruneUnreferenced protects live sessions and evicts only released/dead parts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-prune-'));
  try {
    const store = createNativePartStore({ directory });
    const makePart = (fillByte, nodeId) => {
      const bytes = Buffer.alloc(600_000, fillByte);
      return {
        type: 'media',
        mimeType: 'video/mp4',
        data: bytes.toString('base64'),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        source: { canvasId: 'c1', nodeId, resourceId: `r-${nodeId}`, version: `v-${nodeId}`, startMs: 0, endMs: 5000 },
      };
    };
    const partLive = makePart(1, 'n-live');
    const partReleased = makePart(2, 'n-released');
    const partShared = makePart(3, 'n-shared');

    const refLive = store.write(partLive, { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000001' });
    // Age live part's mtime to be the oldest: mtime alone must NEVER cause eviction!
    const oldTime = new Date(Date.now() - 86_400_000);
    fs.utimesSync(path.join(directory, `${refLive.id}.bin`), oldTime, oldTime);

    const refShared = store.write(partShared, { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000002' });
    store.copySessionRefs('c1', 'durable:00000000-0000-0000-0000-000000000002', 'durable:00000000-0000-0000-0000-000000000003');
    const refReleased = store.write(partReleased, { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000002' });

    // While all sessions are live, pruning below total bytes must evict ZERO parts.
    const noEvict = store.pruneUnreferenced({ maxTotalBytes: 100_000 });
    expect(noEvict.deleted).toEqual([]);
    expect(store.read(refLive).sha256).toBe(refLive.id);

    // Deleting session 2 releases partReleased (0 refs) while partShared stays protected by forked session 3.
    const rel = store.releaseSession('c1', 'durable:00000000-0000-0000-0000-000000000002');
    expect(rel.unreferencedIds).toEqual([refReleased.id]);

    const pruned = store.pruneUnreferenced({ maxTotalBytes: 100_000 });
    expect(pruned.deleted).toEqual([refReleased.id]);
    expect(pruned.reclaimedBytes).toBe(600_000);
    expect(store.read(refLive).sha256).toBe(refLive.id);
    expect(store.read(refShared).sha256).toBe(refShared.id);
    expect(() => store.read(refReleased)).toThrow();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing native parts (ENOENT) and >32 MiB requests degrade gracefully into structured placeholders', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-degrade-'));
  try {
    const store = createNativePartStore({ directory });
    const makeVideo = (idx, size) => {
      const bytes = Buffer.alloc(size, idx + 10);
      return {
        type: 'media',
        mimeType: 'video/mp4',
        data: bytes.toString('base64'),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        source: { canvasId: 'c1', nodeId: `n-${idx}`, resourceId: `r-${idx}`, version: `v-${idx}`, startMs: idx * 1000, endMs: (idx + 1) * 1000 },
      };
    };

    // Missing part (ENOENT) degrades cleanly without throwing native_history_unavailable.
    const vanished = makeVideo(0, 64_000);
    const vanishedRef = store.write(vanished, { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000099' });
    fs.rmSync(path.join(directory, `${vanishedRef.id}.json`));
    fs.rmSync(path.join(directory, `${vanishedRef.id}.bin`));
    const missingMarker = `BEEFTV_MEDIA_REF_V1:${JSON.stringify(vanishedRef)}`;
    expect(trustedMediaSources(transcript(missingMarker), { ...model, nativePartStore: store })).toEqual([]);
    const missingAdapted = adaptMediaRequest(transcript(missingMarker), { ...model, nativePartStore: store });
    expect(missingAdapted.messages[1].content).toContain('"degradedMedia":true');
    expect(missingAdapted.messages[1].content).toContain('"reason":"missing"');
    expect(missingAdapted.messages[1].content).toContain('"resourceId":"r-0"');
    expect(missingAdapted.messages[1].content).toContain('"mimeType":"video/mp4"');

    // Corrupt on-disk manifest degrades safely to text placeholder (never returns tampered bytes, never bricks session).
    const corrupt = makeVideo(99, 64_000);
    const corruptRef = store.write(corrupt, { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000099' });
    fs.writeFileSync(path.join(directory, `${corruptRef.id}.json`), '{truncated-json');
    const corruptMarker = `BEEFTV_MEDIA_REF_V1:${JSON.stringify(corruptRef)}`;
    expect(trustedMediaSources(transcript(corruptMarker), { ...model, nativePartStore: store })).toEqual([]);
    const corruptAdapted = adaptMediaRequest(transcript(corruptMarker), { ...model, nativePartStore: store });
    expect(corruptAdapted.messages[1].content).toContain('"degradedMedia":true');
    expect(corruptAdapted.messages[1].content).toContain('"reason":"corrupt"');
    expect(corruptAdapted.messages[1].content).toContain('"resourceId":"r-99"');

    // 8 videos x 5 MiB binary (~6.67 MiB base64 wire each = ~53.3 MiB wire > 32 MiB cap):
    // newest 4 (~26.67 MiB wire <= 32 MiB) remain binary, older 4 degrade cleanly!
    const messages = [];
    for (let i = 1; i <= 8; i += 1) {
      const part = makeVideo(i, 5 * 1024 * 1024);
      const ref = store.write(part, { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000099' });
      messages.push({ role: 'assistant', tool_calls: [{ id: `t${i}`, function: { name: 'media_inspect' } }] });
      messages.push({ role: 'tool', tool_call_id: `t${i}`, content: `BEEFTV_MEDIA_REF_V1:${JSON.stringify(ref)}` });
    }
    const sources = trustedMediaSources({ messages }, { ...model, nativePartStore: store });
    expect(sources).toHaveLength(4);
    expect(sources.map((s) => s.resourceId)).toEqual(['r-5', 'r-6', 'r-7', 'r-8']);

    const adapted = adaptMediaRequest({ messages }, { ...model, nativePartStore: store });
    const toolMsgs = adapted.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs[0].content).toContain('"reason":"budget_exceeded"');
    expect(toolMsgs[0].content).toContain('"resourceId":"r-1"');
    expect(toolMsgs[3].content).toContain('"reason":"budget_exceeded"');
    expect(toolMsgs[3].content).toContain('"resourceId":"r-4"');
    const binaryParts = adapted.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .filter((p) => p.type === 'image_url');
    expect(binaryParts).toHaveLength(4);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy non-refs manifests are excluded from evictable totalBytes accounting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-legacy-'));
  try {
    const store = createNativePartStore({ directory });
    const legacyBytes = Buffer.alloc(900_000, 7);
    const legacyPart = {
      type: 'media',
      mimeType: 'video/mp4',
      data: legacyBytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(legacyBytes).digest('hex'),
      source: { canvasId: 'c1', nodeId: 'n-legacy', resourceId: 'r-legacy', version: 'v-leg', startMs: 0, endMs: 1000 },
    };
    // Write without refContext -> legacy manifest (no refs array)
    const legacyRef = store.write(legacyPart);

    const trackedBytes = Buffer.alloc(200_000, 8);
    const trackedPart = {
      type: 'media',
      mimeType: 'video/mp4',
      data: trackedBytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(trackedBytes).digest('hex'),
      source: { canvasId: 'c1', nodeId: 'n-tracked', resourceId: 'r-tracked', version: 'v-trk', startMs: 0, endMs: 1000 },
    };
    const trackedRef = store.write(trackedPart, { canvasId: 'c1', sessionId: 'durable:00000000-0000-0000-0000-000000000010' });
    store.releaseSession('c1', 'durable:00000000-0000-0000-0000-000000000010');

    // Limit = 500_000: trackedBytes (200_000) <= limit, even though legacyBytes is 900_000!
    // Legacy bytes must NOT cause premature eviction of tracked parts under budget.
    const underBudget = store.pruneUnreferenced({ maxTotalBytes: 500_000 });
    expect(underBudget.deleted).toEqual([]);
    expect(underBudget.totalBytes).toBe(200_000);
    expect(underBudget.legacyBytes).toBe(900_000);
    expect(store.read(legacyRef).sha256).toBe(legacyRef.id);
    expect(store.read(trackedRef).sha256).toBe(trackedRef.id);

    // Lowering limit below trackedBytes evicts only unreferenced tracked parts and leaves legacy intact.
    const overBudget = store.pruneUnreferenced({ maxTotalBytes: 100_000 });
    expect(overBudget.deleted).toEqual([trackedRef.id]);
    expect(overBudget.totalBytes).toBe(0);
    expect(store.read(legacyRef).sha256).toBe(legacyRef.id);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('full-access cross-canvas inspection binds ref to owning session canvas so pruneUnreferenced keeps it alive until owner deletes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-cross-canvas-'));
  try {
    const store = createNativePartStore({ directory });
    const bytes = Buffer.alloc(300_000, 0x33);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const foreignPart = {
      type: 'media',
      mimeType: 'video/mp4',
      data: bytes.toString('base64'),
      sha256: sha,
      source: { canvasId: 'canvas-B', nodeId: 'node-b1', resourceId: 'res-b1', version: 'a'.repeat(64), startMs: 0, endMs: 3000 },
    };
    const mediaInspectDescriptor = {
      id: 'media.inspect',
      readOnly: true,
      replay: 'safe',
      assistantModes: ['read-only', 'canvas', 'full-access'],
      scope: 'canvas',
      summary: 'Inspect media',
      params: {
        type: 'object',
        properties: { canvasId: { type: 'string' }, nodeId: { type: 'string' }, expectedVersion: { type: 'string' }, mode: { type: 'string' } },
        required: ['canvasId', 'expectedVersion', 'mode'],
      },
    };
    const opsServer = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/ops') {
        res.end(JSON.stringify({ code: 0, data: { ops: [mediaInspectDescriptor] } }));
        return;
      }
      res.end(JSON.stringify({
        code: 0,
        data: {
          result: {
            canvasId: 'canvas-B',
            durationMs: 5000,
            hasAudio: true,
            source: foreignPart.source,
            content: [foreignPart],
          },
        },
      }));
    });
    await new Promise((r) => opsServer.listen(0, '127.0.0.1', r));
    try {
      const bridge = createOperationBridge({
        opsUrl: `http://127.0.0.1:${opsServer.address().port}`,
        opsToken: 'tok-cross',
        opsClientId: 'cli-cross',
        mediaModel: model,
        nativePartStore: store,
        turnBudgetContext: { getStore: () => null },
      });
      await bridge.loadDescriptors();
      const sessionId = 'durable:00000000-0000-0000-0000-0000000000aa';
      const tools = bridge.buildTools('canvas-A', [], { durable: true, permissionMode: 'full-access' }, { turnId: 't-cross' }, sessionId);
      const inspectTool = tools.find((t) => t.name === 'media_inspect');
      expect(inspectTool).toBeTruthy();

      await inspectTool.execute('call-1', { canvasId: 'canvas-B', nodeId: 'node-b1', expectedVersion: 'a'.repeat(64), mode: 'video' });

      // Session exists ONLY on canvas-A (never on canvas-B).
      const isAlive = (cId, sId) => cId === 'canvas-A' && sId === sessionId;
      const whileAlive = store.pruneUnreferenced({ maxTotalBytes: 0, isSessionAlive: isAlive });
      expect(whileAlive.deleted).toEqual([]);
      expect(store.read(sha).sha256).toBe(sha);

      // Once canvas-A session is deleted, releaseSession + pruneUnreferenced reclaims the part cleanly.
      store.releaseSession('canvas-A', sessionId);
      const afterDelete = store.pruneUnreferenced({ maxTotalBytes: 0, isSessionAlive: () => false });
      expect(afterDelete.deleted).toEqual([sha]);
    } finally {
      await new Promise((r) => opsServer.close(r));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('forkSession copies native part refs and passes nativePartStore so deleting parent keeps child media intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-native-fork-store-'));
  const prevKey = process.env.BEEFTV_AGENT_API_KEY;
  process.env.BEEFTV_AGENT_API_KEY = 'sk-test-native-fork';
  const partStore = createNativePartStore({ directory: path.join(dir, 'parts') });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('beeftv', providerRegistration({ api: 'openai-completions', baseUrl, modelId: 'stub-fork', contextWindow: 64000, maxTokens: 1024 }));
  const store = createDurableSessionStore({
    sessionRoot: path.join(dir, 'sessions'),
    workspaceRoot: path.join(dir, 'workspace'),
    nativePartStore: partStore,
    getModels: () => runtime.models,
    getModelRef: () => ({ provider: 'beeftv', modelId: 'stub-fork' }),
    buildTools: () => [],
    authorizeTurn: async () => ({ open: true, canvasId: 'canvas-fork', permissionMode: 'canvas' }),
    settings: { retry: { maxRetries: 0 } },
  });
  try {
    const parent = await store.createSession('canvas-fork');
    const sub = await store.submit(parent, { turnId: 'turn-p1', requestId: 'req-p1', content: 'turn 1', userText: 'turn 1' });
    expect((await store.wait(parent, sub)).error).toBeNull();

    const bytes = Buffer.alloc(250_000, 0x55);
    const mediaPart = {
      type: 'media',
      mimeType: 'video/mp4',
      data: bytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      source: { canvasId: 'canvas-fork', nodeId: 'n1', resourceId: 'r-fork', version: 'b'.repeat(64), startMs: 0, endMs: 2000 },
    };
    const ref = partStore.write(mediaPart, { canvasId: 'canvas-fork', sessionId: parent.sessionId });

    // Fork at turn-p1 -> must copy refs from parent.sessionId to child.sessionId without throwing ReferenceError!
    const forked = await store.forkSession('canvas-fork', { sessionId: parent.sessionId, turnId: 'turn-p1' });
    expect(forked.sessionId).toBeTruthy();

    // Delete parent session -> triggers releaseSession(parent) + pruneUnreferenced; child MUST keep the part alive!
    await store.deleteSession('canvas-fork', parent.sessionId);
    expect(partStore.pruneUnreferenced({ maxTotalBytes: 0 }).deleted).toEqual([]);
    expect(partStore.read(ref).sha256).toBe(ref.id);

    // Delete forked child session -> now 0 live refs, pruneUnreferenced reclaims it!
    await store.deleteSession('canvas-fork', forked.sessionId);
    expect(partStore.pruneUnreferenced({ maxTotalBytes: 0 }).deleted).toEqual([ref.id]);
  } finally {
    await store.disposeAll();
    await new Promise((r) => server.close(r));
    if (prevKey === undefined) delete process.env.BEEFTV_AGENT_API_KEY;
    else process.env.BEEFTV_AGENT_API_KEY = prevKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
