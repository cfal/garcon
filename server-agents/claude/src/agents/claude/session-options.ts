import type {
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '@garcon/common/chat-modes';
import type { ClaudeModelSource, ClaudeStartRequest } from './runtime-types.js';

export interface ClaudeSessionOptions {
  agentSessionId: string;
  sessionId: string;
  chatId: string;
  projectPath: string;
  model: string;
  modelSource: ClaudeModelSource;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  envOverrides?: Record<string, string>;
}

type ClaudeSessionRequest = Pick<
  ClaudeStartRequest,
  | 'agentSessionId'
  | 'chatId'
  | 'projectPath'
  | 'model'
  | 'modelSource'
  | 'permissionMode'
  | 'thinkingMode'
  | 'claudeThinkingMode'
  | 'envOverrides'
>;

export function createClaudeSessionOptions(request: ClaudeSessionRequest): ClaudeSessionOptions {
  const {
    agentSessionId,
    chatId,
    projectPath,
    model,
    modelSource,
    permissionMode,
    thinkingMode,
    claudeThinkingMode,
    envOverrides,
  } = request;
  return {
    agentSessionId,
    sessionId: agentSessionId,
    chatId,
    projectPath,
    model,
    modelSource: modelSource ?? 'native',
    permissionMode,
    thinkingMode,
    claudeThinkingMode,
    envOverrides,
  };
}

export function mergeClaudeSessionOptions(
  current: ClaudeSessionOptions,
  next: ClaudeSessionOptions,
): ClaudeSessionOptions {
  return {
    agentSessionId: next.agentSessionId ?? current.agentSessionId,
    sessionId: next.sessionId ?? current.sessionId,
    chatId: next.chatId ?? current.chatId,
    projectPath: next.projectPath ?? current.projectPath,
    model: next.model ?? current.model,
    modelSource: next.modelSource ?? current.modelSource,
    permissionMode: next.permissionMode ?? current.permissionMode,
    thinkingMode: next.thinkingMode ?? current.thinkingMode,
    claudeThinkingMode: next.claudeThinkingMode ?? current.claudeThinkingMode,
    envOverrides: next.envOverrides ?? current.envOverrides,
  };
}

export function normalizeClaudeThinkingModeForState(
  claudeThinkingMode: ClaudeThinkingMode | undefined,
): ClaudeThinkingMode {
  return claudeThinkingMode ?? 'auto';
}
