import { getCodexAuthStatus } from '../providers/codex-auth.js';

async function getCodexAuthStatusRoute(request, url) {

  try {
    const result = await getCodexAuthStatus();
    return Response.json({
      authenticated: result.authenticated,
      email: result.email,
      error: result.error || null,
    });
  } catch (error) {
    console.error('Error checking Codex auth status:', error);
    return Response.json({ authenticated: false, email: null, error: error.message }, { status: 500 });
  }
}

export default {
  '/api/v1/codex/auth/status': { GET: getCodexAuthStatusRoute },
};
