// Serves the GET /api/v1/models endpoint using the live agent catalog from
// the registry.

import { getPiModelsStrict, isPiModelDiscoveryUnavailableError } from "../agents/pi/pi-models.js";

function piDiscoveryUnavailableResponse(error, catalog, entry) {
  const reason = error instanceof Error ? error.message : String(error);
  const body = {
    error: 'Pi model discovery unavailable',
    reason,
  };
  if (isPiModelDiscoveryUnavailableError(error) && error.staleModels.length > 0 && entry) {
    body.catalog = {
      agents: [{
        ...entry,
        defaultModel: entry.defaultModel || error.staleModels[0]?.value || '',
        models: error.staleModels,
      }],
      apiProviders: catalog.apiProviders,
    };
  }
  return Response.json(body, { status: 503 });
}

export default function createModelsRoutes(providers) {
  const catalog = async () => ({
    agents: await providers.agents.getAgentCatalogEntries(),
    apiProviders: providers.apiProviders.getCatalog(),
  });

  async function getModels(request, url) {
    const agentId = url?.searchParams?.get('agent');

    if (agentId) {
      if (agentId === 'pi') {
        let strictPiModels;
        try {
          strictPiModels = await getPiModelsStrict();
        } catch (error) {
          const currentCatalog = await catalog();
          const entry = currentCatalog.agents.find((agent) => agent.id === agentId);
          return piDiscoveryUnavailableResponse(error, currentCatalog, entry);
        }

        const currentCatalog = await catalog();
        const entry = currentCatalog.agents.find((agent) => agent.id === agentId);
        if (!entry) {
          return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
        }
        return Response.json({
          catalog: {
            agents: [{
              ...entry,
              defaultModel: entry.defaultModel || strictPiModels[0]?.value || '',
              models: strictPiModels,
            }],
            apiProviders: currentCatalog.apiProviders,
          },
        });
      }

      const currentCatalog = await catalog();
      const entry = currentCatalog.agents.find((agent) => agent.id === agentId);
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

    return Response.json({
      catalog: await catalog(),
    });
  }

  return {
    '/api/v1/models': { GET: getModels },
  };
}
