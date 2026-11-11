import { describe, expect, test } from 'bun:test';
import { createSimGo } from './sim-go.mjs';

function emptyCanvas(sim, canvasId) {
  return sim.ensureCanvas(canvasId, {
    id: canvasId,
    title: '分镜一致性',
    revision: 1,
    nodes: [],
    connections: [],
    timeline: null,
  });
}

describe('分镜行时长与真实后端一致', () => {
  test('行草稿接受任意有限数字；只在准备视频草稿时校验 1..60 秒', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-duration-image';
    emptyCanvas(sim, canvasId);
    sim.beginTurn({ turnId: 'turn-duration-image', canvasId, permissionMode: 'canvas' });
    const row = (seconds) => ({
      durationSeconds: seconds,
      plotDescription: '雨夜站台',
      imageGenerationPrompt: '雨夜站台首帧',
      videoMotionPrompt: '镜头缓推',
    });
    const prepared = sim.executeOp('canvas.script.prepare', {
      canvasId,
      expectedRevision: 1,
      script: { title: '长镜头', rows: [row(90)] },
      image: { model: 'seedream-3.0' },
    }, 'duration-image-1', 'turn-duration-image').result;
    const script = sim.ensureCanvas(canvasId).nodes.find((node) => node.id === prepared.nodeId);
    expect(script.metadata.storyboard.rows[0].durationSeconds).toBe(90);

    const videoCanvas = 'canvas-duration-video';
    emptyCanvas(sim, videoCanvas);
    sim.beginTurn({ turnId: 'turn-duration-video', canvasId: videoCanvas, permissionMode: 'canvas' });
    expect(() => sim.executeOp('canvas.script.prepare', {
      canvasId: videoCanvas,
      expectedRevision: 1,
      script: { title: '长镜头视频', rows: [row(90)] },
      video: { model: 'seedance-1.0', generateAudio: 'true' },
    }, 'duration-video-1', 'turn-duration-video')).toThrow(/有效的分镜时长/);
  });

  test('追加分镜行不套用 1..60 秒限制', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-duration-append';
    emptyCanvas(sim, canvasId);
    sim.beginTurn({ turnId: 'turn-duration-append', canvasId, permissionMode: 'canvas' });
    const created = sim.executeOp('canvas.nodes.create', {
      canvasId,
      expectedRevision: 1,
      nodes: [{ type: 'script', title: '分镜' }],
    }, 'duration-append-node', 'turn-duration-append').result;
    const appended = sim.executeOp('canvas.script.rows.append', {
      canvasId,
      nodeId: created.created[0].id,
      expectedRevision: 2,
      rows: [{ durationSeconds: 0, plotDescription: '零秒占位' }],
    }, 'duration-append-1', 'turn-duration-append').result;
    expect(appended.rowCount).toBe(1);
    expect(sim.ensureCanvas(canvasId).nodes[0].metadata.storyboard.rows[0].durationSeconds).toBe(0);
  });
});
