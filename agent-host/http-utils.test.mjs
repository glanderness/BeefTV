import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BODY_BYTES, MAX_EVENTS_BODY_BYTES, readJsonBody } from './http-utils.mjs';
import { handleEventsRoute } from './events-route.mjs';
import { fetchModelWithProgressIdle } from './model-stream-idle.mjs';

const hostDir = path.dirname(fileURLToPath(import.meta.url));

function streamOf(text) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

describe('agent-host http-utils body limits', () => {
  test('default readJsonBody rejects >64 KiB payload with tooLarge', async () => {
    const payload = JSON.stringify({ message: '测'.repeat(25000) }); // ~75 KiB UTF-8
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES);
    await expect(readJsonBody(streamOf(payload))).rejects.toMatchObject({ tooLarge: true });
  });

  test('/events body limit accepts 48,000-char Chinese skill_script_completed payload', async () => {
    const chineseMessage = '成'.repeat(48000); // 144,000 UTF-8 bytes
    const payload = JSON.stringify({ canvasId: 'c1', kind: 'skill_script_completed', message: chineseMessage });
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES);
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(MAX_EVENTS_BODY_BYTES);
    const parsed = await readJsonBody(streamOf(payload), MAX_EVENTS_BODY_BYTES);
    expect(parsed.message.length).toBe(48000);
  });

  test('handleEventsRoute accepts 48,000-char Chinese skill_script_completed payload and responds 202', async () => {
    const chineseMessage = '成'.repeat(48000);
    const payload = JSON.stringify({ canvasId: 'c1', kind: 'skill_script_completed', message: chineseMessage });
    let statusCode = 0;
    let bodyText = '';
    const res = {
      writeHead(code) { statusCode = code; },
      end(chunk) { bodyText = String(chunk || ''); },
    };
    let recorded = null;
    await handleEventsRoute(streamOf(payload), res, {
      durable: {
        recordEvent: async (canvasId, evt) => {
          recorded = { canvasId, len: evt.message.length, kind: evt.kind };
          return { accepted: true };
        },
      },
      ops: { opsRequest: async () => ({}) },
      currentId: () => '',
      followDurable: () => {},
      getProviderReason: () => '',
      readOnlyMode: false,
      modelApi: 'openai-completions',
      modelId: 'test-model',
    });
    expect(statusCode).toBe(202);
    expect(JSON.parse(bodyText)).toEqual({ accepted: true });
    expect(recorded).toEqual({ canvasId: 'c1', len: 48000, kind: 'skill_script_completed' });
  });

  test('real server.mjs enforces 64 KiB on /chat (413) while accepting 144 KiB Chinese /events (202)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-body-limit-'));
    const token = 'test-host-token';
    const child = spawn(process.execPath, [path.join(hostDir, 'server.mjs')], {
      env: {
        ...process.env,
        BEEFTV_AGENT_PORT: '0',
        BEEFTV_AGENT_HOST_TOKEN: token,
        BEEFTV_AGENT_DATA_DIR: dataDir,
        BEEFTV_OPS_URL: 'http://127.0.0.1:1/api',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const baseUrl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server.mjs start timeout')), 10000);
        let buf = '';
        child.stdout.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const match = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) { clearTimeout(timer); resolve(match[0]); }
        });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${buf}`)); });
      });

      const headers = { 'Content-Type': 'application/json', 'X-Beeftv-Agent-Token': token };

      // 1) /chat with ~75 KiB UTF-8 payload must still return 413 body_too_large.
      const chatRes = await fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ canvasId: 'c1', turnId: 'aabbccdd', message: '测'.repeat(25000) }),
      });
      expect(chatRes.status).toBe(413);
      expect(await chatRes.json()).toMatchObject({ code: 413, reason: 'body_too_large' });

      // 2) /events with 48,000-char Chinese skill_script_completed (~144 KiB UTF-8) must succeed with 202.
      const evtRes = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ canvasId: 'c1', kind: 'skill_script_completed', message: '成'.repeat(48000) }),
      });
      expect(evtRes.status).toBe(202);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('model-stream-idle flush timer guard', () => {
  test('observe.flush after stream EOF does not re-arm idle timer', async () => {
    const origSetTimeout = globalThis.setTimeout;
    let totalTimers = 0;
    let activeTimers = 0;
    const origClearTimeout = globalThis.clearTimeout;
    const tracked = new Set();
    globalThis.setTimeout = (...args) => {
      totalTimers += 1;
      const id = origSetTimeout(...args);
      tracked.add(id);
      activeTimers = tracked.size;
      return id;
    };
    globalThis.clearTimeout = (id) => {
      tracked.delete(id);
      activeTimers = tracked.size;
      return origClearTimeout(id);
    };
    try {
      const transport = async () => new Response(new ReadableStream({
        start(controller) {
          // No trailing newline so observe.flush() processes the terminal SSE record at EOF.
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}'));
          controller.close();
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

      let settled = null;
      const res = await fetchModelWithProgressIdle('https://example.invalid/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      }, { fetch: transport, timeoutMs: 200, onSettled: (info) => { settled = info; } });
      await res.text();
      expect(settled?.ok).toBe(true);
      // Only the initial arm() in ReadableStream.start(); observe.flush() at EOF must NOT re-arm a second timer.
      expect(totalTimers).toBe(1);
      expect(activeTimers).toBe(0);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});
