// Serves the GET /api/v1/models endpoint using the live harness catalog from
// the registry.

import { getPiModelsStrict, isPiModelDiscoveryUnavailableError } from '../providers/pi-models.js';

function piDiscoveryUnavailableResponse(error, catalog, entry) {
  const reason = error instanceof Error ? error.message : String(error);
  const body = {
    error: 'Pi model discovery unavailable',
    reason,
  };
  if (isPiModelDiscoveryUnavailableError(error) && error.staleModels.length > 0 && entry) {
    body.catalog = {
      harnesses: [{
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
  async function getModels(request, url) {
    const harnessId = url?.searchParams?.get('harness');

    if (harnessId) {
      if (harnessId === 'pi') {
        let strictPiModels;
        try {
          strictPiModels = await getPiModelsStrict();
        } catch (error) {
          const catalog = await providers.getHarnessCatalog();
          const entry = catalog.harnesses.find((harness) => harness.id === harnessId);
          return piDiscoveryUnavailableResponse(error, catalog, entry);
        }

        const catalog = await providers.getHarnessCatalog();
        const entry = catalog.harnesses.find((harness) => harness.id === harnessId);
        if (!entry) {
          return Response.json({ error: `Unknown harness: ${harnessId}` }, { status: 400 });
        }
        return Response.json({
          catalog: {
            harnesses: [{
              ...entry,
              defaultModel: entry.defaultModel || strictPiModels[0]?.value || '',
              models: strictPiModels,
            }],
            apiProviders: catalog.apiProviders,
          },
        });
      }

      const catalog = await providers.getHarnessCatalog();
      const entry = catalog.harnesses.find((harness) => harness.id === harnessId);
      if (!entry) {
        return Response.json({ error: `Unknown harness: ${harnessId}` }, { status: 400 });
      }
      return Response.json({
        catalog: {
          harnesses: [entry],
          apiProviders: catalog.apiProviders,
        },
      });
    }

    const catalog = await providers.getHarnessCatalog();
    return Response.json({
      catalog,
    });
  }

  return {
    '/api/v1/models': { GET: getModels },
  };
}
