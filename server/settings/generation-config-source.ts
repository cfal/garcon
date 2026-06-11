import type { AgentCatalogEntry, AgentModelOption } from '../../common/agents.js';

export interface GenerationContext {
  authByAgent: Record<string, { authenticated?: boolean }>;
  readinessByAgent: Record<string, { ready?: boolean }>;
  modelsByAgent: Record<string, AgentModelOption[]>;
}

interface GenerationContextAgentSource {
  getAgentAuthStatusMap(): Promise<Record<string, unknown>>;
  getAgentReadinessMap(): Promise<Record<string, unknown>>;
  getAgentCatalogEntries?(): Promise<AgentCatalogEntry[]>;
  getAgentCatalog?(): Promise<{ agents?: AgentCatalogEntry[] }>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function getAgentCatalogEntries(source: GenerationContextAgentSource): Promise<AgentCatalogEntry[]> {
  if (typeof source.getAgentCatalogEntries === 'function') {
    return source.getAgentCatalogEntries();
  }
  if (typeof source.getAgentCatalog === 'function') {
    const catalog = await source.getAgentCatalog();
    return Array.isArray(catalog?.agents) ? catalog.agents : [];
  }
  return [];
}

function modelsByAgentFromCatalog(entries: AgentCatalogEntry[]): Record<string, AgentModelOption[]> {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.id,
      Array.isArray(entry.models) ? entry.models : [],
    ]),
  );
}

function authByAgentFromRaw(raw: Record<string, unknown>): Record<string, { authenticated?: boolean }> {
  return Object.fromEntries(
    Object.entries(raw).map(([agentId, value]) => {
      const entry = asObject(value);
      return [agentId, { authenticated: entry.authenticated === true }];
    }),
  );
}

function readinessByAgentFromRaw(raw: Record<string, unknown>): Record<string, { ready?: boolean }> {
  return Object.fromEntries(
    Object.entries(raw).map(([agentId, value]) => {
      const entry = asObject(value);
      return [agentId, { ready: entry.ready === true }];
    }),
  );
}

export async function resolveGenerationContext(source: GenerationContextAgentSource): Promise<GenerationContext> {
  const [rawAuthByAgent, rawReadinessByAgent, catalogEntries] = await Promise.all([
    source.getAgentAuthStatusMap(),
    source.getAgentReadinessMap(),
    getAgentCatalogEntries(source),
  ]);

  return {
    authByAgent: authByAgentFromRaw(rawAuthByAgent),
    readinessByAgent: readinessByAgentFromRaw(rawReadinessByAgent),
    modelsByAgent: modelsByAgentFromCatalog(catalogEntries),
  };
}
