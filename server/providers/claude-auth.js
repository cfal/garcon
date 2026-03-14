import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export async function getClaudeAuthStatus() {
  if (typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.trim()) {
    return { authenticated: true, canReauth: false, label: '' };
  }

  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const content = await fs.readFile(credPath, 'utf8');
    const creds = JSON.parse(content);
    const oauth = creds.claudeAiOauth;
    let isValid = false;
    if (oauth && oauth.refreshToken) {
      isValid = true;
    } else if (oauth && oauth.accessToken) {
      const isExpired = oauth.expiresAt && Date.now() >= oauth.expiresAt;
      if (!isExpired) {
        isValid = true;
      }
    }
    if (isValid) {
      let label = '';
      try {
        const configPath = path.join(os.homedir(), '.claude', '.claude.json');
        const configContent = await fs.readFile(configPath, 'utf8');
        const config = JSON.parse(configContent);
        if (config.oauthAccount && config.oauthAccount.emailAddress) {
          label = config.oauthAccount.emailAddress;
        }
      } catch {
        // .claude.json not found or unreadable
      }
      return { authenticated: true, canReauth: true, label };
    }
    return { authenticated: false, canReauth: true, label: '' };
  } catch {
    return { authenticated: false, canReauth: true, label: '' };
  }
}
