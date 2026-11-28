// Architectural boundary & standalone runtime behavior test for extensions/pi-creative-media/.
// Proves via REAL isolated execution (in an empty temp directory with only node_modules symlinked
// and ZERO BeefTV files reachable) that pi-creative-media has zero coupling to BeefTV modules.
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const agentHostDir = path.dirname(fileURLToPath(import.meta.url));
const extensionSrcDir = path.join(agentHostDir, 'extensions', 'pi-creative-media');

test('pi-creative-media imports and executes standalone in an isolated directory with zero BeefTV modules', async () => {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-creative-media-isolated-'));
  try {
    const isolatedExtDir = path.join(isolatedRoot, 'pkg', 'pi-creative-media');
    fs.mkdirSync(isolatedExtDir, { recursive: true });
    fs.cpSync(extensionSrcDir, isolatedExtDir, { recursive: true });
    fs.symlinkSync(path.join(agentHostDir, 'node_modules'), path.join(isolatedRoot, 'node_modules'), 'dir');

    // Import EVERY module from the isolated temp copy — any import pointing outside
    // pi-creative-media into BeefTV agent-host/studio/Go modules will throw ERR_MODULE_NOT_FOUND.
    const moduleFiles = fs.readdirSync(isolatedExtDir).filter((name) => name.endsWith('.mjs')).sort();
    expect(moduleFiles.length).toBeGreaterThanOrEqual(5);
    for (const file of moduleFiles) {
      const mod = await import(pathToFileURL(path.join(isolatedExtDir, file)).href);
      expect(typeof mod).toBe('object');
    }

    const pkg = await import(pathToFileURL(path.join(isolatedExtDir, 'index.mjs')).href);

    // 1. Composable extension factory builds Pi 1.6.0 extensions cleanly.
    const manager = pkg.createPhotonImageManager({ idleMs: 5000 });
    try {
      const exts = await pkg.createCreativeMediaExtensions({
        mediaPayload: {},
        compaction: {
          systemPrompt: 'Generic test compactor',
          buildPrompt: ({ messages }) => `Summarize ${messages.length} messages`,
        },
        fitImages: { manager },
      });
      expect(exts).toHaveLength(3);
      expect(exts.map((ext) => ext.name)).toEqual([
        'pi-creative-media.payload.v1',
        'pi-creative-media.compaction.v1',
        expect.any(String),
      ]);
    } finally {
      await manager.close();
    }

    // 2. Multimodal payload adapter works independently with domain-agnostic source shapes
    //    (zero canvasId/nodeId/assetId/resourceId), wire-byte budget, and corrupt-manifest degradation.
    const videoBytes = Buffer.from('standalone-mp4-bytes');
    const genericSource = { documentId: 'doc-42', clipId: 'clip-9', startMs: 0, endMs: 1000 };
    const part = {
      type: 'media',
      mimeType: 'video/mp4',
      data: videoBytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(videoBytes).digest('hex'),
      source: genericSource,
    };
    const payload = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'tc1', function: { name: 'inspect_clip' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: `PI_MEDIA_PART_V1:${JSON.stringify(part)}` },
      ],
    };
    const sources = pkg.collectTrustedMediaSources(payload, {
      api: 'openai-completions',
      modelId: 'gemini-3.8-flash',
      isTrustedToolName: (name) => name === 'inspect_clip',
    });
    expect(sources).toEqual([genericSource]);
    expect(sources[0].mediaKind).toBe('video');

    const adapted = pkg.adaptMultimodalRequest(payload, {
      api: 'openai-completions',
      modelId: 'gemini-3.8-flash',
      isTrustedToolName: (name) => name === 'inspect_clip',
    });
    expect(adapted.messages.at(-1).role).toBe('user');
    expect(adapted.messages.at(-1).content.at(-1)).toEqual({
      type: 'image_url',
      image_url: { url: `data:video/mp4;base64,${part.data}` },
    });

    // Corrupt persisted manifest degrades gracefully to a neutral domain-agnostic text placeholder.
    const corruptAdapted = pkg.adaptMultimodalRequest({
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'tc2', function: { name: 'inspect_clip' } }] },
        { role: 'tool', tool_call_id: 'tc2', content: `PI_MEDIA_REF_V1:${JSON.stringify({ id: part.sha256, mimeType: 'video/mp4', source: genericSource })}` },
      ],
    }, {
      api: 'openai-completions',
      modelId: 'gemini-3.8-flash',
      isTrustedToolName: (name) => name === 'inspect_clip',
      partStore: {
        read: () => { throw new SyntaxError('Unexpected end of JSON input'); },
      },
    });
    expect(corruptAdapted.messages[1].content).toContain('"degradedMedia":true');
    expect(corruptAdapted.messages[1].content).toContain('"reason":"corrupt"');
    expect(corruptAdapted.messages[1].content).toContain('"documentId":"doc-42"');
    expect(corruptAdapted.messages[1].content).not.toContain('media_inspect');

    // 3. Scoped SSE idle watchdog detects idle timeout without mutating globalThis.fetch.
    const originalFetch = globalThis.fetch;
    const scopedFetch = pkg.createScopedStreamIdleFetch({
      timeoutMs: 60,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const res = await scopedFetch('https://example.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [] }),
    });
    let timedOut = false;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
    } catch (err) {
      timedOut = /Model stream idle timeout/.test(String(err?.message || err));
    }
    expect(timedOut).toBe(true);
    expect(globalThis.fetch).toBe(originalFetch);
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});
