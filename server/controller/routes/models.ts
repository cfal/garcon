// Serves the GET /api/v1/models endpoint using the live agent catalog from
// the registry.

import { catalogResponseFromSnapshot } from './model-catalog-response.js';
import { isCatalogExecutorFailure } from '../agents/catalog-service.js';
import { buildCatalogResponse, type ModelCatalog, type ModelCatalogResponseCache } from '../agents/model-catalog-cache.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentCatalogEntry, AgentModelOption } from '../../../common/agents.js';
import { executorIdFromUrl, onLoginInstance } from './executor-target.js';
import { LOGIN_INSTANCE_QUERY } from '../../../common/agent-auth.js';
import { CATALOG_INSTANCE_HEADER, LOGIN_AGENT_QUERY, type ModelCatalogResponse } from '../../../common/model-catalog.js';
import { DomainError } from '../../common/domain-error.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { jsonErrorFromUnknown } from '../../common/http-error.js';

function staleModelsFromDiscoveryError(error: unknown): AgentModelOption[] {
  if (typeof error === 'object' && error !== null && 'staleModels' in error && Array.isArray(error.staleModels)) {
    return error.staleModels;
  }
  return [];
}

function modelDiscoveryUnavailableResponse(
  error: unknown,
  entry: AgentCatalogEntry,
  apiProviders: ModelCatalogResponse['catalog']['apiProviders'],
): Response {
  const reason = error instanceof Error ? error.message : String(error);
  const staleModels = staleModelsFromDiscoveryError(error);
  const body: {
    error: string;
    reason: string;
    catalog?: ModelCatalogResponse['catalog'];
  } = {
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
  instanceId,
}: {
  modelCatalog: ModelCatalog;
  responseCache: ModelCatalogResponseCache;
  instanceId(executorId: string): string;
}): RouteMap {
  async function agentModels(agentId: string, executorId: string): Promise<Response> {
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
        if (isCatalogExecutorFailure(error)) throw error;
        return modelDiscoveryUnavailableResponse(error, entry, apiProviders);
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

  async function getModels(request: Request, url: URL): Promise<Response> {
    const executorId = executorIdFromUrl(url);
    const servingInstance = instanceId(executorId);
    const loginInstance = url.searchParams.get(LOGIN_INSTANCE_QUERY);
    const response = await onLoginInstance(() => instanceId(executorId), loginInstance, async () => {
      const agentId = url.searchParams.get('agent');
      if (agentId) return agentModels(agentId, executorId);
      if (loginInstance === null) {
        return catalogResponseFromSnapshot(request, await responseCache.getSnapshot(modelCatalog, executorId, servingInstance));
      }
      const confirmingAgents = url.searchParams.getAll(LOGIN_AGENT_QUERY);
      responseCache.clear(executorId);
      try {
        const snapshot = await buildCatalogResponse(modelCatalog, executorId, confirmingAgents);
        return catalogResponseFromSnapshot(request, snapshot);
      } catch (error) {
        if (confirmingAgents.length > 0 && !isCatalogExecutorFailure(error)
          && error instanceof AgentIntegrationError && error.code === 'UNAVAILABLE') {
          throw new DomainError('MODEL_DISCOVERY_UNAVAILABLE', 'Model discovery is temporarily unavailable.', 503, true, { cause: error });
        }
        throw error;
      }
    });
    if (servingInstance !== instanceId(executorId)) {
      throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor changed during model discovery.', 503, true);
    }
    response.headers.set(CATALOG_INSTANCE_HEADER, servingInstance);
    return response;
  }

  return {
    '/api/v1/models': { GET: async (request, url) => {
      try { return await getModels(request, url); }
      catch (error) { return jsonErrorFromUnknown(error); }
    } },
  };
}
