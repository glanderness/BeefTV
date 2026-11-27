import { describe, expect, test } from 'bun:test';
import {
  applyMonotoneMediaCutoff,
  buildStudioDigest,
  describeChangesSince,
  evaluateMonotoneMediaCutoff,
  isTransientStudioTailMessage,
  nodeState,
  normalizeSystemHeaderMessages,
  snapshotOf,
  withCurrentStudio,
} from './studio-digest.mjs';

const media = (id, type, title, meta = {}) => ({ id, type, title, metadata: meta });
const board = (rows) => ({ id: 'board-1', type: 'script', title: '13楼的外卖', metadata: { storyboard: { rows } } });
const row = (n, extra = {}) => ({ id: `row-${n}`, shotNumber: n, durationSeconds: 5, plotDescription: `第${n}镜剧情`, imageGenerationPrompt: 'p', videoMotionPrompt: '', ...extra });

describe('nodeState', () => {
  test('进行中、失败、完成、空', () => {
    expect(nodeState(media('a', 'image', 'x', { status: 'loading' }))).toBe('running');
    expect(nodeState(media('a', 'image', 'x', { taskStatus: 'queued' }))).toBe('running');
    expect(nodeState(media('a', 'image', 'x', { status: 'error' }))).toBe('failed');
    expect(nodeState(media('a', 'image', 'x', { assetId: 'asset-1' }))).toBe('done');
    expect(nodeState(media('a', 'image', 'x'))).toBe('empty');
  });
});

describe('buildStudioDigest', () => {
  const canvas = {
    revision: 12,
    nodes: [
      board([row(1, { imageNodeId: 'img-1', videoNodeId: 'vid-1' }), row(2, { imageNodeId: 'img-2' }), row(3)]),
      media('img-1', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
      media('vid-1', 'video', '镜1视频', { status: 'loading' }),
      media('img-2', 'image', '镜2首帧', { status: 'error', generationErrorSummary: '内容审核未通过' }),
    ],
    connections: [{ id: 'c1', fromNodeId: 'img-1', toNodeId: 'vid-1' }],
  };
  test('包含版本、分镜行绑定、进行中与失败，并带上 id', () => {
    const { text } = buildStudioDigest(canvas, { selectedNodeIds: ['img-2'] });
    expect(text).toContain('画布版本 12');
    expect(text).toContain('分镜板「13楼的外卖」id=board-1，共 3 镜');
    expect(text).toContain('镜1 5s｜行id=row-1｜首帧 img-1 完成｜视频 vid-1 生成中');
    expect(text).toContain('镜2 5s｜行id=row-2｜首帧 img-2 失败｜视频 — 未建');
    expect(text).toContain('镜3 5s｜行id=row-3｜首帧 — 未建');
    expect(text).toContain('生成中：vid-1');
    expect(text).toContain('失败：img-2「镜2首帧」内容审核未通过');
    expect(text).toContain('用户选中：img-2');
  });
  test('同一状态输出完全相同（缓存友好）', () => {
    expect(buildStudioDigest(canvas).text).toBe(buildStudioDigest(JSON.parse(JSON.stringify(canvas))).text);
  });
  test('超预算先收缩分镜明细，关键信息保留', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1, { imageNodeId: `i${i}`, plotDescription: '很长的剧情描述'.repeat(5) }));
    const big = { revision: 3, nodes: [board(rows), media('i0', 'image', 'x', { status: 'error', generationErrorSummary: '失败了' })], connections: [] };
    const { text } = buildStudioDigest(big, { maxBytes: 1500 });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1500);
    expect(text).toContain('失败：i0');
    expect(text).toContain('分镜明细已收缩');
  });
  test('空画布', () => {
    expect(buildStudioDigest({ revision: 0, nodes: [], connections: [] }).text).toContain('画布是空的');
  });
  test('文本节点的身份与当前正文预览可见，长文仍需按版本读取原文', () => {
    const { text } = buildStudioDigest({ revision: 23, nodes: [media('brief', 'text', '用户刚修改的要求', { content: '保持角色一致性。'.repeat(40) })] });
    expect(text).toContain('brief');
    expect(text).toContain('用户刚修改的要求');
    expect(text).toContain('保持角色一致性');
    expect(text).toContain('预览');
    expect(text).toContain('canvas_get');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3600);
  });
  test('已完成视频与音频在摘要中直接带出 durationMs，避免重复调用 canvas_get', () => {
    const { text } = buildStudioDigest({
      revision: 15,
      nodes: [
        board([row(1, { imageNodeId: 'img-1', videoNodeId: 'vid-1' })]),
        media('img-1', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
        media('vid-1', 'video', '镜1视频', { status: 'success', assetId: 'v1', durationMs: 5120 }),
        media('aud-1', 'audio', '旁白', { status: 'success', assetId: 'au1', durationMs: 4800 }),
      ],
      connections: [],
    });
    expect(text).toContain('视频 vid-1 完成(5120ms)');
    expect(text).toContain('aud-1「旁白」音频完成(4800ms)');
  });
});

