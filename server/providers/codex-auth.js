import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export async function getCodexAuthStatus() {
  if (typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim()) {
    return { authenticated: true, canReauth: false, label: '' };
  }

  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const content = await fs.readFile(authPath, 'utf8');
    const auth = JSON.parse(content);
    const tokens = auth.tokens || {};
    if (tokens.id_token || tokens.access_token) {
      let label = '';
      if (tokens.id_token) {
        try {
          const parts = tokens.id_token.split('.');
          if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            label = payload.email || payload.user || '';
          }
        } catch {
          label = '';
        }
      }
      return { authenticated: true, canReauth: true, label };
    }
    if (auth.OPENAI_API_KEY) {
      return { authenticated: true, canReauth: false, label: '' };
    }
    return { authenticated: false, canReauth: true, label: '' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { authenticated: false, canReauth: true, label: '' };
    }
    return { authenticated: false, canReauth: true, label: '' };
  }
}
