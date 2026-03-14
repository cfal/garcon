// Unified provider auth status endpoint.
// GET /api/v1/providers/auth?provider=claude  -> { claude: { ... } }
// GET /api/v1/providers/auth                  -> { claude: { ... }, codex: { ... }, ... }

export default function createProviderRoutes(providers) {
  async function getProviderAuth(request, url) {
    const provider = url.searchParams.get('provider');
    try {
      if (provider) {
        const status = await providers.getAuthStatus(provider);
        if (!status) {
          return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
        }
        return Response.json({ [provider]: status });
      }
      return Response.json(await providers.getAuthStatusMap());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return {
    '/api/v1/providers/auth': { GET: getProviderAuth },
  };
}
