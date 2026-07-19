import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentOperationIdentity } from '@garcon/server-agent-interface';

export interface FactoryCommandImage {
  readonly data: string;
  readonly name?: string;
  readonly mimeType: string;
}

export interface FactoryExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): void;
}

export interface FactoryExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly clientRequestId?: string;
  readonly turnId?: string;
  readonly executionAdmission?: FactoryExecutionAdmission;
  readonly onAbortable?: () => void;
}

export interface FactoryStartRequest extends FactoryExecutionRequest {
  readonly command: string;
  readonly images?: FactoryCommandImage[];
}

export interface FactoryResumeRequest extends FactoryStartRequest {
  readonly agentSessionId: string;
}

export interface FactoryStartedSession {
  readonly agentSessionId: string;
  readonly nativePath: string | null;
}

export function assertFactoryExecutionOpen(
  request: { readonly executionAdmission?: FactoryExecutionAdmission },
): void {
  request.executionAdmission?.signal.throwIfAborted();
}

export function markFactoryExecutionStarted(
  request: { readonly executionAdmission?: FactoryExecutionAdmission },
): void {
  assertFactoryExecutionOpen(request);
  request.executionAdmission?.markStarted();
}

export function factoryEventMetadata(
  request: Pick<FactoryExecutionRequest, 'clientRequestId' | 'turnId'>,
  commandType?: AgentOperationIdentity['commandType'],
) {
  return Object.freeze({
    ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
    ...(commandType ? { commandType } : {}),
    ...(request.turnId ? { turnId: request.turnId } : {}),
  });
}