describe('describeChangesSince', () => {
  const before = snapshotOf([
    media('a', 'image', '镜1首帧', { status: 'loading' }),
    media('b', 'text', '角色设定', { content: '老内容' }),
    media('c', 'image', '要删的', { assetId: 'x' }),
  ]);
  test('生成完成、用户修改、新增、删除都能说出来', () => {
    const after = snapshotOf([
      media('a', 'image', '镜1首帧', { status: 'success', assetId: 'a1' }),
      media('b', 'text', '角色设定', { content: '用户改过的内容' }),
      media('d', 'image', '新的', {}),
    ]);
    const text = describeChangesSince(before, after);
    expect(text).toContain('用户修改了「角色设定」');
    expect(text).toContain('新增 1 个节点');
    expect(text).toContain('删除了「要删的」');
    expect(text).toContain('「镜1首帧」生成完成');
  });
  test('失败要说出来；位置变化不算改动；无变化返回空串', () => {
    const failed = snapshotOf([media('a', 'image', '镜1首帧', { status: 'error' }), media('b', 'text', '角色设定', { content: '老内容' }), media('c', 'image', '要删的', { assetId: 'x' })]);
    expect(describeChangesSince(before, failed)).toContain('「镜1首帧」生成失败');
    const moved = snapshotOf([{ ...media('a', 'image', '镜1首帧', { status: 'loading' }), position: { x: 99, y: 1 } }, media('b', 'text', '角色设定', { content: '老内容' }), media('c', 'image', '要删的', { assetId: 'x' })]);
    expect(describeChangesSince(before, moved)).toBe('');
    expect(describeChangesSince(null, moved)).toBe('');
  });
  test('列表过长时压缩成“等 N 个”', () => {
    const many = (suffix) => snapshotOf(Array.from({ length: 9 }, (_, i) => media(`n${i}`, 'text', `节点${i}`, { content: suffix })));
    expect(describeChangesSince(many('旧'), many('新'))).toContain('等 9 个');
  });
});

