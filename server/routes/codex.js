import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

async function getCodexAuthStatus() {
  // Check OPENAI_API_KEY env var first.
  if (typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim()) {
    return { authenticated: true, email: 'API Key Auth', method: 'api_key_env' };
  }

  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const content = await fs.readFile(authPath, 'utf8');
    const auth = JSON.parse(content);
    const tokens = auth.tokens || {};
    if (tokens.id_token || tokens.access_token) {
      let email = 'Authenticated';
      if (tokens.id_token) {
        try {
          const parts = tokens.id_token.split('.');
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            email = payload.email || payload.user || 'Authenticated';
          }
        } catch {
          email = 'Authenticated';
        }
      }
      return { authenticated: true, email, method: 'credentials_file' };
    }
    if (auth.OPENAI_API_KEY) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key_file' };
    }
    return { authenticated: false, email: null, error: 'No usable Codex credentials were found.' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { authenticated: false, email: null, error: 'Codex authentication has not been configured.' };
    }
    return { authenticated: false, email: null, error: error.message };
  }
}

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
