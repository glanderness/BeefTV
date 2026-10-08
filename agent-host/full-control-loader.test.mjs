import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFullControlLoader, SYSTEM_PROMPT } from './full-control-loader.mjs';
import { createSessionStore } from './session-owner.mjs';

test('official loader ignores discovered host resources but loads explicit per-session extensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'beeftv-loader-'));
  let store;
  try {
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
    mkdirSync(join(agentDir, 'skills', 'untrusted'), { recursive: true });
    writeFileSync(join(cwd, 'AGENTS.md'), 'SHOULD_NOT_LOAD');
    writeFileSync(join(cwd, '.pi', 'extensions', 'bad.mjs'), 'throw new Error("discovered extension ran");');
    writeFileSync(join(agentDir, 'skills', 'untrusted', 'SKILL.md'), '---\nname: untrusted\ndescription: no\n---\nSHOULD_NOT_LOAD');
    writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), 'SHOULD_NOT_LOAD');
    const loadedScopes = [];
    const factory = ({ canvasId, cwd, agentDir }) => {
      loadedScopes.push(canvasId);
      return createFullControlLoader({ cwd, agentDir, extensionFactories: [(pi) => {
        pi.on('before_provider_request', async ({ payload }) => ({ ...payload, scope: canvasId }));
      }] });
    };
    const loader = factory({ canvasId: 'one', cwd, agentDir });
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    store = createSessionStore({ sessionRoot: join(root, 'sessions'), workspaceRoot: cwd, agentDir,
      runId: 'test', getModelRuntime: () => undefined, getModel: () => undefined, createResourceLoader: factory });
    const a = await store.ensureSession('one', () => []);
    const b = await store.ensureSession('two', () => []);
    expect(await a.session.extensionRunner.emitBeforeProviderRequest({ messages: [] })).toEqual({ messages: [], scope: 'one' });
    expect(await b.session.extensionRunner.emitBeforeProviderRequest({ messages: [] })).toEqual({ messages: [], scope: 'two' });
    expect(loadedScopes).toEqual(['one', 'one', 'two']);
  } finally {
    await store?.disposeAll();
    rmSync(root, { recursive: true, force: true });
  }
});
