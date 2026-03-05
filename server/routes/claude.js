import { getClaudeAuthStatus } from '../providers/claude-auth.js';

async function getClaudeAuthStatusRoute(request, url) {

  try {
    const result = await getClaudeAuthStatus();
    if (result.authenticated) {
      return Response.json({
        authenticated: true,
        email: result.method === 'api_key_env'
          ? 'API Key Auth'
          : (result.email || 'Authenticated session'),
        method: result.method,
      });
    }
    return Response.json({
      authenticated: false,
      email: null,
      error: 'No active Claude authentication session was found.',
    });
  } catch (error) {
    return Response.json({ authenticated: false, email: null, error: error.message }, { status: 500 });
  }
}

export default {
  '/api/v1/claude/auth/status': { GET: getClaudeAuthStatusRoute },
};
