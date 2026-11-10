import { test, expect } from 'bun:test';
import { createCnyBudget, costOfTokens, extractUsage, normalizeAgentUsage, parseTurnEnd } from './usage.mjs';

const sse = (...chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c)).join('\n\n') + '\n\ndata: [DONE]\n\n';

test('OpenAI 兼容流式：usage 在末尾 chunk，缓存在 prompt_tokens_details', () => {
  const u = extractUsage(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'canvas_get', arguments: '{}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } }));
  expect(u).toMatchObject({ promptTokens: 1000, completionTokens: 20, cachedTokens: 900, missing: false, tools: ['canvas_get'] });
});

test('DeepSeek 原生字段 prompt_cache_hit_tokens 与 choices[0].usage', () => {
  expect(extractUsage(sse({ choices: [{ delta: { content: '好' }, usage: { prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 400 } }] })))
    .toMatchObject({ promptTokens: 500, cachedTokens: 400, missing: false, replied: true });
});

test('Responses 风格 input_tokens_details 与非流式 JSON', () => {
  const json = JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [{ function: { name: 'plan_update', arguments: '{"a":1}' } }] } }],
    usage: { input_tokens: 70, output_tokens: 3, input_tokens_details: { cached_tokens: 64 } } });
  expect(extractUsage(json)).toMatchObject({ promptTokens: 70, completionTokens: 3, cachedTokens: 64, missing: false, tools: ['plan_update'] });
});

test('有用量但没有缓存字段：缓存是未知，不等于 0', () => {
  expect(extractUsage(sse({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 2 } }))).toMatchObject({ promptTokens: 80, cachedTokens: 0, cacheKnown: false, missing: false });
  expect(extractUsage(sse({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } })).cacheKnown).toBe(true);
});

test('没有 usage 时显式标记缺失，而不是当作 0 悄悄通过', () => {
  expect(extractUsage(sse({ choices: [{ delta: { content: '好' } }] })).missing).toBe(true);
  expect(extractUsage('').missing).toBe(true);
});

test('Anthropic 流式：message_start 的输入与 message_delta 的缓存字段合并', () => {
  const u = extractUsage([
    'event: message_start',
    'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 1 } } }),
    'event: message_delta',
    'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { cache_read_input_tokens: 900, output_tokens: 30 } }),
    '',
  ].join('\n'));
  expect(u).toMatchObject({ promptTokens: 1920, completionTokens: 30, cachedTokens: 900, cacheKnown: true, cacheCreationTokens: 900, missing: false });
});

test('Anthropic 流式：message_start 只有 input_tokens，message_delta 才带缓存字段也按总输入计算', () => {
  const u = extractUsage([
    'event: message_start',
    'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1 } } }),
    'event: message_delta',
    'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 80, output_tokens: 30 } }),
    '',
  ].join('\n'));
  expect(u).toMatchObject({ promptTokens: 1100, completionTokens: 30, cachedTokens: 900, cacheCreationTokens: 80, cacheKnown: true, missing: false });
  expect(((u.cachedTokens / u.promptTokens) * 100).toFixed(1)).toBe('81.8');
});

test('Anthropic 命中率分母是总输入量：未命中 + 缓存读取 + 缓存创建', () => {
  const u = extractUsage('data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 1 } } }) + '\n');
  expect(u).toMatchObject({ promptTokens: 1020, cachedTokens: 900, cacheCreationTokens: 0, cacheKnown: true });
  expect(((u.cachedTokens / u.promptTokens) * 100).toFixed(1)).toBe('88.2');
});

test('回合结果以 turn_end 为准：HTTP 200 里的错误和取消都能识别', () => {
  const line = (row) => JSON.stringify(row);
  expect(parseTurnEnd([line({ type: 'session' }), line({ type: 'turn_end', reply: '完成', proposals: [1] })].join('\n'))).toMatchObject({ status: 'done', reply: '完成', proposals: 1 });
  expect(parseTurnEnd(line({ type: 'turn_end', error: 'upstream 500', errorReason: 'model_failed' })).status).toBe('error:model_failed');
  expect(parseTurnEnd(line({ type: 'turn_end', cancelled: true })).status).toBe('cancelled');
  expect(parseTurnEnd(line({ type: 'session' })).status).toBe('no_turn_end');
});

// 三类外部 Agent 的统一口径：未缓存输入、缓存读、输出。
test('统一用量口径：Claude 加回缓存创建，Codex 减掉缓存读，DSH 直接用未缓存输入', () => {
  expect(normalizeAgentUsage('claude', { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 7 }))
    .toEqual({ uncachedInput: 150, cacheRead: 900, output: 7, cacheKnown: true, incomplete: false });
  expect(normalizeAgentUsage('codex', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 9 }))
    .toEqual({ uncachedInput: 200, cacheRead: 800, output: 9, cacheKnown: true, incomplete: false });
  expect(normalizeAgentUsage('dsh', { inputTokens: 129, cacheReadTokens: 9216, outputTokens: 2 }))
    .toEqual({ uncachedInput: 129, cacheRead: 9216, output: 2, cacheKnown: true, incomplete: false });
  expect(normalizeAgentUsage('dsh', { uncachedInput: 5, cacheRead: 6, cacheKnown: true, output: 7 }))
    .toEqual({ uncachedInput: 5, cacheRead: 6, output: 7, cacheKnown: true, incomplete: false });
  expect(normalizeAgentUsage('dsh', null).incomplete).toBe(true);
});

test('费用分别按未缓存输入、缓存读、输出折算，缓存价缺省时沿用输入价', () => {
  const tokens = { uncachedInput: 1_000_000, cacheRead: 2_000_000, output: 1_000_000 };
  expect(costOfTokens(tokens, { input: 0.2, cache: 0.004, output: 0.8 })).toBeCloseTo(1.008, 6);
  expect(costOfTokens(tokens, { input: 0.2, output: 0.8 })).toBeCloseTo(1.4, 6);
});

test('预算：设了上限但价格缺失或为 0 时直接报错，不按 0 算', () => {
  expect(() => createCnyBudget({ budgetCny: 1, priceIn: 0, priceOut: 0.8 })).toThrow('budget_price_missing');
  expect(() => createCnyBudget({ budgetCny: 1, priceIn: 0.2, priceOut: 0 })).toThrow('budget_price_missing');
  expect(() => createCnyBudget({ budgetCny: 1, priceIn: 0.2, priceCache: 0, priceOut: 0.8 })).toThrow('budget_price_missing');
  expect(() => createCnyBudget({ budgetCny: 0, priceIn: 0.2, priceOut: 0.8 })).toThrow('--budget-cny');
});

test('预算：累计达到上限后 reached 为真；没设预算时不限制且按 0 单价', () => {
  const budget = createCnyBudget({ budgetCny: 0.01, priceIn: 1, priceOut: 1 });
  expect(budget.enabled).toBe(true);
  expect(budget.cachePriceSource).toBe('price_in');
  expect(budget.reached()).toBe(false);
  budget.addCost({ uncachedInput: 5_000, cacheRead: 0, output: 0 });
  expect(budget.reached()).toBe(false);
  budget.addCost({ uncachedInput: 5_000, cacheRead: 0, output: 0 });
  expect(budget.reached()).toBe(true);
  expect(budget.spent).toBeCloseTo(0.01, 8);

  const none = createCnyBudget({ priceIn: 0, priceOut: 0 });
  expect(none.enabled).toBe(false);
  expect(none.reached()).toBe(false);
});
