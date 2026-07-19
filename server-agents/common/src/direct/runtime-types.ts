import type {
  AgentAttachment,
  AgentEndpointSelection,
} from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentOperationIdentity } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '../shared/event-emitter-runtime.js';

export interface DirectEndpointRuntime {
  readonly selection: AgentEndpointSelection;
  readonly credential: string | null;
}

export interface DirectExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): void;
}

export interface DirectExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly clientRequestId?: string;
  readonly clientMessageId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: DirectExecutionAdmission;
  readonly command: string;
  readonly images?: readonly AgentAttachment[];
  readonly onAbortable?: () => void;
  readonly endpoint: DirectEndpointRuntime;
}

export type DirectStartRequest = DirectExecutionRequest;

export interface DirectResumeRequest extends DirectExecutionRequest {
  readonly agentSessionId: string;
  readonly nativePath?: string | null;
  readonly directHistoryRecovery?: 'allow-empty';
}

export interface DirectStartedSession {
  readonly agentSessionId: string;
  readonly nativePath: string;
}

export function assertDirectExecutionOpen(
  request: { readonly executionAdmission?: DirectExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export function markDirectExecutionStarted(
  request: { readonly executionAdmission?: DirectExecutionAdmission },
): void {
  assertDirectExecutionOpen(request);
  request.executionAdmission?.markStarted();
}

export function directEventMetadata(
  request: Pick<DirectExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: AgentOperationIdentity['commandType'],
): RuntimeEventMetadata {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
