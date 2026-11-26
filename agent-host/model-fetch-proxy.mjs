import { resolveHostModelRequestUrl } from './canvas-turn.mjs';
import { budgetError, spendModelRequest } from './request-budget.mjs';
import { adaptMediaRequest, trustedMediaSources } from './media-content.mjs';
import { nativeSourceKey } from './native-history.mjs';
import { fetchModelWithProgressIdle } from './model-stream-idle.mjs';
import { classifyModelFetchError, classifyModelHttpStatus } from './dispatch-diagnostics.mjs';

export function installModelFetchProxy({
  baseUrl,
  isRawBaseUrl,
  modelApi,
  modelId,
  customHeaders = [],
  turnBudgetContext,
  nativePartStore,
  lifetimeBudget,
  dispatchDiagnostics,
  getOps,
}) {
  const outbound = [];
  let dispatched = 0;
  const baseOrigin = baseUrl ? new URL(baseUrl).origin : '';
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (input, options = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const resolvedRaw = resolveHostModelRequestUrl(raw, { baseUrl, isRaw: isRawBaseUrl, api: modelApi });
    if (resolvedRaw !== raw) {
      input = typeof input === 'string' ? resolvedRaw : new Request(resolvedRaw, input);
    }
    let parsed = null;
    try { parsed = new URL(resolvedRaw); } catch { parsed = null; }
    const isModelCall = !!baseOrigin && parsed && parsed.origin === baseOrigin;
    if (isModelCall) {
      // Transform at the real dispatch boundary; extension errors are caught by pi.
      const budget = turnBudgetContext.getStore();
      const ops = getOps();
      let historicalKind = '素材';
      try {
        if (options.body) {
          const payload = JSON.parse(options.body);
          const mediaOptions = { api: modelApi, modelId, nativePartStore, unpinnedSignatures: budget?.unpinnedSignatures };
          for (const source of trustedMediaSources(payload, mediaOptions)) {
            historicalKind = source.mediaKind;
            if (!budget?.turnId || !budget.canvasId) throw new Error('media_authorization_missing');
            let actual;
            if (budget.sessionId) {
              const sourceKey = nativeSourceKey(source);
              const pinned = budget.nativeHistory?.origins.get(`${source.toolCallId}:${sourceKey}`)
                || (!source.toolCallId && source.originTurnId
                  ? budget.nativeHistory?.byOriginSource?.get(`${source.originTurnId}:${sourceKey}`)
                  : undefined)
                || (!source.toolCallId && !source.originTurnId
                  ? budget.nativeHistory?.bySource?.get(sourceKey)
                  : undefined);
              if (!pinned || (source.originTurnId && source.originTurnId !== pinned.originTurnId)) throw new Error('native_history_requires_reference');
              const { toolCallId, originTurnId, ...nativeSource } = source;
              await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(pinned.originTurnId)}/bind-session`, { sessionId: budget.sessionId, historical: pinned.historical, currentTurnId: budget.turnId, source: nativeSource });
              actual = await ops.opsRequest('POST', `/assistant/runtime/turns/${encodeURIComponent(budget.turnId)}/native-rehydrate`, { sessionId: budget.sessionId, originTurnId: pinned.originTurnId, source: nativeSource });
            } else {
              actual = (await ops.opsRequest('POST', '/ops/media.overview', {
                params: {
                  canvasId: source.canvasId,
                  ...(source.nodeId ? { nodeId: source.nodeId } : { assetId: source.assetId }),
                  resourceId: source.resourceId,
                },
              }, undefined, budget.turnId)).result;
            }
            if (actual.source.version !== source.version) throw new Error('media_content_changed');
          }
          options = { ...options, body: JSON.stringify(adaptMediaRequest(payload, mediaOptions)) };
        }
      } catch (error) {
        const failure = { reason: error.reason || 'native_history_unavailable', message: `历史${historicalKind}已不可用，请在新对话重新添加这份素材后再试。` };
        if (budget) budget.failure = failure;
        return new Response(JSON.stringify({ error: { message: failure.message, type: 'invalid_request_error', code: failure.reason } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (budget?.generation?.aborted || options.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      if (budget?.generation && !budget.generation.durable) budget.generation.modelEpoch = budget.generation.intentEpoch;
      const turn = spendModelRequest(budget);
      if (!turn.allowed) {
        if (budget) budget.failure = turn;
        throw budgetError(turn);
      }
      const lifetime = lifetimeBudget.reserve();
      if (!lifetime.allowed) {
        if (budget) { budget.requests -= 1; budget.failure = lifetime; }
        throw budgetError(lifetime);
      }
      dispatched += 1;
      let bodyModel = null;
      try { bodyModel = JSON.parse(options.body || '{}').model || null; } catch { /* 非 JSON body */ }
      const entry = {
        at: new Date().toISOString(),
        dispatchIndex: dispatched,
        origin: parsed.origin,
        path: parsed.pathname,
        model: bodyModel,
        turnId: budget?.turnId,
        canvasId: budget?.canvasId,
        sessionId: budget?.sessionId,
        requestId: budget?.requestId,
      };
      outbound.push(entry);
      if (outbound.length > 200) outbound.shift();
      dispatchDiagnostics.record(entry);
      if (Array.isArray(customHeaders) && customHeaders.length > 0) {
        const merged = new Headers(typeof input !== 'string' ? input.headers : undefined);
        if (options.headers) {
          new Headers(options.headers).forEach((value, key) => merged.set(key, value));
        }
        for (const [name, value] of customHeaders) {
          merged.set(name, value);
        }
        options = { ...options, headers: merged };
      }
      const startedAt = Date.now();
      return await fetchModelWithProgressIdle(input, options, {
        fetch: realFetch,
        onSettled: ({ ok, httpStatus, error }) => {
          dispatchDiagnostics.record({
            ...entry,
            status: ok ? 'ok' : 'error',
            ...(httpStatus ? { httpStatus } : {}),
            reason: error ? classifyModelFetchError(error) : classifyModelHttpStatus(httpStatus),
            durationMs: Date.now() - startedAt,
          });
        },
      });
    }
    return realFetch(input, options);
  };

  return {
    outbound,
    getDispatched: () => dispatched,
  };
}
