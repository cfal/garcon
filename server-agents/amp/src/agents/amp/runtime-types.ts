import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentOperationIdentity } from '@garcon/server-agent-interface';

export interface AmpExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): void;
}

export interface AmpExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly clientRequestId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: AmpExecutionAdmission;
  readonly onAbortable?: () => void;
}

export interface AmpStartRequest extends AmpExecutionRequest {
  readonly command: string;
}

export interface AmpResumeRequest extends AmpStartRequest {
  readonly agentSessionId: string;
}

export interface AmpStartedSession {
  readonly agentSessionId: string;
  readonly nativePath: string | null;
}

export function assertAmpExecutionOpen(
  request: { readonly executionAdmission?: AmpExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export function markAmpExecutionStarted(
  request: { readonly executionAdmission?: AmpExecutionAdmission },
): void {
  assertAmpExecutionOpen(request);
  request.executionAdmission?.markStarted();
}

export function ampEventMetadata(
  request: Pick<AmpExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: AgentOperationIdentity['commandType'],
) {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