describe('normalizeSystemHeaderMessages & withCurrentStudio', () => {
  test('头部只保留 instructions 与 beeftv_skill_catalog，保留后续工具增量，且不丢弃以标签开头的真实用户消息', () => {
    const toolDef = { name: 'extra_tool', description: 'extra', parameters: { type: 'object', properties: {} } };
    const messages = [
      {
        role: 'system',
        content: 'legacy prefix',
        sections: {
          beeftv_skill_catalog: 'CAT',
          instructions: 'INSTR',
          beeftv_studio: 'OLD_STUDIO',
          unknown_sec: 'NOPE',
        },
      },
      {
        role: 'system',
        content: 'mid convo text',
        toolsAdded: [toolDef],
        sections: { beeftv_plan: 'OLD_PLAN' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<beeftv_plan>\n用户自己贴的计划文本\n</beeftv_plan>' }],
      },
    ];

    const once = withCurrentStudio(messages, '[制作现场｜画布版本 1｜本轮请求前的实际状态]\n概况：画布是空的。', {
      planText: '当前制作计划：所有步骤已完成。',
    });
    expect(once[0].content).toBe('');
    expect(Object.keys(once[0].sections)).toEqual(['instructions', 'beeftv_skill_catalog']);
    expect(once[1].role).toBe('system');
    expect(once[1].content).toBe('');
    expect(once[1].sections).toBeUndefined();
    expect(once[1].toolsAdded).toEqual([toolDef]);
    // 真实用户消息即使以 <beeftv_plan> 开头也必须完整保留
    expect(once[2].role).toBe('user');
    expect(once[2].content[0].text).toContain('用户自己贴的计划文本');
    expect(isTransientStudioTailMessage(once[3])).toBe(true);

    // 再次叠加时只替换末尾生成的 transientStudioTail，不误删用户的消息
    const twice = withCurrentStudio(once, '[制作现场｜画布版本 2｜本轮请求前的实际状态]\n概况：画布是空的。');
    expect(twice.length).toBe(4);
    expect(twice[2].content[0].text).toContain('用户自己贴的计划文本');
    expect(twice[3].content[0].text).toContain('画布版本 2');
  });

  test('单调媒体裁剪游标：连续视觉轮次保持前缀 100% 字节一致，超预算才单调前推且不回退', () => {
    const bigPad = 'A'.repeat(20 * 1024);
    const imgPart = (tag) => ({ type: 'image', mimeType: 'image/jpeg', data: `${tag}_${bigPad}` });
    const tinyPart = { type: 'image', mimeType: 'image/png', data: 'TINY_ICON' };

    const turn1 = [
      { role: 'user', content: [{ type: 'text', text: '看第一张首帧图' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'media_overview', arguments: { nodeId: 'img-1' } }] },
      { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '{"op":"media.overview"}' }, imgPart('SHOT_1'), tinyPart] },
      { role: 'assistant', content: [{ type: 'text', text: '镜1构图不错。' }] },
    ];
    const turn2 = [
      ...turn1,
      { role: 'user', content: [{ type: 'text', text: '再对比第二张首帧图' }, imgPart('USER_REF')] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'media_overview', arguments: { nodeId: 'img-2' } }] },
      { role: 'toolResult', toolCallId: 'c2', content: [{ type: 'text', text: '{"op":"media.overview"}' }, imgPart('SHOT_2')] },
    ];

    const entryMap = new Map();
    turn2.forEach((m, idx) => entryMap.set(m, idx + 1));

    // 1. 预算足够时（例如 100KB），连续两轮对比镜1与镜2，游标保持 0 不动，前 4 条消息字节级完全一致
    const evalTurn1 = evaluateMonotoneMediaCutoff(turn1, {
      cutoffEntryId: 0,
      messageEntryId: entryMap,
      maxInlineImageChars: 100 * 1024,
    });
    expect(evalTurn1.advanced).toBe(false);
    expect(evalTurn1.cutoffEntryId).toBe(0);

    const evalTurn2 = evaluateMonotoneMediaCutoff(turn2, {
      cutoffEntryId: evalTurn1.cutoffEntryId,
      messageEntryId: entryMap,
      maxInlineImageChars: 100 * 1024,
    });
    expect(evalTurn2.advanced).toBe(false);
    expect(evalTurn2.cutoffEntryId).toBe(0);

    const req1 = withCurrentStudio(turn1, '现场摘要1', { mediaCutoffEntryId: evalTurn1.cutoffEntryId, messageEntryId: entryMap });
    const req2 = withCurrentStudio(turn2, '现场摘要2', { mediaCutoffEntryId: evalTurn2.cutoffEntryId, messageEntryId: entryMap });
    // 关键 KV-Cache 性质：turn2 的前缀与 turn1 的非尾消息 100% 字节一致
    expect(JSON.stringify(req2.slice(0, turn1.length))).toBe(JSON.stringify(req1.slice(0, turn1.length)));
    expect(req2[2].content[1]).toEqual(imgPart('SHOT_1'));
    expect(req2[6].content[1]).toEqual(imgPart('SHOT_2'));

    // 2. 第三张图到来导致累计内联图超过预算（例如 45KB）时，游标单调前推，只折叠最旧的 SHOT_1，保留最新 SHOT_2/SHOT_3 与小图标及用户附件
    const turn3 = [
      ...turn2,
      { role: 'assistant', content: [{ type: 'toolCall', id: 'f1', name: 'file_read', arguments: { resourceId: 'pdf-1' } }] },
      { role: 'toolResult', toolCallId: 'f1', toolName: 'file_read', content: [{ type: 'text', text: '{"op":"file.read","result":{"format":"pdf-images"}}' }, imgPart('SCAN_1')] },
    ];
    turn3.forEach((m, idx) => entryMap.set(m, idx + 1));

    const evalOverflow = evaluateMonotoneMediaCutoff(turn3, {
      cutoffEntryId: 0,
      messageEntryId: entryMap,
      maxInlineImageChars: 45 * 1024,
    });
    expect(evalOverflow.advanced).toBe(true);
    expect(evalOverflow.cutoffEntryId).toBe(3); // SHOT_1 所在的 entryId=3

    const folded = applyMonotoneMediaCutoff(turn3, {
      cutoffEntryId: evalOverflow.cutoffEntryId,
      messageEntryId: entryMap,
    });
    expect(folded[2].content[1]).toEqual({
      type: 'text',
      text: '[此前已展示过的历史媒体预览图已在后续步骤折叠以节省上下文；如需复查概览请调 media_overview，查看原图或局部细节请调 media_inspect]',
    });
    // 小图标与用户附件永不折叠，且不修改原数组
    expect(folded[2].content[2]).toEqual(tinyPart);
    expect(folded[4].content[1]).toEqual(imgPart('USER_REF'));
    expect(folded[6].content[1]).toEqual(imgPart('SHOT_2'));
    expect(folded[8].content[1]).toEqual(imgPart('SCAN_1'));
    expect(turn3[2].content[1]).toEqual(imgPart('SHOT_1'));

    // 3. 当扫描件（file_read）被游标越过时，使用 file_read 专用占位文案；且游标永远单调不回退
    const foldedPastScan = applyMonotoneMediaCutoff(turn3, {
      cutoffEntryId: 9,
      messageEntryId: entryMap,
    });
    expect(foldedPastScan[8].content[1]).toEqual({
      type: 'text',
      text: '[此前已展示过的文档扫描页画面已在后续步骤折叠以节省上下文；你此前据此读取并记录的内容仍然有效，如需再次查看请重新调用 file_read]',
    });
    const evalNoRollback = evaluateMonotoneMediaCutoff(turn1, {
      cutoffEntryId: 9,
      messageEntryId: entryMap,
      maxInlineImageChars: 100 * 1024,
    });
    expect(evalNoRollback.advanced).toBe(false);
    expect(evalNoRollback.cutoffEntryId).toBe(9);
  });
});
