// Serves the GET /api/v1/models endpoint using the live harness catalog from
// the registry.

export default function createModelsRoutes(providers) {
  async function getModels(request, url) {
    const harnessId = url?.searchParams?.get('harness');
    const catalog = await providers.getHarnessCatalog();

    if (harnessId) {
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

    return Response.json({
      catalog,
    });
  }

  return {
    '/api/v1/models': { GET: getModels },
  };
}
