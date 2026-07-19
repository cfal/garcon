import type { AgentAttachment } from '@garcon/common/agent-execution';
import type {
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '@garcon/common/chat-modes';
import type { AgentOperationIdentity } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';

export interface ClaudeExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): void;
}

export interface ClaudeExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly claudeThinkingMode?: ClaudeThinkingMode;
  readonly clientRequestId?: string;
  readonly clientMessageId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: ClaudeExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly envOverrides?: Record<string, string>;
  readonly onAbortable?: () => void;
}

export interface ClaudeStartRequest extends ClaudeExecutionRequest {
  readonly agentSessionId: string;
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

export function claudeEventMetadata(
  request: Pick<ClaudeExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: AgentOperationIdentity['commandType'],
): RuntimeEventMetadata {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
