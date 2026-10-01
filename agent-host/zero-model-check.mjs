// 零模型断言：不会调用任何模型，只验证会话装配（systemPrompt 与 active tools）。
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
const prompt = 'MARKER_ZERO_MODEL_CHECK';
const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => prompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
const customTools = ['canvas_get', 'canvas_nodes_create'].map((name) => ({
  name, label: name, description: `${name} 测试用`,
  parameters: { type: 'object', properties: {}, additionalProperties: true },
  execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
}));
const { session } = await createAgentSession({
  cwd: process.env.CHECK_CWD,
  agentDir: process.env.CHECK_AGENT_DIR,
  noTools: 'builtin',
  customTools,
  resourceLoader,
  settingsManager: SettingsManager.inMemory(),
  sessionManager: SessionManager.inMemory(process.env.CHECK_CWD),
});
const active = session.getActiveToolNames();
const system = session.systemPrompt || '';
console.log(JSON.stringify({ systemPromptHasMarker: system.includes(prompt), activeTools: active,
  noBuiltinTools: !active.some((n) => ['read', 'bash', 'edit', 'write', 'ls', 'grep', 'find'].includes(n)),
  systemPromptLength: system.length }));
session.dispose();
