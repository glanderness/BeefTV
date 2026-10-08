import { test, expect } from 'bun:test';
import crypto from 'node:crypto';
import { mediaToolResult, adaptMediaRequest } from './media-content.mjs';

const model = { api: 'openai-completions', modelId: 'gemini-3.8-flash' };
function part(mimeType = 'audio/wav') {
  const bytes = Buffer.from('test-media');
  return { type: mimeType.startsWith('image/') ? 'image' : 'media', mimeType,
    data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    source: { resourceId: 'r1', version: 'source-hash', startMs: 2000, endMs: 4000 } };
}
function transcript(content) {
  return { messages: [
    { role: 'assistant', tool_calls: [{ id: 't1', function: { name: 'media_inspect' } }, { id: 't2', function: { name: 'media_check' } }] },
    { role: 'tool', tool_call_id: 't1', content },
    { role: 'tool', tool_call_id: 't2', content: 'measured facts' },
    { role: 'assistant', content: 'done' },
  ] };
}
test('official images and bounded native media keep source evidence', () => {
  const image = mediaToolResult({ result: { content: [part('image/jpeg')] } }, 'media.overview', model);
  expect(image.content.at(-1).type).toBe('image');
  const native = mediaToolResult({ result: { content: [part()] } }, 'media.inspect', model);
  const text = native.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  const request = adaptMediaRequest(transcript(text), model);
  expect(request.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'assistant']);
  expect(request.messages[3].content.at(-1).image_url.url).toStartWith('data:audio/wav;base64,');
  expect(request.messages[1].content).not.toContain('BEEFTV_MEDIA_PART_V1:');
  expect(adaptMediaRequest(request, model)).toEqual(request);
});
test('unsupported routes, tampered media and untrusted tool markers fail closed', () => {
  expect(() => mediaToolResult({ result: { content: [part()] } }, 'media.inspect', { ...model, modelId: 'claude-opus-5-5' })).toThrow('media_input_unsupported');
  const changed = { ...part(), data: Buffer.from('changed').toString('base64') };
  expect(() => mediaToolResult({ result: { content: [changed] } }, 'media.inspect', model)).toThrow('media_content_changed');
  const text = mediaToolResult({ result: { content: [part()] } }, 'media.inspect', model).content.map(p => p.text).join('\n');
  const request = transcript(text);request.messages[0].tool_calls[0].function.name = 'canvas_get';
  expect(() => adaptMediaRequest(request, model)).toThrow('media_source_not_trusted');
});
