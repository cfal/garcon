// Serves the GET /api/v1/models endpoint using the live agent catalog from
// the registry.

import { catalogResponseFromSnapshot } from './model-catalog-response.js';
import { type ModelCatalog, type ModelCatalogResponseCache } from '../agents/model-catalog-cache.js';
import type { ModelCatalogResponse } from '../../../common/model-catalog.js';
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
  executorInstanceId: string,
  apiProviders: ModelCatalogResponse['catalog']['apiProviders'],
  entry: AgentCatalogEntry,
): Response {
  const reason = error instanceof Error ? error.message : String(error);
  const staleModels = staleModelsFromDiscoveryError(error);
  const body: {
    executorInstanceId: string;
    error: string;
    reason: string;
    catalog?: ModelCatalogResponse['catalog'];
  } = {
    executorInstanceId,
    error: 'Model discovery unavailable',
    reason,
  };
  if (staleModels.length > 0) {
    body.catalog = {
      agents: [{
        ...entry,
        defaultModel: entry.defaultModel || staleModels[0]?.value || '',
        models: staleModels,
      }],
      apiProviders,
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
      const captured = modelCatalog.agents.captureCatalog(executorId);
      let entry = await captured.getAgentCatalogEntry(agentId);
      if (!entry) {
        const agents = await captured.getAgentCatalogEntries();
        captured.assertCurrent();
        const availableAgents = agents.map((agent) => agent.id).join(', ') || 'none';
        return Response.json({
          error: `Unknown agent: ${agentId}. Available agents: ${availableAgents}`,
        }, { status: 400 });
      }
      captured.assertCurrent();
      const apiProviders = modelCatalog.apiProviders.getCatalog(executorId);
      if (entry.requiresStrictModelDiscovery || captured.requiresStrictModelDiscovery(agentId)) {
        try {
          entry = await captured.getAgentCatalogEntry(agentId, { strict: true }) ?? entry;
        } catch (error) {
          captured.assertCurrent();
          return modelDiscoveryUnavailableResponse(error, captured.executorInstanceId, apiProviders, entry);
        }
        captured.assertCurrent();
      }
      return Response.json({
        executorInstanceId: captured.executorInstanceId,
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
