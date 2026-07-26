import type { AgentAttachment } from '@garcon/common/agent-execution';
import type {
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '@garcon/common/chat-modes';

export interface ClaudeSessionOptions {
  agentSessionId: string;
  sessionId: string;
  chatId: string;
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  images?: readonly AgentAttachment[];
  envOverrides?: Record<string, string>;
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
    permissionMode: next.permissionMode ?? current.permissionMode,
    thinkingMode: next.thinkingMode ?? current.thinkingMode,
    claudeThinkingMode: next.claudeThinkingMode ?? current.claudeThinkingMode,
    envOverrides: next.envOverrides ?? current.envOverrides,
    images: next.images,
  };
}

export function normalizeClaudeThinkingModeForState(
  claudeThinkingMode: ClaudeThinkingMode | undefined,
): ClaudeThinkingMode {
  return claudeThinkingMode ?? 'auto';
}
