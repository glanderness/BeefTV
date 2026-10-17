import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createDurableSessionStore } from './durable-session-owner.mjs';

const msgText = (message) => typeof message.content === 'string'
  ? message.content
  : (message.content || []).map((part) => part.text || '').join('');
const userText = (payload) => payload.messages.filter((m) => m.role === 'user').map(msgText).join('\n');
const systemText = (payload) => payload.messages.filter((m) => m.role === 'system' || m.role === 'developer').map(msgText).join('\n');

async function createProducerFixture({ canvasState, script = () => null, buildTools = () => [], maxPlanContinuations = 4 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-producer-'));
  const payloads = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    payloads.push(body);
    const step = script(body, payloads.length);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (step?.tool) {
      frame({
        role: 'assistant',
        tool_calls: [{ index: 0, id: `call-${payloads.length}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }],
      });
      frame({}, 'tool_calls');
    } else {
      frame({ role: 'assistant', content: step?.reply || `reply ${payloads.length}` });
      frame({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('beeftv', {
    api: 'openai-completions',
    apiKey: 'synthetic',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: 'producer', name: 'producer', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  const models = createModels();
  models.setProvider(runtime.getProvider('beeftv'));
  const store = createDurableSessionStore({
    sessionRoot: path.join(directory, 'sessions'),
    workspaceRoot: path.join(directory, 'workspace'),
    getModels: () => models,
    getModelRef: () => ({ provider: 'beeftv', modelId: 'producer' }),
    buildTools,
    authorizeTurn: async () => ({ open: true, canvasId: 'canvas-1', permissionMode: 'canvas' }),
    readCanvas: canvasState ? async () => canvasState.current : null,
    maxPlanContinuations,
    settings: { retry: { maxRetries: 0 } },
  });
  return {
    store,
    payloads,
    async close() {
      await store.disposeAll();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('creative producer durable host', () => {
  test('injects <beeftv_studio> digest and prepends <canvas_changes> when user edits between turns', async () => {
    const canvasState = {
      current: {
        revision: 3,
        nodes: [
          {
            id: 'sb-1',
            type: 'script',
            title: '都市逆袭分镜',
            metadata: {
              storyboard: {
                rows: [{ id: 'r1', shotNumber: 1, durationSeconds: 4, plotDescription: '女主推门进入天台', imageNodeId: 'img-1', imageGenerationPrompt: '雨夜天台女主' }],
              },
            },
          },
          { id: 'img-1', type: 'image', title: '镜1首帧', metadata: { status: 'loading', taskStatus: 'running', content: '雨夜天台女主' } },
        ],
        connections: [],
      },
    };
    const fixture = await createProducerFixture({ canvasState });
    try {
      const entry = await fixture.store.ensureSession('canvas-1');
      const sub1 = await fixture.store.submit(entry, { turnId: 't-1', requestId: 'req-1', content: '查看当前画布状态', userText: '查看当前画布状态', revisionBefore: 3 });
      await fixture.store.wait(entry, sub1);

      expect(fixture.payloads.length).toBe(1);
      expect(systemText(fixture.payloads[0])).toContain('<beeftv_studio>');
      expect(systemText(fixture.payloads[0])).toContain('都市逆袭分镜');
      expect(systemText(fixture.payloads[0])).toContain('生成中 1');
      expect(userText(fixture.payloads[0])).not.toContain('<canvas_changes>');

      // Simulate user editing the storyboard title and image generation completing between turns
      canvasState.current = {
        revision: 5,
        nodes: [
          {
            id: 'sb-1',
            type: 'script',
            title: '赛博天台分镜（用户已改）',
            metadata: {
              storyboard: {
                rows: [{ id: 'r1', shotNumber: 1, durationSeconds: 4, plotDescription: '女主推门进入赛博天台', imageNodeId: 'img-1', imageGenerationPrompt: '霓虹雨夜天台女主' }],
              },
            },
          },
          { id: 'img-1', type: 'image', title: '镜1首帧', metadata: { status: 'success', assetId: 'asset-img-1', content: '霓虹雨夜天台女主' } },
        ],
        connections: [],
      };

      const sub2 = await fixture.store.submit(entry, { turnId: 't-2', requestId: 'req-2', content: '继续下一步', userText: '继续下一步', revisionBefore: 5 });
      await fixture.store.wait(entry, sub2);

      expect(fixture.payloads.length).toBe(2);
      expect(systemText(fixture.payloads[1])).toContain('赛博天台分镜（用户已改）');
      expect(systemText(fixture.payloads[1])).toContain('完成 1');
      expect(userText(fixture.payloads[1])).toContain('<canvas_changes>');
      expect(userText(fixture.payloads[1])).toContain('用户修改了「赛博天台分镜（用户已改）」');
      expect(userText(fixture.payloads[1])).toContain('「镜1首帧」生成完成');
    } finally {
      await fixture.close();
    }
  });

  test('plan_update maintains <beeftv_plan> and onYield continues todo steps until needs_user', async () => {
    const fixture = await createProducerFixture({
      script(_body, callIndex) {
        if (callIndex === 1) {
          return {
            tool: {
              name: 'plan_update',
              args: {
                goal: '制作两镜短剧并提议首帧',
                items: [
                  { id: 's1', title: '编写分镜脚本', status: 'done' },
                  { id: 's2', title: '创建首帧节点并提议生成', status: 'todo' },
                ],
              },
            },
          };
        }
        if (callIndex === 2) {
          // Model yields after step 1; onYield should see s2 is still todo and continue!
          return { reply: '已完成分镜脚本编写。' };
        }
        if (callIndex === 3) {
          return {
            tool: {
              name: 'plan_update',
              args: {
                items: [
                  { id: 's1', title: '编写分镜脚本', status: 'done' },
                  { id: 's2', title: '创建首帧节点并提议生成', status: 'needs_user', note: '等待用户确认首帧出图' },
                ],
              },
            },
          };
        }
        return { reply: '已准备好首帧生成提议，请确认后开始生成。' };
      },
    });
    try {
      const entry = await fixture.store.ensureSession('canvas-1');
      const sub = await fixture.store.submit(entry, { turnId: 't-plan', requestId: 'req-plan', content: '帮我做两镜短剧', userText: '帮我做两镜短剧', revisionBefore: 1 });
      const record = await fixture.store.wait(entry, sub);

      expect(fixture.payloads.length).toBe(4);
      expect(userText(fixture.payloads[2])).toContain('计划还没做完。继续做「创建首帧节点并提议生成」');
      expect(systemText(fixture.payloads[3])).toContain('<beeftv_plan>');
      expect(systemText(fixture.payloads[3])).toContain('[等你确认] 创建首帧节点并提议生成');
      expect(record.reply).toContain('请确认后开始生成');
      expect(record.plan).toMatchObject({ done: 1, total: 2 });

      const history = await fixture.store.history('canvas-1', entry.sessionId);
      expect(history.plan).toMatchObject({
        goal: '制作两镜短剧并提议首帧',
        done: 1,
        total: 2,
      });
    } finally {
      await fixture.close();
    }
  });

  test('recordEvent silently appends <canvas_event> while idle and surfaces it on next turn with deduplication', async () => {
    const fixture = await createProducerFixture();
    try {
      const entry = await fixture.store.ensureSession('canvas-1');
      const event1 = await fixture.store.recordEvent('canvas-1', {
        sessionId: entry.sessionId,
        requestId: 'task-done-1',
        kind: 'task_completed',
        message: '镜1首帧（节点 img-1）已生成完成，资源 asset-101。',
        data: { taskId: 'task-1', nodeId: 'img-1', assetId: 'asset-101' },
      });
      const eventDup = await fixture.store.recordEvent('canvas-1', {
        sessionId: entry.sessionId,
        requestId: 'task-done-1',
        kind: 'task_completed',
        message: '镜1首帧（节点 img-1）已生成完成，资源 asset-101。',
        data: { taskId: 'task-1', nodeId: 'img-1', assetId: 'asset-101' },
      });
      expect(event1.submissionId).toBe(eventDup.submissionId);
      expect(fixture.payloads.length).toBe(0);

      const sub = await fixture.store.submit(entry, { turnId: 't-after-event', requestId: 'req-after-event', content: '检查刚才生成的图', userText: '检查刚才生成的图', revisionBefore: 2 });
      await fixture.store.wait(entry, sub);

      expect(fixture.payloads.length).toBe(1);
      const allUsers = userText(fixture.payloads[0]);
      expect(allUsers).toContain('<canvas_event kind="task_completed">');
      expect(allUsers).toContain('镜1首帧（节点 img-1）已生成完成，资源 asset-101。');
      expect(allUsers.split('asset-101').length - 1).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
