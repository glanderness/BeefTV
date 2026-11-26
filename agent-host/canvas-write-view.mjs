const NODE_WRITES = new Set(['canvas.node.update', 'canvas.node.configure', 'canvas.node.bind_asset']);
const MEDIA_KINDS = new Set(['image', 'video', 'audio']);
const MAX_WRITE_VIEW_BYTES = 40000;
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function previewShort(value, maxChars = 240) {
  if (typeof value !== 'string' || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function fitBudgetedArray(items, budgetBytes, transform = item => item) {
  const kept = [];
  let used = 2; // []
  for (let i = 0; i < items.length; i++) {
    const projected = transform(items[i], i);
    const size = jsonBytes(projected) + (kept.length > 0 ? 1 : 0);
    if (used + size > budgetBytes) break;
    kept.push(projected);
    used += size;
  }
  return { items: kept, omitted: items.length - kept.length, usedBytes: used };
}

function projectProposeResult(result) {
  const { pricing: _pricing, order: _order, targets, production, nodeIds, ...rest } = result;
  const compactTarget = (target) => {
    if (!target || typeof target !== 'object') return target;
    const { pricing: _targetPricing, prompt, ...targetRest } = target;
    return {
      ...targetRest,
      ...(prompt !== undefined ? { prompt: previewShort(prompt, 240) } : {}),
    };
  };
  const compactProductionTarget = (target) => {
    if (!target || typeof target !== 'object') return target;
    const summary = {
      nodeId: target.nodeId,
      kind: target.kind,
      modelKey: target.modelKey,
    };
    if (typeof target.title === 'string' && target.title) summary.title = previewShort(target.title, 80);
    if (target.estimate !== undefined) summary.estimate = target.estimate;
    return summary;
  };

  const skeleton = {
    ...rest,
    ...(Array.isArray(nodeIds) ? { nodeIds: [], omittedNodeIdCount: 999999 } : {}),
    ...(Array.isArray(targets) ? { targets: [], targetCount: targets.length, targetsTruncated: true, omittedTargetCount: 999999 } : {}),
    ...(production && typeof production === 'object'
      ? {
          production: {
            ...(production.estimate !== undefined ? { estimate: production.estimate } : {}),
            ...(Array.isArray(production.targets)
              ? { targets: [], targetCount: production.targets.length, targetsTruncated: true, omittedTargetCount: 999999 }
              : {}),
          },
        }
      : {}),
  };
  let remaining = Math.max(0, MAX_WRITE_VIEW_BYTES - 512 - jsonBytes({ result: skeleton }));
  const output = { ...rest };

  if (Array.isArray(nodeIds)) {
    const idBudget = Math.min(remaining, 8192);
    const fittedIds = fitBudgetedArray(nodeIds, idBudget);
    output.nodeIds = fittedIds.items;
    if (fittedIds.omitted > 0) output.omittedNodeIdCount = fittedIds.omitted;
    remaining = Math.max(0, remaining - fittedIds.usedBytes);
  }

  const hasProductionTargets = Boolean(production && typeof production === 'object' && Array.isArray(production.targets));
  if (Array.isArray(targets)) {
    const targetBudget = hasProductionTargets ? Math.floor(remaining * 0.65) : remaining;
    const fittedTargets = fitBudgetedArray(targets, targetBudget, compactTarget);
    output.targets = fittedTargets.items;
    if (fittedTargets.omitted > 0) {
      output.targetCount = targets.length;
      output.targetsTruncated = true;
      output.omittedTargetCount = fittedTargets.omitted;
    }
    remaining = Math.max(0, remaining - fittedTargets.usedBytes);
  }

  if (production && typeof production === 'object') {
    const nextProduction = {};
    if (production.estimate !== undefined) nextProduction.estimate = production.estimate;
    if (Array.isArray(production.targets)) {
      const fittedProd = fitBudgetedArray(production.targets, remaining, compactProductionTarget);
      nextProduction.targets = fittedProd.items;
      if (fittedProd.omitted > 0) {
        nextProduction.targetCount = production.targets.length;
        nextProduction.targetsTruncated = true;
        nextProduction.omittedTargetCount = fittedProd.omitted;
      }
    }
    output.production = nextProduction;
  }

  return output;
}

function projectSubmitResult(result) {
  const { tasks, taskIds, nodeIds, ...rest } = result;
  const compactTask = (task) => {
    if (!task || typeof task !== 'object') return task;
    const out = {};
    for (const key of ['id', 'status', 'resultState', 'outcome', 'error']) {
      if (task[key] !== undefined && task[key] !== '') {
        out[key] = key === 'error' ? previewShort(task[key], 300) : task[key];
      }
    }
    if (Array.isArray(task.outputs)) {
      out.outputs = task.outputs.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const compactOut = {};
        for (const key of ['outputIndex', 'mediaType', 'resourceId', 'materializationErrorCode']) {
          if (item[key] !== undefined && item[key] !== '') compactOut[key] = item[key];
        }
        return compactOut;
      });
    }
    return out;
  };

  const skeleton = {
    ...rest,
    ...(Array.isArray(taskIds) ? { taskIds: [], omittedTaskIdCount: 999999 } : {}),
    ...(Array.isArray(nodeIds) ? { nodeIds: [], omittedNodeIdCount: 999999 } : {}),
    tasks: [],
    taskCount: tasks.length,
    tasksTruncated: true,
    omittedTaskCount: 999999,
  };
  let remaining = Math.max(0, MAX_WRITE_VIEW_BYTES - 512 - jsonBytes({ result: skeleton }));
  const output = { ...rest };

  if (Array.isArray(taskIds)) {
    const fittedTaskIds = fitBudgetedArray(taskIds, Math.min(remaining, 8192));
    output.taskIds = fittedTaskIds.items;
    if (fittedTaskIds.omitted > 0) output.omittedTaskIdCount = fittedTaskIds.omitted;
    remaining = Math.max(0, remaining - fittedTaskIds.usedBytes);
  }
  if (Array.isArray(nodeIds)) {
    const fittedNodeIds = fitBudgetedArray(nodeIds, Math.min(remaining, 8192));
    output.nodeIds = fittedNodeIds.items;
    if (fittedNodeIds.omitted > 0) output.omittedNodeIdCount = fittedNodeIds.omitted;
    remaining = Math.max(0, remaining - fittedNodeIds.usedBytes);
  }
  const fittedTasks = fitBudgetedArray(tasks, remaining, compactTask);
  output.tasks = fittedTasks.items;
  if (fittedTasks.omitted > 0) {
    output.taskCount = tasks.length;
    output.tasksTruncated = true;
    output.omittedTaskCount = fittedTasks.omitted;
  }
  return output;
}

