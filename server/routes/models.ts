// Serves the GET /api/v1/models endpoint using the live agent catalog from
// the registry.

import {
  catalogResponseFromSnapshot,
  type ModelCatalog,
  type ModelCatalogResponseCache,
  type ModelCatalogResponseBody,
} from './model-catalog-cache.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentCatalogEntry, AgentModelOption } from '../../common/agents.js';

interface ModelDiscoveryUnavailableError extends Error {
  staleModels?: AgentModelOption[];
}

function staleModelsFromDiscoveryError(error: unknown): AgentModelOption[] {
  return error
    && typeof error === 'object'
    && Array.isArray((error as ModelDiscoveryUnavailableError).staleModels)
    ? (error as ModelDiscoveryUnavailableError).staleModels ?? []
    : [];
}

function modelDiscoveryUnavailableResponse(
  error: unknown,
  catalog: ModelCatalogResponseBody['catalog'],
  entry: AgentCatalogEntry | undefined,
): Response {
  const reason = error instanceof Error ? error.message : String(error);
  const staleModels = staleModelsFromDiscoveryError(error);
  const body: {
    error: string;
    reason: string;
    catalog?: ModelCatalogResponseBody['catalog'];
  } = {
    error: 'Model discovery unavailable',
    reason,
  };
  if (staleModels.length > 0 && entry) {
    body.catalog = {
      agents: [{
        ...entry,
        defaultModel: entry.defaultModel || staleModels[0]?.value || '',
        models: staleModels,
      }],
      apiProviders: catalog.apiProviders,
    };
  }
  return Response.json(body, { status: 503 });
}

export default function createModelsRoutes({
  modelCatalog,
  responseCache,
}: {
  modelCatalog: ModelCatalog;
  responseCache: ModelCatalogResponseCache;
}): RouteMap {
  const catalog = async () => ({
    agents: await modelCatalog.agents.getAgentCatalogEntries(),
    apiProviders: modelCatalog.apiProviders.getCatalog(),
  });

  async function getModels(request: Request, url: URL): Promise<Response> {
    const agentId = url?.searchParams?.get('agent');

    if (agentId) {
      const currentCatalog = await catalog();
      let entry: AgentCatalogEntry | null | undefined;
      try {
        entry = typeof modelCatalog.agents.getAgentCatalogEntry === 'function'
          ? await modelCatalog.agents.getAgentCatalogEntry(agentId, { strict: agentId === 'pi' })
          : currentCatalog.agents.find((agent) => agent.id === agentId);
      } catch (error) {
        const staleEntry = currentCatalog.agents.find((agent) => agent.id === agentId);
        return modelDiscoveryUnavailableResponse(error, currentCatalog, staleEntry);
      }
      if (!entry) {
        return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
      }
      return Response.json({
        catalog: {
          agents: [entry],
          apiProviders: currentCatalog.apiProviders,
        },
      });
    }

    const snapshot = await responseCache.getSnapshot(modelCatalog);
    return catalogResponseFromSnapshot(request, snapshot);
  }

  return {
    '/api/v1/models': { GET: getModels },
  };
}
