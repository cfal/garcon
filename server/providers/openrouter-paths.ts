// Shared path helpers for OpenRouter session storage.
// Used by both the provider and the history loader.

import path from 'path';
import { getWorkspaceDir } from '../config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

export function getSessionDir(): string {
  return path.join(getWorkspaceDir(), 'openrouter-sessions');
}

export function getSessionFilePath(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid OpenRouter session ID: ${sessionId}`);
  }
  return path.join(getSessionDir(), `${sessionId}.jsonl`);
}
