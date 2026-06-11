import type { AgentCatalogEntry, AgentModelOption } from '../../common/agents.js';

export interface GenerationContext {
  authByAgent: Record<string, { authenticated?: boolean }>;
  readinessByAgent: Record<string, { ready?: boolean }>;
  modelsByAgent: Record<string, AgentModelOption[]>;
}

interface GenerationContextAgentSource {
  getAgentAuthStatusMap(): Promise<Record<string, { authenticated?: boolean }>>;
  getAgentReadinessMap(): Promise<Record<string, { ready?: boolean }>>;
  getAgentCatalogEntries?(): Promise<AgentCatalogEntry[]>;
  getAgentCatalog?(): Promise<{ agents?: AgentCatalogEntry[] }>;
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

export async function resolveGenerationContext(source: GenerationContextAgentSource): Promise<GenerationContext> {
  const [authByAgent, readinessByAgent, catalogEntries] = await Promise.all([
    source.getAgentAuthStatusMap(),
    source.getAgentReadinessMap(),
    getAgentCatalogEntries(source),
  ]);

  return {
    authByAgent,
    readinessByAgent,
    modelsByAgent: modelsByAgentFromCatalog(catalogEntries),
  };
}
