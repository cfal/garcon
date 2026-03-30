// Unified provider auth status endpoint plus provider-specific UI login launchers.
// GET  /api/v1/providers/auth?provider=claude  -> { claude: { ... } }
// GET  /api/v1/providers/auth                  -> { claude: { ... }, codex: { ... }, ... }
// POST /api/v1/claude/auth/login              -> { launched: true, alreadyRunning: false }
// POST /api/v1/codex/auth/login               -> { launched: true, alreadyRunning: false }

import { launchProviderAuthLogin } from '../providers/auth-login.js';

const UI_LOGIN_PROVIDERS = ['claude', 'codex'];

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

  async function postProviderAuthLogin(provider) {
    try {
      return Response.json(await launchProviderAuthLogin(provider));
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  const loginRoutes = Object.fromEntries(
    UI_LOGIN_PROVIDERS.map((provider) => [
      `/api/v1/${provider}/auth/login`,
      { POST: () => postProviderAuthLogin(provider) },
    ])
  );

  return {
    '/api/v1/providers/auth': { GET: getProviderAuth },
    ...loginRoutes,
  };
}
