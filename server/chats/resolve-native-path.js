// Resolves the native file path for a chat session when not yet persisted.
// Shared by both the REST route and the WebSocket handler.

import { promises as fs } from 'fs';
import { createClaudeNativePath } from "../agents/claude/claude-cli.js";
import { findPiSessionFileBySessionId } from "../agents/pi/pi-session-paths.js";
import { createArtificialNativePath } from './artificial-native-path.js';
import { isEndpointOnlyAgentId } from '../../common/providers.ts';

export async function resolveMissingNativePath(session, options = {}) {
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
    return options.resolveCodexNativePath
      ? options.resolveCodexNativePath(session)
      : null;
  }

  if (session.provider === 'opencode') {
    return createArtificialNativePath(session.provider, session.providerSessionId);
  }

  if (session.provider === 'amp') {
    return createArtificialNativePath(session.provider, session.providerSessionId);
  }

  if (session.provider === 'cursor') {
    return createArtificialNativePath(session.provider, session.providerSessionId);
  }

  if (session.provider === 'factory') {
    return createArtificialNativePath(session.provider, session.providerSessionId);
  }

  if (session.provider === 'pi') {
    const found = await findPiSessionFileBySessionId(session.providerSessionId, session.projectPath);
    return found || createArtificialNativePath(session.provider, session.providerSessionId);
  }

  if (isEndpointOnlyAgentId(session.provider)) {
    return createArtificialNativePath(session.provider, session.providerSessionId);
  }

  return null;
}
