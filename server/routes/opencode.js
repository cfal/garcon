// /api/opencode/* route handlers. Provides auth status via the OpenCode SDK.
// Model listing is handled by the unified models.js.

export default function createOpenCodeRoutes(opencode) {

  // OpenCode has no traditional auth. "Authenticated" means the SDK is reachable
  // and at least one provider has API keys configured (appears in `connected`).
  async function getOpenCodeAuthStatus() {
    try {
      const client = await opencode.getClient();
      const result = await client.provider.list();
      // SDK wraps in { data, request, response }
      // data = { all: Provider[], default: {}, connected: string[] }
      const data = result.data;
      const connected = Array.isArray(data.connected) ? data.connected : [];
      const all = Array.isArray(data.all) ? data.all : [];
      return Response.json({
        authenticated: connected.length > 0,
        email: connected.length > 0 ? 'OpenCode Connected' : null,
        providers: all.map((p) => p.id || p.name),
      });
    } catch (error) {
      return Response.json({
        authenticated: false,
        email: null,
        error: error.message || 'OpenCode not available',
      });
    }
  }

  return {
    '/api/v1/opencode/auth/status': { GET: getOpenCodeAuthStatus },
  };
}
