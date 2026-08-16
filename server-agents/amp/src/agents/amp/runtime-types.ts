import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';

export interface AmpExecutionAdmission {
  readonly signal: AbortSignal;
  markStarted(): Promise<void>;
}

export interface AmpExecutionRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly operation: AgentRuntimeOperation;
  readonly executionAdmission?: AmpExecutionAdmission;
}

export interface AmpStartRequest extends AmpExecutionRequest {
  readonly command: string;
  readonly onSessionActivated?: (session: AmpStartedSession) => void;
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

export async function markAmpExecutionStarted(
  request: { readonly executionAdmission?: AmpExecutionAdmission },
): Promise<void> {
  assertAmpExecutionOpen(request);
  await request.executionAdmission?.markStarted();
}
