// Serves the GET /api/v1/models endpoint using the live agent catalog from
// the registry.

import {
  catalogResponseFromSnapshot,
  type ModelCatalog,
  type ModelCatalogResponseCache,
  type ModelCatalogResponseBody,
} from './model-catalog-cache.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentCatalogEntry, AgentModelOption } from '../../../common/agents.js';
import { executorIdFromUrl } from './executor-target.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';

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
  async function getModels(request: Request, url: URL): Promise<Response> {
    const executorId = executorIdFromUrl(url);
    const agentId = url?.searchParams?.get('agent');

    if (agentId) {
      let entry = await modelCatalog.agents.getAgentCatalogEntry(agentId, { executorId });
      if (!entry) {
        const agents = await modelCatalog.agents.getAgentCatalogEntries(executorId);
        const availableAgents = agents.map((agent) => agent.id).join(', ') || 'none';
        return Response.json({
          error: `Unknown agent: ${agentId}. Available agents: ${availableAgents}`,
        }, { status: 400 });
      }
      modelCatalog.agents.assertAgentAvailable(agentId, executorId);
      const apiProviders = modelCatalog.apiProviders.getCatalog(executorId);
      if (entry.requiresStrictModelDiscovery || modelCatalog.agents.requiresStrictModelDiscovery(agentId, executorId)) {
        try {
          entry = await modelCatalog.agents.getAgentCatalogEntry(agentId, { strict: true, executorId }) ?? entry;
        } catch (error) {
          modelCatalog.agents.assertAgentAvailable(agentId, executorId);
          return modelDiscoveryUnavailableResponse(error, { agents: [entry], apiProviders }, entry);
        }
        modelCatalog.agents.assertAgentAvailable(agentId, executorId);
      }
      return Response.json({
        catalog: {
          agents: [entry],
          apiProviders,
        },
      });
    }

    const snapshot = await responseCache.getSnapshot(modelCatalog, executorId);
    return catalogResponseFromSnapshot(request, snapshot);
  }

  return {
    '/api/v1/models': { GET: async (request, url) => {
      try { return await getModels(request, url); }
      catch (error) { return jsonErrorFromUnknown(error); }
    } },
  };
}
