import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

async function getClaudeAuthStatus() {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const content = await fs.readFile(credPath, 'utf8');
    const creds = JSON.parse(content);
    const oauth = creds.claudeAiOauth;
    if (oauth && oauth.accessToken) {
      const isExpired = oauth.expiresAt && Date.now() >= oauth.expiresAt;
      if (!isExpired) {
        return { authenticated: true, email: creds.email || creds.user || null };
      }
    }
    return { authenticated: false, email: null };
  } catch {
    return { authenticated: false, email: null };
  }
}

async function getClaudeAuthStatusRoute(request, url) {

  try {
    const credentialsResult = await getClaudeAuthStatus();
    if (credentialsResult.authenticated) {
      return Response.json({
        authenticated: true,
        email: credentialsResult.email || 'Authenticated session',
        method: 'credentials_file',
      });
    }
    return Response.json({
      authenticated: false,
      email: null,
      error: credentialsResult.error || 'No active Claude authentication session was found.',
    });
  } catch (error) {
    return Response.json({ authenticated: false, email: null, error: error.message }, { status: 500 });
  }
}

export default {
  '/api/v1/claude/auth/status': { GET: getClaudeAuthStatusRoute },
};
