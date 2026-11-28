// Generic configurable Pi 1.6.0 compaction extension factory.
// BeefTV-agnostic: domain apps inject their own systemPrompt, prompt builder,
// post-processor, and lifecycle hooks.
import { CompactionTask, ProviderDoc, UsageDoc, defineExtension, hook } from '@earendil-works/pi-durable';

const DEFAULT_TOOL_RESULT_MAX_CHARS = 2400;

export function extractBlockText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function serializeConversationTranscript(messages, { toolResultMaxChars = DEFAULT_TOOL_RESULT_MAX_CHARS } = {}) {
  const parts = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      const text = extractBlockText(message.content);
      if (text) parts.push(`[User]: ${text}`);
    } else if (message.role === 'assistant') {
      const text = (message.content || [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
        .map((block) => block.text);
      const calls = (message.content || [])
        .filter((block) => block?.type === 'toolCall')
        .map((block) => {
          const args = block.arguments && typeof block.arguments === 'object'
            ? Object.entries(block.arguments).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
            : '';
          return `${block.name}(${args})`;
        });
      if (text.length) parts.push(`[Assistant]: ${text.join('\n')}`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`);
    } else if (message.role === 'toolResult') {
      const text = extractBlockText(message.content);
      if (text) {
        const clipped = text.length > toolResultMaxChars
          ? `${text.slice(0, toolResultMaxChars)}\n[... omitted ${text.length - toolResultMaxChars} chars]`
          : text;
        parts.push(`[Tool result]: ${clipped}`);
      }
    }
  }
  return parts.join('\n\n');
}

export async function recordUsageToUsageDoc(api, message, context) {
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return;
  const modelKey = `${message.provider || 'unknown'}/${message.model || 'unknown'}`;
  await api.commit(async (tx) => {
    const doc = await tx.doc(UsageDoc, api.conversationId);
    if (!doc.models || typeof doc.models !== 'object') doc.models = {};
    const existing = Object.hasOwn(doc.models, modelKey) ? doc.models[modelKey] : undefined;
    if (!existing) {
      doc.models[modelKey] = {
        input: Number(usage.input) || 0,
        output: Number(usage.output) || 0,
        cacheRead: Number(usage.cacheRead) || 0,
        cacheWrite: Number(usage.cacheWrite) || 0,
        totalTokens: Number(usage.totalTokens) || 0,
        ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: Number(usage.cacheWrite1h) || 0 } : {}),
        ...(usage.reasoning !== undefined ? { reasoning: Number(usage.reasoning) || 0 } : {}),
        cost: {
          input: Number(usage.cost?.input) || 0,
          output: Number(usage.cost?.output) || 0,
          cacheRead: Number(usage.cost?.cacheRead) || 0,
          cacheWrite: Number(usage.cost?.cacheWrite) || 0,
          total: Number(usage.cost?.total) || 0,
        },
      };
      return undefined;
    }
    existing.input = (Number(existing.input) || 0) + (Number(usage.input) || 0);
    existing.output = (Number(existing.output) || 0) + (Number(usage.output) || 0);
    existing.cacheRead = (Number(existing.cacheRead) || 0) + (Number(usage.cacheRead) || 0);
    existing.cacheWrite = (Number(existing.cacheWrite) || 0) + (Number(usage.cacheWrite) || 0);
    existing.totalTokens = (Number(existing.totalTokens) || 0) + (Number(usage.totalTokens) || 0);
    if (usage.cacheWrite1h !== undefined) {
      existing.cacheWrite1h = (Number(existing.cacheWrite1h) || 0) + (Number(usage.cacheWrite1h) || 0);
    }
    if (usage.reasoning !== undefined) {
      existing.reasoning = (Number(existing.reasoning) || 0) + (Number(usage.reasoning) || 0);
    }
    if (!existing.cost || typeof existing.cost !== 'object') {
      existing.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    }
    existing.cost.input = (Number(existing.cost.input) || 0) + (Number(usage.cost?.input) || 0);
    existing.cost.output = (Number(existing.cost.output) || 0) + (Number(usage.cost?.output) || 0);
    existing.cost.cacheRead = (Number(existing.cost.cacheRead) || 0) + (Number(usage.cost?.cacheRead) || 0);
    existing.cost.cacheWrite = (Number(existing.cost.cacheWrite) || 0) + (Number(usage.cost?.cacheWrite) || 0);
    existing.cost.total = (Number(existing.cost.total) || 0) + (Number(usage.cost?.total) || 0);
    return undefined;
  }, context);
}

function cleanCompactionSummaryText(message) {
  if (!message || message.stopReason !== 'stop') return undefined;
  if (Array.isArray(message.content) && message.content.some((block) => block?.type === 'toolCall')) {
    return undefined;
  }
  const text = extractBlockText(message.content);
  return text.length > 0 ? text : undefined;
}

const DEFAULT_SYSTEM_PROMPT = 'You are a structured conversation compaction assistant. Produce only a faithful checkpoint summary preserving all identifiers, artifact references, active tasks, and constraints. Never continue the conversation.';

function defaultPromptBuilder({ messages, instructions }) {
  const transcript = serializeConversationTranscript(messages);
  const extra = String(instructions || '').trim();
  return [
    `<conversation>\n${transcript}\n</conversation>`,
    'Summarize the conversation above into a structured continuation checkpoint preserving all IDs, references, decisions, and next steps.',
    extra ? `Additional instructions: ${extra}` : '',
  ].filter(Boolean).join('\n\n');
}

export function createConfigurableCompactionExtension({
  name = 'pi-creative-media.compaction.v1',
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  buildPrompt = defaultPromptBuilder,
  postProcessSummary = null,
  resolveSessionId = null,
  onBeforeCall = null,
  onSummaryAccepted = null,
  onFinally = null,
} = {}) {
  return defineExtension({
    name,
    hooks: [hook(CompactionTask, {
      beforeCompact: async (compaction, api, context) => {
        const agent = await api.agent(context);
        const ref = agent?.model;
        const model = ref ? api.models.getModel(ref.provider, ref.modelId) : undefined;
        if (!ref || !model) return undefined;

        const signal = api.signal || context.abortSignal;
        const built = await buildPrompt({
          compaction,
          messages: compaction.messages,
          instructions: compaction.instructions,
          api,
          context,
          signal,
        });
        const promptText = typeof built === 'string' ? built : String(built?.prompt || '');
        const promptMeta = typeof built === 'object' && built !== null ? built : {};
        if (!promptText) return undefined;

        const resolvedSystem = typeof systemPrompt === 'function'
          ? await systemPrompt({ compaction, api, context, promptMeta })
          : String(promptMeta.systemPrompt || systemPrompt || DEFAULT_SYSTEM_PROMPT);

        const reserveTokens = Number(
          agent?.compaction?.reserveTokens
          ?? api.settings?.compaction?.reserveTokens
          ?? 16384,
        );
        const maxTokens = Math.min(
          Math.max(512, Math.floor(0.8 * reserveTokens)),
          model.maxTokens > 0 ? model.maxTokens : 8192,
        );
        const providerDoc = await api.snapshot(ProviderDoc, api.conversationId, context).catch(() => null);
        const now = api.now();
        const messages = [
          { role: 'system', content: resolvedSystem, timestamp: now },
          { role: 'user', content: [{ type: 'text', text: promptText }], timestamp: now },
        ];
        const { deferred: _deferred, ...forwardedStream } = api.settings?.stream || {};
        const fallbackSessionId = typeof resolveSessionId === 'function'
          ? resolveSessionId({ compaction, api, context })
          : api.conversationId;
        const options = {
          ...forwardedStream,
          cacheRetention: 'none',
          maxTokens,
          signal,
          telemetry: context.telemetry,
          sessionId: providerDoc?.sessionId || fallbackSessionId,
          ...(agent.thinkingLevel && agent.thinkingLevel !== 'off' ? { reasoning: agent.thinkingLevel } : {}),
        };

        await onBeforeCall?.({ compaction, api, context, promptMeta });
        try {
          const message = await api.models.completeSimple(model, { messages }, options);
          signal?.throwIfAborted?.();
          await recordUsageToUsageDoc(api, message, context).catch(() => {});
          const rawSummary = cleanCompactionSummaryText(message);
          if (!rawSummary) {
            // Return undefined so Pi CompactionTask's built-in retry loop handles empty/non-stop results.
            return undefined;
          }
          const finalSummary = typeof postProcessSummary === 'function'
            ? await postProcessSummary(rawSummary, { compaction, api, context, promptMeta })
            : rawSummary;
          await onSummaryAccepted?.({
            summary: finalSummary,
            compaction,
            api,
            context,
            promptMeta,
          });
          return { summary: finalSummary };
        } catch (error) {
          if (api.signal?.aborted || context.abortSignal?.aborted) throw error;
          // Transient model/network failures fall back to Pi CompactionTask's native retry loop.
          return undefined;
        } finally {
          await onFinally?.({ compaction, api, context, promptMeta });
        }
      },
    })],
  });
}
