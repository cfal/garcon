// Serves the GET /api/v1/models endpoint using the live agent catalog from
// the registry.

import {
  catalogResponseFromSnapshot,
} from './model-catalog-cache.js';

function staleModelsFromDiscoveryError(error) {
  return error
    && typeof error === 'object'
    && Array.isArray(error.staleModels)
    ? error.staleModels
    : [];
}

function modelDiscoveryUnavailableResponse(error, catalog, entry) {
  const reason = error instanceof Error ? error.message : String(error);
  const staleModels = staleModelsFromDiscoveryError(error);
  const body = {
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

export default function createModelsRoutes({ modelCatalog, responseCache }) {
  const catalog = async () => ({
    agents: await modelCatalog.agents.getAgentCatalogEntries(),
    apiProviders: modelCatalog.apiProviders.getCatalog(),
  });

  async function getModels(request, url) {
    const agentId = url?.searchParams?.get('agent');

    if (agentId) {
      const currentCatalog = await catalog();
      let entry;
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
