// Resolves the native file path for a chat session when not yet persisted.
// Shared by both the REST route and the WebSocket handler.
// TODO: can we deprecate this?

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { findCodexSessionFileBySessionId } from '../projects/codex.js';

export function encodeProjectPath(projectPath) {
  return String(projectPath || '').replace(/[\\/:\s~_]/g, '-');
}

export async function resolveMissingNativePath(session) {
  if (!session || session.nativePath || !session.providerSessionId) {
    return null;
  }

  if (session.provider === 'claude') {
    const projectName = encodeProjectPath(session.projectPath);
    if (!projectName) return null;
    const candidate = path.join(
      os.homedir(),
      '.claude',
      'projects',
      projectName,
      `${session.providerSessionId}.jsonl`,
    );
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
