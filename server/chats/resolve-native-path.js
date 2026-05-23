// Resolves the native file path for a chat session when not yet persisted.
// Shared by both the REST route and the WebSocket handler.

import { promises as fs } from 'fs';
import { createClaudeNativePath } from "../agents/claude/claude-cli.js";
import { findPiSessionFileBySessionId } from "../agents/pi/pi-session-paths.js";
import { createArtificialNativePath } from './artificial-native-path.js';
import { isEndpointOnlyAgentId } from '../../common/agents.ts';

export async function resolveMissingNativePath(session, options = {}) {
  if (!session || !session.agentSessionId) {
    return null;
  }

  if (session.agentId === 'claude') {
    const candidate = await createClaudeNativePath(session.projectPath, session.agentSessionId);
    if (!candidate) return null;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  if (session.agentId === 'codex') {
    return options.resolveCodexNativePath
      ? options.resolveCodexNativePath(session)
      : null;
  }

  if (session.agentId === 'opencode') {
    return createArtificialNativePath(session.agentId, session.agentSessionId);
  }

  if (session.agentId === 'amp') {
    return createArtificialNativePath(session.agentId, session.agentSessionId);
  }

  if (session.agentId === 'cursor') {
    return createArtificialNativePath(session.agentId, session.agentSessionId);
  }

  if (session.agentId === 'factory') {
    return createArtificialNativePath(session.agentId, session.agentSessionId);
  }

  if (session.agentId === 'pi') {
    const found = await findPiSessionFileBySessionId(session.agentSessionId, session.projectPath);
    return found || createArtificialNativePath(session.agentId, session.agentSessionId);
  }

  if (isEndpointOnlyAgentId(session.agentId)) {
    return createArtificialNativePath(session.agentId, session.agentSessionId);
  }

  return null;
}
