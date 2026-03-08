// Resolves the native file path for a chat session when not yet persisted.
// Shared by both the REST route and the WebSocket handler.
// TODO: can we deprecate this?

import { promises as fs } from 'fs';
import { findCodexSessionFileBySessionId } from '../projects/codex.js';
import { createClaudeNativePath } from '../providers/claude-cli.js';

export async function resolveMissingNativePath(session) {
  if (!session || !session.providerSessionId) {
    return null;
  }

  if (session.provider === 'claude') {
    const candidate = await createClaudeNativePath(session.projectPath, session.providerSessionId);
    if (!candidate) return null;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  if (session.provider === 'codex') {
    return findCodexSessionFileBySessionId(session.providerSessionId);
  }

  if (session.provider === 'opencode') {
    return `opencode:${session.providerSessionId}`;
  }

  return null;
}
