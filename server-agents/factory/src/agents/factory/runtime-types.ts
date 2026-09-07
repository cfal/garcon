import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';

export interface FactoryCommandImage {
  readonly data: string;
  readonly name?: string;
  readonly mimeType: string;
}

export interface FactoryExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface FactoryExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly operation: AgentRuntimeOperation;
  readonly executionAdmission?: FactoryExecutionAdmission;
}

export interface FactoryStartRequest extends FactoryExecutionRequest {
  readonly command: string;
  readonly images?: FactoryCommandImage[];
  readonly onSessionActivated?: (session: FactoryStartedSession) => void;
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

export async function markFactoryExecutionStarted(
  request: { readonly executionAdmission?: FactoryExecutionAdmission },
): Promise<void> {
  assertFactoryExecutionOpen(request);
  await request.executionAdmission?.markStarted();
}
