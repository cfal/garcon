import type { AgentAttachment } from '@garcon/common/agent-execution';
import type {
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';

export interface ClaudeExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface ClaudeExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly claudeThinkingMode?: ClaudeThinkingMode;
  readonly executionAdmission?: ClaudeExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly envOverrides?: Record<string, string>;
  readonly operation: AgentRuntimeOperation;
}

export interface ClaudeStartRequest extends ClaudeExecutionRequest {
  readonly agentSessionId: string;
  readonly onSessionActivated?: () => void;
}

export interface ClaudeResumeRequest extends ClaudeExecutionRequest {
  readonly agentSessionId: string;
  readonly nativePath?: string | null;
}

export interface ClaudeProjectPathUpdate {
  readonly chatId: string;
  readonly agentSessionId: string | null;
  readonly previousProjectPath: string;
  readonly nextProjectPath: string;
  readonly nativePath: string | null;
}

export function assertClaudeExecutionOpen(
  request: { readonly executionAdmission?: ClaudeExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}
