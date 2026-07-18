import path from 'path';
import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '../../../common/agents.js';

export type DirectAgentId =
  | typeof DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID
  | typeof DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID
  | typeof DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID;

const SESSION_ROOT_BY_AGENT: Record<DirectAgentId, string> = {
  [DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: 'openai-compatible-sessions',
  [DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: 'openai-compatible-responses-sessions',
  [DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: 'anthropic-compatible-sessions',
};

const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface DirectSessionPaths {
  sessionDir(endpointId: string): string;
  sessionFilePath(endpointId: string, sessionId: string): string;
}

export function isSafeDirectPathSegment(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_PATH_SEGMENT_RE.test(value)
    && value !== '.'
    && value !== '..';
}

function requireSafePathSegment(value: string, label: string): string {
  if (!isSafeDirectPathSegment(value)) {
    throw new Error(`Invalid Direct ${label}: ${value}`);
  }
  return value;
}

export function createDirectSessionPaths(
  workspaceDir: string,
  agentId: DirectAgentId,
): DirectSessionPaths {
  const root = path.resolve(workspaceDir, SESSION_ROOT_BY_AGENT[agentId]);

  return {
    sessionDir(endpointId) {
      return path.join(root, requireSafePathSegment(endpointId, 'endpoint ID'));
    },
    sessionFilePath(endpointId, sessionId) {
      return path.join(
        root,
        requireSafePathSegment(endpointId, 'endpoint ID'),
        `${requireSafePathSegment(sessionId, 'session ID')}.jsonl`,
      );
    },
  };
}