// Only the model-facing receipt is reduced. Business receipts and turn effects
// retain the original node; omitted fields remain accessible through canvas_get.
export function canvasWriteView(data, operation, params = {}) {
  if (operation === 'model.catalog' && Array.isArray(data?.result?.channels)) {
    // 助手只读提案里的 estimate，不直接读取单价表自行换算其他方案费用。
    const channels = data.result.channels.map(channel => Array.isArray(channel?.models)
      ? { ...channel, models: channel.models.map(({ pricing: _pricing, videoPricing: _videoPricing, ...model }) => model) }
      : channel);
    return { ...data, result: { ...data.result, channels } };
  }
  if (operation === 'canvas.generation.propose' && data?.result && typeof data.result === 'object' && !Array.isArray(data.result)) {
    return { ...data, result: projectProposeResult(data.result) };
  }
  if ((operation === 'canvas.generation.submit' || operation === 'canvas.generation.regenerate') && data?.result && typeof data.result === 'object' && !Array.isArray(data.result) && Array.isArray(data.result.tasks)) {
    return { ...data, result: projectSubmitResult(data.result) };
  }
  if (operation === 'business.list' && Array.isArray(data?.result?.tools)) {
    const skeleton = {
      ...data,
      result: {
        total: data.result.total,
        offset: data.result.offset,
        limit: data.result.limit,
        tools: [],
        omittedToolCount: 999999,
      },
    };
    const budget = Math.max(0, MAX_WRITE_VIEW_BYTES - 512 - jsonBytes(skeleton));
    const compactSchema = (schema, maxProps = 24) => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
      if (jsonBytes(schema) <= 4096) return schema;
      const slim = {};
      if (schema.type) slim.type = schema.type;
      if (Array.isArray(schema.required)) slim.required = schema.required.slice(0, maxProps);
      if (schema.properties && typeof schema.properties === 'object') {
        const entries = Object.entries(schema.properties);
        slim.properties = Object.fromEntries(entries.slice(0, maxProps).map(([k, v]) => [
          k,
          v && typeof v === 'object' ? { ...(v.type ? { type: v.type } : {}), ...(Array.isArray(v.enum) ? { enum: v.enum.slice(0, 12) } : {}) } : v,
        ]));
        if (entries.length > maxProps) slim.omittedPropertyCount = entries.length - maxProps;
      }
      return slim;
    };
    const baseTool = (tool) => ({
      id: tool?.id,
      method: tool?.method,
      path: tool?.path,
      readOnly: tool?.readOnly,
      ...(tool?.submitsGeneration ? { submitsGeneration: true } : {}),
      summary: previewShort(tool?.summary, 140),
    });
    const fitted = fitBudgetedArray(data.result.tools, budget, (tool) => ({
      ...baseTool(tool),
      ...(tool?.params && typeof tool.params === 'object' ? { params: compactSchema(tool.params) } : {}),
    }));
    // 单条工具的 params 仍超出剩余预算时，至少保留该工具的标识与摘要并标记 paramsOmitted，避免整页退化成 tools: []。
    if (fitted.items.length === 0 && data.result.tools.length > 0) {
      const first = baseTool(data.result.tools[0]);
      if (data.result.tools[0]?.params) first.paramsOmitted = true;
      fitted.items.push(first);
      fitted.omitted = Math.max(0, data.result.tools.length - 1);
    }
    return {
      ...data,
      result: {
        total: data.result.total,
        offset: data.result.offset,
        limit: data.result.limit,
        tools: fitted.items,
        ...(fitted.omitted > 0 ? { omittedToolCount: fitted.omitted } : {}),
      },
    };
  }
  if (operation === 'business.call' && data?.result !== undefined) {
    const serialized = JSON.stringify(data);
    const totalBytes = Buffer.byteLength(serialized, 'utf8');
    if (totalBytes > MAX_WRITE_VIEW_BYTES) {
      const buf = Buffer.from(serialized, 'utf8');
      let cut = Math.min(buf.length, MAX_WRITE_VIEW_BYTES - 1024);
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1;
      const preview = buf.subarray(0, cut).toString('utf8');
      return {
        ...data,
        result: {
          tool: data.result?.tool,
          method: data.result?.method,
          path: data.result?.path,
          truncated: true,
          bytes: totalBytes,
          preview: `${preview}…`,
          note: '底层接口返回超过单次输出上限，请加分页或筛选参数缩小范围后再查。',
        },
      };
    }
  }
  if (operation === 'canvas.task.bind' && typeof data?.result?.bindingStatus === 'string') {
    // Go retains the full document for replay and undo. Model/nested callers
    // only need this binding receipt, not every source prompt on the canvas.
    const result = {};
    for (const key of ['canvasId', 'revision', 'nodeId', 'taskId', 'outputIndex', 'effectKey', 'mediaType',
      'bindingStatus', 'applied', 'alreadyBound', 'assetId', 'resourceId', 'storageKey', 'alsoChanged']) {
      if (data.result[key] !== undefined) result[key] = data.result[key];
    }
    result.writeView = { complete: false, omittedNodeFields: true,
      readView: { nodeId: result.nodeId, expectedRevision: result.revision } };
    return { ...data, result };
  }
  if (operation === 'canvas.nodes.configure' && Array.isArray(data?.result?.nodes)) {
    const totalCount = data.result.nodes.length;
    const skeleton = {
      ...data,
      result: {
        canvasId: data.result.canvasId,
        revision: data.result.revision,
        configuredCount: totalCount,
        nodes: [],
        omittedNodeCount: 999999,
        writeView: { complete: false, omittedNodeFields: true },
      },
    };
    const budget = Math.max(0, MAX_WRITE_VIEW_BYTES - 512 - jsonBytes(skeleton));
    const fitted = fitBudgetedArray(data.result.nodes, budget, (item) => ({
      nodeId: item?.nodeId,
      draftConfigured: item?.draftConfigured ?? true,
      ...(item?.revision !== undefined ? { revision: item.revision } : {}),
    }));
    return {
      ...data,
      result: {
        canvasId: data.result.canvasId,
        revision: data.result.revision,
        configuredCount: totalCount,
        nodes: fitted.items,
        ...(fitted.omitted > 0 ? { omittedNodeCount: fitted.omitted } : {}),
        writeView: { complete: false, omittedNodeFields: true },
      },
    };
  }
  if (!NODE_WRITES.has(operation)) return data;
  const result = data?.result, source = result?.node;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return data;
  const readView = { nodeId: result.nodeId, expectedRevision: result.revision };
  const field = (value, fieldPath) => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= 2000) return value;
    return { complete: false, characters: value.length, preview: value.slice(0, 160), readView: { ...readView, fieldPath } };
  };
  const node = { id: source.id, type: source.type, title: field(source.title, '/title') };
  const metadata = {};
  for (const name of Object.keys(params.patch || {})) {
    if (name === 'title') continue;
    const key = ((operation === 'canvas.node.update' && name === 'content') ||
      (operation === 'canvas.node.configure' && name === 'prompt')) && MEDIA_KINDS.has(source.type)
      ? 'composerContent' : name;
    if (Object.hasOwn(source.metadata || {}, key)) {
      metadata[key] = field(source.metadata[key], `/metadata/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
  }
  if (Object.keys(metadata).length) node.metadata = metadata;
  return { ...data, result: { ...result, node,
    writeView: { complete: false, omittedNodeFields: true, readView },
  } };
}

export function canvasWriteViewDescription(_operation) {
  return '';
}
