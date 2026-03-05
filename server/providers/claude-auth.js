import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export async function getClaudeAuthStatus() {
  if (typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.trim()) {
    return { authenticated: true, email: null, method: 'api_key_env' };
  }

  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const content = await fs.readFile(credPath, 'utf8');
    const creds = JSON.parse(content);
    const oauth = creds.claudeAiOauth;
    if (oauth && oauth.accessToken) {
      const isExpired = oauth.expiresAt && Date.now() >= oauth.expiresAt;
      if (!isExpired) {
        return { authenticated: true, email: creds.email || creds.user || null, method: 'credentials_file' };
      }
    }
    return { authenticated: false, email: null, method: null };
  } catch {
    return { authenticated: false, email: null, method: null };
  }
}
