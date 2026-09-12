import type { AgentIntegrationClass, AgentNativeEnvironment } from '@garcon/server-agent-interface';

const loaders = new Map<string, () => Promise<{ default: AgentIntegrationClass }>>([
  ['claude', () => import('@garcon/server-agent-claude')],
  ['codex', () => import('@garcon/server-agent-codex')],
  ['direct-openai-responses-compatible', () => import('@garcon/server-agent-direct-openai-responses-compatible')],
  ['direct-openai-compatible', () => import('@garcon/server-agent-direct-openai-compatible')],
  ['direct-anthropic-compatible', () => import('@garcon/server-agent-direct-anthropic-compatible')],
  ['opencode', () => import('@garcon/server-agent-opencode')],
  ['amp', () => import('@garcon/server-agent-amp')],
  ['cursor', () => import('@garcon/server-agent-cursor')],
  ['factory', () => import('@garcon/server-agent-factory')],
  ['pi', () => import('@garcon/server-agent-pi')],
]);

let defaults: Promise<AgentIntegrationClass[]> | null = null;

/** Loads only this instance's provider, including its module-level environment initialization. */
export async function loadAgentIntegration(agentId: string): Promise<AgentIntegrationClass> {
  const load = loaders.get(agentId);
  if (!load) throw new Error('Unsupported agent integration');
  const prepare: unknown = Reflect.get(globalThis, Symbol.for('garcon.prepare-agent-runtime'));
  if (typeof prepare === 'function') await prepare(agentId);
  const { default: integration } = await load();
  if (integration.integrationId !== agentId) throw new Error('Agent integration identity mismatch');
  return integration;
}

export function loadDefaultAgentIntegrations(): Promise<AgentIntegrationClass[]> {
  return defaults ??= Promise.all([...loaders.keys()].map(loadAgentIntegration));
}

const environmentLoaders = new Map<string, () => Promise<{ default: AgentNativeEnvironment }>>([
  ['claude', () => import('@garcon/server-agent-claude/native-environment')],
  ['codex', () => import('@garcon/server-agent-codex/native-environment')],
  ['direct-openai-responses-compatible', () => import('@garcon/server-agent-direct-openai-responses-compatible/native-environment')],
  ['direct-openai-compatible', () => import('@garcon/server-agent-direct-openai-compatible/native-environment')],
  ['direct-anthropic-compatible', () => import('@garcon/server-agent-direct-anthropic-compatible/native-environment')],
  ['opencode', () => import('@garcon/server-agent-opencode/native-environment')],
  ['amp', () => import('@garcon/server-agent-amp/native-environment')],
  ['cursor', () => import('@garcon/server-agent-cursor/native-environment')],
  ['factory', () => import('@garcon/server-agent-factory/native-environment')],
  ['pi', () => import('@garcon/server-agent-pi/native-environment')],
]);

export async function loadAgentNativeEnvironment(agentId: string): Promise<AgentNativeEnvironment> {
  const load = environmentLoaders.get(agentId);
  if (!load) throw new Error('Unsupported agent integration');
  const { default: environment } = await load();
  if (environment.integrationId !== agentId) throw new Error('Agent native environment identity mismatch');
  return environment;
}
