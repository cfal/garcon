// Persists text-only direct chat history for compatible API providers.

import { promises as fs } from 'fs';
import { hasNodeErrorCode } from '../../lib/errors.js';

export type DirectConversationRole = 'user' | 'assistant';

export interface DirectConversationMessage {
  role: DirectConversationRole;
  content: string;
}

export interface PersistedDirectMessage extends DirectConversationMessage {
  timestamp: string;
}

export interface DirectSessionStoreConfig {
  getSessionDir: () => string;
  getSessionFilePath: (sessionId: string) => string;
}

export class DirectSessionStore {
  constructor(private readonly config: DirectSessionStoreConfig) {}

  async append(sessionId: string, role: DirectConversationRole, content: string): Promise<void> {
    await fs.mkdir(this.config.getSessionDir(), { recursive: true });
    const entry: PersistedDirectMessage = {
      role,
      content,
      timestamp: new Date().toISOString(),
    };
    await fs.appendFile(this.config.getSessionFilePath(sessionId), `${JSON.stringify(entry)}\n`);
  }

  async read(sessionId: string): Promise<DirectConversationMessage[] | null> {
    let raw = '';
    try {
      raw = await fs.readFile(this.config.getSessionFilePath(sessionId), 'utf8');
    } catch (error: unknown) {
      if (hasNodeErrorCode(error, 'ENOENT')) return null;
      throw error;
    }

    const messages = raw
      .split('\n')
      .map(parseDirectMessageLine)
      .filter((message): message is DirectConversationMessage => message !== null);

    return messages.length > 0 ? messages : null;
  }
}

export function parseDirectMessageLine(line: string): DirectConversationMessage | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const role = parsed.role;
    const content = parsed.content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
      return { role, content };
    }
  } catch {
    return null;
  }
  return null;
}
